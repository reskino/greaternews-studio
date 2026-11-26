"""GreaterNews auto-render: turns content/<date>/cards.json into finished PNGs and videos.

Starts a local file receiver, serves the built app, drives it in headless Edge,
and collects the rendered assets into content/<date>/assets/.

Usage: python scripts/render_assets.py [YYYY-MM-DD]
"""

import glob
import json
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import threading
import time
import urllib.parse
import urllib.request
import uuid
from datetime import date
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


def free_port():
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


def kill_port_holders(*ports):
    """A crashed previous run can leave Edge/vite holding our ports — clear them first."""
    try:
        output = subprocess.check_output(["netstat", "-ano"], text=True)
    except Exception:
        return
    pids = set()
    for line in output.splitlines():
        parts = line.split()
        if len(parts) >= 5 and parts[3] == "LISTENING":
            for port in ports:
                if parts[1].endswith(f":{port}"):
                    pids.add(parts[4])
    for pid in pids:
        subprocess.run(["taskkill", "/F", "/PID", pid], capture_output=True)
        print(f"  cleared stale process {pid}")

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# Page log lines carry ✓/✗ and emoji; Windows consoles default to cp1252, which crashed the receiver.
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
EDGE = r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
RECEIVER_PORT = 5198
APP_PORT = 4179
TIMEOUT_SECONDS = 1500  # photo fetching + multiple videos can push past 10 minutes

run_date = sys.argv[1] if len(sys.argv) > 1 else date.today().isoformat()
content_dir = os.path.join(ROOT, "content")
spec_path = os.path.join(content_dir, f"cards_{run_date}.json")
out_dir = os.path.join(content_dir, run_date, "assets")

if not os.path.exists(spec_path):
    print(f"No card spec at {spec_path} - nothing to render.")
    sys.exit(0)

os.makedirs(out_dir, exist_ok=True)
done_event = threading.Event()
results = {"rendered": 0, "failed": 0}


class Handler(BaseHTTPRequestHandler):
    def _cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "*")

    def do_OPTIONS(self):
        self.send_response(204)
        self._cors()
        self.end_headers()

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path == "/cards.json":
            body = open(spec_path, "rb").read()
            self.send_response(200)
            self._cors()
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(body)
        elif parsed.path.startswith("/music/"):
            # Serve user music tracks from public/music/ (vite preview returns 204 to the headless
            # fetch, so the renderer fetches tracks from here instead).
            name = os.path.basename(urllib.parse.unquote(parsed.path[len("/music/"):]))
            fpath = os.path.join(ROOT, "public", "music", name)
            if name and os.path.exists(fpath):
                data = open(fpath, "rb").read()
                self.send_response(200)
                self._cors()
                self.send_header("Content-Type", "audio/mpeg")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)
            else:
                self.send_response(404)
                self._cors()
                self.end_headers()
        elif parsed.path == "/done":
            params = urllib.parse.parse_qs(parsed.query)
            results["rendered"] = int(params.get("rendered", ["0"])[0])
            results["failed"] = int(params.get("failed", ["0"])[0])
            self.send_response(200)
            self._cors()
            self.end_headers()
            self.wfile.write(b"ok")
            done_event.set()
        else:
            self.send_response(404)
            self._cors()
            self.end_headers()

    def do_POST(self):
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path == "/save":
            params = urllib.parse.parse_qs(parsed.query)
            name = os.path.basename(params.get("name", ["file.bin"])[0])
            length = int(self.headers.get("Content-Length", "0"))
            data = self.rfile.read(length)
            with open(os.path.join(out_dir, name), "wb") as handle:
                handle.write(data)
            print(f"  saved {name} ({len(data) // 1024} KB)")
            self.send_response(200)
            self._cors()
            self.end_headers()
            self.wfile.write(b"ok")
        elif parsed.path == "/log":  # the page's own log lines (beat clips/photos, failures, timings)
            length = int(self.headers.get("Content-Length", "0"))
            print(f"    [page] {self.rfile.read(length).decode('utf-8', 'replace')[:300]}", flush=True)
            self.send_response(200)
            self._cors()
            self.end_headers()
        else:
            self.send_response(404)
            self._cors()
            self.end_headers()

    def log_message(self, *args):  # keep the console clean
        pass


def wait_for(url, seconds):
    for _ in range(seconds * 2):
        try:
            urllib.request.urlopen(url, timeout=2)
            return True
        except Exception:
            time.sleep(0.5)
    return False


kill_port_holders(RECEIVER_PORT, APP_PORT)

server = ThreadingHTTPServer(("127.0.0.1", RECEIVER_PORT), Handler)
threading.Thread(target=server.serve_forever, daemon=True).start()
print(f"Receiver on :{RECEIVER_PORT}, assets -> {out_dir}")

app = subprocess.Popen(
    ["npx.cmd", "vite", "preview", "--port", str(APP_PORT), "--strictPort"],
    cwd=ROOT,
    stdout=subprocess.DEVNULL,
    stderr=subprocess.DEVNULL,
)

def kill_tree(proc):
    """Stop a process AND its children (Popen.terminate() on Windows only ends the top one, which
    left the node under `npx vite preview` running)."""
    if proc and proc.poll() is None:
        subprocess.run(["taskkill", "/F", "/T", "/PID", str(proc.pid)], capture_output=True)


def kill_render_edges(marker="gn-render-"):
    """Stop headless Edge processes started by render runs, matched by their throwaway profile dir.
    The msedge.exe we launch is only a stub that exits at once, so its browser/renderer/GPU
    processes are orphans no process-tree kill can reach - 100+ of them had piled up (2026-11-26)."""
    try:
        import psutil
    except ImportError:
        return
    for p in psutil.process_iter(["name", "cmdline"]):
        try:
            if (p.info["name"] or "").lower() == "msedge.exe" and marker in " ".join(p.info["cmdline"] or []):
                p.kill()
        except (psutil.NoSuchProcess, psutil.AccessDenied):
            pass


# Only one render can run at a time (fixed ports), so anything left from an earlier run is stale.
kill_render_edges()
for _old in glob.glob(os.path.join(tempfile.gettempdir(), "gn-render-*")):
    shutil.rmtree(_old, ignore_errors=True)


edge = None
profile_dir = None
try:
    if not wait_for(f"http://localhost:{APP_PORT}/render.html", 30):
        print("App server did not start.")
        sys.exit(1)

    # Unique debug port and profile per run — a shared profile/port makes a new Edge
    # hand the URL to any stuck previous instance and exit, hanging the render.
    profile_dir = os.path.join(tempfile.gettempdir(), f"gn-render-{uuid.uuid4().hex[:8]}")
    edge = subprocess.Popen(
        [
            EDGE,
            "--headless=new",
            "--disable-gpu",
            "--autoplay-policy=no-user-gesture-required",
            # A headless page counts as "in the background": Edge throttles its timers harder and harder,
            # so a narrated video's encode crawled from ~20s to never finishing (2026-11-26). Turn it off.
            "--disable-background-timer-throttling",
            "--disable-renderer-backgrounding",
            "--disable-backgrounding-occluded-windows",
            "--disable-features=IntensiveWakeUpThrottling,CalculateNativeWinOcclusion",
            f"--remote-debugging-port={free_port()}",
            f"--user-data-dir={profile_dir}",
            f"http://localhost:{APP_PORT}/render.html",
        ],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )

    print("Rendering...")
    if done_event.wait(TIMEOUT_SECONDS):
        print(f"Done: {results['rendered']} files rendered, {results['failed']} failures.")
    else:
        print("Timed out waiting for the renderer.")
finally:
    kill_tree(edge)
    if profile_dir:   # this run's browser processes + throwaway profile
        kill_render_edges(os.path.basename(profile_dir))
        time.sleep(1)  # let Edge release its files
        shutil.rmtree(profile_dir, ignore_errors=True)
    kill_tree(app)
    server.shutdown()

sys.exit(0 if done_event.is_set() and results["failed"] == 0 else 1)
