"""GreaterNews auto-render: turns content/<date>/cards.json into finished PNGs and videos.

Starts a local file receiver, serves the built app, drives it in headless Edge,
and collects the rendered assets into content/<date>/assets/.

Usage: python scripts/render_assets.py [YYYY-MM-DD]
"""

import json
import os
import subprocess
import sys
import threading
import time
import urllib.parse
import urllib.request
from datetime import date
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
EDGE = r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
RECEIVER_PORT = 5198
APP_PORT = 4179
TIMEOUT_SECONDS = 600

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


server = ThreadingHTTPServer(("127.0.0.1", RECEIVER_PORT), Handler)
threading.Thread(target=server.serve_forever, daemon=True).start()
print(f"Receiver on :{RECEIVER_PORT}, assets -> {out_dir}")

app = subprocess.Popen(
    ["npx.cmd", "vite", "preview", "--port", str(APP_PORT), "--strictPort"],
    cwd=ROOT,
    stdout=subprocess.DEVNULL,
    stderr=subprocess.DEVNULL,
)

edge = None
try:
    if not wait_for(f"http://localhost:{APP_PORT}/render.html", 30):
        print("App server did not start.")
        sys.exit(1)

    edge = subprocess.Popen(
        [
            EDGE,
            "--headless=new",
            "--disable-gpu",
            "--autoplay-policy=no-user-gesture-required",
            "--remote-debugging-port=9224",
            f"--user-data-dir={os.path.join(os.environ.get('TEMP', '.'), 'gn-render-profile')}",
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
    if edge:
        edge.terminate()
    app.terminate()
    server.shutdown()

sys.exit(0 if done_event.is_set() and results["failed"] == 0 else 1)
