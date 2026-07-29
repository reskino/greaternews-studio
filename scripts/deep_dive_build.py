"""GreaterNews Deep Dive assembler (CapCut-style, word-by-word captions).

Approved spec (chapters: narration + a visual) -> vertical explainer:
- ElevenLabs "with-timestamps" -> burned captions that reveal ONE WORD at a time (Poppins).
- Stills come from a broad search (Google/Serper -> Commons -> Openverse -> Pexels) so specific
  subjects (a Ghana Shell station, a Strait map) resolve; b-roll comes from Pexels video.
- Brand header on top: GREATERNEWS wordmark + the real GN logo in a rounded badge (like the cards).
- No on-screen sources card (sources go in the post text).
Composited + concatenated with ffmpeg. Keys from secrets.json (elevenlabs, pexels, serper).
Output: content/deep-dive/<slug>_9x16.mp4  (human review before publishing).
"""

import base64
import io
import json
import os
import shutil
import subprocess
import sys
import tempfile

import requests
from PIL import Image, ImageDraw, ImageFont

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SECRETS = json.load(open(os.path.join(ROOT, "secrets.json"), encoding="utf-8"))
OUT_DIR = os.path.join(ROOT, "content", "deep-dive")
LOGO = os.path.join(ROOT, "public", "logo.png")
POPPINS_BOLD = "C:/Windows/Fonts/Poppins-Bold.ttf"
UA = {"User-Agent": "Mozilla/5.0 (GreaterNews DeepDive)"}
W, H = 1080, 1920

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
    r = requests.post(
        "https://api.groq.com/openai/v1/audio/speech",
        headers={"Authorization": f"Bearer {c['api_key']}", "Content-Type": "application/json"},
        json={"model": c.get("tts_model", "canopylabs/orpheus-v1-english"), "input": text,
              "voice": voice_name or c.get("tts_voice", "hannah"), "response_format": "wav"},
        timeout=120,
    )
    r.raise_for_status()
    open(path, "wb").write(r.content)


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
    """ElevenLabs (word-accurate captions) if available, else Groq voice with estimated timing."""
    if voice == "elevenlabs":
        try:
            chars, starts, ends = eleven_timestamps(text, path)
            return words_from_alignment(chars, starts, ends)
        except Exception as e:
            print(f"  (ElevenLabs unavailable: {str(e)[:50]} -> Groq voice)")
    groq_tts(text, path, groq_voice)
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
        header, lines = ass_header(84, margin_v=520), _highlight_lines(words)
    else:
        header, lines = ass_header(116), _word_lines(words)
    open(path, "w", encoding="utf-8").write(header + "\n".join(lines) + "\n")


def duration(path):
    return float(subprocess.check_output(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "default=nk=1:nw=1", path], text=True
    ).strip())


def brand_header(path):
    """Transparent overlay: GREATERNEWS wordmark + GN logo in a rounded badge (as before)."""
    img = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    d.text((W / 2, int(H * 0.052)), "G R E A T E R N E W S", font=font(int(W * 0.03)), fill=(255, 255, 255, 210), anchor="mm")
    s, m = int(W * 0.11), int(W * 0.05)
    x, y = W - m - s, int(H * 0.028)
    d.rounded_rectangle([x, y, x + s, y + s], radius=int(s * 0.24), outline=(255, 255, 255, 235), width=5)
    try:
        logo = Image.open(LOGO).convert("RGBA")
        pad = int(s * 0.16)
        logo.thumbnail((s - 2 * pad, s - 2 * pad))
        img.alpha_composite(logo, (x + (s - logo.width) // 2, y + (s - logo.height) // 2))
    except Exception:
        d.text((x + s / 2, y + s / 2), "GN", font=font(int(s * 0.42)), fill=(243, 196, 87), anchor="mm")
    img.save(path)


def _download_img(url, path):
    data = requests.get(url, timeout=60, headers=UA).content
    im = Image.open(io.BytesIO(data)).convert("RGB")
    if min(im.size) < 400:
        raise ValueError("too small")
    im.save(path, "JPEG", quality=90)
    return True


def serper_images(q):
    key = (SECRETS.get("serper") or {}).get("api_key")
    if not key:
        return []
    r = requests.post("https://google.serper.dev/images", headers={"X-API-KEY": key, "Content-Type": "application/json"},
                      json={"q": q, "num": 10, "gl": "gh"}, timeout=30)
    return [i["imageUrl"] for i in r.json().get("images", []) if i.get("imageUrl")]


def commons_images(q):
    r = requests.get("https://commons.wikimedia.org/w/api.php", headers=UA, timeout=30, params={
        "action": "query", "format": "json", "generator": "search", "gsrnamespace": 6,
        "gsrsearch": q, "gsrlimit": 8, "prop": "imageinfo", "iiprop": "url", "iiurlwidth": 1400})
    out = []
    for p in (r.json().get("query", {}).get("pages", {}) or {}).values():
        ii = (p.get("imageinfo") or [{}])[0]
        u = ii.get("thumburl") or ii.get("url")
        if u and not u.lower().endswith(".svg"):
            out.append(u)
    return out


def openverse_images(q):
    r = requests.get("https://api.openverse.org/v1/images/", headers=UA, timeout=30, params={"q": q, "page_size": 8})
    return [i["url"] for i in r.json().get("results", []) if i.get("url")]


def pexels_photo(q):
    r = requests.get("https://api.pexels.com/v1/search", headers={"Authorization": SECRETS["pexels"]["api_key"]},
                     params={"query": q, "per_page": 8, "orientation": "portrait"}, timeout=30)
    return [(p["src"].get("large2x") or p["src"].get("original")) for p in r.json().get("photos", []) if p.get("src")]


def find_still(q, path):
    # Google Images first (best relevance for specific subjects), then licensed sources.
    for src in (serper_images, commons_images, openverse_images, pexels_photo):
        try:
            urls = src(q)
        except Exception:
            urls = []
        for u in urls:
            try:
                if _download_img(u, path):
                    return True
            except Exception:
                continue
    return False


def pexels_video(q, path):
    r = requests.get("https://api.pexels.com/videos/search", headers={"Authorization": SECRETS["pexels"]["api_key"]},
                     params={"query": q, "per_page": 8, "orientation": "portrait", "size": "medium"}, timeout=30)
    best = None
    for v in r.json().get("videos", []):
        for f in v["video_files"]:
            if (f.get("height") or 0) >= (f.get("width") or 0) and f.get("file_type") == "video/mp4":
                if best is None or (f.get("height") or 0) > best[0]:
                    best = ((f.get("height") or 0), f["link"])
    if not best:
        return False
    open(path, "wb").write(requests.get(best[1], timeout=120).content)
    return True


def ffmpeg(args, cwd=None):
    subprocess.run(["ffmpeg", "-y", "-loglevel", "error"] + args, check=True, cwd=cwd)


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
        # A-minor sustained pad (110/C/E/A), low-passed to keep it warm and unobtrusive.
        expr = "0.30*sin(2*PI*110*t)+0.22*sin(2*PI*130.81*t)+0.20*sin(2*PI*164.81*t)+0.16*sin(2*PI*220*t)"
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
    work = tempfile.mkdtemp(prefix="gn-dd-")
    os.makedirs(OUT_DIR, exist_ok=True)
    shutil.copy(POPPINS_BOLD, os.path.join(work, "Poppins-Bold.ttf"))
    brand = os.path.join(work, "brand.png")
    brand_header(brand)
    cap_style = spec.get("captions", "word")
    voice = spec.get("voice", "elevenlabs")
    groq_voice = spec.get("groq_voice")
    cache, segments = {}, []

    for i, ch in enumerate(spec["chapters"]):
        mp3 = os.path.join(work, f"v{i:02d}.mp3")
        words = synthesize(ch["say"], mp3, voice, groq_voice)
        write_ass(words, os.path.join(work, f"cap{i:02d}.ass"), cap_style)
        dur = duration(mp3) + 0.4

        vis = ch["visual"]
        key = (vis["type"], vis["query"])
        if key not in cache:
            asset = os.path.join(work, f"a{len(cache)}" + (".mp4" if vis["type"] == "broll" else ".jpg"))
            ok = pexels_video(vis["query"], asset) if vis["type"] == "broll" else find_still(vis["query"], asset)
            cache[key] = asset if ok else None
        asset = cache[key]

        if vis["type"] == "broll" and asset:
            vin = ["-stream_loop", "-1", "-i", asset]
            bg = f"scale={W}:{H}:force_original_aspect_ratio=increase,crop={W}:{H},setsar=1"
        elif asset:  # still with Ken Burns: single frame -> zoompan generates the zoom over N frames
            n_frames = max(1, int(dur * 30))
            vin = ["-i", asset]
            bg = (
                "scale=2160:3840:force_original_aspect_ratio=increase,crop=2160:3840,"
                f"zoompan=z='min(zoom+0.0012,1.20)':d={n_frames}:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':s={W}x{H}:fps=30,setsar=1"
            )
        else:
            vin = ["-f", "lavfi", "-i", f"color=c=0x0b0b0d:s={W}x{H}:r=30"]
            bg = f"scale={W}:{H},setsar=1"
        fc = (
            f"[0:v]{bg}[bg];"
            f"[bg][1:v]overlay=0:0[hb];"
            f"[hb]subtitles=cap{i:02d}.ass:fontsdir=.[v];"
            f"[2:a]apad[aud]"  # pad voice with silence to the full clip length (a == v)
        )
        args = vin + ["-loop", "1", "-i", brand, "-i", mp3, "-t", f"{dur:.3f}", "-filter_complex", fc,
                      "-map", "[v]", "-map", "[aud]",
                      "-r", "30", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-video_track_timescale", "30000",
                      "-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-ac", "2",
                      os.path.join(work, f"seg{i:02d}.mp4")]
        ffmpeg(args, cwd=work)
        segments.append(os.path.join(work, f"seg{i:02d}.mp4"))
        print(f"  chapter {i} ({vis['type']}: {vis['query']}) {'OK' if asset else 'NO ASSET'} -> {dur:.1f}s")

    out = os.path.join(OUT_DIR, f"{slug}_9x16.mp4")
    music = spec.get("music")
    if music:
        concat_tmp = os.path.join(work, "concat.mp4")
        concat_reencode(segments, concat_tmp)
        add_music(concat_tmp, out, music)
    else:
        concat_reencode(segments, out)
    print(f"Done: {out}  ({duration(out):.1f}s)")


if __name__ == "__main__":
    spec_path = sys.argv[1] if len(sys.argv) > 1 else os.path.join(OUT_DIR, "spec.json")
    build(json.load(open(spec_path, encoding="utf-8")))
