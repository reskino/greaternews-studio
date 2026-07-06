# GreaterNews Auto-Publishing Setup

The publisher (`scripts/publish.py`) posts your daily queue to Facebook and X automatically.
It runs in **dry-run mode** (prints instead of posting) until you create `secrets.json`.

## 1. Facebook Page credentials (~15 minutes, free)

1. Make sure the GreaterNews **Facebook Page** exists and you are its admin.
2. Go to **developers.facebook.com** → My Apps → **Create App** → type "Business" → name it "GreaterNews Publisher".
3. In the app dashboard, open **Graph API Explorer** (Tools menu):
   - In "User or Page", pick **Get Page Access Token** and select the GreaterNews page.
   - Grant the `pages_manage_posts` and `pages_read_engagement` permissions when prompted.
4. Exchange it for a long-lived token (60 days): open this URL in the browser (fill in the 3 values):
   `https://graph.facebook.com/v21.0/oauth/access_token?grant_type=fb_exchange_token&client_id=APP_ID&client_secret=APP_SECRET&fb_exchange_token=SHORT_TOKEN`
5. Get a **never-expiring page token**: with that long-lived user token, open
   `https://graph.facebook.com/v21.0/me/accounts?access_token=LONG_LIVED_USER_TOKEN`
   — copy the `access_token` for the GreaterNews page and its `id`.

## 2. X (Twitter) credentials (~10 minutes, free tier)

1. Go to **developer.x.com** → sign in with the GreaterNews X account → apply for the **Free** tier.
2. Create a Project + App. In the app's **Settings → User authentication**, enable **Read and write**.
3. In **Keys and tokens**, generate and copy all four values:
   API Key, API Key Secret, Access Token, Access Token Secret.
   (Free tier allows ~500 posts/month — roughly 16/day, plenty for the daily queue.)

## 3. Create secrets.json

Create `C:\GreaterNews\secrets.json` (it is git-ignored — never commit it):

```json
{
  "facebook": {
    "page_id": "YOUR_PAGE_ID",
    "page_token": "YOUR_PAGE_ACCESS_TOKEN"
  },
  "x": {
    "api_key": "...",
    "api_secret": "...",
    "access_token": "...",
    "access_secret": "..."
  }
}
```

## 4. Test, then schedule

```bat
:: preview what would go out (safe)
python C:\GreaterNews\scripts\publish.py --dry-run

:: post ONE item for real (start here)
python C:\GreaterNews\scripts\publish.py --next
```

When you're happy, schedule spread-out posting times (run once in an **admin** Command Prompt):

```bat
schtasks /Create /F /TN "GreaterNews Post Morning"  /SC DAILY /ST 07:33 /TR "python C:\GreaterNews\scripts\publish.py --next"
schtasks /Create /F /TN "GreaterNews Post Midday"   /SC DAILY /ST 12:27 /TR "python C:\GreaterNews\scripts\publish.py --next"
schtasks /Create /F /TN "GreaterNews Post Evening"  /SC DAILY /ST 18:11 /TR "python C:\GreaterNews\scripts\publish.py --next"
schtasks /Create /F /TN "GreaterNews Post Night"    /SC DAILY /ST 20:41 /TR "python C:\GreaterNews\scripts\publish.py --next"
```

Each run posts exactly one pending item, so the queue spreads across the day at Ghana's peak hours.
The morning run builds the day's queue; you can edit or delete items in
`content\queue_YYYY-MM-DD.json` any time before they go out (status: "pending" → will post,
anything else → skipped).

## Notes

- Failures stay "pending" with a `lastError` field and retry at the next scheduled run.
- The Facebook page token above doesn't expire; X tokens don't expire either unless regenerated.
- Instagram requires a Business account + app review — add later if needed; WhatsApp Status has no API (share manually from your phone via the app's Share buttons).
- Editorial rule: the queue is written by the verified morning run, but you can always review
  `queue_YYYY-MM-DD.json` before 07:33 — the first posting slot is deliberately after breakfast.
