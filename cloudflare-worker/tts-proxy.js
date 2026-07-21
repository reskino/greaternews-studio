// GreaterNews TTS proxy — a free Cloudflare Worker that holds the ElevenLabs key server-side so
// the studio can add voiceover from ANY device (phone included) without exposing the key.
//
// Deploy (Cloudflare dashboard → Workers & Pages → Create Worker → Edit code → paste this → Deploy):
//   Then add these under the Worker's Settings → Variables and Secrets:
//     ELEVEN_API_KEY   (Secret)   your ElevenLabs key (sk_...)
//     ELEVEN_VOICE_ID  (Text)     cjVigY5qzO86Huf0OWal   (or any premade voice id)
//     ALLOWED_ORIGIN   (Text)     https://reskino.github.io
//   Copy the Worker URL (https://<name>.<subdomain>.workers.dev) and send it back.
//
// The studio calls it like: <worker-url>?text=...  — the Worker synthesizes and returns audio/mpeg.

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
    if (!env.ELEVEN_API_KEY) {
      return json(503, { error: 'ELEVEN_API_KEY not set on the worker' });
    }

    const text = (new URL(request.url).searchParams.get('text') || '').slice(0, 2000).trim();
    if (!text) {
      return json(400, { error: 'missing text' });
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
