// GreaterNews proxy — a free Cloudflare Worker that holds the ElevenLabs + Groq keys server-side so
// the studio can add voiceover AND draft video scripts from ANY device without exposing the keys.
//
// Deploy (Cloudflare dashboard → Workers & Pages → your Worker → Edit code → paste this → Deploy):
//   Settings → Variables and Secrets:
//     ELEVEN_API_KEY   (Secret)   your ElevenLabs key (sk_...)
//     ELEVEN_VOICE_ID  (Text)     cjVigY5qzO86Huf0OWal   (or any premade voice id)
//     GROQ_API_KEY     (Secret)   your Groq key (gsk_...)     — for the free Groq voice + beat drafting
//     GROQ_TTS_MODEL   (Text)     canopylabs/orpheus-v1-english   (optional; this is the default)
//     GROQ_TTS_VOICE   (Text)     tara                            (optional; this is the default)
//     GROQ_LLM_MODEL   (Text)     llama-3.3-70b-versatile         (optional; this is the default)
//     ALLOWED_ORIGIN   (Text)     https://reskino.github.io
//   NOTE: the Groq voice (Orpheus) needs a one-time terms acceptance by the org admin at
//   https://console.groq.com/playground?model=canopylabs/orpheus-v1-english before it will work.
//
// The studio calls it like:
//   <worker-url>?text=...&voice=elevenlabs|groq          -> audio
//   <worker-url>?mode=beats&headline=...&subline=...      -> {"beats":[...]}

const GROQ_BEATS_SYSTEM = [
  'You script a short news video for GreaterNews, a Ghana-first news channel. You are given a',
  'headline, one line of context, and optional longer story details. Write 4 to 6 beats that tell',
  'the story in order, each building on the last.',
  '',
  'For EACH beat return:',
  '- label: a 1-3 word ALL-CAPS section tag, e.g. THE STORY, THE DETAIL, WHO, WHY IT MATTERS,',
  "  WHAT'S NEXT, THE SOURCE.",
  '- caption: a SHORT on-screen line for the slide, max 6 words, punchy (not a full sentence).',
  '- say: what the presenter SAYS for this beat - ONE natural spoken sentence, ~18 to 28 words, that',
  '  actually explains this part of the story. This is the substance: make it informative and flowing.',
  '- image: a concrete, searchable photo subject to depict this beat (a person, place, building or',
  '  thing), Ghana-aware; empty string if there is nothing safe/relevant to depict.',
  '',
  'Rules:',
  '- Use ONLY facts in the headline/context/details. Never invent names, numbers, quotes or outcomes.',
  '- The headline is spoken first as the hook and a closing line is added automatically - do NOT',
  '  repeat either in the beats.',
  '- No hashtags, no emojis, no timestamps, no stage directions.',
  'Respond with JSON only: {"scenes":[{"label":"","caption":"","say":"","image":""}]}',
].join('\n');

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

    // ---- Draft video beats (Groq LLM) ----
    if (mode === 'beats') {
      if (!env.GROQ_API_KEY) {
        return json(503, { error: 'GROQ_API_KEY not set on the worker' });
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

      const upstream = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: { Authorization: `Bearer ${env.GROQ_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: env.GROQ_LLM_MODEL || 'llama-3.3-70b-versatile',
          temperature: 0.4,
          max_tokens: 900,
          response_format: { type: 'json_object' },
          messages: [
            { role: 'system', content: GROQ_BEATS_SYSTEM },
            { role: 'user', content: userMessage },
          ],
        }),
      });
      if (!upstream.ok) {
        return json(502, { error: 'beats failed', status: upstream.status, detail: (await upstream.text()).slice(0, 300) });
      }
      const data = await upstream.json();
      let scenes = [];
      try {
        const parsed = JSON.parse(data.choices?.[0]?.message?.content || '{}');
        scenes = Array.isArray(parsed.scenes)
          ? parsed.scenes
              .filter((s) => s && (String(s.caption || '').trim() || String(s.say || '').trim()))
              .map((s) => ({
                label: String(s.label || '').trim(),
                caption: String(s.caption || '').trim(),
                say: String(s.say || '').trim(),
                image: String(s.image || '').trim(),
              }))
          : [];
      } catch {
        scenes = [];
      }
      return json(200, { scenes });
    }

    // ---- Text-to-speech ----
    const text = (url.searchParams.get('text') || '').slice(0, 2000).trim();
    if (!text) {
      return json(400, { error: 'missing text' });
    }
    const voice = (url.searchParams.get('voice') || 'elevenlabs').trim();

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
          voice: env.GROQ_TTS_VOICE || 'tara',
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
