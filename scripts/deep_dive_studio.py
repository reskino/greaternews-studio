"""GreaterNews Deep Dive Studio — a LOCAL control panel (runs on your machine).

Start it:
    python scripts/deep_dive_studio.py
Then open http://localhost:5200 in your browser. From there you can:
  - Research a topic  (writes a cited brief + spec via the Claude CLI)  [optional]
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


def groq_curate(stories, want=6):
    """Fast editorial triage: rank which headlines make the best 90s explainers + suggest an angle."""
    g = _secrets().get("groq", {})
    key = g.get("api_key")
    if not key or not stories:
        return []
    model = g.get("llm_model", "llama-3.3-70b-versatile")
    listing = "\n".join(
        f"{i}. [{s['bucket']}] {s['title']} - {s.get('source', '')}"
        for i, s in enumerate(stories))
    system = (
        "You are the commissioning editor for GreaterNews, a Ghana-first channel making 90-second "
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
        data = json.loads(r.json()["choices"][0]["message"]["content"])
        picks = []
        for p in data.get("picks", []):
            i = p.get("index")
            if isinstance(i, int) and 0 <= i < len(stories):
                s = dict(stories[i])
                s.update(score=p.get("score"), angle=p.get("angle", ""),
                         why_now=p.get("why_now", ""),
                         topic=p.get("topic") or stories[i]["title"])
                picks.append(s)
        return picks
    except Exception:
        return []


PAGE = r'''<!doctype html><html><head><meta charset=utf8><meta name=viewport content="width=device-width,initial-scale=1">
<title>GreaterNews — Deep Dive Studio</title><style>
:root{--gold:#f3c457;--bg:#0e0e11;--card:#17171c;--line:#2a2a33;--tx:#eee}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--tx);font:15px/1.5 'Segoe UI',system-ui,sans-serif}
header{padding:16px 22px;border-bottom:1px solid var(--line);display:flex;align-items:center;gap:10px}
header b{color:var(--gold)} .wrap{max-width:900px;margin:0 auto;padding:20px}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:16px;margin:14px 0}
h3{margin:.2em 0 .6em;font-size:14px;letter-spacing:.04em;text-transform:uppercase;color:var(--gold)}
label{display:block;font-size:12px;opacity:.7;margin:8px 0 3px}
input,select,textarea{width:100%;background:#0c0c0f;color:var(--tx);border:1px solid var(--line);border-radius:8px;padding:9px}
textarea{resize:vertical} .row{display:flex;gap:10px;flex-wrap:wrap}.row>*{flex:1;min-width:120px}
button{background:var(--gold);color:#111;border:0;border-radius:999px;padding:10px 18px;font-weight:700;cursor:pointer}
button.ghost{background:transparent;color:var(--tx);border:1px solid var(--line)}
button:disabled{opacity:.5;cursor:default}
.ch{border:1px solid var(--line);border-radius:10px;padding:10px;margin:8px 0}.ch .row{align-items:end}
.small{font-size:12px;opacity:.65}.log{white-space:pre-wrap;font:12px ui-monospace,monospace;background:#0c0c0f;border:1px solid var(--line);border-radius:8px;padding:10px;max-height:220px;overflow:auto}
video{width:100%;border-radius:10px;margin-top:10px;background:#000}.x{color:#ff6b6b}.ok{color:#7CFC9B}
details summary{cursor:pointer;color:var(--gold)}
.hotitem{border:1px solid var(--line);border-radius:10px;padding:10px;margin:8px 0}
.tag{background:var(--gold);color:#111;border-radius:6px;padding:1px 7px;font-size:11px;font-weight:700;margin-right:8px}
.hotitem a{color:var(--gold)}
</style></head><body>
<header><b>◆ GreaterNews</b> — Deep Dive Studio <span class=small style="margin-left:auto">local · ffmpeg pipeline</span></header>
<div class=wrap>

<div class=card>
  <h3>Topic</h3>
  <div class=row><input id=topic placeholder="e.g. Strait of Hormuz tensions and Ghana fuel prices">
  <button class=ghost style="flex:0 0 auto" onclick=research()>Research → brief + script</button></div>
  <p class=small>Researching web-searches the story and writes a cited brief + a draft script (a few minutes). Or just edit the chapters below.</p>
  <div class=row style="margin-top:2px"><button class=ghost style="flex:0 0 auto" onclick=hot()>🔥 Find hot stories</button><button class=ghost style="flex:0 0 auto" onclick=surprise()>🎲 Surprise me</button><span class=small style="align-self:center">world · Ghana · Africa · business · energy · tech · sports · health</span></div>
  <div id=hotlist style="display:none;margin-top:8px"></div>
  <div id=rlog class=log style="display:none"></div>
</div>

<div class=card>
  <h3>Brief <span class=small>(review before building)</span></h3>
  <details><summary>Show brief</summary><div id=brief class=log style="max-height:340px;margin-top:8px">—</div></details>
</div>

<div class=card>
  <h3>Settings</h3>
  <div class=row>
    <div><label>Voice</label><select id=voice><option value=elevenlabs>ElevenLabs (word-accurate)</option><option value=groq>Groq (free)</option></select></div>
    <div><label>Groq voice</label><select id=groq_voice><option>hannah</option><option>autumn</option><option>diana</option><option>austin</option><option>daniel</option><option>troy</option></select></div>
    <div><label>Captions</label><select id=captions><option value=highlight>Highlight box</option><option value=word>Word-by-word</option></select></div>
    <div><label>Music</label><select id=music><option value=generated>Generated pad</option><option value="">None</option></select></div>
  </div>
  <label>Post caption (Facebook) — the hook</label><textarea id=caption rows=3></textarea>
  <label>Body — 2-3 lines of key facts</label><textarea id=body rows=3></textarea>
  <label>Sources — one per line: <span class=small>Name | https://url</span></label><textarea id=sources rows=5 placeholder="U.S. EIA | https://www.eia.gov/...
CNN | https://www.cnn.com/..."></textarea>
  <label>Call to action</label><input id=cta placeholder="🔔 Follow GreaterNews — news you can trust.">
  <label>Hashtags (space separated)</label><input id=hashtags placeholder="#GreaterNews #Ghana #Explainer">
</div>

<div class=card>
  <h3>Chapters</h3><div id=chapters></div>
  <button class=ghost onclick=addCh()>+ Add chapter</button>
</div>

<div class=card>
  <div class=row><button onclick=save()>Save</button>
  <button onclick=build()>Build video</button>
  <button class=ghost onclick=schedule()>Queue + Schedule to Facebook</button></div>
  <div id=log class=log style="display:none;margin-top:12px"></div>
  <video id=vid controls style="display:none"></video>
</div>
</div>
<script>
const $=id=>document.getElementById(id); let spec={};
function chRow(c={visual:{type:'broll',query:''},say:''}){const d=document.createElement('div');d.className='ch';
 d.innerHTML=`<div class=row><div style="flex:0 0 120px"><label>Type</label><select class=ctype><option value=broll>b-roll</option><option value=still>still</option></select></div>
 <div><label>Image/clip search</label><input class=cq></div>
 <button class=ghost style="flex:0 0 auto" onclick="this.closest('.ch').remove()">✕</button></div>
 <label>Narration (spoken)</label><textarea class=csay rows=2></textarea>`;
 d.querySelector('.ctype').value=c.visual.type;d.querySelector('.cq').value=c.visual.query||'';d.querySelector('.csay').value=c.say||'';
 return d;}
function addCh(c){$('chapters').appendChild(chRow(c));}
function srcToLine(s){return (typeof s==='string')?s:(s.url?`${s.name} | ${s.url}`:(s.name||''));}
function lineToSrc(l){const i=l.indexOf('|');return i>=0?{name:l.slice(0,i).trim(),url:l.slice(i+1).trim()}:{name:l.trim()};}
function load(s){spec=s;const p=s.post||{};$('voice').value=s.voice||'elevenlabs';$('groq_voice').value=s.groq_voice||'hannah';
 $('captions').value=s.captions||'highlight';$('music').value=s.music||'';
 $('caption').value=p.caption||'';$('body').value=p.body||'';
 $('sources').value=(p.sources||[]).map(srcToLine).join('\n');
 $('cta').value=p.cta||'';$('hashtags').value=(p.hashtags||[]).join(' ');
 $('chapters').innerHTML='';(s.chapters||[]).forEach(addCh);}
function collect(){const chapters=[...document.querySelectorAll('.ch')].map(d=>({
  visual:{type:d.querySelector('.ctype').value,query:d.querySelector('.cq').value.trim()},
  say:d.querySelector('.csay').value.trim()})).filter(c=>c.say);
 const post={caption:$('caption').value.trim(),body:$('body').value.trim(),
  sources:$('sources').value.split('\n').map(x=>x.trim()).filter(Boolean).map(lineToSrc),
  cta:$('cta').value.trim(),hashtags:$('hashtags').value.split(/\s+/).map(x=>x.trim()).filter(Boolean)};
 return {...spec,voice:$('voice').value,groq_voice:$('groq_voice').value,captions:$('captions').value,
  music:$('music').value,post,chapters};}
async function save(){const r=await fetch('/spec',{method:'POST',body:JSON.stringify(collect())});const j=await r.json();spec=j.spec;flash('Saved.');}
function flash(m,cls=''){const l=$('log');l.style.display='block';l.innerHTML+=`\n${cls?`<span class=${cls}>`:''}${m}${cls?'</span>':''}`;l.scrollTop=l.scrollHeight;}
async function build(){await save();flash('Building… (1–2 min, TTS + b-roll + ffmpeg)');const r=await fetch('/build',{method:'POST'});const j=await r.json();
 flash(j.log.split('\n').slice(-8).join('\n'), j.ok?'ok':'x');
 if(j.ok){const v=$('vid');v.style.display='block';v.src='/video?'+Date.now();v.load();flash('Done — preview above.','ok');}}
async function schedule(){if(!confirm('Queue + schedule this to Facebook (2h out, reviewable in FB first)?'))return;
 await save();flash('Scheduling…');const r=await fetch('/schedule',{method:'POST'});const j=await r.json();flash(j.log.split('\n').slice(-10).join('\n'), j.ok?'ok':'x');}
async function research(){const t=$('topic').value.trim();if(!t)return;const rl=$('rlog');rl.style.display='block';
 let sec=0;const tick=()=>{rl.textContent='🔎 Researching "'+t+'" … '+sec+'s  (usually 1–3 min: searching the web + writing the cited brief)';};tick();
 const timer=setInterval(()=>{sec++;tick();},1000);
 try{const r=await fetch('/research',{method:'POST',body:JSON.stringify({topic:t})});const j=await r.json();clearInterval(timer);
  if(j.ok){await refresh();rl.textContent='✅ Done in '+sec+'s — brief + chapters loaded below. Review them, then Build.';}
  else{rl.textContent='❌ Research did not finish.\n'+((j.log||'').split('\n').slice(-8).join('\n'));}}
 catch(e){clearInterval(timer);rl.textContent='❌ Research failed: '+e;}}
function srcMeta(s){return `<div class=small>${s.source||''}${s.date?' · '+s.date:''}${s.link?` · <a href="${s.link}" target=_blank rel=noopener>open</a>`:''}</div>`;}
async function hot(){const el=$('hotlist');el.style.display='block';el.innerHTML='<span class=small>Scanning headlines and ranking them for explainers…</span>';
 let j;try{j=await (await fetch('/curate')).json();}catch(e){el.innerHTML='<span class=x>Search failed.</span>';return;}
 const all=j.all||[];window._hot=all;window._picks=j.picks||[];
 if(!all.length){el.innerHTML='<span class=x>No results — check the Serper key / connection.'+(j.error?(' ('+j.error+')'):'')+'</span>';return;}
 let html='';
 if(window._picks.length){html+='<h3 style="margin:4px 0">✨ Best for a deep dive</h3>'+window._picks.map((s,i)=>`<div class=hotitem>
   <div><span class=tag>${s.score!=null?('★ '+s.score):s.bucket}</span>${s.title}</div>
   ${(s.angle||s.why_now)?`<div class=small style="color:#cdb06a">${s.angle||''}${(s.angle&&s.why_now)?' — ':''}${s.why_now||''}</div>`:''}
   ${srcMeta(s)}<button class=ghost style="margin-top:6px;padding:5px 12px" onclick="pickTopic(${i})">Use this →</button></div>`).join('');}
 html+='<h3 style="margin:12px 0 4px">More headlines</h3>'+all.map((s,i)=>`<div class=hotitem><div><span class=tag>${s.bucket}</span>${s.title}</div>
  ${srcMeta(s)}<button class=ghost style="margin-top:6px;padding:5px 12px" onclick="pick(${i})">Use this →</button></div>`).join('');
 el.innerHTML=html;}
function pick(i){$('topic').value=window._hot[i].title;window.scrollTo({top:0,behavior:'smooth'});$('topic').focus();}
function pickTopic(i){const s=window._picks[i];$('topic').value=s.topic||s.title;window.scrollTo({top:0,behavior:'smooth'});$('topic').focus();}
async function surprise(){const rl=$('rlog');rl.style.display='block';rl.textContent='🎲 Finding the hottest explainer-worthy story…';
 let j;try{j=await (await fetch('/curate')).json();}catch(e){rl.textContent='Search failed.';return;}
 const top=(j.picks&&j.picks[0])||(j.all&&j.all[0]);if(!top){rl.textContent='No stories found — check the Serper key.';return;}
 $('topic').value=top.topic||top.title;rl.textContent='🎲 Picked: '+top.title+'\nResearching…';await research();}
async function refresh(){load(await (await fetch('/spec')).json());$('brief').textContent=await (await fetch('/brief')).text();}
refresh();
</script></body></html>'''


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
            return self._send(200, PAGE, "text/html; charset=utf-8")
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
        if path == "/trending":
            try:
                return self._send(200, json.dumps({"stories": trending_stories()}))
            except Exception as e:
                return self._send(200, json.dumps({"stories": [], "error": str(e)}))
        if path == "/curate":
            try:
                stories = trending_stories()
                return self._send(200, json.dumps({"picks": groq_curate(stories), "all": stories}))
            except Exception as e:
                return self._send(200, json.dumps({"picks": [], "all": [], "error": str(e)}))
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
        if path in ("/build", "/schedule", "/research"):
            if not JOB_LOCK.acquire(blocking=False):
                return self._send(200, json.dumps(
                    {"ok": False, "log": "Another job (build/research/schedule) is already running — "
                                         "wait for it to finish."}))
            try:
                if path == "/build":
                    code, out = run([os.path.join("scripts", "deep_dive_build.py"), SPEC])
                    return self._send(200, json.dumps({"ok": code == 0, "log": out}))
                if path == "/schedule":
                    slug = json.load(open(SPEC, encoding="utf-8"))["slug"]
                    c1, o1 = run([os.path.join("scripts", "deep_dive_publish.py"), SPEC])
                    c2, o2 = run([os.path.join("scripts", "publish.py"), "--date", f"deepdive_{slug}",
                                  "--all", "--schedule", "+2h"])
                    return self._send(200, json.dumps({"ok": c1 == 0 and c2 == 0, "log": o1 + "\n" + o2}))
                topic = json.loads(body).get("topic", "").strip()  # /research
                return self._research(topic)
            finally:
                JOB_LOCK.release()
        self._send(404, "{}")

    def _research(self, topic):
        slug = re.sub(r"[^a-z0-9]+", "-", topic.lower()).strip("-")[:40] or "deep-dive"
        prompt = (
            f"You are the GreaterNews deep-dive researcher. Research this story for a Ghana-first news "
            f"channel: \"{topic}\". Web-search and verify with 2+ independent current sources. "
            f"Write TWO files. (1) content/deep-dive/{slug}.md: a cited brief — one-line summary, a Ghana/"
            f"Africa angle if relevant, timeline, key facts (each with a source), the numbers, what's next, "
            f"and a numbered References list with URLs. (2) content/deep-dive/spec.json with EXACTLY this shape: "
            f'{{"slug":"{slug}","captions":"highlight","music":"generated","voice":"groq","groq_voice":"hannah",'
            f'"post":{{"caption":"a punchy 1-2 sentence hook","body":"2-3 lines of the key facts",'
            f'"sources":[{{"name":"Outlet (what it backs)","url":"https://real-url-from-your-research"}}],'
            f'"cta":"Follow GreaterNews - news you can trust.","hashtags":["#GreaterNews","#Ghana","#Explainer"]}},'
            f'"chapters":[{{"say":"one spoken sentence ~18-26 words, facts only","visual":{{"type":"broll or still",'
            f'"query":"a concrete Pexels/Google image subject"}}}}]}} — 6 to 7 chapters that arc: hook, what/where, '
            f"why it matters, why now, the numbers, the local impact, what's next. Facts only from your sources. "
            f"The final chapter's spoken 'say' MUST end with the exact sign-off: Follow GreaterNews, news you can trust."
        )
        try:
            p = subprocess.run(
                ["claude", "-p", prompt,
                 "--permission-mode", "bypassPermissions",
                 "--output-format", "text",
                 "--allowedTools", "Read,Write,WebSearch,WebFetch,Glob,Grep"],
                cwd=ROOT, capture_output=True, text=True, timeout=900,
                stdin=subprocess.DEVNULL, creationflags=NO_WINDOW)
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
            return self._send(200, json.dumps({"ok": ok, "log": (p.stdout or "")[-1200:] + (p.stderr or "")[-400:]}))
        except Exception as e:
            return self._send(200, json.dumps({"ok": False, "log": f"research failed: {e}"}))

    def log_message(self, *a):
        pass


if __name__ == "__main__":
    print(f"GreaterNews Deep Dive Studio -> http://localhost:{PORT}")
    ThreadingHTTPServer(("127.0.0.1", PORT), H).serve_forever()
