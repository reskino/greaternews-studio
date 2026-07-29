"""Queue an assembled Deep Dive for scheduling on Facebook (reviewed by a human first).

Usage:
  python scripts/deep_dive_publish.py [content/deep-dive/spec.json]

Reads the spec (for slug + the "post" caption/sources), checks the rendered video exists, and writes
content/queue_deepdive_<slug>.json with a Facebook VIDEO item (caption + sources in the text). Then:

  1) Review the video: content/deep-dive/<slug>_9x16.mp4
  2) Schedule it (2h out, reviewable/deletable in Facebook before it goes live):
       python scripts/publish.py --date deepdive_<slug> --all --schedule +2h

Nothing posts here — this only prepares the queue.
"""

import json
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")


def main(spec_path):
    spec = json.load(open(spec_path, encoding="utf-8"))
    slug = spec["slug"]
    video_rel = f"deep-dive/{slug}_9x16.mp4"
    if not os.path.exists(os.path.join(ROOT, "content", video_rel)):
        print(f"No rendered video at content/{video_rel} — run deep_dive_build.py first.")
        sys.exit(1)

    post = spec.get("post", {})
    caption = (post.get("caption") or "").strip()
    sources = post.get("sources") or []
    parts = [caption]
    if sources:
        parts.append("Sources: " + " · ".join(sources))
    parts.append("#GreaterNews #Ghana #Explainer")
    text = "\n\n".join(p for p in parts if p)

    queue = {"date": f"deepdive_{slug}", "items": [
        {"platform": "facebook", "status": "pending", "video": video_rel, "text": text}
    ]}
    out = os.path.join(ROOT, "content", f"queue_deepdive_{slug}.json")
    with open(out, "w", encoding="utf-8", newline="\n") as handle:
        json.dump(queue, handle, indent=2, ensure_ascii=False)

    print(f"Queued -> {out}")
    print(f"\nPost text:\n{text}\n")
    print("Next:")
    print(f"  1) Review: content/{video_rel}")
    print(f"  2) Schedule (2h out, review in Facebook first):")
    print(f"     python scripts/publish.py --date deepdive_{slug} --all --schedule +2h")


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else os.path.join(ROOT, "content", "deep-dive", "spec.json"))
