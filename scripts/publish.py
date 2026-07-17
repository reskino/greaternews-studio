"""GreaterNews auto-publisher.

Reads content/queue_<date>.json and posts approved items to Facebook (Graph API)
and X (API v2 + v1.1 media). Credentials live in C:\\GreaterNews\\secrets.json
(git-ignored) — see PUBLISHING_SETUP.md for how to create them.

Usage:
  python scripts/publish.py --dry-run          preview everything without posting
  python scripts/publish.py --next             post the single next pending item
  python scripts/publish.py --all              post every pending item now
  python scripts/publish.py --date 2026-07-06  target a specific day's queue
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


# ---------- Facebook ----------

def publish_facebook(item, creds):
    page_id = creds["page_id"]
    token = creds["page_token"]
    image = item.get("image")

    if image:
        image_path = os.path.join(ROOT, "content", image)
        if not os.path.exists(image_path):
            raise FileNotFoundError(f"image not found: {image_path}")
        with open(image_path, "rb") as handle:
            response = requests.post(
                f"{GRAPH}/{page_id}/photos",
                data={"message": item["text"], "access_token": token},
                files={"source": handle},
                timeout=60,
            )
    else:
        response = requests.post(
            f"{GRAPH}/{page_id}/feed",
            data={"message": item["text"], "access_token": token},
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
            print(f"[would post to {item['platform']}] {item.get('image') or '(no image)'}")
            print(f"  {item['text'][:160]}{'…' if len(item['text']) > 160 else ''}\n")
        print(f"{len(pending)} item(s) pending.")
        return

    to_post = pending[:1] if args.next else pending if args.all else pending[:1]
    posted = 0

    for item in to_post:
        platform = item["platform"]
        try:
            if platform == "facebook":
                post_id = publish_facebook(item, creds["facebook"])
            elif platform == "x":
                post_id = publish_x(item, creds["x"])
            else:
                print(f"Unknown platform '{platform}' — skipped.")
                continue
            item["status"] = "posted"
            item["postId"] = post_id
            item["postedAt"] = time.strftime("%Y-%m-%dT%H:%M:%S")
            posted += 1
            print(f"POSTED to {platform}: {post_id} — {item['text'][:60]}…")
        except Exception as error:  # keep the queue moving; failures stay pending
            item["status"] = "pending"
            item["lastError"] = str(error)[:300]
            print(f"FAILED on {platform}: {error}")

    save_queue(queue_path, queue)
    remaining = len([item for item in queue.get("items", []) if item.get("status", "pending") == "pending"])
    print(f"Done: {posted} posted, {remaining} still pending.")


if __name__ == "__main__":
    main()
