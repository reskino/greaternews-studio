"""GreaterNews Deep Dive assembler (CapCut-style, word-by-word captions).

Approved spec (chapters: narration + a visual) -> vertical explainer:
- ElevenLabs "with-timestamps" -> burned captions that reveal ONE WORD at a time (Poppins).
- Stills come from a broad search (Google/Serper -> Commons -> Openverse -> Pexels) so specific
  subjects (a Ghana Shell station, a Strait map) resolve; b-roll comes from Pexels video.
- "clip" chapters use REAL news footage when a free-to-reuse copy exists (Wikimedia Commons:
  public-domain DVIDS/VOA/White House video, CC-licensed clips) or a file you supply; otherwise a still.
  Credits go on screen and into <slug>_credits.json for the post text.
- Brand header on top: GREATERNEWS wordmark + the real GN logo in a rounded badge (like the cards),
  placed below the phone notch / Reels top bar (SAFE_TOP).
- No on-screen sources card (sources go in the post text).
Composited + concatenated with ffmpeg. Keys from secrets.json (elevenlabs, pexels, serper).
Output: content/deep-dive/<slug>_9x16.mp4  (human review before publishing).
"""

import base64
import glob
import html
import io
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
import unicodedata

import requests
from PIL import Image, ImageDraw, ImageFilter, ImageFont

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SECRETS = json.load(open(os.path.join(ROOT, "secrets.json"), encoding="utf-8"))
OUT_DIR = os.path.join(ROOT, "content", "deep-dive")
LOGO = os.path.join(ROOT, "public", "logo.png")
POPPINS_BOLD = "C:/Windows/Fonts/Poppins-Bold.ttf"
UA = {"User-Agent": "Mozilla/5.0 (GreaterNews DeepDive)"}
# Wikimedia's API 403s browser-style "Mozilla/5.0 (...)" agents that aren't a real browser, which
# silently disabled the Commons tier — it needs a plain tool-style agent (policy: meta.wikimedia.org/wiki/User-Agent_policy).
# Downloading FILES from upload.wikimedia.org (news clips) additionally needs contact info in the agent
# (an email or website, per the Wikimedia User-Agent policy) - without it they're throttled to HTTP 429.
# Set it in secrets.json: {"wikimedia": {"contact": "https://your-site or you@example.com"}}.
WIKI_CONTACT = ((SECRETS.get("wikimedia") or {}).get("contact") or "").strip()
WIKI_UA = {"User-Agent": (f"GreaterNews-DeepDive/1.0 ({WIKI_CONTACT}) python-requests/{requests.__version__}"
                          if WIKI_CONTACT else "GreaterNews-DeepDive/1.0 (python-requests)")}
W, H = 1080, 1920
# Reels safe zone (Meta guidance): the top ~14% sits under the notch/status bar + app top bar, and
# the bottom ~30% under the page name, post caption and buttons. Keep brand marks and captions out.
SAFE_TOP = 0.145
CAPTION_MARGIN = 600   # caption baseline, px up from the bottom edge (was 520)

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

HI_BOX = "57C4F3"  # brand gold (#F3C457) as ASS &HBBGGRR for the highlight box


def ass_header(fontsize, margin_v=470):
    return (
        "[Script Info]\nScriptType: v4.00+\nPlayResX: 1080\nPlayResY: 1920\n"
        "WrapStyle: 0\nScaledBorderAndShadow: yes\n\n"
        "[V4+ Styles]\n"
        "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\n"
        f"Style: Cap,Poppins,{fontsize},&H00FFFFFF,&H000000FF,&H00121212,&H00000000,-1,0,0,0,100,100,0,0,1,8,4,2,90,90,{margin_v},1\n\n"
        "[Events]\n"
        "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n"
    )


def font(size):
    for p in (POPPINS_BOLD, "C:/Windows/Fonts/arialbd.ttf"):
        try:
            return ImageFont.truetype(p, size)
        except Exception:
            continue
    return ImageFont.load_default()


def eleven_timestamps(text, mp3_path):
    conf = SECRETS["elevenlabs"]
    r = requests.post(
        f"https://api.elevenlabs.io/v1/text-to-speech/{conf.get('voice_id', 'cjVigY5qzO86Huf0OWal')}/with-timestamps",
        headers={"xi-api-key": conf["api_key"], "Content-Type": "application/json"},
        json={"text": text, "model_id": "eleven_multilingual_v2"},
        timeout=120,
    )
    r.raise_for_status()
    d = r.json()
    open(mp3_path, "wb").write(base64.b64decode(d["audio_base64"]))
    a = d["alignment"] or {}
    return a.get("characters", []), a.get("character_start_times_seconds", []), a.get("character_end_times_seconds", [])


def groq_tts(text, path, voice_name=None):
    c = SECRETS["groq"]
    keys = [k for k in (c.get("api_keys") or [c.get("api_key")]) if k]
    voice = voice_name or c.get("tts_voice", "hannah")
    last_err = None
    for ki, key in enumerate(keys):
        for attempt in range(3):
            r = requests.post(
                "https://api.groq.com/openai/v1/audio/speech",
                headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"},
                json={"model": c.get("tts_model", "canopylabs/orpheus-v1-english"), "input": text,
                      "voice": voice, "response_format": "wav"},
                timeout=120,
            )
            if r.status_code == 429:
                wait = float(r.headers.get("retry-after", 0))
                if wait > 90:  # this key's daily quota is gone -> try the next key
                    last_err = RuntimeError(f"key {ki + 1} quota exhausted (~{int(wait / 60)}m)")
                    break
                wait = wait or (5 * (attempt + 1))
                print(f"    (Groq key {ki + 1} throttled; waiting {int(wait)}s)")
                time.sleep(min(wait, 30))
                continue
            if r.status_code >= 400:  # bad/terms-required key -> try the next key
                last_err = RuntimeError(f"key {ki + 1}: {r.status_code} {r.text[:100]}")
                break
            open(path, "wb").write(r.content)
            return
    raise last_err or RuntimeError("Groq TTS failed on all keys")


def windows_tts(text, path):
    """Offline stopgap voice (Windows SAPI) — no quota. Lower quality than Groq/ElevenLabs."""
    tf = path + ".txt"
    with open(tf, "w", encoding="utf-8") as h:
        h.write(text)
    ps = (
        "$t=[IO.File]::ReadAllText('{txt}');Add-Type -AssemblyName System.Speech;"
        "$s=New-Object System.Speech.Synthesis.SpeechSynthesizer;"
        "$f=$s.GetInstalledVoices()|?{{$_.VoiceInfo.Gender -eq 'Female' -and $_.Enabled}}|select -First 1;"
        "if($f){{$s.SelectVoice($f.VoiceInfo.Name)}};$s.Rate=-1;"
        "$s.SetOutputToWaveFile('{wav}');$s.Speak($t);$s.Dispose()"
    ).format(txt=tf.replace("'", "''"), wav=path.replace("'", "''"))
    pwsh = os.path.join(os.environ.get("SystemRoot", r"C:\Windows"),
                        "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
    if not os.path.exists(pwsh):
        pwsh = "powershell"
    subprocess.run([pwsh, "-NoProfile", "-Command", ps],
                   check=True, stdin=subprocess.DEVNULL, creationflags=NO_WINDOW)
    os.remove(tf)


def approx_words(text, total):
    """No timestamps (Groq) -> estimate word timing by length AND pauses at punctuation, so the
    highlighted word tracks the speech closely."""
    raw = text.split()

    def weight(w):
        base = len(w) + 2
        if w[-1:] in ".!?":
            base += 7  # sentence pause
        elif w[-1:] in ",;:":
            base += 4  # clause pause
        return base

    weights = [weight(w) for w in raw]
    tot = sum(weights) or 1
    lead, tail = 0.10, 0.30
    span = max(0.2, total - lead - tail)
    t, out = lead, []
    for w, wt in zip(raw, weights):
        d = span * wt / tot
        out.append((w, t, t + d))
        t += d
    return out


def synthesize(text, path, voice, groq_voice=None):
    """ElevenLabs (word-accurate) -> Groq voice -> offline Windows voice. Never hard-fails on TTS."""
    if voice == "elevenlabs":
        try:
            chars, starts, ends = eleven_timestamps(text, path)
            return words_from_alignment(chars, starts, ends)
        except Exception as e:
            print(f"  (ElevenLabs unavailable: {str(e)[:50]} -> Groq voice)")
    try:
        groq_tts(text, path, groq_voice)
    except Exception as e:
        print(f"  (Groq voice unavailable: {str(e)[:70]} -> offline Windows voice)")
        windows_tts(text, path)
    return approx_words(text, duration(path))


def words_from_alignment(chars, starts, ends):
    words, cur, ws, we = [], "", None, None
    for c, s, e in zip(chars, starts, ends):
        if not c.strip():
            if cur:
                words.append((cur, ws, we))
                cur, ws = "", None
        else:
            if not cur:
                ws = s
            cur += c
            we = e
    if cur:
        words.append((cur, ws, we))
    return words


# ---------- captions: spoken numbers -> digits ----------
# Narration spells numbers out so the voice reads them right ("one-nil", "June twenty-fourth"); on
# screen they should read like a news graphic ("1-0", "June 24"). News style: small cardinals
# ("seven weeks", "one of the largest") stay as words; 10+, decimals, scores, %, dates and years
# become digits. Merged words keep the first word's start and the last word's end time.
_UNITS = {w: i for i, w in enumerate(
    "zero one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen "
    "sixteen seventeen eighteen nineteen".split())}
_TENS = {w: 10 * (i + 2) for i, w in enumerate("twenty thirty forty fifty sixty seventy eighty ninety".split())}
_SCALES = {"hundred": 100, "thousand": 1000, "million": 10**6, "billion": 10**9, "trillion": 10**12}
_ORD_TO_CARD = {"first": "one", "second": "two", "third": "three", "fifth": "five", "eighth": "eight",
                "ninth": "nine", "twelfth": "twelve"}
for _w in _UNITS:
    if _w != "zero" and _w not in _ORD_TO_CARD.values():
        _ORD_TO_CARD[_w + "th"] = _w                       # fourth, sixth, tenth, eighteenth...
for _w in _TENS:
    _ORD_TO_CARD[_w[:-1] + "ieth"] = _w                    # twentieth, thirtieth...
for _w in _SCALES:
    _ORD_TO_CARD[_w + "th"] = _w                           # hundredth, thousandth...
_NUMBER_WORDS = set(_UNITS) | set(_TENS) | set(_SCALES) | set(_ORD_TO_CARD)
_MONTHS = set("january february march april may june july august september october november december".split())
_YEAR_CONTEXT = _MONTHS | {"in", "since", "until", "by", "of", "from", "to", "season", "year"}


def _cardinal(toks):
    """'two thousand and twenty-six' -> 2026; None if the tokens aren't exactly one number."""
    total, cur, last = 0, 0, None
    for t in toks:
        if t == "and":
            if last not in ("hundred", "scale"):
                return None
            continue
        if t in _UNITS:
            v = _UNITS[t]
            if last in ("unit", "teen") or (last == "tens" and (v >= 10 or v == 0)):
                return None
            cur, last = cur + v, ("teen" if v >= 10 else "unit")
        elif t in _TENS:
            if last in ("unit", "teen", "tens"):
                return None
            cur, last = cur + _TENS[t], "tens"
        elif t == "hundred":
            if last not in ("unit", "teen") or cur >= 100:
                return None
            cur, last = cur * 100, "hundred"
        elif t in _SCALES:
            if cur == 0:
                return None
            total, cur, last = total + cur * _SCALES[t], 0, "scale"
        else:
            return None
    return None if last is None else total + cur


def _ordinal_suffix(n):
    return "th" if 10 <= n % 100 <= 13 else {1: "st", 2: "nd", 3: "rd"}.get(n % 10, "th")


def _spoken_number(toks, prev):
    """Display text for a run of number tokens, or None to leave the words as spoken."""
    if toks[-1] == "nil":                                  # scores: "one-nil" -> 1-0
        n = 0 if toks[:-1] == ["nil"] else _cardinal(toks[:-1])
        return None if n is None else f"{n}-0"
    if "point" in toks:                                    # "seven point four" / "... point five eight billion"
        k = toks.index("point")
        whole, rest = _cardinal(toks[:k]), toks[k + 1:]
        scale = rest.pop() if rest and rest[-1] in ("million", "billion", "trillion") else None
        if whole is None or not rest or any(_UNITS.get(t, 99) > 9 for t in rest):
            return None
        return f"{whole:,}." + "".join(str(_UNITS[t]) for t in rest) + (f" {scale}" if scale else "")
    if toks[-1] in _ORD_TO_CARD:                           # ordinals: dates or 10th+
        n = _cardinal(toks[:-1] + [_ORD_TO_CARD[toks[-1]]])
        if n is None:
            return None
        if prev in _MONTHS:
            return str(n)
        return f"{n}{_ordinal_suffix(n)}" if n >= 10 else None
    n = _cardinal(toks)
    if n is None and len(toks) >= 2 and toks[0] in _UNITS and 11 <= _UNITS[toks[0]] <= 19 or (
            n is None and len(toks) >= 2 and toks[0] in _TENS):
        rest = _cardinal(toks[1:])                         # years: "twenty twenty-five" -> 2025
        head = _UNITS.get(toks[0]) or _TENS.get(toks[0])
        if rest is not None and 10 <= rest <= 99 and toks[1] not in _SCALES:
            return str(head * 100 + rest)
        return None
    if n is None or n < 10:
        return None
    if toks[-1] in ("million", "billion", "trillion") and n >= 10**6:
        return f"{n / _SCALES[toks[-1]]:g} {toks[-1]}"     # "ten billion" -> 10 billion
    if 1900 <= n <= 2100 and prev in _YEAR_CONTEXT:
        return str(n)
    return f"{n:,}"


def _split_punct(text):
    m = re.match(r"^([\"'“‘(\[]*)(.*?)([\"'”’)\].,;:!?]*)$", text)
    return m.group(1), m.group(2), m.group(3)


def digitize_words(words):
    """Merge spoken-number word runs into digit tokens for the captions (timing preserved)."""
    out, i = [], 0
    parts = [_split_punct(w[0]) for w in words]

    def toks_of(core):
        return core.lower().split("-")

    def is_num(k, first):
        ts = toks_of(parts[k][1])
        if not parts[k][1]:
            return False
        if first:  # a run starts on a number word ("one-nil" and "nil-nil" included)
            return ((ts[0] in _NUMBER_WORDS or (ts[0] == "nil" and len(ts) > 1))
                    and all(t in _NUMBER_WORDS or t == "nil" for t in ts[1:]))
        return all(t in _NUMBER_WORDS or t in ("and", "point", "nil") for t in ts)

    while i < len(words):
        if not is_num(i, True):
            out.append(words[i])
            i += 1
            continue
        j = i
        while j + 1 < len(words) and not parts[j][2] and is_num(j + 1, False):
            j += 1                                         # extend the run until punctuation
        prev = _split_punct(words[i - 1][0])[1].lower() if i else ""
        for k in range(j, i - 1, -1):                      # longest phrase that reads as one number
            toks = [t for w in range(i, k + 1) for t in toks_of(parts[w][1])]
            if toks[-1] == "and":
                continue
            shown = _spoken_number(toks, prev)
            if shown is None:
                continue
            end_k, tail = k, parts[k][2]
            nxt = _split_punct(words[k + 1][0]) if k + 1 < len(words) else ("", "", "")
            if not tail and nxt[1].lower() == "percent":   # "forty percent" -> 40%
                shown, end_k, tail = shown + "%", k + 1, nxt[2]
            out.append((parts[i][0] + shown + tail, words[i][1], words[end_k][2]))
            i = end_k + 1
            break
        else:
            out.append(words[i])
            i += 1
    return out


def ass_time(t):
    return f"{int(t // 3600)}:{int((t % 3600) // 60):02d}:{t % 60:05.2f}"


def _end_time(ws, we, nxt):
    start = ws or 0
    end = nxt if nxt is not None else (we or start) + 0.4
    return start, (end if end > start else start + 0.2)


def _word_lines(words):
    out = []
    for i, (text, ws, we) in enumerate(words):
        nxt = words[i + 1][1] if i + 1 < len(words) else None
        start, end = _end_time(ws, we, nxt)
        text = text.replace("{", "(").replace("}", ")")
        out.append(f"Dialogue: 0,{ass_time(start)},{ass_time(end)},Cap,,0,0,0,,{{\\fad(40,0)}}{text}")
    return out


def _highlight_lines(words, per=3):
    # Show a short phrase; box the currently-spoken word (like the reference caption).
    out = []
    for c in range(0, len(words), per):
        chunk = words[c:c + per]
        texts = [w[0].replace("{", "(").replace("}", ")").upper() for w in chunk]
        for j, (text, ws, we) in enumerate(chunk):
            nxt = chunk[j + 1][1] if j + 1 < len(chunk) else (words[c + per][1] if c + per < len(words) else None)
            start, end = _end_time(ws, we, nxt)
            parts = [(f"{{\\1c&H141414&\\3c&H{HI_BOX}&\\bord22}}{tx}{{\\r}}" if k == j else tx) for k, tx in enumerate(texts)]
            out.append(f"Dialogue: 0,{ass_time(start)},{ass_time(end)},Cap,,0,0,0,,{' '.join(parts)}")
    return out


def write_ass(words, path, style="word"):
    if style == "highlight":
        header, lines = ass_header(84, margin_v=CAPTION_MARGIN), _highlight_lines(words)
    else:
        header, lines = ass_header(116, margin_v=CAPTION_MARGIN), _word_lines(words)
    open(path, "w", encoding="utf-8").write(header + "\n".join(lines) + "\n")


NO_WINDOW = getattr(subprocess, "CREATE_NO_WINDOW", 0)  # don't flash console windows on Windows


def duration(path):
    return float(subprocess.check_output(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "default=nk=1:nw=1", path],
        text=True, stdin=subprocess.DEVNULL, creationflags=NO_WINDOW
    ).strip())


def brand_header(path):
    """Transparent overlay: a single centered lockup — GN badge beside the GREATERNEWS wordmark,
    with a soft shadow so it stays legible over light images."""
    img = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)

    text = "G R E A T E R N E W S"
    fs = int(W * 0.033)
    wm = font(fs)
    tb = d.textbbox((0, 0), text, font=wm)
    tw = tb[2] - tb[0]
    s = int(fs * 2.0)                         # badge sized to sit inline with the wordmark
    # Badge top on the 14.5% line: higher up, the phone's notch / status bar and Facebook's Reels
    # top bar cover it (it was at 6% and sat under the camera cut-out on some phones).
    cy = int(H * SAFE_TOP) + s // 2           # lockup centre-line
    gap = int(W * 0.020)
    x0 = (W - (s + gap + tw)) // 2            # left edge of the whole lockup -> centred

    bx, by = x0, cy - s // 2                   # badge
    d.rounded_rectangle([bx + 3, by + 3, bx + s + 3, by + s + 3],
                        radius=int(s * 0.24), outline=(0, 0, 0, 90), width=5)   # shadow
    d.rounded_rectangle([bx, by, bx + s, by + s],
                        radius=int(s * 0.24), outline=(255, 255, 255, 235), width=5)
    try:
        logo = Image.open(LOGO).convert("RGBA")
        pad = int(s * 0.16)
        logo.thumbnail((s - 2 * pad, s - 2 * pad))
        img.alpha_composite(logo, (bx + (s - logo.width) // 2, by + (s - logo.height) // 2))
    except Exception:
        d.text((bx + s / 2, by + s / 2), "GN", font=font(int(s * 0.42)), fill=(243, 196, 87), anchor="mm")

    wx = bx + s + gap                          # wordmark, left-middle anchored beside the badge
    d.text((wx + 2, cy + 2), text, font=wm, fill=(0, 0, 0, 110), anchor="lm")   # shadow
    d.text((wx, cy), text, font=wm, fill=(255, 255, 255, 230), anchor="lm")
    img.save(path)


def _download_img(url, path):
    data = requests.get(url, timeout=60, headers=UA).content
    im = Image.open(io.BytesIO(data)).convert("RGB")
    if min(im.size) < 400:
        raise ValueError("too small")
    im.save(path, "JPEG", quality=90)
    return True


# Each source returns [(image_url, title_or_alt_text)] in best-match-first order.
def serper_images(q):
    key = (SECRETS.get("serper") or {}).get("api_key")
    if not key:
        return []
    r = requests.post("https://google.serper.dev/images", headers={"X-API-KEY": key, "Content-Type": "application/json"},
                      json={"q": q, "num": 10, "gl": "gh"}, timeout=30)
    return [(i["imageUrl"], i.get("title") or "") for i in r.json().get("images", []) if i.get("imageUrl")]


def commons_images(q):
    r = requests.get("https://commons.wikimedia.org/w/api.php", headers=WIKI_UA, timeout=30, params={
        "action": "query", "format": "json", "generator": "search", "gsrnamespace": 6,
        "gsrsearch": f"filetype:bitmap {q}", "gsrlimit": 8, "prop": "imageinfo", "iiprop": "url", "iiurlwidth": 1400})
    pages = (r.json().get("query", {}).get("pages", {}) or {}).values()
    out = []
    # `pages` is keyed by page id, NOT search rank — sort by `index` or the oldest file wins
    # (that ordering put Yul Edochie's photo on a Pete Edochie card, 2026-11-25).
    for p in sorted(pages, key=lambda p: p.get("index", 10**6)):
        ii = (p.get("imageinfo") or [{}])[0]
        u = ii.get("thumburl") or ii.get("url")
        if u and not u.lower().endswith(".svg"):
            out.append((u, p.get("title") or ""))
    return out


def openverse_images(q):
    r = requests.get("https://api.openverse.org/v1/images/", headers=UA, timeout=30, params={"q": q, "page_size": 8})
    return [(i["url"], i.get("title") or "") for i in r.json().get("results", []) if i.get("url")]


def pexels_photo(q):
    r = requests.get("https://api.pexels.com/v1/search", headers={"Authorization": SECRETS["pexels"]["api_key"]},
                     params={"query": q, "per_page": 8, "orientation": "portrait"}, timeout=30)
    return [((p["src"].get("large2x") or p["src"].get("original")), p.get("alt") or "")
            for p in r.json().get("photos", []) if p.get("src")]


LOOKALIKE = re.compile(r"\b(look-?alikes?|impersonat\w*|cosplay\w*|wax figure|parody)\b", re.I)
_NAME_STOP = {"the", "a", "an", "of", "in", "on", "at", "for", "and", "or", "to", "with", "by", "from", "as"}


def _norm(text):
    text = "".join(c for c in unicodedata.normalize("NFD", text) if not unicodedata.combining(c))
    return " " + re.sub(r"[^a-z0-9]+", " ", text.lower()).strip() + " "


def name_words(q):
    """The specific people/places a query names = its capitalised words ('Pete', 'Edochie', 'Accra')."""
    words = []
    for w in re.findall(r"\b[A-Z][\w'-]*", q):
        words += [t for t in _norm(w).split() if len(t) > 1 and t not in _NAME_STOP]
    # Queries tack on "Ghana" to disambiguate ("... in Accra Ghana"); when something more specific is
    # named, an "Accra skyline" photo shouldn't be rejected for not also saying "Ghana".
    specific = [w for w in words if w not in ("ghana", "ghanaian")]
    return specific or words


def names_match(text, names):
    """Every named word appears (as a word start, so 'Ghana' matches 'Ghanaian') in the title/alt text."""
    t = _norm(text)
    return all(f" {n}" in t for n in names)


def still_ok(source, url, title, names):
    if any(b in url.lower() for b in STOCK_BLOCK):
        return False
    if LOOKALIKE.search(title or ""):
        return False
    # Google ranks by relevance, so trust its order; the fallbacks (Commons/Openverse/stock) must
    # visibly be OF the named subject — never a relative, namesake, or a stock stranger.
    if source is not serper_images and names and not names_match(title or "", names):
        return False
    return True


STOCK_BLOCK = (
    "shutterstock", "gettyimages", "istockphoto", "istock", "alamy", "dreamstime",
    "depositphotos", "123rf", "stock.adobe", "fotolia", "bigstock", "vecteezy",
    "agefotostock", "picfair", "canstockphoto", "adobestock", "shutter",
)


def find_still(q, path):
    # Google relevance first, then licensed sources; skip watermarked / unlicensed stock previews,
    # lookalikes, and fallback results that don't name who/what the query asks for.
    names = name_words(q)
    for src in (serper_images, commons_images, openverse_images, pexels_photo):
        try:
            hits = src(q)
        except Exception:
            hits = []
        for u, title in hits:
            if not still_ok(src, u, title, names):
                continue
            try:
                if _download_img(u, path):
                    return True
            except Exception:
                continue
    return False


_BROLL_GENERIC = {"the", "and", "with", "for", "from", "into", "near", "over", "view", "shot", "video", "footage",
                  "clip", "close", "slow", "motion", "scene", "people", "person", "man", "woman", "very"}


def _stems(text):
    """Crude stems for matching a query to a Pexels slug: 'celebrating'~'celebration', 'flags'~'flag',
    and 'soccer'~'football' (they're the same sport for our audience)."""
    out = set()
    for w in re.findall(r"[a-z]+", text.lower()):
        if len(w) > 2 and w not in _BROLL_GENERIC:
            w = "football" if w in ("soccer", "soccers") else w
            w = w[:-1] if w.endswith("s") and len(w) > 3 else w
            out.add(w[:5])
    return out


# For a Ghana audience "football" is soccer; Pexels' "football" mixes in American football
# (an end zone and goalposts under AFCON narration), so search "soccer" and refuse those clips.
_NOT_OUR_FOOTBALL = {"american", "nfl", "touchdown", "quarterback", "gridiron", "helmet", "rugby"}


def _broll_search_query(q):
    if re.search(r"\bamerican football\b", q, re.I):
        return q
    return re.sub(r"\bfootball\b", "soccer", q, flags=re.I)


def pexels_video(q, path):
    """Pick the clip whose description (the pexels.com URL slug) best matches the query, in Pexels'
    own rank order on ties. Clips that don't match enough are refused (the caller falls back to a
    still) — a loosely related clip under specific narration misleads viewers. Downloads ~1080p,
    not 4K. (Previously this took the highest-resolution clip of all results, regardless of match.)"""
    r = requests.get("https://api.pexels.com/videos/search", headers={"Authorization": SECRETS["pexels"]["api_key"]},
                     params={"query": _broll_search_query(q), "per_page": 12, "orientation": "portrait",
                             "size": "medium"}, timeout=30)
    want = _stems(q)
    refuse = _NOT_OUR_FOOTBALL - set(re.findall(r"[a-z]+", q.lower()))
    need = max(1, -(-len(want) // 3))                      # match at least a third of the query's words
    best = None
    for v in r.json().get("videos", []):
        files = [f for f in v.get("video_files", [])
                 if f.get("file_type") == "video/mp4" and (f.get("height") or 0) >= (f.get("width") or 0)
                 and (f.get("height") or 0) >= 1080]
        if not files:
            continue
        slug = (v.get("url") or "").rstrip("/").rsplit("/", 1)[-1]
        if refuse & set(slug.split("-")):
            continue
        score = len(want & _stems(slug))
        if score >= need and (best is None or score > best[0]):
            fits = [f for f in files if f["height"] <= 1920]
            pick = max(fits, key=lambda f: f["height"]) if fits else min(files, key=lambda f: f["height"])
            best = (score, pick["link"], slug)
    if not best:
        return False
    open(path, "wb").write(requests.get(best[1], timeout=180).content)
    print(f"    b-roll: {best[2]} (matched {best[0]}/{len(want)})")
    return True


# ---- Real news footage, only when it's free to reuse ------------------------------------------
# Wikimedia Commons hosts public-domain US-government news video (DVIDS military footage, VOA, the
# White House) and CC-licensed clips from news events. Broadcaster footage (TV news, YouTube news
# channels) is deliberately NOT used: Facebook's Rights Manager matches it and mutes/blocks the reel.
COMMONS_API = "https://commons.wikimedia.org/w/api.php"
CLIP_MAX_BYTES = 160 * 2**20


def _strip_html(s):
    text = html.unescape(re.sub(r"<[^>]+>", " ", s or ""))
    return re.sub(r"\s+", " ", unicodedata.normalize("NFKC", text)).strip()


def _clip_year(em):
    for k in ("DateTimeOriginal", "DateTime"):      # when it was shot, else when it was uploaded
        m = re.search(r"\b(19|20)\d\d\b", str((em.get(k) or {}).get("value") or ""))
        if m:
            return int(m.group(0))
    return None


def _clip_by(em):
    """A short 'who shot it' for the on-screen credit and the post's footage line."""
    artist = _strip_html((em.get("Artist") or {}).get("value"))
    cats = str((em.get("Categories") or {}).get("value") or "")
    if artist and "null" not in artist.lower() and len(artist) <= 48:
        return artist
    if "Voice of America" in cats or "VOA" in cats:
        return "VOA"
    if any(k in cats for k in ("PD US Military", "Department of Defense", "DVIDS")):
        return "U.S. Dept. of Defense (DVIDS)"
    if "White House" in cats:
        return "The White House"
    if "PD US Government" in cats:
        return "U.S. Government"
    return "Wikimedia Commons"


def commons_clips(q):
    r = requests.get(COMMONS_API, headers=WIKI_UA, timeout=30, params={
        "action": "query", "format": "json", "generator": "search", "gsrnamespace": 6, "gsrlimit": 15,
        "gsrsearch": f"filetype:video {q}", "prop": "videoinfo",
        "viprop": "url|size|extmetadata|derivatives"})
    pages = ((r.json().get("query") or {}).get("pages") or {}).values()
    out = []
    for p in sorted(pages, key=lambda p: p.get("index", 10**6)):   # search rank, not page id
        vi = (p.get("videoinfo") or [{}])[0]
        em = vi.get("extmetadata") or {}
        out.append({
            "title": p.get("title", "").split(":", 1)[-1].rsplit(".", 1)[0],
            "desc": _strip_html((em.get("ImageDescription") or {}).get("value"))[:300],
            "page": vi.get("descriptionurl") or "", "url": vi.get("url") or "",
            "duration": float(vi.get("duration") or 0), "height": int(vi.get("height") or 0),
            "size": int(vi.get("size") or 0), "derivatives": vi.get("derivatives") or [],
            "license": _strip_html((em.get("LicenseShortName") or {}).get("value")) or "free license",
            "by": _clip_by(em), "year": _clip_year(em)})
    return out


def _clip_source_url(c):
    """A web-playable transcode: up to 1080p for short clips, 480p for long ones (smaller download)."""
    cap = 1080 if c["duration"] <= 240 else 480
    webm = [d for d in c["derivatives"]
            if "webm" in (d.get("type") or "") and 360 <= int(d.get("height") or 0) <= cap]
    if webm:
        return max(webm, key=lambda d: int(d.get("height") or 0))["src"]
    return c["url"] if c["size"] and c["size"] <= CLIP_MAX_BYTES else None


def _download_commons(url, path):
    """upload.wikimedia.org throttles bursts (429 + Retry-After) - wait once, then give up."""
    for attempt in range(2):
        with requests.get(url, headers=WIKI_UA, timeout=180, stream=True) as r:
            if r.status_code == 429 and not WIKI_CONTACT:
                print("    (Commons refused the clip download: add a contact to secrets.json -> "
                      "wikimedia.contact so Wikimedia lets the downloads through; using a photo instead)")
                return False
            if r.status_code == 429 and attempt == 0:
                wait = min(int(float(r.headers.get("retry-after") or 30)), 75)
                print(f"    (Commons is throttling downloads; waiting {wait}s)")
                time.sleep(wait)
                continue
            r.raise_for_status()
            got = 0
            with open(path, "wb") as h:
                for chunk in r.iter_content(1 << 16):
                    got += len(chunk)
                    if got > CLIP_MAX_BYTES:
                        raise ValueError("clip too large")
                    h.write(chunk)
            return True
    return False


def find_clip(vis, path, used):
    """Footage for a 'clip' chapter -> {'path','label','credit'} or None (caller falls back to a still).
    1) the spec's own file (footage you have the right to use): vis.file under content/, + vis.credit;
    2) a free Commons clip that NAMES the query's subject, matches at least half its words, and is
       recent (vis.since, default: this year or last) - old footage of a different strike or flood
       under today's narration would mislead."""
    own = vis.get("file")
    if own:
        p = own if os.path.isabs(own) else os.path.join(ROOT, "content", own)
        if os.path.exists(p):
            credit = (vis.get("credit") or "").strip()
            return {"path": p, "start": vis.get("start"), "label": f"VIDEO: {credit}" if credit else "",
                    "credit": {"by": credit, "title": os.path.basename(p), "license": "", "url": ""} if credit else None}
        print(f"    (clip file not found: {own})")

    q = vis["query"]
    names, want = name_words(q), _stems(q)
    need = max(1, -(-len(want) // 2))
    this_year = time.gmtime().tm_year
    since = int(vis.get("since") or this_year - 1)
    try:
        cands = commons_clips(q)
    except Exception as e:
        print(f"    (Commons video search failed: {str(e)[:60]})")
        return None
    best = None
    for c in cands:
        text = f"{c['title']} {c['desc']}"
        if c["title"] in used or (names and not names_match(text, names)):
            continue
        score = len(want & _stems(text))
        if score < need or not (4 <= c["duration"] <= 1800) or c["height"] < 360:
            continue
        if not c["year"] or c["year"] < since:
            continue
        if best is None or (score, c["year"]) > best[0]:          # ties keep Commons' rank order
            best = ((score, c["year"]), c)
    if not best:
        return None
    c = best[1]
    src = _clip_source_url(c)
    try:
        if not src or not _download_commons(src, path):
            return None
    except Exception as e:
        print(f"    (clip download failed: {str(e)[:60]})")
        return None
    used.add(c["title"])
    print(f"    news clip: {c['title'][:70]} ({c['year']}, {c['license']}, matched {best[0][0]}/{len(want)})")
    file_tag = "FILE · " if c["year"] < this_year else ""
    return {"path": path, "start": None,
            "label": f"{file_tag}VIDEO: {c['by']} · {c['year']} · {c['license']}",
            "credit": {"by": c["by"], "title": c["title"], "license": c["license"], "url": c["page"]}}


def _clip_start(clip_dur, need):
    """Skip opening slates/titles (~12% in) but keep enough runway for the chapter."""
    if clip_dur <= need + 1:
        return 0.0
    return max(0.0, min(max(2.0, clip_dur * 0.12), clip_dur - need - 0.5))


def _probe_size(path):
    out = subprocess.check_output(
        ["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height",
         "-of", "csv=p=0", path], text=True, stdin=subprocess.DEVNULL, creationflags=NO_WINDOW).strip()
    w, h = (int(x) for x in out.split(",")[:2])
    return w, h


CLIP_CENTER = 0.41   # where a landscape clip's picture sits: clear of the header above and the captions below


def clip_layout(path):
    """ffmpeg filter for a news clip -> [bg] at 1080x1920, plus the top of the picture (for the credit).
    Vertical clips fill the frame. Landscape ones go in a 4:3 window (a slight centre zoom of 16:9,
    so faces stay big) over a blurred, darkened copy of the same footage - the familiar news-reel look."""
    cw, ch = _probe_size(path)
    a = cw / ch
    if a < 0.75:
        return (f"[0:v]fps=30,scale={W}:{H}:force_original_aspect_ratio=increase,crop={W}:{H},setsar=1[bg]",
                int(H * SAFE_TOP) + 110)
    fa = min(a, 4 / 3) if a >= 1 else a
    fh = int(round(W / fa / 2)) * 2
    fy = int(H * CLIP_CENTER - fh / 2)
    fc = (f"[0:v]fps=30,split=2[cb][cf];"
          f"[cb]scale=270:480:force_original_aspect_ratio=increase,crop=270:480,boxblur=10:2,"
          f"scale={W}:{H},eq=brightness=-0.22:saturation=0.8[cbg];"
          f"[cf]scale={W}:{fh}:force_original_aspect_ratio=increase,crop={W}:{fh},setsar=1[cfg];"
          f"[cbg][cfg]overlay=0:{fy},setsar=1[bg]")
    return fc, fy + 18


def overlay_with_label(brand_png, label, y, out):
    """The brand header plus a small credit tag ('VIDEO: VOA · 2026 · Public domain')."""
    img = Image.open(brand_png).convert("RGBA")
    if label:
        d = ImageDraw.Draw(img)
        try:
            f = ImageFont.truetype("C:/Windows/Fonts/Poppins-SemiBold.ttf", 24)
        except Exception:
            f = font(24)
        label = label if len(label) <= 64 else label[:63] + "…"
        tb = d.textbbox((0, 0), label, font=f)
        x, pad = 28, 12
        d.rounded_rectangle([x, y, x + tb[2] - tb[0] + 2 * pad, y + tb[3] - tb[1] + 2 * pad],
                            radius=10, fill=(0, 0, 0, 150))
        d.text((x + pad - tb[0], y + pad - tb[1]), label, font=f, fill=(255, 255, 255, 235))
    img.save(out)
    return out


COVER_SECS = 1.8   # opening card (also the Facebook thumbnail)
END_SECS = 2.2     # closing brand card
SEG_ENCODE = ["-r", "30", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-video_track_timescale", "30000",
              "-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-ac", "2"]


def _source_names(post, n=2):
    names = []
    for s in post.get("sources") or []:
        name = ((s.get("name") if isinstance(s, dict) else str(s)) or "").split("(")[0].strip()
        if name and name not in names:
            names.append(name)
    return names[:n]


def render_cover(spec, work):
    """Opening frame + thumbnail, drawn by the SAME card engine as the daily image posts
    (src/cardEngine.ts, 9:16 'story' format, via scripts/render_assets.py) so a Deep Dive looks like
    a GreaterNews card in the feed. Needs a built dist/. Returns the PNG path, or None (the build
    carries on without a cover)."""
    cover = spec.get("cover") or {}
    headline = (cover.get("headline") or "").strip()
    if not headline:
        print("  (no cover headline in spec - skipping the cover card)")
        return None
    query = cover.get("query") or next(
        (c["visual"]["query"] for c in spec["chapters"] if c["visual"]["type"] == "still"), "")
    photo_url, jpg = None, os.path.join(work, "cover_photo.jpg")
    if query and find_still(query, jpg):
        with Image.open(jpg) as im:
            im = im.convert("RGB")
            im.thumbnail((1600, 1600))
            buf = io.BytesIO()
            im.save(buf, "JPEG", quality=88)
        photo_url = "data:image/jpeg;base64," + base64.b64encode(buf.getvalue()).decode()

    label = f"ddcover-{spec['slug']}"
    card_spec = os.path.join(ROOT, "content", f"cards_{label}.json")
    out_dir = os.path.join(ROOT, "content", label)
    names = _source_names(spec.get("post") or {})
    card = {"slug": "cover", "template": "headline", "headline": headline,
            "subline": cover.get("subline", ""), "highlight": cover.get("highlight", ""),
            "footer": ("Source: " + " / ".join(names)) if names else "",
            "dim": cover.get("dim", 0.3), "formats": ["story"], "video": False,
            "photoUrl": photo_url, "articleUrl": None, "photoQuery": None if photo_url else (query or None)}
    with open(card_spec, "w", encoding="utf-8") as h:
        json.dump({"date": label, "cards": [card]}, h, ensure_ascii=False)
    try:
        p = subprocess.run([sys.executable, os.path.join(ROOT, "scripts", "render_assets.py"), label],
                           cwd=ROOT, capture_output=True, text=True, timeout=300,
                           stdin=subprocess.DEVNULL, creationflags=NO_WINDOW)
        png = os.path.join(out_dir, "assets", "cover_9x16.png")
        if not os.path.exists(png):
            print(f"  (cover render failed - continuing without it: {(p.stdout or p.stderr or '').strip()[-160:]})")
            return None
        dst = os.path.join(work, "cover.png")
        shutil.copy(png, dst)
        return dst
    except Exception as e:
        print(f"  (cover render failed - continuing without it: {e})")
        return None
    finally:
        try:
            os.remove(card_spec)
        except OSError:
            pass
        shutil.rmtree(out_dir, ignore_errors=True)


def end_card(path):
    """Closing brand card: GN badge, wordmark, tagline — matches the sign-off line."""
    img = Image.new("RGB", (W, H), (6, 6, 6))
    glow = Image.new("L", (W, H), 0)
    ImageDraw.Draw(glow).ellipse([int(W * 0.05), int(H * 0.26), int(W * 0.95), int(H * 0.66)], fill=60)
    img.paste(Image.new("RGB", (W, H), (243, 196, 87)), (0, 0), glow.filter(ImageFilter.GaussianBlur(170)))
    d = ImageDraw.Draw(img)
    cx, s = W // 2, 250
    by = int(H * 0.36)
    d.rounded_rectangle([cx - s // 2, by, cx + s // 2, by + s], radius=int(s * 0.24),
                        outline=(255, 255, 255), width=8, fill=(14, 14, 16))
    try:
        logo = Image.open(LOGO).convert("RGBA")
        logo.thumbnail((int(s * 0.68), int(s * 0.68)))
        img.paste(logo, (cx - logo.width // 2, by + (s - logo.height) // 2), logo)
    except Exception:
        d.text((cx, by + s // 2), "GN", font=font(int(s * 0.42)), fill=(243, 196, 87), anchor="mm")
    y = by + s + 90
    d.text((cx, y), "G R E A T E R N E W S", font=font(58), fill=(255, 255, 255), anchor="mm")
    d.line([cx - 90, y + 70, cx + 90, y + 70], fill=(243, 196, 87), width=5)
    d.text((cx, y + 150), "News You Can Trust", font=font(64), fill=(243, 196, 87), anchor="mm")
    try:
        small = ImageFont.truetype("C:/Windows/Fonts/Poppins-Medium.ttf", 40)
    except Exception:
        small = font(40)
    d.text((cx, y + 250), "Follow for more Deep Dives", font=small, fill=(200, 200, 200), anchor="mm")
    img.save(path)


def still_segment(png, secs, out, zoom=0.04):
    """A short silent clip of one image with a gentle push-in (the music bed plays over it)."""
    n = max(1, int(secs * 30))
    fc = (f"[0:v]scale=2160:3840,zoompan=z='1+{zoom}*on/{n}':d={n}:x='iw/2-(iw/zoom/2)':"
          f"y='ih/2-(ih/zoom/2)':s={W}x{H}:fps=30,setsar=1[v]")
    ffmpeg(["-i", png, "-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo", "-t", f"{secs:.3f}",
            "-filter_complex", fc, "-map", "[v]", "-map", "1:a"] + SEG_ENCODE + [out])
    return out


def ffmpeg(args, cwd=None):
    subprocess.run(["ffmpeg", "-y", "-loglevel", "error"] + args, check=True, cwd=cwd,
                   stdin=subprocess.DEVNULL, creationflags=NO_WINDOW)


def concat_reencode(segments, out):
    """Join segments by decoding + re-encoding as ONE continuous stream (concat filter), so the
    audio has no click at the joins (stream-copy of AAC pops at each boundary)."""
    ins = []
    for s in segments:
        ins += ["-i", s]
    streams = "".join(f"[{i}:v:0][{i}:a:0]" for i in range(len(segments)))
    fc = f"{streams}concat=n={len(segments)}:v=1:a=1[v][a]"
    ffmpeg(ins + ["-filter_complex", fc, "-map", "[v]", "-map", "[a]",
                  "-r", "30", "-c:v", "libx264", "-crf", "20", "-pix_fmt", "yuv420p",
                  "-video_track_timescale", "30000",
                  "-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-ac", "2", out])


def add_music(video_in, out_path, music):
    """Mix a bed under the voice. music='generated' synthesizes a calm pad; otherwise it's a file
    name in public/music/. Bed is low + faded so narration stays clear."""
    dur = duration(video_in)
    if music == "generated":
        # A-minor pad (110/C/E/A) with a slow ~16s swell so it breathes; low-passed + unobtrusive.
        chord = "0.30*sin(2*PI*110*t)+0.22*sin(2*PI*130.81*t)+0.20*sin(2*PI*164.81*t)+0.16*sin(2*PI*220*t)"
        expr = f"({chord})*(0.82+0.18*sin(2*PI*0.06*t))"
        bed_in = ["-f", "lavfi", "-i", f"aevalsrc={expr}:s=48000:d={dur:.2f}"]
        pre = "lowpass=f=850,"
    else:
        bed_in = ["-stream_loop", "-1", "-i", os.path.join(ROOT, "public", "music", music)]
        pre = ""
    fade_out = max(0.0, dur - 1.5)
    fc = (
        f"[1:a]{pre}afade=t=in:st=0:d=1.5,afade=t=out:st={fade_out:.2f}:d=1.5,volume=0.16,"
        "aformat=channel_layouts=stereo:sample_rates=48000[bed];"
        "[0:a][bed]amix=inputs=2:duration=first:normalize=0[a]"
    )
    ffmpeg(["-i", video_in] + bed_in + ["-t", f"{dur:.2f}", "-filter_complex", fc,
            "-map", "0:v", "-map", "[a]", "-c:v", "copy", "-c:a", "aac", "-b:a", "192k",
            "-ar", "48000", "-ac", "2", out_path])


def build(spec):
    slug = spec["slug"]
    for old in glob.glob(os.path.join(tempfile.gettempdir(), "gn-dd-*")):
        shutil.rmtree(old, ignore_errors=True)  # clear leftover temp dirs from past builds
    work = tempfile.mkdtemp(prefix="gn-dd-")
    os.makedirs(OUT_DIR, exist_ok=True)
    shutil.copy(POPPINS_BOLD, os.path.join(work, "Poppins-Bold.ttf"))
    brand = os.path.join(work, "brand.png")
    brand_header(brand)
    cap_style = spec.get("captions", "word")
    voice = spec.get("voice", "elevenlabs")
    groq_voice = spec.get("groq_voice")
    cache, segments = {}, []
    used_clips, credits = set(), []   # don't reuse one clip twice; credit every clip in the post

    # Opening card — the same design as the daily image posts; also saved as the video thumbnail.
    cover = render_cover(spec, work)
    if cover:
        shutil.copy(cover, os.path.join(OUT_DIR, f"{slug}_cover.png"))
        segments.append(still_segment(cover, COVER_SECS, os.path.join(work, "seg_cover.mp4")))
        print(f"  cover card OK -> content/deep-dive/{slug}_cover.png")

    # Guarantee the spoken brand sign-off closes every deep dive
    chapters = spec["chapters"]
    sign_off = "Follow GreaterNews, news you can trust."
    if chapters and "greaternews" not in chapters[-1]["say"].lower():
        chapters[-1]["say"] = chapters[-1]["say"].rstrip().rstrip(".") + ". " + sign_off

    for i, ch in enumerate(chapters):
        mp3 = os.path.join(work, f"v{i:02d}.mp3")
        words = synthesize(ch["say"], mp3, voice, groq_voice)
        write_ass(digitize_words(words), os.path.join(work, f"cap{i:02d}.ass"), cap_style)
        dur = duration(mp3) + 0.4

        vis = ch["visual"]
        key = (vis["type"], vis["query"], vis.get("file"))
        if key not in cache:
            base = os.path.join(work, f"a{len(cache)}")
            clip = find_clip(vis, base + ".clip", used_clips) if vis["type"] == "clip" else None
            if clip:
                cache[key] = ("clip", clip["path"], clip)
                if clip["credit"]:
                    credits.append(clip["credit"])
            elif vis["type"] == "broll" and pexels_video(vis["query"], base + ".mp4"):
                cache[key] = ("broll", base + ".mp4", None)
            elif find_still(vis["query"], base + ".jpg"):  # stills, and broll/clips with nothing that truly matches
                cache[key] = ("still", base + ".jpg", None)
            else:
                cache[key] = (vis["type"], None, None)
        kind, asset, clip = cache[key]
        overlay = brand

        if kind == "clip" and asset:   # real news footage, muted under the narration
            start = clip["start"] if clip["start"] is not None else _clip_start(duration(asset), dur)
            vin = ["-ss", f"{float(start):.2f}", "-stream_loop", "-1", "-i", asset]
            bg_fc, label_y = clip_layout(asset)
            overlay = overlay_with_label(brand, clip["label"], label_y, os.path.join(work, f"ovl{i:02d}.png"))
        elif kind == "broll" and asset:
            vin = ["-stream_loop", "-1", "-i", asset]
            bg_fc = f"[0:v]scale={W}:{H}:force_original_aspect_ratio=increase,crop={W}:{H},setsar=1[bg]"
        elif asset:  # still: pan WIDE images side-to-side (clean, full-frame); blurred-fill for tall ones
            n_frames = max(1, int(dur * 30))
            try:
                with Image.open(asset) as _im:
                    wide = (_im.width / _im.height) > (W / H)  # wider than the 9:16 frame
            except Exception:
                wide = False
            if wide:  # fill the height, slowly pan across the full width (no blur, no crop loss)
                vin = ["-loop", "1", "-i", asset]
                p = f"min(1,t/{dur:.3f})"
                ease = f"(0.5-0.5*cos(PI*{p}))"                 # ease in and out
                travel = 0.7                                    # pan across 70% of the width (gentler)
                xexpr = (f"(iw-2160)*(0.5+{travel}*({ease}-0.5))" if i % 2 == 0
                         else f"(iw-2160)*(0.5-{travel}*({ease}-0.5))")  # alt L<->R, centred
                bg_fc = (f"[0:v]scale=-2:3840,crop=2160:3840:x='{xexpr}':y=0,"
                         f"scale={W}:{H},setsar=1[bg]")
            else:  # very tall image: fit the whole thing over a blurred fill, ease-out zoom
                vin = ["-i", asset]
                peak = 1.22
                t = f"min(1,on/{max(1, n_frames - 1)})"
                ease = f"(1-pow(1-{t},2))"
                z = (f"(1.0+{peak - 1.0:.3f}*{ease})" if i % 2 == 0
                     else f"({peak:.3f}-{peak - 1.0:.3f}*{ease})")
                kb = (f"zoompan=z='{z}':d={n_frames}:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)'"
                      f":s={W}x{H}:fps=30")
                bg_fc = (
                    "[0:v]split=2[kbb][kbf];"
                    "[kbb]scale=2160:3840:force_original_aspect_ratio=increase,crop=2160:3840,"
                    "boxblur=30:2,eq=brightness=-0.10[kbg];"
                    "[kbf]scale=2160:3840:force_original_aspect_ratio=decrease[kfg];"
                    f"[kbg][kfg]overlay=(W-w)/2:(H-h)/2,{kb},setsar=1[bg]"
                )
        else:
            vin = ["-f", "lavfi", "-i", f"color=c=0x0b0b0d:s={W}x{H}:r=30"]
            bg_fc = f"[0:v]scale={W}:{H},setsar=1[bg]"
        fc = (
            f"{bg_fc};"
            f"[bg][1:v]overlay=0:0[hb];"
            f"[hb]subtitles=cap{i:02d}.ass:fontsdir=.[v];"
            f"[2:a]apad[aud]"  # pad voice with silence to the full clip length (a == v)
        )
        args = vin + ["-loop", "1", "-i", overlay, "-i", mp3, "-t", f"{dur:.3f}", "-filter_complex", fc,
                      "-map", "[v]", "-map", "[aud]",
                      "-r", "30", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-video_track_timescale", "30000",
                      "-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-ac", "2",
                      os.path.join(work, f"seg{i:02d}.mp4")]
        ffmpeg(args, cwd=work)
        segments.append(os.path.join(work, f"seg{i:02d}.mp4"))
        shown = kind + ("" if kind == vis["type"] else f" (no matching {vis['type']})")
        print(f"  chapter {i} ({shown}: {vis['query']}) {'OK' if asset else 'NO ASSET'} -> {dur:.1f}s")

    end_png = os.path.join(work, "end.png")
    end_card(end_png)
    segments.append(still_segment(end_png, END_SECS, os.path.join(work, "seg_end.mp4"), zoom=0.02))

    out = os.path.join(OUT_DIR, f"{slug}_9x16.mp4")
    music = spec.get("music")
    if music:
        concat_tmp = os.path.join(work, "concat.mp4")
        concat_reencode(segments, concat_tmp)
        add_music(concat_tmp, out, music)
    else:
        concat_reencode(segments, out)
    # Footage credits for the post text (deep_dive_publish.py) - rewritten every build so a rebuild
    # without clips doesn't leave stale credits behind.
    with open(os.path.join(OUT_DIR, f"{slug}_credits.json"), "w", encoding="utf-8", newline="\n") as h:
        json.dump({"footage": credits}, h, indent=2, ensure_ascii=False)
    print(f"Done: {out}  ({duration(out):.1f}s)")
    shutil.rmtree(work, ignore_errors=True)  # free the temp assets/segments


if __name__ == "__main__":
    spec_path = sys.argv[1] if len(sys.argv) > 1 else os.path.join(OUT_DIR, "spec.json")
    build(json.load(open(spec_path, encoding="utf-8")))
