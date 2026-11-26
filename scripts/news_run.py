"""GreaterNews automatic news run — hot news in, scheduled Facebook posts out, a report to the editor.

  python scripts/news_run.py --slot morning     (Task Scheduler, ~06:00 — via morning-run.cmd)
  python scripts/news_run.py --slot evening     (Task Scheduler, ~17:00 — via evening-run.cmd)
  options: --deep-dive yes|no|auto (auto = Mon/Wed/Fri mornings), --no-publish (everything except posting)

Steps: build the app -> Claude researches + writes the day's pack/cards/queue (API credit first, CLI
login as fallback) -> render cards + videos (news clips when free footage exists) -> schedule the
Facebook posts to go live 2h out, 45 min apart (editable/deletable in Facebook until then) ->
optional automatic Deep Dive -> report on Telegram / email / PC pop-up (scripts/notify.py),
including failures, so a silent dead run (like 2026-11-26's "Not logged in") can't happen again.
Run label: the date for the morning run, "<date>-pm" for the evening run (separate files).
"""

import argparse
import glob
import json
import os
import socket
import subprocess
import sys
import time
import traceback
from datetime import date, datetime, timedelta, timezone

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from claude_client import ClaudeUnavailable, claude_research, last_json_block, run_claude_cli  # noqa: E402
from notify import notify  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CONTENT = os.path.join(ROOT, "content")
LOG = os.path.join(CONTENT, "news-run.log")
PY = sys.executable
NO_WINDOW = getattr(subprocess, "CREATE_NO_WINDOW", 0)
GHANA_TZ = timezone.utc  # Ghana is UTC+0 all year

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")


def log(msg):
    line = f"[{datetime.now().strftime('%Y-%m-%d %H:%M:%S')}] {msg}"
    print(line)
    with open(LOG, "a", encoding="utf-8") as h:
        h.write(line + "\n")


def run(cmd, timeout=1800, **kw):
    """Run a command, log its tail, return (returncode, output)."""
    try:
        p = subprocess.run(cmd, cwd=ROOT, capture_output=True, text=True, encoding="utf-8", errors="replace",
                           timeout=timeout, stdin=subprocess.DEVNULL, creationflags=NO_WINDOW, **kw)
        out = (p.stdout or "") + (p.stderr or "")
        code = p.returncode
    except subprocess.TimeoutExpired:
        out, code = f"timed out after {timeout}s", -1
    with open(LOG, "a", encoding="utf-8") as h:
        h.write(out[-4000:] + "\n")
    return code, out


SLOT_RULES = {
    "morning": ("MORNING RUN for {LABEL}. Cover today's top stories."),
    "evening": ("EVENING RUN for {LABEL}. This morning's pack is C:\\GreaterNews\\content\\greaternews_{TODAY}.md and "
                "its queue is C:\\GreaterNews\\content\\queue_{TODAY}.json (if they exist). Cover only stories that broke "
                "or moved on SINCE this morning — 2 to 4 of them, strongest first. Do not repeat a morning story unless "
                "there is a significant verified new development; then use the 'update' template with chip UPDATE. "
                "If nothing new clears the verification bar, write the files with an empty cards list and an empty "
                "items list rather than padding."),
}


def _read(path, limit=None):
    try:
        text = open(path, encoding="utf-8").read()
        return text[-limit:] if limit else text
    except OSError:
        return ""


def already_covered(label):
    """What the API run can't look up itself: the posting log + headlines of the latest packs."""
    parts = ["posted_log.md (most recent last):\n" + _read(os.path.join(ROOT, "posted_log.md"), 6000)]
    packs = sorted(glob.glob(os.path.join(CONTENT, "greaternews_*.md")), key=os.path.getmtime)[-4:]
    for p in packs:
        heads = [l.strip() for l in _read(p).splitlines() if l.startswith("## STORY")]
        if heads:
            parts.append(f"{os.path.basename(p)}:\n" + "\n".join(heads))
    return "\n\n".join(parts)


API_DELIVERY = (
    "\n\nDELIVERY (overrides any instruction above to read or write files): you cannot read or write files in "
    "this session. The files you were told to check are summarised below. When the research is done, return "
    "ONE JSON object in a single ```json fenced block, exactly: "
    "{\"pack_md\": \"<the full markdown pack you would have written to greaternews_{LABEL}.md>\", "
    "\"cards\": <the exact object for cards_{LABEL}.json>, \"queue\": <the exact object for queue_{LABEL}.json>}. "
    "Nothing after the block.\n\nALREADY COVERED — do not repeat these stories:\n{COVERED}")


def research(label, slot):
    """Claude API (hosted web search, the API credit) writes the pack/cards/queue; claude CLI login as fallback."""
    template = open(os.path.join(ROOT, "scripts", "news_run_prompt.md"), encoding="utf-8").read()
    rules = SLOT_RULES[slot].replace("{LABEL}", label).replace("{TODAY}", date.today().isoformat())
    prompt = template.replace("{SLOT_RULES}", rules).replace("{LABEL}", label)
    paths = {k: os.path.join(CONTENT, f"{k}_{label}.json") for k in ("cards", "queue")}
    pack_path = os.path.join(CONTENT, f"greaternews_{label}.md")
    out = ""
    try:
        system = _read(os.path.join(ROOT, "GreaterNews_Master_Prompt.md"))
        user = prompt + API_DELIVERY.replace("{LABEL}", label).replace("{COVERED}", already_covered(label))
        text, usage = claude_research(system, user, max_tokens=64000, effort="high", timeout=2400)
        data = last_json_block(text)
        cards, queue = data.get("cards") or {}, data.get("queue") or {}
        if not isinstance(cards.get("cards"), list) or not isinstance(queue.get("items"), list) or not data.get("pack_md"):
            raise ClaudeUnavailable("reply was missing the pack, cards or queue")
        cards["date"], queue["date"] = label, label
        with open(pack_path, "w", encoding="utf-8", newline="\n") as h:
            h.write(data["pack_md"].rstrip() + "\n")
        for key, obj in (("cards", cards), ("queue", queue)):
            with open(paths[key], "w", encoding="utf-8", newline="\n") as h:
                json.dump(obj, h, indent=2, ensure_ascii=False)
        return True, f"Claude API ({usage})", "researched via the API"
    except (ClaudeUnavailable, ValueError) as e:
        out = f"[Claude API] {e}\n"
        log(f"API research failed ({e}) — trying the claude CLI login")

    started = time.time()

    def check():  # the CLI run must have written THIS run's files
        return all(os.path.exists(p) and os.path.getmtime(p) >= started - 5 for p in paths.values())

    ok, engine, cli_out = run_claude_cli(prompt, check=check, allowed_tools="Read,Write,Glob,Grep,WebSearch,WebFetch",
                                         bypass_permissions=False, timeout=2400)
    out += cli_out
    with open(LOG, "a", encoding="utf-8") as h:
        h.write(out[-6000:] + "\n")
    return ok, engine, out


def port_open(port):
    with socket.socket() as s:
        s.settimeout(0.5)
        return s.connect_ex(("127.0.0.1", port)) == 0


def render(label):
    resolver = None
    if not port_open(5199):  # local resolver = voiceover (TTS) + Claude script drafting for the renderer
        resolver = subprocess.Popen([PY, os.path.join(ROOT, "scripts", "resolver.py")], cwd=ROOT,
                                    stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, creationflags=NO_WINDOW)
        for _ in range(40):
            if port_open(5199):
                break
            time.sleep(0.5)
    try:
        return run([PY, os.path.join(ROOT, "scripts", "render_assets.py"), label], timeout=1800)
    finally:
        if resolver:
            subprocess.run(["taskkill", "/F", "/T", "/PID", str(resolver.pid)], capture_output=True)


def queue_items(label):
    p = os.path.join(CONTENT, f"queue_{label}.json")
    try:
        return json.load(open(p, encoding="utf-8")).get("items", [])
    except (OSError, ValueError):
        return []


def fallback_to_images(label, notes):
    """A story whose video didn't render still gets posted — as its card image — instead of failing."""
    p = os.path.join(CONTENT, f"queue_{label}.json")
    try:
        queue = json.load(open(p, encoding="utf-8"))
    except (OSError, ValueError):
        return
    changed = False
    for it in queue.get("items", []):
        vid = it.get("video")
        if it.get("status", "pending") == "pending" and vid and not os.path.exists(os.path.join(CONTENT, vid)):
            img = it.get("image")
            if img and os.path.exists(os.path.join(CONTENT, img)):
                it["video"] = None
                changed = True
                notes.append(f"Video missing for '{headline_of(it)[:60]}' — posting its card image instead.")
    if changed:
        with open(p, "w", encoding="utf-8", newline="\n") as h:
            json.dump(queue, h, indent=2, ensure_ascii=False)


def fb_link(post_id):
    return f"https://www.facebook.com/{post_id}" if post_id else ""


def when_local(iso):
    try:
        return datetime.fromisoformat(iso).astimezone(GHANA_TZ).strftime("%H:%M")
    except (TypeError, ValueError):
        return "?"


def headline_of(item):
    first = (item.get("text") or "").strip().splitlines()
    return (first[0] if first else "")[:110]


def report_posts(items):
    lines = []
    for it in items:
        if it.get("platform") != "facebook":
            continue
        st = it.get("status", "pending")
        kind = "video" if it.get("video") else "card"
        if st == "scheduled":
            lines.append(f"• {when_local(it.get('scheduledFor'))} GMT ({kind}) {headline_of(it)}")
        elif st == "posted":
            lines.append(f"• LIVE ({kind}) {headline_of(it)}  {fb_link(it.get('postId'))}")
        else:
            lines.append(f"• NOT POSTED ({st}) {headline_of(it)}")
    return lines


# ---- surviving shutdowns, restarts, sleep and power cuts ---------------------------------------
# Task Scheduler starts a missed run as soon as the PC is back (and at logon), retries failures, and
# wakes the PC from sleep. These guards make that safe: once per slot per day, never two at once,
# never too late to be useful, and a run cut off half-way RESUMES instead of researching/posting again.
RUNS = os.path.join(CONTENT, ".runs")
SLOTS = {  # scheduled start, and the latest time a catch-up still makes sense
    "morning": {"from": (5, 0), "at": (6, 3), "until": (15, 0)},   # after 15:00 the evening run covers the day
    "evening": {"from": (16, 30), "at": (17, 0), "until": (23, 0)},  # a 07:00 logon must not run it early
}


def done_marker(label):
    return os.path.join(RUNS, f"{label}.done.json")


def acquire_lock():
    """One run at a time (a catch-up morning run can overlap the evening run). Stale locks are taken over."""
    os.makedirs(RUNS, exist_ok=True)
    path = os.path.join(RUNS, "news_run.lock")
    try:
        pid = int(open(path).read().strip() or 0)
        import psutil
        if pid and pid != os.getpid() and psutil.pid_exists(pid) and "python" in psutil.Process(pid).name().lower():
            return None
    except (OSError, ValueError, ImportError):
        pass
    except Exception:
        pass
    with open(path, "w") as h:
        h.write(str(os.getpid()))
    return path


def keep_awake(on=True):
    """Stop Windows sleeping while a run is working (it would freeze research/rendering mid-way)."""
    if os.name == "nt":
        import ctypes
        ES_CONTINUOUS, ES_SYSTEM_REQUIRED = 0x80000000, 0x00000001
        ctypes.windll.kernel32.SetThreadExecutionState(ES_CONTINUOUS | (ES_SYSTEM_REQUIRED if on else 0))


def wait_for_internet(max_minutes=15):
    """Right after boot/wake the network can take a while — wait instead of failing the run."""
    deadline = time.time() + max_minutes * 60
    while True:
        try:
            socket.create_connection(("api.anthropic.com", 443), timeout=5).close()
            return True
        except OSError:
            if time.time() > deadline:
                return False
            time.sleep(15)


def media_ready(label):
    """True when every Facebook item's image/video already exists (a resumed run can skip rendering)."""
    items = [i for i in queue_items(label) if i.get("platform") == "facebook"]
    paths = [i.get("video") or i.get("image") for i in items]
    return bool(items) and all(p and os.path.exists(os.path.join(CONTENT, p)) for p in paths)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--slot", choices=["morning", "evening"], required=True)
    ap.add_argument("--deep-dive", choices=["auto", "yes", "no"], default="auto")
    ap.add_argument("--no-publish", action="store_true")
    ap.add_argument("--force", action="store_true", help="run even if this slot already ran or its window passed")
    a = ap.parse_args()

    today = date.today().isoformat()
    label = today if a.slot == "morning" else f"{today}-pm"
    now = datetime.now()
    slot = SLOTS[a.slot]
    if not a.force:
        if os.path.exists(done_marker(label)):
            print(f"{a.slot} run for {label} already done — nothing to do.")
            return 0
        if (now.hour, now.minute) < slot["from"]:
            print(f"Too early for the {a.slot} run ({now:%H:%M}) — its scheduled trigger will run it.")
            return 0
        if (now.hour, now.minute) > slot["until"]:
            log(f"{a.slot} run for {label} skipped: it's {now:%H:%M}, past {slot['until'][0]:02d}:{slot['until'][1]:02d} "
                f"(the PC was off/asleep at the scheduled time).")
            return 0
    lock = acquire_lock()
    if not lock:
        print("Another news run is in progress — leaving it to finish.")
        return 0
    keep_awake(True)
    problems, notes = [], []
    log(f"===== news run ({a.slot}, {label}) started =====")
    scheduled = now.replace(hour=slot["at"][0], minute=slot["at"][1], second=0, microsecond=0)
    if now > scheduled + timedelta(minutes=30):
        notes.append(f"Started late at {now:%H:%M} (the PC was off or asleep at {scheduled:%H:%M}) — posts are scheduled from now.")
    if not wait_for_internet():
        problems.append("No internet for 15 minutes after start — will retry.")
        return finish(a, label, [], problems, notes, None, mark_done=False)

    code, out = run(["cmd", "/c", "npm", "run", "build"], timeout=600)
    if code != 0:
        problems.append("App build failed — rendered with the previous build.")

    have_pack = all(os.path.exists(os.path.join(CONTENT, f"{k}_{label}.json")) for k in ("cards", "queue"))
    if have_pack:   # an earlier attempt researched this slot and was cut off — resume, don't redo/repost
        ok, engine, out = True, "resumed (already researched)", ""
        notes.append("Resumed an interrupted run — kept its stories, no new research.")
    else:
        ok, engine, out = research(label, a.slot)
    if ok:
        notes.append(f"Research: {engine}")
    else:
        lines = [ln for ln in out.strip().splitlines() if ln.strip() and "Permission allow rule" not in ln]
        problems.append("Research failed — no new pack. " + " | ".join(lines[-4:])[:400])

    items = []
    if ok:
        try:
            cards = json.load(open(os.path.join(CONTENT, f"cards_{label}.json"), encoding="utf-8")).get("cards", [])
        except (OSError, ValueError):
            cards = []
        if cards and media_ready(label):
            notes.append("Cards/videos were already rendered.")
        elif cards:
            code, out = render(label)
            saved = out.count("  saved ")
            notes.append(f"Rendered {saved} file(s)")
            if code != 0:
                problems.append("Some cards/videos failed to render: " + " ".join(
                    ln for ln in out.splitlines() if "✗" in ln or "fail" in ln.lower())[:300])
        else:
            notes.append("No new stories cleared the verification bar.")
        fallback_to_images(label, notes)
        if queue_items(label) and not a.no_publish:
            code, out = run([PY, os.path.join(ROOT, "scripts", "publish.py"), "--date", label, "--all",
                             "--schedule", "+2h", "--stagger", "45m"], timeout=1200)
            if "FAILED" in out or code != 0:
                problems.append("Some posts failed to schedule: " + " ".join(
                    l for l in out.splitlines() if "FAILED" in l)[:300])
        items = queue_items(label)

    dd = None
    weekday = date.today().weekday()  # Mon=0 Wed=2 Fri=4
    dd_marker = os.path.join(RUNS, f"deepdive_{today}.done.json")
    want_dd = a.deep_dive == "yes" or (a.deep_dive == "auto" and a.slot == "morning" and weekday in (0, 2, 4))
    if want_dd and (a.force or not os.path.exists(dd_marker)):
        try:
            import deep_dive_auto
            dd = deep_dive_auto.run(publish=not a.no_publish, log=log)
            if dd.get("ok") or "no fresh story" in str(dd.get("error", "")):
                with open(dd_marker, "w", encoding="utf-8") as h:   # once per day, even after a catch-up
                    json.dump(dd, h, ensure_ascii=False, default=str)
            if not dd.get("ok"):
                problems.append(f"Deep Dive: {dd.get('error')}")
        except Exception as e:
            problems.append(f"Deep Dive crashed: {e}")
            log(traceback.format_exc())

    # The slot counts as done once its stories exist and posting was attempted — a later retry or
    # catch-up then won't research or post again. A failed research leaves it open for a retry.
    return finish(a, label, items, problems, notes, dd, mark_done=ok)


def finish(a, label, items, problems, notes, dd, mark_done):
    """Send the report, record the slot as done (when it is), release the lock, let the PC sleep."""
    try:
        posts = report_posts(items)
        queued = sum(1 for i in items if i.get("status") in ("scheduled", "posted") and i.get("platform") == "facebook")
        title = f"GreaterNews {a.slot} run — " + ("⚠️ needs attention" if problems else f"✅ {queued} post(s) queued")
        body = []
        if posts:
            body.append("Facebook (goes live at these times — edit or delete in Meta Business Suite before then):")
            body += posts
            body.append("Scheduled posts: https://business.facebook.com/latest/posts/scheduled_posts")
        if dd and dd.get("ok"):
            body.append("")
            body.append(f"Deep Dive: {dd.get('title')} ({dd.get('duration', 0):.0f}s) — "
                        + (f"goes live {when_local(dd.get('scheduledFor'))} GMT" if dd.get("scheduledFor") else "built, not posted"))
            if dd.get("caption"):
                body.append(f"  “{dd['caption'][:160]}”")
        if problems:
            body.append("")
            body.append("Problems:")
            body += [f"• {p}" for p in problems]
            if not mark_done:
                body.append("It will try again automatically (retry / next time the PC starts).")
        if notes:
            body.append("")
            body += notes
        body.append(f"\nLog: {LOG}")
        text = "\n".join(body)
        log(title + "\n" + text)
        sent = notify(title, text)
        log(f"report sent: {sent}")
        if mark_done:
            os.makedirs(RUNS, exist_ok=True)
            with open(done_marker(label), "w", encoding="utf-8") as h:
                json.dump({"finished": datetime.now().isoformat(timespec="seconds"), "problems": problems,
                           "queued": queued}, h, ensure_ascii=False)
        log(f"===== news run ({a.slot}) finished =====")
        return 1 if (problems and not mark_done) else 0
    finally:
        keep_awake(False)
        try:
            os.remove(os.path.join(RUNS, "news_run.lock"))
        except OSError:
            pass


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as exc:  # last resort: still tell the editor
        tb = traceback.format_exc()
        try:
            log(tb)
            notify("GreaterNews run CRASHED ⚠️", f"{exc}\n\n{tb[-1500:]}")
        finally:
            sys.exit(2)
