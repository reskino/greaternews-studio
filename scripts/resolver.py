"""GreaterNews photo-search query resolver.

A tiny local endpoint the Card Studio calls to turn a vague image-search query
(e.g. "DVLA CEO") into a disambiguated, Ghana-aware search plan via Claude. The
Anthropic API key stays here (read from secrets.json), never in the browser.

Run it alongside the studio:
    python scripts/resolver.py
Then the studio's photo search uses it automatically (falling back to its
built-in heuristics if this isn't running).

Reads the key from secrets.json ("anthropic": {"api_key": "sk-ant-..."}) or the
ANTHROPIC_API_KEY environment variable.
"""

import json
import os
import sys
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import requests

# Windows consoles default to cp1252, which can't print some characters.
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SECRETS_PATH = os.path.join(ROOT, "secrets.json")
PORT = 5199
MODEL = "claude-opus-4-8"
MESSAGES_URL = "https://api.anthropic.com/v1/messages"

# Text-to-speech defaults (overridable in secrets.json).
DEFAULT_GOOGLE_VOICE = "en-GB-Neural2-B"
DEFAULT_ELEVEN_VOICE = "cjVigY5qzO86Huf0OWal"  # ElevenLabs "Eric" — premade, usable on the free tier
DEFAULT_GROQ_TTS_MODEL = "canopylabs/orpheus-v1-english"  # Groq Orpheus TTS (needs one-time terms acceptance)
DEFAULT_GROQ_TTS_VOICE = "diana"  # valid Orpheus voices: autumn diana hannah austin daniel troy
DEFAULT_GROQ_LLM_MODEL = "llama-3.3-70b-versatile"

# System prompt for drafting the video script: a short on-screen caption + a fuller spoken sentence
# + a photo subject, per beat.
# Rich, few-shot drafting prompt (authored by Claude) so the free Groq model produces
# broadcast-quality scripts. Keep in sync with src/videoBeats.ts and cloudflare-worker/tts-proxy.js.
BEATS_SYSTEM_PROMPT = """You are a senior broadcast news scriptwriter for GreaterNews, a Ghana-first news channel. You turn a verified story into the script for a short vertical news video.

You are given a headline, a line of context, and sometimes fuller story details. Write 4 to 6 beats that carry the story in a clear arc: what happened, the key detail, why it matters or who it affects, then what is next or the source. Each beat builds on the one before; never repeat a point.

For EACH beat return four fields:
- "label": a 1-3 word ALL-CAPS section tag (e.g. THE STORY, THE DETAIL, THE NUMBERS, WHO, WHY IT MATTERS, WHAT'S NEXT, THE SOURCE).
- "caption": the on-screen text for the slide - a SHORT punchy phrase, max 6 words, NOT a sentence, no ending period.
- "say": what the presenter SAYS for this beat - ONE natural, flowing spoken sentence of about 18 to 28 words. Use active voice and broadcast cadence, lead with the news, vary how each sentence opens, one idea per beat. Write numbers, money and dates the way they are SPOKEN (e.g. "three hundred sixty million dollars"), and expand an acronym the first time it is said. No filler, no hedging.
- "image": a concrete, searchable photo subject to show behind this beat - a real person, place, building, organisation or object, Ghana-aware. Use "" if nothing safe or relevant (tragedy, crime victims, private individuals).

Hard rules:
- Use ONLY facts in the headline, context or details. Never invent names, numbers, quotes, dates or outcomes. If a fact is not given, do not imply it.
- The headline is spoken first as the hook and a closing line is added automatically - do NOT repeat either.
- No hashtags, no emojis, no timestamps, no stage directions, no markdown.
- If the story is thin, write fewer, stronger beats rather than padding.

Example input:
Headline: Ghana secures $360m World Bank loan to fix the power grid
Context: The financing targets grid reliability and reducing nationwide outages.
Example output:
{"scenes":[{"label":"THE STORY","caption":"$360m power deal","say":"Ghana has secured a three hundred and sixty million dollar loan from the World Bank to overhaul its struggling power sector.","image":"World Bank headquarters Washington"},{"label":"WHERE IT GOES","caption":"Fixing the grid","say":"The funding is earmarked for modernising the national grid and cutting the frequent outages that disrupt homes and businesses.","image":"electricity pylons"},{"label":"WHY IT MATTERS","caption":"Fewer blackouts","say":"More reliable power would ease the dumsor blackouts that have long frustrated households and forced factories to slow production.","image":"Accra skyline at night"},{"label":"WHAT'S NEXT","caption":"Awaiting approval","say":"Officials say the rollout begins once parliament approves the agreement in the weeks ahead.","image":"Parliament House Accra"}]}

Respond with JSON only, in exactly this shape: {"scenes":[{"label":"","caption":"","say":"","image":""}]}"""

BEATS_JSON_SCHEMA = {
    "type": "object",
    "additionalProperties": False,
    "properties": {
        "scenes": {
            "type": "array",
            "items": {
                "type": "object",
                "additionalProperties": False,
                "properties": {
                    "label": {"type": "string"},
                    "caption": {"type": "string"},
                    "say": {"type": "string"},
                    "image": {"type": "string"},
                },
                "required": ["label", "caption", "say", "image"],
            },
        },
    },
    "required": ["scenes"],
}


def clean_scenes(scenes):
    clean = []
    for scene in scenes or []:
        if not isinstance(scene, dict):
            continue
        caption = str(scene.get("caption", "")).strip()
        say = str(scene.get("say", "")).strip()
        if not caption and not say:
            continue
        clean.append(
            {
                "label": str(scene.get("label", "")).strip(),
                "caption": caption,
                "say": say,
                "image": str(scene.get("image", "")).strip(),
            }
        )
    return clean


def beats_user_message(headline, subline, details, source):
    return "\n".join(
        part
        for part in [
            f"Headline (the hook - do NOT repeat): {headline}",
            f"Context: {subline}" if subline else "",
            f"Story details:\n{details}" if details else "",
            f"Source: {source}" if source else "",
        ]
        if part
    )

SYSTEM_PROMPT = (
    "You help a Ghana-first news channel (GreaterNews) find a LICENSED photo for a news card.\n"
    "The user types a short image-search query. Turn it into a disambiguated search plan for\n"
    "free image sources (Wikimedia Commons, Wikipedia lead images, Openverse).\n\n"
    "Rules:\n"
    "- Default AMBIGUOUS acronyms and bodies to their GHANA meaning (e.g. \"DVLA\" is Ghana's\n"
    "  Driver and Vehicle Licensing Authority, not the UK agency).\n"
    "- If the query names an organisation plus a role (\"DVLA CEO\", \"GRA boss\", \"the IGP\"),\n"
    "  it wants a portrait of that office-holder. Only put a name in \"person\" if you are\n"
    "  genuinely confident of the CURRENT holder; otherwise leave it \"\" and depict the\n"
    "  organisation (a wrong face is far worse than a neutral building/logo).\n"
    "- searchQueries: 3-6 precise queries, best first: the person (if known), then the full\n"
    "  organisation name, then its headquarters/logo, then a relevant place or concept.\n"
    "- excludeTerms: words that would reveal a WRONG match (for Ghana's DVLA: \"Swansea\",\n"
    "  \"Dundee\", \"United Kingdom\"). Empty if none apply.\n"
    "- sensitive: true for tragedy, crime, victims, or minors (skip depicting a person).\n"
    "- interpretation: one short human-readable line describing what you think they mean."
)

SCHEMA = {
    "type": "object",
    "additionalProperties": False,
    "properties": {
        "interpretation": {"type": "string"},
        "entity": {"type": "string"},
        "person": {"type": "string"},
        "country": {"type": "string"},
        "searchQueries": {"type": "array", "items": {"type": "string"}},
        "excludeTerms": {"type": "array", "items": {"type": "string"}},
        "sensitive": {"type": "boolean"},
    },
    "required": ["interpretation", "entity", "person", "country", "searchQueries", "excludeTerms", "sensitive"],
}


def load_api_key():
    if os.path.exists(SECRETS_PATH):
        try:
            with open(SECRETS_PATH, encoding="utf-8") as handle:
                data = json.load(handle)
            key = (data.get("anthropic") or {}).get("api_key")
            if key:
                return key
        except Exception as error:
            print(f"  (could not read secrets.json: {error})")
    return os.environ.get("ANTHROPIC_API_KEY")


def resolve(query, context, api_key):
    user = f"Query: {query}\nStory context: {context}" if context else f"Query: {query}"
    response = requests.post(
        MESSAGES_URL,
        headers={
            "x-api-key": api_key,
            "anthropic-version": "2023-06-01",
            "content-type": "application/json",
        },
        json={
            "model": MODEL,
            "max_tokens": 512,
            "output_config": {"effort": "low", "format": {"type": "json_schema", "schema": SCHEMA}},
            "system": SYSTEM_PROMPT,
            "messages": [{"role": "user", "content": user}],
        },
        timeout=30,
    )
    response.raise_for_status()
    data = response.json()
    text = next((b.get("text") for b in data.get("content", []) if b.get("type") == "text"), None)
    if not text:
        raise ValueError("no text block in response")
    return json.loads(text)


def load_secrets_dict():
    if os.path.exists(SECRETS_PATH):
        try:
            with open(SECRETS_PATH, encoding="utf-8") as handle:
                return json.load(handle)
        except Exception:
            return {}
    return {}


def google_tts(text, key, voice):
    lang = "-".join(voice.split("-")[:2]) or "en-GB"
    response = requests.post(
        f"https://texttospeech.googleapis.com/v1/text:synthesize?key={key}",
        json={
            "input": {"text": text},
            "voice": {"languageCode": lang, "name": voice},
            "audioConfig": {"audioEncoding": "MP3"},
        },
        timeout=45,
    )
    response.raise_for_status()
    import base64

    return base64.b64decode(response.json()["audioContent"])


def elevenlabs_tts(text, key, voice_id):
    response = requests.post(
        f"https://api.elevenlabs.io/v1/text-to-speech/{voice_id}",
        headers={"xi-api-key": key, "Content-Type": "application/json", "Accept": "audio/mpeg"},
        json={"text": text, "model_id": "eleven_multilingual_v2"},
        timeout=60,
    )
    response.raise_for_status()
    return response.content


def groq_tts(text, key, model, voice):
    response = requests.post(
        "https://api.groq.com/openai/v1/audio/speech",
        headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"},
        json={"model": model, "input": text, "voice": voice, "response_format": "wav"},
        timeout=60,
    )
    response.raise_for_status()
    return response.content


# Returns (audio_bytes, content_type, None) on success, or (None, None, error_message) on failure.
# `name` optionally overrides the specific voice within the engine (e.g. a Groq/Orpheus voice).
def synthesize(text, voice, name=""):
    secrets = load_secrets_dict()
    if voice == "elevenlabs":
        conf = secrets.get("elevenlabs", {})
        key = conf.get("api_key") or os.environ.get("ELEVENLABS_API_KEY")
        if not key:
            return None, None, "no elevenlabs.api_key in secrets.json"
        return elevenlabs_tts(text, key, name or conf.get("voice_id") or DEFAULT_ELEVEN_VOICE), "audio/mpeg", None
    if voice == "groq":
        conf = secrets.get("groq", {})
        key = conf.get("api_key") or os.environ.get("GROQ_API_KEY")
        if not key:
            return None, None, "no groq.api_key in secrets.json"
        model = conf.get("tts_model") or DEFAULT_GROQ_TTS_MODEL
        return groq_tts(text, key, model, name or conf.get("tts_voice") or DEFAULT_GROQ_TTS_VOICE), "audio/wav", None
    conf = secrets.get("google_tts", {})
    key = conf.get("api_key") or os.environ.get("GOOGLE_TTS_API_KEY")
    if not key:
        return None, None, "no google_tts.api_key in secrets.json"
    return google_tts(text, key, conf.get("voice") or DEFAULT_GOOGLE_VOICE), "audio/mpeg", None


def claude_beats(api_key, headline, subline, details, source):
    response = requests.post(
        MESSAGES_URL,
        headers={"x-api-key": api_key, "anthropic-version": "2023-06-01", "content-type": "application/json"},
        json={
            "model": MODEL,
            "max_tokens": 900,
            "output_config": {"effort": "low", "format": {"type": "json_schema", "schema": BEATS_JSON_SCHEMA}},
            "system": BEATS_SYSTEM_PROMPT,
            "messages": [{"role": "user", "content": beats_user_message(headline, subline, details, source)}],
        },
        timeout=40,
    )
    response.raise_for_status()
    data = response.json()
    text = next((b.get("text") for b in data.get("content", []) if b.get("type") == "text"), None)
    return clean_scenes(json.loads(text).get("scenes", []) if text else [])


def groq_beats(headline, subline, details, source):
    secrets = load_secrets_dict()
    conf = secrets.get("groq", {})
    key = conf.get("api_key") or os.environ.get("GROQ_API_KEY")
    if not key:
        raise ValueError("no groq.api_key in secrets.json")
    response = requests.post(
        "https://api.groq.com/openai/v1/chat/completions",
        headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"},
        json={
            "model": conf.get("llm_model") or DEFAULT_GROQ_LLM_MODEL,
            "temperature": 0.4,
            "max_tokens": 900,
            "response_format": {"type": "json_object"},
            "messages": [
                {"role": "system", "content": BEATS_SYSTEM_PROMPT},
                {"role": "user", "content": beats_user_message(headline, subline, details, source)},
            ],
        },
        timeout=30,
    )
    response.raise_for_status()
    return clean_scenes(json.loads(response.json()["choices"][0]["message"]["content"]).get("scenes", []))


# Draft the beats: Claude first (best writing), Groq as backup. Returns (scenes, error).
def draft_beats(headline, subline, details, source):
    api_key = load_api_key()
    if api_key:
        try:
            scenes = claude_beats(api_key, headline, subline, details, source)
            if scenes:
                return scenes, None
        except Exception as error:
            print(f"  beats: claude failed ({str(error)[:80]}); trying groq")
    try:
        return groq_beats(headline, subline, details, source), None
    except Exception as error:
        return None, str(error)[:200]


class Handler(BaseHTTPRequestHandler):
    def _send(self, code, payload):
        body = json.dumps(payload).encode("utf-8")
        self.send_response(code)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _send_bytes(self, code, content_type, body):
        self.send_response(code)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "*")
        self.end_headers()

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)

        if parsed.path == "/tts":
            params = urllib.parse.parse_qs(parsed.query)
            text = (params.get("text", [""])[0]).strip()
            voice = (params.get("voice", ["google"])[0]).strip()
            name = (params.get("name", [""])[0]).strip()
            if not text:
                self._send(400, {"error": "missing text"})
                return
            try:
                audio, content_type, error = synthesize(text[:2000], voice, name)
                if error:
                    self._send(503, {"error": error})
                    return
                print(f"  voiceover ({voice}): {len(audio) // 1024} KB for '{text[:50]}...'")
                self._send_bytes(200, content_type, audio)
            except Exception as error:
                print(f"  tts failed ({voice}): {error}")
                self._send(500, {"error": str(error)[:200]})
            return

        if parsed.path == "/beats":
            params = urllib.parse.parse_qs(parsed.query)
            headline = (params.get("headline", [""])[0]).strip()
            subline = (params.get("subline", [""])[0]).strip()
            details = (params.get("details", [""])[0]).strip()
            source = (params.get("source", [""])[0]).strip()
            if not headline and not subline and not details:
                self._send(400, {"error": "missing headline/subline"})
                return
            try:
                scenes, error = draft_beats(headline[:600], subline[:1200], details[:4000], source[:120])
                if error:
                    self._send(503, {"error": error})
                    return
                print(f"  beats: {len(scenes)} scenes for '{headline[:50]}...'")
                self._send(200, {"scenes": scenes})
            except Exception as error:
                print(f"  beats failed: {error}")
                self._send(500, {"error": str(error)[:200]})
            return

        if parsed.path != "/resolve":
            self._send(404, {"error": "not found"})
            return

        params = urllib.parse.parse_qs(parsed.query)
        query = (params.get("q", [""])[0]).strip()
        context = (params.get("context", [""])[0]).strip()
        if not query:
            self._send(400, {"error": "missing q"})
            return

        api_key = load_api_key()
        if not api_key:
            self._send(503, {"error": "no ANTHROPIC_API_KEY in secrets.json or environment"})
            return

        try:
            plan = resolve(query, context, api_key)
            print(f"  resolved '{query}' -> {plan.get('interpretation', '')[:70]}")
            self._send(200, plan)
        except Exception as error:
            print(f"  resolve failed for '{query}': {error}")
            self._send(500, {"error": str(error)[:200]})

    def log_message(self, *args):  # keep the console clean
        pass


def main():
    key = load_api_key()
    status = "key loaded" if key else "NO KEY — add anthropic.api_key to secrets.json (studio will use heuristics)"
    print(f"GreaterNews resolver on http://localhost:{PORT}/resolve  ({status})")
    ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()


if __name__ == "__main__":
    main()
