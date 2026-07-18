"""GreaterNews auto-publisher.

Reads content/queue_<date>.json and posts approved items to Facebook (Graph API)
and X (API v2 + v1.1 media). Credentials live in C:\\GreaterNews\\secrets.json
(git-ignored) — see PUBLISHING_SETUP.md for how to create them.

Usage:
  python scripts/publish.py --dry-run          preview everything without posting
  python scripts/publish.py --next             post the single next pending item
  python scripts/publish.py --all              post every pending item now
  python scripts/publish.py --date 2026-07-06  target a specific day's queue

Scheduling (Facebook only): give a queue item a "scheduleAt" field and --all/--next will
schedule it with Facebook instead of posting immediately. "scheduleAt" accepts an ISO time
in Ghana/UTC ("2026-07-18T17:00:00") or an offset from now ("+3h", "+90m", "+2d").
Facebook requires the time to be 10 minutes to 75 days in the future.
"""

import argparse
import base64
import hashlib
import hmac
import json
import os
import secrets as pysecrets
import sys
import time
import urllib.parse
from datetime import date

import requests

# Windows consoles default to cp1252, which can't print the emoji in post text.
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SECRETS_PATH = os.path.join(ROOT, "secrets.json")
GRAPH = "https://graph.facebook.com/v21.0"


def load_secrets():
    if not os.path.exists(SECRETS_PATH):
        return None
    with open(SECRETS_PATH, encoding="utf-8") as handle:
        return json.load(handle)


def load_queue(run_date):
    path = os.path.join(ROOT, "content", f"queue_{run_date}.json")
    if not os.path.exists(path):
        print(f"No queue at {path} — nothing to publish.")
        sys.exit(0)
    with open(path, encoding="utf-8") as handle:
        return path, json.load(handle)


def save_queue(path, queue):
    with open(path, "w", encoding="utf-8", newline="\n") as handle:
        json.dump(queue, handle, indent=2, ensure_ascii=False)


def log_to_posted_log(item, run_date):
    """Append the published headline to posted_log.md so the morning run's no-repeat check sees it."""
    path = os.path.join(ROOT, "posted_log.md")
    headline = item["text"].split("\n")[0][:120]
    line = f"- {run_date} - [{item['platform']}] {headline}\n"
    try:
        existing = open(path, encoding="utf-8").read() if os.path.exists(path) else "# posted_log\n\n"
        if "No stories logged yet" in existing:
            existing = "# posted_log\n\n"
        with open(path, "w", encoding="utf-8", newline="\n") as handle:
            handle.write(existing.rstrip("\n") + "\n" + line)
    except Exception as error:
        print(f"  (posted_log.md update failed: {error})")


# ---------- scheduling ----------

def resolve_schedule(value):
    """Validate a scheduleAt value and return a future Unix timestamp.

    Accepts an ISO datetime (treated as Ghana/UTC, e.g. "2026-07-18T17:00:00")
    or an offset from now ("+3h", "+90m", "+2d"). Raises ValueError if the time
    is outside Facebook's allowed window (10 minutes to 75 days ahead).
    """
    from datetime import datetime, timezone

    now = time.time()
    text = str(value).strip()

    if text.startswith("+"):
        unit = text[-1].lower()
        mult = {"m": 60, "h": 3600, "d": 86400}.get(unit)
        if mult is None:
            raise ValueError(f"bad offset '{value}' (use +90m, +3h, +2d)")
        ts = int(now + float(text[1:-1]) * mult)
    else:
        dt = datetime.fromisoformat(text)
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        ts = int(dt.timestamp())

    if ts < now + 600:
        raise ValueError("scheduled time must be at least 10 minutes ahead")
    if ts > now + 75 * 86400:
        raise ValueError("scheduled time must be within 75 days")
    return ts


# ---------- Facebook ----------

def publish_facebook(item, creds, scheduled_ts=None):
    page_id = creds["page_id"]
    token = creds["page_token"]
    image = item.get("image")

    data = {"message": item["text"], "access_token": token}
    # A scheduled post is created unpublished with a future publish time; Facebook
    # then publishes it server-side, so this machine need not be running at that time.
    if scheduled_ts:
        data["published"] = "false"
        data["scheduled_publish_time"] = str(scheduled_ts)

    if image:
        image_path = os.path.join(ROOT, "content", image)
        if not os.path.exists(image_path):
            raise FileNotFoundError(f"image not found: {image_path}")
        with open(image_path, "rb") as handle:
            response = requests.post(
                f"{GRAPH}/{page_id}/photos",
                data=data,
                files={"source": handle},
                timeout=60,
            )
    else:
        response = requests.post(
            f"{GRAPH}/{page_id}/feed",
            data=data,
            timeout=60,
        )

    response.raise_for_status()
    result = response.json()
    return result.get("post_id") or result.get("id", "")


# ---------- X (OAuth 1.0a signing) ----------

def oauth1_header(method, url, creds, extra_params=None):
    oauth = {
        "oauth_consumer_key": creds["api_key"],
        "oauth_nonce": pysecrets.token_hex(16),
        "oauth_signature_method": "HMAC-SHA1",
        "oauth_timestamp": str(int(time.time())),
        "oauth_token": creds["access_token"],
        "oauth_version": "1.0",
    }
    params = {**oauth, **(extra_params or {})}
    encoded = "&".join(
        f"{urllib.parse.quote(key, safe='')}={urllib.parse.quote(str(value), safe='')}"
        for key, value in sorted(params.items())
    )
    base = "&".join([method.upper(), urllib.parse.quote(url, safe=""), urllib.parse.quote(encoded, safe="")])
    signing_key = f"{urllib.parse.quote(creds['api_secret'], safe='')}&{urllib.parse.quote(creds['access_secret'], safe='')}"
    signature = base64.b64encode(hmac.new(signing_key.encode(), base.encode(), hashlib.sha1).digest()).decode()
    oauth["oauth_signature"] = signature
    header = ", ".join(f'{key}="{urllib.parse.quote(str(value), safe="")}"' for key, value in sorted(oauth.items()))
    return f"OAuth {header}"


def publish_x(item, creds):
    media_ids = []
    image = item.get("image")

    if image:
        image_path = os.path.join(ROOT, "content", image)
        if not os.path.exists(image_path):
            raise FileNotFoundError(f"image not found: {image_path}")
        upload_url = "https://upload.twitter.com/1.1/media/upload.json"
        with open(image_path, "rb") as handle:
            response = requests.post(
                upload_url,
                headers={"Authorization": oauth1_header("POST", upload_url, creds)},
                files={"media": handle},
                timeout=120,
            )
        response.raise_for_status()
        media_ids.append(response.json()["media_id_string"])

    tweet_url = "https://api.x.com/2/tweets"
    payload = {"text": item["text"]}
    if media_ids:
        payload["media"] = {"media_ids": media_ids}

    response = requests.post(
        tweet_url,
        headers={"Authorization": oauth1_header("POST", tweet_url, creds), "Content-Type": "application/json"},
        json=payload,
        timeout=60,
    )
    response.raise_for_status()
    return response.json().get("data", {}).get("id", "")


# ---------- main ----------

def check_credentials(creds):
    """Read-only validation of both platforms — never posts anything."""
    ok = True

    fb = creds.get("facebook", {})
    if fb.get("page_id") and fb.get("page_token"):
        try:
            response = requests.get(
                f"{GRAPH}/{fb['page_id']}",
                params={"fields": "name,followers_count", "access_token": fb["page_token"]},
                timeout=30,
            )
            response.raise_for_status()
            data = response.json()
            print(f"  Facebook OK — page: {data.get('name')} ({data.get('followers_count', '?')} followers)")
        except Exception as error:
            ok = False
            print(f"  Facebook FAILED: {error}")
    else:
        ok = False
        print("  Facebook: page_id/page_token missing from secrets.json")

    x = creds.get("x", {})
    if all(x.get(key) for key in ("api_key", "api_secret", "access_token", "access_secret")):
        try:
            url = "https://api.x.com/2/users/me"
            response = requests.get(url, headers={"Authorization": oauth1_header("GET", url, x)}, timeout=30)
            response.raise_for_status()
            data = response.json().get("data", {})
            print(f"  X OK — account: @{data.get('username')} ({data.get('name')})")
        except Exception as error:
            ok = False
            print(f"  X FAILED: {error}")
    else:
        ok = False
        print("  X: one or more keys missing from secrets.json")

    return ok


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--date", default=date.today().isoformat())
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--check", action="store_true", help="validate credentials read-only, post nothing")
    parser.add_argument("--next", action="store_true", help="post only the next pending item")
    parser.add_argument("--all", action="store_true", help="post every pending item")
    args = parser.parse_args()

    if args.check:
        creds = load_secrets()
        if creds is None:
            print("No secrets.json found at C:\\GreaterNews\\secrets.json — see PUBLISHING_SETUP.md")
            sys.exit(1)
        print("Checking credentials (read-only)...")
        sys.exit(0 if check_credentials(creds) else 1)

    queue_path, queue = load_queue(args.date)
    pending = [item for item in queue.get("items", []) if item.get("status", "pending") == "pending"]

    if not pending:
        print("Queue is empty — everything already posted.")
        return

    creds = load_secrets()
    if args.dry_run or creds is None:
        if creds is None and not args.dry_run:
            print("No secrets.json found — running as dry-run. See PUBLISHING_SETUP.md to go live.\n")
        for item in pending:
            when = f" @ {item['scheduleAt']}" if item.get("scheduleAt") else ""
            print(f"[would post to {item['platform']}{when}] {item.get('image') or '(no image)'}")
            print(f"  {item['text'][:160]}{'…' if len(item['text']) > 160 else ''}\n")
        print(f"{len(pending)} item(s) pending.")
        return

    def platform_configured(platform):
        if platform == "facebook":
            fb = creds.get("facebook", {})
            return bool(fb.get("page_id") and fb.get("page_token"))
        if platform == "x":
            x = creds.get("x", {})
            return all(x.get(key) for key in ("api_key", "api_secret", "access_token", "access_secret"))
        return False

    # Only attempt platforms with stored credentials — an unconfigured platform's items
    # stay pending (ready for when its keys arrive) without blocking the others.
    postable = [item for item in pending if platform_configured(item["platform"])]
    skipped = len(pending) - len(postable)
    if skipped:
        print(f"({skipped} item(s) for unconfigured platforms left pending)")
    if not postable:
        print("No pending items for configured platforms.")
        return

    to_post = postable[:1] if args.next else postable if args.all else postable[:1]
    posted = 0
    scheduled = 0

    for item in to_post:
        platform = item["platform"]
        scheduled_ts = None
        try:
            if item.get("scheduleAt"):
                scheduled_ts = resolve_schedule(item["scheduleAt"])
            if platform == "facebook":
                post_id = publish_facebook(item, creds["facebook"], scheduled_ts)
            elif platform == "x":
                if scheduled_ts:
                    raise RuntimeError("X scheduling is not supported")
                post_id = publish_x(item, creds["x"])
            else:
                print(f"Unknown platform '{platform}' — skipped.")
                continue
            item["postId"] = post_id
            if scheduled_ts:
                item["status"] = "scheduled"
                item["scheduledFor"] = item["scheduleAt"]
                scheduled += 1
                print(f"SCHEDULED on {platform} for {item['scheduleAt']}: {post_id} — {item['text'][:50]}…")
            else:
                item["status"] = "posted"
                item["postedAt"] = time.strftime("%Y-%m-%dT%H:%M:%S")
                posted += 1
                print(f"POSTED to {platform}: {post_id} — {item['text'][:60]}…")
            log_to_posted_log(item, args.date)
        except Exception as error:  # keep the queue moving; failures stay pending
            item["status"] = "pending"
            item["lastError"] = str(error)[:300]
            print(f"FAILED on {platform}: {error}")

    save_queue(queue_path, queue)
    remaining = len([item for item in queue.get("items", []) if item.get("status", "pending") == "pending"])
    print(f"Done: {posted} posted, {scheduled} scheduled, {remaining} still pending.")


if __name__ == "__main__":
    main()
