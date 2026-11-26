"""GreaterNews Deep Dive Studio — a LOCAL control panel (runs on your machine).

Start it:
    python scripts/deep_dive_studio.py
Then open http://localhost:5200 in your browser. The page is scripts/deep_dive_studio.html, styled by
the shared design system src/ui/gn-ui.css (inlined per request — edit either and just reload).
AI: Claude first (secrets.json anthropic.api_key, see claude_client.py), Groq as the fallback.
From there you can:
  - Find hot stories   (Serper headlines, ranked by Claude -> Groq fallback)
  - Research a topic  (claude CLI on the API key -> CLI login fallback; writes a cited brief + spec)
  - Review/edit the brief and the chapters/settings
  - Build the video   (ElevenLabs/Groq voice, captions, b-roll, ffmpeg)
  - Preview it inline
  - Queue + Schedule it to Facebook (2h out, reviewable there first)

It just drives the same scripts (deep_dive_build.py / deep_dive_publish.py / publish.py) — the
reliable local ffmpeg pipeline — behind a UI. Local only (binds 127.0.0.1).
"""

import json
import os
import re
import subprocess
import sys
import shutil
import threading
import urllib.parse
from concurrent.futures import ThreadPoolExecutor
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import requests

from claude_client import MODEL as CLAUDE_MODEL, ClaudeUnavailable, claude_json
from claude_client import api_key as claude_api_key

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DD = os.path.join(ROOT, "content", "deep-dive")
SPEC = os.path.join(DD, "spec.json")
PORT = 5200

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")


NO_WINDOW = getattr(subprocess, "CREATE_NO_WINDOW", 0)  # don't flash console windows on Windows
JOB_LOCK = threading.Lock()  # only one heavy job (build/research/schedule) at a time


def run(cmd):
    p = subprocess.run([sys.executable] + cmd, cwd=ROOT, capture_output=True, text=True,
                       stdin=subprocess.DEVNULL, creationflags=NO_WINDOW)
    return p.returncode, (p.stdout or "") + (p.stderr or "")


def _secrets():
    p = os.path.join(ROOT, "secrets.json")
    return json.load(open(p, encoding="utf-8")) if os.path.exists(p) else {}


# Buckets we scan for hot stories: (label, query, country-bias)
TREND_BUCKETS = [
    ("World", "breaking world news today", None),
    ("Ghana", "Ghana breaking news today", "gh"),
    ("Africa", "Africa top news today", None),
    ("Business", "global economy and markets news today", None),
    ("Energy", "oil gas and energy prices news today", None),
    ("Tech", "technology and AI news today", None),
    ("Sports", "major sports news today", None),
    ("Health", "global health and medical news today", None),
]


def serper_news(query, gl=None):
    key = _secrets().get("serper", {}).get("api_key")
    if not key:
        return []
    body = {"q": query, "num": 10}
    if gl:
        body["gl"] = gl
    r = requests.post("https://google.serper.dev/news",
                      headers={"X-API-KEY": key, "Content-Type": "application/json"},
                      json=body, timeout=20)
    r.raise_for_status()
    return r.json().get("news", [])


def trending_stories():
    """Scan the buckets (in parallel) and return a deduped list of current headlines."""
    def fetch(bucket):
        label, query, gl = bucket
        try:
            return label, serper_news(query, gl)
        except Exception:
            return label, []

    with ThreadPoolExecutor(max_workers=len(TREND_BUCKETS)) as ex:
        by_label = dict(ex.map(fetch, TREND_BUCKETS))

    out, seen = [], set()
    for label, query, gl in TREND_BUCKETS:
        for n in (by_label.get(label) or [])[:6]:
            title = (n.get("title") or "").strip()
            key = title.lower()[:60]
            if not title or key in seen:
                continue
            seen.add(key)
            out.append({"bucket": label, "title": title,
                        "source": n.get("source", ""), "date": n.get("date", ""),
                        "link": n.get("link", ""), "snippet": n.get("snippet", "")})
    return out


CURATE_SCHEMA = {
    "type": "object",
    "properties": {"picks": {"type": "array", "items": {
        "type": "object",
        "properties": {"index": {"type": "integer"}, "score": {"type": "integer"}, "angle": {"type": "string"},
                       "why_now": {"type": "string"}, "topic": {"type": "string"}},
        "required": ["index", "score", "angle", "why_now", "topic"]}}},
    "required": ["picks"],
}


def _picks_from(data, stories):
    picks = []
    for p in (data or {}).get("picks", []):
        i = p.get("index")
        if isinstance(i, int) and 0 <= i < len(stories):
            s = dict(stories[i])
            s.update(score=p.get("score"), angle=p.get("angle", ""), why_now=p.get("why_now", ""),
                     topic=p.get("topic") or stories[i]["title"])
            picks.append(s)
    return picks


def curate(stories, want=6):
    """Rank the headlines for explainers: Claude first (your API credit), Groq as the fallback.
    Returns (picks, engine_label)."""
    if not stories:
        return [], ""
    system, user = _curate_prompt(stories, want)
    try:
        return _picks_from(claude_json(system, user, CURATE_SCHEMA, max_tokens=8000, effort="low",
                                       timeout=60), stories), f"Claude ({CLAUDE_MODEL})"
    except ClaudeUnavailable as e:
        print(f"  curate: Claude unavailable ({e}); using Groq")
    return groq_curate(stories, want), "Groq (fallback)"


def _curate_prompt(stories, want):
    listing = "\n".join(
        f"{i}. [{s['bucket']}] {s['title']} - {s.get('source', '')}"
        for i, s in enumerate(stories))
    system = (
        "You are the commissioning editor for GreaterNews, a Ghana-first channel making 1-3 minute "
        "REFERENCED explainer videos. The audience is Ghanaian — and Ghanaians follow BOTH local news "
        "AND the world's biggest stories. Pick the headlines that make the strongest explainers for them, "
        "blending the two.\n"
        "SCORE 8-10 (top picks) — EITHER (a) a clear Ghana or Africa angle, OR (b) a genuinely MAJOR world "
        "story people everywhere are following: big wars and geopolitics, the global economy and markets, "
        "fuel and oil, pandemics and health emergencies, major elections, huge disasters, or world-changing "
        "technology. A world-shaking story does NOT need a Ghana link to score high.\n"
        "SCORE 5-7: solid but more niche or slower-moving stories.\n"
        "SCORE 1-3 (keep OUT of the picks): bare sports results/scores/transfers, celebrity and "
        "entertainment gossip, royal/lifestyle fluff, clickbait listicles, and minor local crime.\n"
        "Make sure the final picks BLEND the day's biggest WORLD stories with the strongest Ghana/Africa "
        "ones — do not let either crowd the other out.")
    user = (
        "Headlines:\n" + listing + "\n\nReturn JSON of the form "
        '{"picks":[{"index":<int from the list>,"score":<1-10>,'
        '"angle":"the Ghana/Africa link OR the global stake, in a few words",'
        '"why_now":"one short sentence on why it matters now",'
        '"topic":"a specific research query to brief this story"}]} '
        "with up to " + str(want) + " picks, best first, blending top WORLD stories and Ghana/Africa "
        "ones. If several headlines cover the SAME underlying story, include only the single strongest "
        "one (never list the same story twice). Include only stories worth a full explainer (score 5+); "
        "skip thin sports/celebrity items.")
    return system, user


def groq_curate(stories, want=6):
    """Fallback editorial triage on Groq's free Llama model (same prompt as Claude gets)."""
    g = _secrets().get("groq", {})
    key = g.get("api_key")
    if not key or not stories:
        return []
    model = g.get("llm_model", "llama-3.3-70b-versatile")
    system, user = _curate_prompt(stories, want)
    try:
        r = requests.post(
            "https://api.groq.com/openai/v1/chat/completions",
            headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"},
            json={"model": model, "temperature": 0.3,
                  "response_format": {"type": "json_object"},
                  "messages": [{"role": "system", "content": system},
                               {"role": "user", "content": user}]},
            timeout=45)
        r.raise_for_status()
        return _picks_from(json.loads(r.json()["choices"][0]["message"]["content"]), stories)
    except Exception:
        return []


PAGE_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "deep_dive_studio.html")
GN_UI_CSS = os.path.join(ROOT, "src", "ui", "gn-ui.css")   # the design system shared with the web app
LOGO = os.path.join(ROOT, "public", "logo.png")


def page_html():
    """The Studio page (scripts/deep_dive_studio.html) with the shared GN UI stylesheet inlined.
    Read on every request, so edits to either file show up on reload without restarting."""
    html = open(PAGE_FILE, encoding="utf-8").read()
    try:
        css = open(GN_UI_CSS, encoding="utf-8").read()
    except OSError:
        css = ""
    return html.replace("/*GN_UI*/", css, 1)


class H(BaseHTTPRequestHandler):
    def _send(self, code, body, ctype="application/json"):
        b = body if isinstance(body, bytes) else body.encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(b)))
        self.end_headers()
        self.wfile.write(b)

    def do_GET(self):
        path = urllib.parse.urlparse(self.path).path
        if path == "/":
            return self._send(200, page_html(), "text/html; charset=utf-8")
        if path == "/logo.png" and os.path.exists(LOGO):
            return self._send(200, open(LOGO, "rb").read(), "image/png")
        if path == "/spec":
            return self._send(200, open(SPEC, encoding="utf-8").read() if os.path.exists(SPEC) else "{}")
        if path == "/brief":
            spec = json.load(open(SPEC, encoding="utf-8")) if os.path.exists(SPEC) else {}
            md = os.path.join(DD, spec.get("brief") or f"{spec.get('slug','')}.md")
            if not os.path.exists(md):  # fall back to any brief in the folder
                mds = [f for f in os.listdir(DD) if f.endswith(".md")]
                md = os.path.join(DD, mds[0]) if mds else md
            return self._send(200, open(md, encoding="utf-8").read() if os.path.exists(md) else "(no brief yet — Research a topic)", "text/plain; charset=utf-8")
        if path == "/video":
            return self._serve_video()
        if path == "/cover":
            spec = json.load(open(SPEC, encoding="utf-8")) if os.path.exists(SPEC) else {}
            png = os.path.join(DD, f"{spec.get('slug', '')}_cover.png")
            if not os.path.exists(png):
                return self._send(404, "no cover")
            return self._send(200, open(png, "rb").read(), "image/png")
        if path == "/trending":
            try:
                return self._send(200, json.dumps({"stories": trending_stories()}))
            except Exception as e:
                return self._send(200, json.dumps({"stories": [], "error": str(e)}))
        if path == "/curate":
            try:
                stories = trending_stories()
                picks, engine = curate(stories)
                return self._send(200, json.dumps({"picks": picks, "all": stories, "engine": engine}))
            except Exception as e:
                return self._send(200, json.dumps({"picks": [], "all": [], "error": str(e)}))
        if path == "/status":
            s = _secrets()
            return self._send(200, json.dumps({
                "claude": bool(claude_api_key()), "claude_model": CLAUDE_MODEL,
                "groq": bool((s.get("groq") or {}).get("api_key")),
                "serper": bool((s.get("serper") or {}).get("api_key")),
                "pexels": bool((s.get("pexels") or {}).get("api_key")),
                "wikimedia": bool((s.get("wikimedia") or {}).get("contact")),
                "facebook": bool((s.get("facebook") or {}).get("page_token")),
                "busy": JOB_LOCK.locked()}))
        self._send(404, "{}")

    def _serve_video(self):
        spec = json.load(open(SPEC, encoding="utf-8"))
        vid = os.path.join(DD, f"{spec['slug']}_9x16.mp4")
        if not os.path.exists(vid):
            return self._send(404, "no video")
        size = os.path.getsize(vid)
        rng = self.headers.get("Range")
        with open(vid, "rb") as f:
            if rng and (m := re.match(r"bytes=(\d+)-(\d*)", rng)):
                start = int(m.group(1))
                end = int(m.group(2)) if m.group(2) else size - 1
                f.seek(start)
                data = f.read(end - start + 1)
                self.send_response(206)
                self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
                self.send_header("Accept-Ranges", "bytes")
                self.send_header("Content-Type", "video/mp4")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)
            else:
                self.send_response(200)
                self.send_header("Content-Type", "video/mp4")
                self.send_header("Content-Length", str(size))
                self.end_headers()
                self.wfile.write(f.read())

    def do_POST(self):
        path = urllib.parse.urlparse(self.path).path
        length = int(self.headers.get("Content-Length", "0"))
        body = self.rfile.read(length).decode("utf-8") if length else "{}"
        if path == "/spec":
            spec = json.loads(body)
            with open(SPEC, "w", encoding="utf-8", newline="\n") as h:
                json.dump(spec, h, indent=2, ensure_ascii=False)
            return self._send(200, json.dumps({"ok": True, "spec": spec}))
        if path in ("/build", "/schedule", "/post", "/research"):
            if not JOB_LOCK.acquire(blocking=False):
                return self._send(200, json.dumps(
                    {"ok": False, "log": "Another job (build/research/schedule) is already running — "
                                         "wait for it to finish."}))
            try:
                if path == "/build":
                    code, out = run([os.path.join("scripts", "deep_dive_build.py"), SPEC])
                    return self._send(200, json.dumps({"ok": code == 0, "log": out}))
                if path in ("/schedule", "/post"):
                    # /schedule: lands in Facebook's scheduled queue 2h out; /post: goes live now
                    # (like the daily image posts). Either way the cover card is the thumbnail.
                    slug = json.load(open(SPEC, encoding="utf-8"))["slug"]
                    c1, o1 = run([os.path.join("scripts", "deep_dive_publish.py"), SPEC])
                    when = ["--schedule", "+2h"] if path == "/schedule" else []
                    c2, o2 = run([os.path.join("scripts", "publish.py"), "--date", f"deepdive_{slug}", "--all"] + when)
                    ok = c1 == 0 and c2 == 0 and "FAILED" not in o2
                    return self._send(200, json.dumps({"ok": ok, "log": o1 + "\n" + o2}))
                req = json.loads(body)  # /research
                return self._research(req.get("topic", "").strip(), req.get("length", "auto"))
            finally:
                JOB_LOCK.release()
        self._send(404, "{}")

    def _research(self, topic, length="auto"):
        slug = re.sub(r"[^a-z0-9]+", "-", topic.lower()).strip("-")[:40] or "deep-dive"
        # Each chapter is ~10-12s of voice, so the chapter count sets the running time.
        short = ("5 to 7 chapters (about 60-90 seconds) that arc: hook, what/where, why it matters, why now, "
                 "the numbers, the local impact, what's next")
        long_ = ("9 to 13 chapters (about 2-3 minutes) for a big, multi-part story: hook, background, the "
                 "key moments in order, who the players are, the numbers, reactions, the Ghana/Africa "
                 "impact, what's next")
        length_rule = {
            "short": f"Write {short}.",
            "long": f"Write {long_}. Only include facts your sources support - never pad to fill time.",
        }.get(length, f"Choose the length the story deserves: {short} for a single development; or {long_} "
                      f"when the story has several stages and enough verified facts to fill it. Never pad.")
        prompt = (
            f"You are the GreaterNews deep-dive researcher. Research this story for a Ghana-first news "
            f"channel: \"{topic}\". Web-search and verify with 2+ independent current sources. "
            f"Write TWO files. (1) content/deep-dive/{slug}.md: a cited brief — one-line summary, a Ghana/"
            f"Africa angle if relevant, timeline, key facts (each with a source), the numbers, what's next, "
            f"and a numbered References list with URLs. (2) content/deep-dive/spec.json with EXACTLY this shape: "
            f'{{"slug":"{slug}","captions":"highlight","music":"generated","voice":"groq","groq_voice":"hannah",'
            f'"cover":{{"headline":"6-9 word Title Case card headline","highlight":"2-4 words of it to colour gold",'
            f'"subline":"one short sentence of context, under 16 words",'
            f'"query":"a concrete image search for the cover photo naming the real subject"}},'
            f'"post":{{"caption":"a punchy 1-2 sentence hook","body":"2-3 lines of the key facts",'
            f'"sources":[{{"name":"Outlet (what it backs)","url":"https://real-url-from-your-research"}}],'
            f'"cta":"Follow GreaterNews - news you can trust.","hashtags":["#GreaterNews","#Ghana","#Explainer"]}},'
            f'"chapters":[{{"say":"one spoken sentence ~18-26 words, facts only","visual":{{"type":"broll, still or clip",'
            f'"query":"a concrete Pexels/Google image subject"}}}}]}}. {length_rule} '
            f"Keep every 'say' to ONE sentence of at most 26 words (the voice engine takes short lines). "
            f"Facts only from your sources. "
            f"Write numbers and dates in 'say' as WORDS (e.g. 'one-nil', 'June twenty-fourth') so the voice reads "
            f"them right; captions turn them into digits. 'still' queries are Google image searches that name the "
            f"real subject; 'broll' queries are generic Pexels stock-VIDEO searches that must literally show what "
            f"is said (never name a person or place in a broll query; use a still for anything specific). "
            f"'clip' = REAL news footage of the event, used only when a free-to-reuse copy exists (public-domain "
            f"U.S. government video such as DVIDS military footage, VOA or the White House, or CC-licensed video "
            f"on Wikimedia Commons); otherwise the build shows a photo for that query. Use 'clip' for 1-3 "
            f"chapters about a concrete, filmed moment (strikes, disasters and rescues, summits, a head of "
            f"state's speech), with a query worded like a news-archive title that names the subject, e.g. "
            f"'U.S. forces strikes Iran' or 'Mahama speech Accra'. Never use broadcaster clips (TV news, "
            f"YouTube news channels). "
            f"The final chapter's spoken 'say' MUST end with the exact sign-off: Follow GreaterNews, news you can trust."
        )
        # Run the claude CLI (web search + file writing) on the GreaterNews API key first, so research
        # spends that Claude credit; if that fails (no key, credit used up), use the CLI's own login.
        base_env = {k: v for k, v in os.environ.items() if k != "ANTHROPIC_API_KEY"}
        attempts = []
        key = claude_api_key()
        if key:
            attempts.append((f"Claude API credit ({CLAUDE_MODEL})", dict(base_env, ANTHROPIC_API_KEY=key),
                             ["--model", CLAUDE_MODEL]))
        attempts.append(("Claude Code login (fallback)", base_env, []))
        log = ""
        for label, env, extra in attempts:
            try:
                p = subprocess.run(
                    ["claude", "-p", prompt,
                     "--permission-mode", "bypassPermissions",
                     "--output-format", "text",
                     "--allowedTools", "Read,Write,WebSearch,WebFetch,Glob,Grep"] + extra,
                    cwd=ROOT, capture_output=True, text=True, timeout=900, env=env,
                    stdin=subprocess.DEVNULL, creationflags=NO_WINDOW)
            except Exception as e:
                log += f"[{label}] failed to run: {e}\n"
                continue
            ok = p.returncode == 0 and os.path.exists(SPEC)
            if ok:  # confirm the spec is really for THIS topic (not a stale leftover), then preserve it
                try:
                    written = json.load(open(SPEC, encoding="utf-8"))
                    ok = written.get("slug") == slug and bool(written.get("chapters"))
                    if ok:
                        os.makedirs(os.path.join(DD, "specs"), exist_ok=True)
                        shutil.copy(SPEC, os.path.join(DD, "specs", f"{slug}.json"))
                except Exception:
                    ok = False
            log += f"[{label}]\n" + (p.stdout or "")[-1200:] + (p.stderr or "")[-400:] + "\n"
            if ok:
                return self._send(200, json.dumps({"ok": True, "engine": label, "log": log}))
        return self._send(200, json.dumps({"ok": False, "log": log or "research failed"}))

    def log_message(self, *a):
        pass


if __name__ == "__main__":
    print(f"GreaterNews Deep Dive Studio -> http://localhost:{PORT}")
    ThreadingHTTPServer(("127.0.0.1", PORT), H).serve_forever()
