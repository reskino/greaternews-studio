"""Automatic Deep Dive: hottest story -> cited research -> video -> scheduled Facebook post.

Called by news_run.py on Mon/Wed/Fri mornings (or: python scripts/deep_dive_auto.py [--no-publish]).
  1. Rank today's headlines (Claude first, Groq fallback — deep_dive_studio.curate) and take the
     strongest one (score 7+) that isn't a story we've done a Deep Dive on in the last 3 weeks.
  2. Research it (cited brief + script; deep_dive_studio.run_research — Claude API credit first).
  3. Build the video (deep_dive_build.py) and run a quality gate: it must build, last 40-240s,
     have a cover card, and miss at most one chapter's visual. Fails the gate -> NOT posted.
  4. Schedule it on Facebook 2h30m out (after the daily posts' slots), cover card as thumbnail.
The editor gets the result in the run report and can delete it in Facebook before it goes live.
"""

import glob
import json
import os
import re
import shutil
import subprocess
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DD = os.path.join(ROOT, "content", "deep-dive")
SPEC = os.path.join(DD, "spec.json")
PY = sys.executable
NO_WINDOW = getattr(subprocess, "CREATE_NO_WINDOW", 0)
STOP = {"the", "and", "for", "with", "from", "after", "over", "into", "amid", "says", "said", "news", "new",
        "ghana", "africa", "world", "global", "impact", "update", "latest", "today", "how", "why", "what"}


def _words(text):
    return {w for w in re.findall(r"[a-z]{3,}", (text or "").lower()) if w not in STOP}


def recent_topics(days=21):
    """Word sets of Deep Dives made in the last `days` days (their specs + queued posts)."""
    cutoff = time.time() - days * 86400
    out = []
    for p in glob.glob(os.path.join(DD, "specs", "*.json")) + glob.glob(os.path.join(ROOT, "content", "queue_deepdive_*.json")):
        if os.path.getmtime(p) >= cutoff:
            out.append(_words(os.path.basename(p).replace("queue_deepdive_", "").replace("-", " ")))
    return out


def already_done(topic, recent):
    w = _words(topic)
    return any(w and len(w & r) / max(1, min(len(w), len(r))) >= 0.5 for r in recent)


def _run(cmd, timeout):
    p = subprocess.run(cmd, cwd=ROOT, capture_output=True, text=True, encoding="utf-8", errors="replace",
                       timeout=timeout, stdin=subprocess.DEVNULL, creationflags=NO_WINDOW)
    return p.returncode, (p.stdout or "") + (p.stderr or "")


def run(publish=True, log=print):
    from deep_dive_studio import curate, run_research, trending_stories

    stories = trending_stories()
    picks, engine = curate(stories)
    recent = recent_topics()
    pick = next((p for p in picks if (p.get("score") or 0) >= 7 and not already_done(p.get("topic") or p["title"], recent)), None)
    if not pick:
        return {"ok": False, "error": "no fresh story scored 7+ today — skipped (nothing posted)"}
    topic = pick.get("topic") or pick["title"]
    log(f"deep dive: picked '{topic}' (score {pick.get('score')}, ranked by {engine})")

    # Keep whatever the Studio had open: save the current spec under its slug before research replaces it.
    try:
        current = json.load(open(SPEC, encoding="utf-8"))
        if current.get("slug"):
            os.makedirs(os.path.join(DD, "specs"), exist_ok=True)
            keep = os.path.join(DD, "specs", f"{current['slug']}.json")
            if not os.path.exists(keep):
                shutil.copy(SPEC, keep)
    except (OSError, ValueError):
        pass

    res = run_research(topic, "auto")
    if not res.get("ok"):
        return {"ok": False, "error": f"research failed for '{topic}'", "topic": topic}
    slug = res["slug"]
    log(f"deep dive: researched ({res.get('engine')}) -> {slug}")

    code, out = _run([PY, os.path.join(ROOT, "scripts", "deep_dive_build.py"), SPEC], timeout=2400)
    m = re.search(r"Done: .*\((\d+(?:\.\d+)?)s\)", out)
    duration = float(m.group(1)) if m else 0.0
    missing = out.count("NO ASSET")
    has_cover = os.path.exists(os.path.join(DD, f"{slug}_cover.png"))
    spec = json.load(open(SPEC, encoding="utf-8"))
    result = {"topic": topic, "slug": slug, "title": (spec.get("cover") or {}).get("headline") or topic,
              "duration": duration, "caption": (spec.get("post") or {}).get("caption", "")}
    gate = []
    if code != 0 or not m:
        gate.append("the video did not build")
    if m and not (40 <= duration <= 240):
        gate.append(f"length {duration:.0f}s is outside 40-240s")
    if missing > 1:
        gate.append(f"{missing} chapters have no picture")
    if not has_cover:
        gate.append("no cover card")
    if gate:
        return {**result, "ok": False, "error": "quality check failed (" + "; ".join(gate) + ") — NOT posted; open the Studio to fix"}

    if not publish:
        return {**result, "ok": True}
    _run([PY, os.path.join(ROOT, "scripts", "deep_dive_publish.py"), SPEC], timeout=120)
    code, out = _run([PY, os.path.join(ROOT, "scripts", "publish.py"), "--date", f"deepdive_{slug}", "--all",
                      "--schedule", "+150m"], timeout=1200)
    try:
        item = json.load(open(os.path.join(ROOT, "content", f"queue_deepdive_{slug}.json"), encoding="utf-8"))["items"][0]
    except (OSError, ValueError, KeyError, IndexError):
        item = {}
    if item.get("status") not in ("scheduled", "posted"):
        return {**result, "ok": False, "error": "built fine but scheduling on Facebook failed: " + out.strip()[-200:]}
    return {**result, "ok": True, "scheduledFor": item.get("scheduledFor"), "postId": item.get("postId")}


if __name__ == "__main__":
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    print(json.dumps(run(publish="--no-publish" not in sys.argv), indent=2, ensure_ascii=False))
