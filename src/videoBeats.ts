// Drafts a video script from a card. Produces, per beat: a SHORT on-screen caption, a FULLER spoken
// narration sentence (so the voice tells the whole story while slides stay readable), and a photo
// subject to depict. Drafts via the server-side proxy (the worker/resolver runs Claude first, then
// Groq — keys never touch the browser), then a direct browser Claude call if a key is present (local
// dev only), then a local heuristic — so the button always yields an editable starting point.

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const MODEL = 'claude-opus-4-8';
// Beats proxy: the hosted worker (?mode=beats) when set, else the local resolver's /beats. It runs
// Groq's LLM server-side so the key never reaches the browser.
const PROXY = import.meta.env.VITE_TTS_PROXY_URL;

// Rich, few-shot drafting prompt (authored by Claude) so the free Groq model produces
// broadcast-quality scripts. Keep this in sync with the copies in scripts/resolver.py and
// cloudflare-worker/tts-proxy.js.
const SYSTEM_PROMPT = `You are a senior broadcast news scriptwriter for GreaterNews, a Ghana-first news channel. You turn a verified story into the script for a short vertical news video.

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

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    scenes: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          label: { type: 'string' },
          caption: { type: 'string' },
          say: { type: 'string' },
          image: { type: 'string' },
        },
        required: ['label', 'caption', 'say', 'image'],
      },
    },
  },
  required: ['scenes'],
} as const;

export type BeatsInput = { headline: string; subline: string; details?: string; source?: string };
export type RawScene = { label?: string; caption?: string; say?: string; image?: string };
// captions[i] ↔ narration[i] ↔ imageQueries[i] all describe the same beat.
export type DraftedBeats = { captions: string[]; narration: string[]; imageQueries: string[] };

// Strip a leading "Source:" / "Photo:" / "Credit:" prefix so we can say "Reported by X".
function cleanSource(footer: string): string {
  return footer
    .replace(/^\s*(source|photo|credit)s?\s*:?/i, '')
    .split(/[/·|]/)[0]
    .trim();
}

function trimWords(text: string, max: number): string {
  const words = text.trim().replace(/\s+/g, ' ').split(' ');
  return words.length <= max ? words.join(' ') : words.slice(0, max).join(' ');
}

// Turn the model's scene objects into the three parallel arrays the studio uses.
function scenesToBeats(scenes: RawScene[]): DraftedBeats | null {
  const captions: string[] = [];
  const narration: string[] = [];
  const imageQueries: string[] = [];
  for (const scene of scenes) {
    const caption = String(scene.caption ?? '').trim();
    const say = String(scene.say ?? '').trim();
    if (!caption && !say) {
      continue;
    }
    const label = String(scene.label ?? '').trim().replace(/[[\]]/g, '');
    captions.push(label ? `[${label.toUpperCase()}] ${caption || say}` : caption || say);
    narration.push(say || caption);
    imageQueries.push(String(scene.image ?? '').trim());
  }
  return captions.length ? { captions, narration, imageQueries } : null;
}

function buildUserMessage(input: BeatsInput): string {
  const source = input.source ? cleanSource(input.source) : '';
  return [
    `Headline (the hook — do NOT repeat): ${input.headline.trim()}`,
    input.subline.trim() ? `Context: ${input.subline.trim()}` : '',
    input.details && input.details.trim() ? `Story details:\n${input.details.trim()}` : '',
    source ? `Source: ${source}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

// Offline fallback: split the available text into sentences, one beat each. The caption is a short
// clip of the sentence; the narration is the whole sentence.
export function heuristicBeats(input: BeatsInput): DraftedBeats {
  const LABELS = ['THE STORY', 'THE DETAIL', 'WHY IT MATTERS', "WHAT'S NEXT"];
  const body = [input.details, input.subline].filter(Boolean).join(' ').trim() || input.headline;
  const sentences = body
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim().replace(/[.]+$/, ''))
    .filter(Boolean)
    .slice(0, 4);

  const captions: string[] = [];
  const narration: string[] = [];
  const imageQueries: string[] = [];
  sentences.forEach((sentence, index) => {
    captions.push(`[${LABELS[Math.min(index, LABELS.length - 1)]}] ${trimWords(sentence, 6)}`);
    narration.push(sentence);
    imageQueries.push('');
  });

  const source = input.source ? cleanSource(input.source) : '';
  if (source && captions.length < 4) {
    captions.push('[THE SOURCE] ' + trimWords(`Reported by ${source}`, 6));
    narration.push(`This was reported by ${source}.`);
    imageQueries.push('');
  }
  return { captions, narration, imageQueries };
}

async function fromProxy(input: BeatsInput): Promise<DraftedBeats | null> {
  const params = new URLSearchParams({ headline: input.headline.trim(), subline: input.subline.trim() });
  if (input.details) params.set('details', input.details.trim());
  if (input.source) params.set('source', cleanSource(input.source));
  const url = PROXY ? `${PROXY}${PROXY.includes('?') ? '&' : '?'}mode=beats&${params}` : `http://localhost:5199/beats?${params}`;
  const response = await fetch(url, { signal: AbortSignal.timeout(25000) });
  if (!response.ok) {
    return null;
  }
  const data = (await response.json()) as { scenes?: RawScene[] };
  return Array.isArray(data.scenes) ? scenesToBeats(data.scenes) : null;
}

async function fromBrowserKey(input: BeatsInput, apiKey: string): Promise<DraftedBeats | null> {
  const response = await fetch(ANTHROPIC_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    signal: AbortSignal.timeout(25000),
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 900,
      output_config: { effort: 'low', format: { type: 'json_schema', schema: SCHEMA } },
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: buildUserMessage(input) }],
    }),
  });
  if (!response.ok) {
    return null;
  }
  const data = (await response.json()) as { content?: Array<{ type: string; text?: string }> };
  const text = data.content?.find((block) => block.type === 'text')?.text;
  if (!text) {
    return null;
  }
  const parsed = JSON.parse(text) as { scenes?: RawScene[] };
  return Array.isArray(parsed.scenes) ? scenesToBeats(parsed.scenes) : null;
}

// Draft the video script for the card. Tries Groq (proxy), then Claude, then the heuristic.
export async function draftVideoBeats(input: BeatsInput): Promise<DraftedBeats> {
  if (!input.headline.trim() && !input.subline.trim() && !input.details?.trim()) {
    return { captions: [], narration: [], imageQueries: [] };
  }

  // 1. Server-side proxy — the worker (web) or resolver (local) drafts with Claude first, then Groq.
  try {
    const beats = await fromProxy(input);
    if (beats && beats.captions.length) {
      return beats;
    }
  } catch {
    // Proxy not reachable — try a direct browser key next.
  }

  // 2. Direct Claude, only if a browser key is present (local dev; never set on the deployed web).
  const apiKey = import.meta.env.VITE_ANTHROPIC_API_KEY;
  if (apiKey) {
    try {
      const beats = await fromBrowserKey(input, apiKey);
      if (beats && beats.captions.length) {
        return beats;
      }
    } catch {
      // Fall through to the heuristic.
    }
  }

  // 3. Offline heuristic — always available.
  return heuristicBeats(input);
}
