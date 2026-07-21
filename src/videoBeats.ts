// Drafts a video script (the [LABEL] beat lines the video engine speaks) from a card's headline +
// context. Uses Claude when a browser key is available — the deployed studio bakes
// VITE_ANTHROPIC_API_KEY into the bundle — and otherwise falls back to a local heuristic so the
// button always produces something. The beats are a starting point the user edits, never final.

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const MODEL = 'claude-opus-4-8';

const SYSTEM_PROMPT = [
  'You write the spoken script for a short news video for GreaterNews, a Ghana-first news channel.',
  'You are given a news card: a headline plus one or two sentences of context.',
  'The headline is spoken first as the hook and a closing line is added automatically — do NOT',
  'repeat either. Write the MIDDLE beats: 3 to 4 lines a presenter would say, each building on the',
  'last so the story flows.',
  '',
  'Rules:',
  '- Each beat is ONE spoken-style sentence, max ~14 words.',
  '- Use ONLY facts present in the headline/context. Never invent names, numbers, quotes or outcomes.',
  '- No hashtags, no emojis, no timestamps, no stage directions.',
  '- Prefix each beat with a short ALL-CAPS section label in square brackets that frames it,',
  '  e.g. [THE STORY], [THE DETAIL], [WHO], [WHY IT MATTERS], [WHAT\'S NEXT], [THE SOURCE].',
  '- If the context is thin, write fewer beats rather than padding with filler or repetition.',
].join('\n');

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    beats: { type: 'array', items: { type: 'string' } },
  },
  required: ['beats'],
} as const;

export type BeatsInput = { headline: string; subline: string; source?: string };

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

const LABELS = ['[THE STORY]', '[THE DETAIL]', '[WHY IT MATTERS]', "[WHAT'S NEXT]"];

// Offline fallback: split the context into sentences and label them in order. Rough, but always
// available and easy to edit.
export function heuristicBeats(input: BeatsInput): string[] {
  const sentences = input.subline
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim().replace(/[.]+$/, ''))
    .filter(Boolean)
    .slice(0, 3);

  const beats = sentences.map((sentence, index) => `${LABELS[Math.min(index, LABELS.length - 1)]} ${trimWords(sentence, 16)}`);

  if (beats.length === 0 && input.headline.trim()) {
    beats.push(`[THE STORY] ${trimWords(input.headline.replace(/[.]+$/, ''), 16)}`);
  }

  const source = input.source ? cleanSource(input.source) : '';
  if (source && beats.length < 4) {
    beats.push(`[THE SOURCE] Reported by ${source}`);
  }

  return beats;
}

async function fromBrowserKey(input: BeatsInput, apiKey: string): Promise<string[] | null> {
  const source = input.source ? cleanSource(input.source) : '';
  const userMessage = [
    `Headline (the hook — do NOT repeat): ${input.headline.trim()}`,
    input.subline.trim() ? `Context: ${input.subline.trim()}` : '',
    source ? `Source: ${source}` : '',
  ]
    .filter(Boolean)
    .join('\n');

  const response = await fetch(ANTHROPIC_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    signal: AbortSignal.timeout(20000),
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 400,
      output_config: { effort: 'low', format: { type: 'json_schema', schema: SCHEMA } },
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userMessage }],
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
  const parsed = JSON.parse(text) as { beats?: unknown };
  const beats = Array.isArray(parsed.beats) ? parsed.beats.map((b) => String(b).trim()).filter(Boolean) : [];
  return beats.length ? beats : null;
}

// Draft beat lines for the card. Tries Claude (browser key), then the heuristic. Always resolves to
// at least one line unless there's nothing to work with.
export async function draftVideoBeats(input: BeatsInput): Promise<string[]> {
  if (!input.headline.trim() && !input.subline.trim()) {
    return [];
  }

  const apiKey = import.meta.env.VITE_ANTHROPIC_API_KEY;
  if (apiKey) {
    try {
      const beats = await fromBrowserKey(input, apiKey);
      if (beats && beats.length) {
        return beats;
      }
    } catch {
      // Fall through to the heuristic.
    }
  }

  return heuristicBeats(input);
}
