// GreaterNews proxy — a free Cloudflare Worker that holds the ElevenLabs + Groq keys server-side so
// the studio can add voiceover AND draft video scripts from ANY device without exposing the keys.
//
// Deploy (Cloudflare dashboard → Workers & Pages → your Worker → Edit code → paste this → Deploy):
//   Settings → Variables and Secrets:
//     ELEVEN_API_KEY    (Secret)  your ElevenLabs key (sk_...)
//     ELEVEN_VOICE_ID   (Text)    cjVigY5qzO86Huf0OWal   (or any premade voice id)
//     ANTHROPIC_API_KEY (Secret)  your Anthropic key (sk-ant-...) — primary drafter for the script
//     ANTHROPIC_MODEL   (Text)    claude-opus-4-8         (optional; e.g. claude-sonnet-5 is cheaper)
//     GROQ_API_KEY      (Secret)  your Groq key (gsk_...) — free Groq voice + the beats backup
//     GROQ_TTS_MODEL    (Text)    canopylabs/orpheus-v1-english   (optional; this is the default)
//     GROQ_TTS_VOICE    (Text)    diana   (optional; one of: autumn diana hannah austin daniel troy)
//     GROQ_LLM_MODEL    (Text)    llama-3.3-70b-versatile         (optional; this is the default)
//     ALLOWED_ORIGIN    (Text)    https://reskino.github.io
//   NOTE: the Groq voice (Orpheus) needs a one-time terms acceptance by the org admin at
//   https://console.groq.com/playground?model=canopylabs/orpheus-v1-english before it will work.
//
// The studio calls it like:
//   <worker-url>?text=...&voice=elevenlabs|groq          -> audio
//   <worker-url>?mode=beats&headline=...&subline=...      -> {"beats":[...]}

// Rich, few-shot drafting prompt (authored by Claude) so the free Groq model produces
// broadcast-quality scripts. Keep in sync with src/videoBeats.ts and scripts/resolver.py.
const GROQ_BEATS_SYSTEM = `You are a senior broadcast news scriptwriter for GreaterNews, a Ghana-first news channel. You turn a verified story into the script for a short vertical news video.

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

Respond with JSON only, in exactly this shape: {"scenes":[{"label":"","caption":"","say":"","image":""}]}`;

const BEATS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    scenes: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: { label: { type: 'string' }, caption: { type: 'string' }, say: { type: 'string' }, image: { type: 'string' } },
        required: ['label', 'caption', 'say', 'image'],
      },
    },
  },
  required: ['scenes'],
};

// Keep only well-formed scenes and trim their fields.
function normalizeScenes(scenes) {
  return Array.isArray(scenes)
    ? scenes
        .filter((s) => s && (String(s.caption || '').trim() || String(s.say || '').trim()))
        .map((s) => ({
          label: String(s.label || '').trim(),
          caption: String(s.caption || '').trim(),
          say: String(s.say || '').trim(),
          image: String(s.image || '').trim(),
        }))
    : [];
}

// Draft via Claude (structured output). Throws on any failure so the caller can fall back to Groq.
async function claudeBeats(env, userMessage) {
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model: env.ANTHROPIC_MODEL || 'claude-opus-4-8',
      max_tokens: 900,
      output_config: { effort: 'low', format: { type: 'json_schema', schema: BEATS_SCHEMA } },
      system: GROQ_BEATS_SYSTEM,
      messages: [{ role: 'user', content: userMessage }],
    }),
  });
  if (!response.ok) {
    throw new Error(`claude ${response.status}`);
  }
  const data = await response.json();
  const text = (data.content || []).find((b) => b.type === 'text')?.text || '{}';
  return normalizeScenes(JSON.parse(text).scenes);
}

// Draft via Groq (JSON mode). Throws on failure.
async function groqBeats(env, userMessage) {
  const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.GROQ_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: env.GROQ_LLM_MODEL || 'llama-3.3-70b-versatile',
      temperature: 0.4,
      max_tokens: 900,
      response_format: { type: 'json_object' },
      messages: [{ role: 'system', content: GROQ_BEATS_SYSTEM }, { role: 'user', content: userMessage }],
    }),
  });
  if (!response.ok) {
    throw new Error(`groq ${response.status}`);
  }
  const data = await response.json();
  return normalizeScenes(JSON.parse(data.choices?.[0]?.message?.content || '{}').scenes);
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';
    const allowed = (env.ALLOWED_ORIGIN || '').split(',').map((s) => s.trim()).filter(Boolean);
    const allowOrigin = allowed.length === 0 ? '*' : allowed.includes(origin) ? origin : allowed[0];
    const cors = {
      'Access-Control-Allow-Origin': allowOrigin,
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': '*',
    };
    const json = (code, obj) => new Response(JSON.stringify(obj), { status: code, headers: { ...cors, 'Content-Type': 'application/json' } });

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors });
    }
    // Basic anti-abuse: only serve browser requests from the studio's origin.
    if (allowed.length && origin && !allowed.includes(origin)) {
      return json(403, { error: 'forbidden origin' });
    }

    const url = new URL(request.url);
    const mode = url.searchParams.get('mode') || 'tts';

    // ---- Draft video beats: Claude first (best writing), Groq as backup ----
    if (mode === 'beats') {
      if (!env.ANTHROPIC_API_KEY && !env.GROQ_API_KEY) {
        return json(503, { error: 'set ANTHROPIC_API_KEY (primary) and/or GROQ_API_KEY (backup) on the worker' });
      }
      const headline = (url.searchParams.get('headline') || '').slice(0, 600).trim();
      const subline = (url.searchParams.get('subline') || '').slice(0, 1200).trim();
      const details = (url.searchParams.get('details') || '').slice(0, 4000).trim();
      const source = (url.searchParams.get('source') || '').slice(0, 120).trim();
      if (!headline && !subline && !details) {
        return json(400, { error: 'missing headline/subline' });
      }
      const userMessage = [
        `Headline (the hook - do NOT repeat): ${headline}`,
        subline ? `Context: ${subline}` : '',
        details ? `Story details:\n${details}` : '',
        source ? `Source: ${source}` : '',
      ].filter(Boolean).join('\n');

      let scenes = [];
      if (env.ANTHROPIC_API_KEY) {
        try {
          scenes = await claudeBeats(env, userMessage);
        } catch {
          // Claude failed — fall through to the Groq backup.
        }
      }
      if (!scenes.length && env.GROQ_API_KEY) {
        try {
          scenes = await groqBeats(env, userMessage);
        } catch {
          scenes = [];
        }
      }
      return json(200, { scenes });
    }

    // ---- Text-to-speech ----
    const text = (url.searchParams.get('text') || '').slice(0, 2000).trim();
    if (!text) {
      return json(400, { error: 'missing text' });
    }
    const voice = (url.searchParams.get('voice') || 'elevenlabs').trim();
    const voiceName = (url.searchParams.get('name') || '').trim();

    if (voice === 'groq') {
      if (!env.GROQ_API_KEY) {
        return json(503, { error: 'GROQ_API_KEY not set on the worker' });
      }
      const upstream = await fetch('https://api.groq.com/openai/v1/audio/speech', {
        method: 'POST',
        headers: { Authorization: `Bearer ${env.GROQ_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: env.GROQ_TTS_MODEL || 'canopylabs/orpheus-v1-english',
          input: text,
          voice: voiceName || env.GROQ_TTS_VOICE || 'diana',
          response_format: 'wav',
        }),
      });
      if (!upstream.ok) {
        return json(502, { error: 'groq tts failed', status: upstream.status, detail: (await upstream.text()).slice(0, 300) });
      }
      return new Response(await upstream.arrayBuffer(), { headers: { ...cors, 'Content-Type': 'audio/wav' } });
    }

    // Default: ElevenLabs.
    if (!env.ELEVEN_API_KEY) {
      return json(503, { error: 'ELEVEN_API_KEY not set on the worker' });
    }
    const voiceId = env.ELEVEN_VOICE_ID || 'cjVigY5qzO86Huf0OWal';
    const upstream = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`, {
      method: 'POST',
      headers: { 'xi-api-key': env.ELEVEN_API_KEY, 'Content-Type': 'application/json', Accept: 'audio/mpeg' },
      body: JSON.stringify({ text, model_id: 'eleven_multilingual_v2' }),
    });
    if (!upstream.ok) {
      return json(502, { error: 'tts failed', status: upstream.status, detail: (await upstream.text()).slice(0, 300) });
    }
    return new Response(await upstream.arrayBuffer(), { headers: { ...cors, 'Content-Type': 'audio/mpeg' } });
  },
};
