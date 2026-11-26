"""Tell the editor what the automatic runs did — Telegram, email, and a Windows pop-up.

Each channel is used only when configured in secrets.json (git-ignored):
  "telegram": {"bot_token": "123:ABC...", "chat_id": "123456789"}
  "email":    {"smtp_host": "smtp.mail.yahoo.com", "smtp_port": 465, "user": "...",
               "password": "<app password>", "to": "you@example.com"}
The Windows pop-up needs no setup (it shows when someone is signed in to this PC).

  python scripts/notify.py --test             send a test message on every configured channel
  python scripts/notify.py --setup-telegram   after you message your bot once, saves its chat_id
"""

import argparse
import html
import json
import os
import smtplib
import ssl
import subprocess
import sys
from email.message import EmailMessage

import requests

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SECRETS_PATH = os.path.join(ROOT, "secrets.json")
NO_WINDOW = getattr(subprocess, "CREATE_NO_WINDOW", 0)

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")


def _secrets():
    try:
        return json.load(open(SECRETS_PATH, encoding="utf-8"))
    except (OSError, ValueError):
        return {}


def send_telegram(title, body, conf):
    token, chat = (conf or {}).get("bot_token"), (conf or {}).get("chat_id")
    if not token or not chat:
        return None
    text = f"<b>{html.escape(title)}</b>\n\n{html.escape(body)}"
    if len(text) > 4000:
        text = text[:3990] + "\n…"
    r = requests.post(f"https://api.telegram.org/bot{token}/sendMessage", timeout=20,
                      json={"chat_id": chat, "text": text, "parse_mode": "HTML", "disable_web_page_preview": True})
    return r.ok or f"telegram {r.status_code}: {r.text[:120]}"


def send_email(title, body, conf):
    need = ("smtp_host", "user", "password", "to")
    if not conf or not all(conf.get(k) for k in need):
        return None
    msg = EmailMessage()
    msg["Subject"] = title
    msg["From"] = conf.get("from") or conf["user"]
    msg["To"] = conf["to"]
    msg.set_content(body)
    port = int(conf.get("smtp_port") or 465)
    try:
        if port == 465:
            with smtplib.SMTP_SSL(conf["smtp_host"], port, context=ssl.create_default_context(), timeout=30) as s:
                s.login(conf["user"], conf["password"])
                s.send_message(msg)
        else:
            with smtplib.SMTP(conf["smtp_host"], port, timeout=30) as s:
                s.starttls(context=ssl.create_default_context())
                s.login(conf["user"], conf["password"])
                s.send_message(msg)
        return True
    except Exception as e:  # never let a report failure break the run
        return f"email: {str(e)[:120]}"


def send_toast(title, body):
    """Windows 10/11 toast via Windows PowerShell's WinRT bridge (shown under 'Windows PowerShell')."""
    if os.name != "nt":
        return None
    first = body.strip().splitlines()[0] if body.strip() else ""
    esc = lambda s: html.escape(s[:200]).replace("'", "''")
    ps = (
        "[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] > $null;"
        "[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] > $null;"
        "$x = New-Object Windows.Data.Xml.Dom.XmlDocument;"
        f"$x.LoadXml('<toast><visual><binding template=\"ToastGeneric\"><text>{esc(title)}</text><text>{esc(first)}</text></binding></visual></toast>');"
        "$t = [Windows.UI.Notifications.ToastNotification]::new($x);"
        "[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier("
        "'{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe').Show($t)"
    )
    exe = os.path.join(os.environ.get("SystemRoot", r"C:\Windows"), "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
    try:
        p = subprocess.run([exe, "-NoProfile", "-NonInteractive", "-Command", ps], capture_output=True, text=True,
                           timeout=30, stdin=subprocess.DEVNULL, creationflags=NO_WINDOW)
        return p.returncode == 0 or f"toast: {(p.stderr or '')[:120]}"
    except Exception as e:
        return f"toast: {str(e)[:120]}"


def notify(title, body):
    """Send on every configured channel. Returns {channel: True | error string} (unconfigured omitted)."""
    s = _secrets()
    results = {}
    for name, fn in (("telegram", lambda: send_telegram(title, body, s.get("telegram"))),
                     ("email", lambda: send_email(title, body, s.get("email"))),
                     ("pc", lambda: send_toast(title, body))):
        try:
            r = fn()
        except Exception as e:
            r = f"{name}: {str(e)[:120]}"
        if r is not None:
            results[name] = r
    return results


def setup_telegram():
    s = _secrets()
    token = (s.get("telegram") or {}).get("bot_token")
    if not token:
        print('Add "telegram": {"bot_token": "<token from @BotFather>"} to secrets.json first.')
        return 1
    r = requests.get(f"https://api.telegram.org/bot{token}/getUpdates", timeout=20).json()
    chats = [u["message"]["chat"] for u in r.get("result", []) if u.get("message", {}).get("chat")]
    if not chats:
        print("No messages yet — open your bot in Telegram, press Start (or send 'hi'), then run this again.")
        return 1
    chat = chats[-1]
    s.setdefault("telegram", {})["chat_id"] = str(chat["id"])
    with open(SECRETS_PATH, "w", encoding="utf-8", newline="\n") as h:
        json.dump(s, h, indent=2, ensure_ascii=False)
    print(f"Saved chat_id for {chat.get('first_name') or chat.get('title') or chat['id']}.")
    print(notify("GreaterNews alerts connected ✅", "You'll get a report here after every automatic run."))
    return 0


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--test", action="store_true")
    ap.add_argument("--setup-telegram", action="store_true")
    a = ap.parse_args()
    if a.setup_telegram:
        sys.exit(setup_telegram())
    if a.test:
        print(notify("GreaterNews test ✅", "If you can read this, automatic-run reports will reach you here."))
