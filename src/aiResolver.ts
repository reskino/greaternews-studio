// Claude-powered query understanding for the photo search. Turns a vague query like
// "DVLA CEO" into a disambiguated, Ghana-aware SearchPlan. Cascades:
//   1. a local resolver (scripts/resolver.py) — keeps the API key server-side
//   2. a direct browser call, if VITE_ANTHROPIC_API_KEY is set (personal/local use)
//   3. null — the studio then falls back to buildHeuristicPlan()
import type { SearchPlan } from './imageSearch';

const LOCAL_RESOLVER = 'http://localhost:5199/resolve';
const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const MODEL = 'claude-opus-4-8';

const SYSTEM_PROMPT = [
  'You help a Ghana-first news channel (GreaterNews) find a LICENSED photo for a news card.',
  'The user types a short image-search query. Turn it into a disambiguated search plan for',
  'free image sources (Wikimedia Commons, Wikipedia lead images, Openverse).',
  '',
  'Rules:',
  '- Default AMBIGUOUS acronyms and bodies to their GHANA meaning (e.g. "DVLA" is Ghana\'s',
  '  Driver and Vehicle Licensing Authority, not the UK agency).',
  '- If the query names an organisation plus a role ("DVLA CEO", "GRA boss", "the IGP"),',
  '  it wants a portrait of that office-holder. Only put a name in "person" if you are',
  '  genuinely confident of the CURRENT holder; otherwise leave it "" and depict the',
  '  organisation (a wrong face is far worse than a neutral building/logo).',
  '- searchQueries: 3-6 precise queries, best first: the person (if known), then the full',
  '  organisation name, then its headquarters/logo, then a relevant place or concept.',
  '- excludeTerms: words that would reveal a WRONG match (for Ghana\'s DVLA: "Swansea",',
  '  "Dundee", "United Kingdom"). Empty if none apply.',
  '- sensitive: true for tragedy, crime, victims, or minors (skip depicting a person).',
  '- interpretation: one short human-readable line describing what you think they mean.',
].join('\n');

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    interpretation: { type: 'string' },
    entity: { type: 'string' },
    person: { type: 'string' },
    country: { type: 'string' },
    searchQueries: { type: 'array', items: { type: 'string' } },
    excludeTerms: { type: 'array', items: { type: 'string' } },
    sensitive: { type: 'boolean' },
  },
  required: ['interpretation', 'entity', 'person', 'country', 'searchQueries', 'excludeTerms', 'sensitive'],
} as const;

type RawPlan = Partial<Omit<SearchPlan, 'raw' | 'source'>>;

function normalizePlan(raw: string, plan: RawPlan): SearchPlan | null {
  const searchQueries = (plan.searchQueries ?? []).map((q) => String(q).trim()).filter(Boolean);
  if (searchQueries.length === 0) {
    return null;
  }
  return {
    raw,
    interpretation: String(plan.interpretation ?? plan.entity ?? raw),
    entity: String(plan.entity ?? ''),
    person: String(plan.person ?? ''),
    country: String(plan.country ?? ''),
    searchQueries: [...new Set(searchQueries)].slice(0, 6),
    excludeTerms: (plan.excludeTerms ?? []).map((t) => String(t).trim()).filter(Boolean),
    sensitive: Boolean(plan.sensitive),
    source: 'ai',
  };
}

async function fromLocalResolver(query: string, context: string): Promise<SearchPlan | null> {
  const url = `${LOCAL_RESOLVER}?q=${encodeURIComponent(query)}&context=${encodeURIComponent(context)}`;
  const response = await fetch(url, { signal: AbortSignal.timeout(15000) });
  if (!response.ok) {
    return null;
  }
  return normalizePlan(query, (await response.json()) as RawPlan);
}

async function fromBrowserKey(query: string, context: string, apiKey: string): Promise<SearchPlan | null> {
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
      max_tokens: 512,
      output_config: { effort: 'low', format: { type: 'json_schema', schema: SCHEMA } },
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: context ? `Query: ${query}\nStory context: ${context}` : `Query: ${query}` }],
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
  return normalizePlan(query, JSON.parse(text) as RawPlan);
}

// Returns an AI-resolved plan, or null if neither the local resolver nor a browser key is
// available (or the call fails). Callers fall back to buildHeuristicPlan().
export async function resolveQuery(query: string, context = ''): Promise<SearchPlan | null> {
  const trimmed = query.trim();
  if (!trimmed) {
    return null;
  }

  try {
    const local = await fromLocalResolver(trimmed, context);
    if (local) {
      return local;
    }
  } catch {
    // Local resolver not running — try the browser key next.
  }

  const apiKey = import.meta.env.VITE_ANTHROPIC_API_KEY;
  if (apiKey) {
    try {
      return await fromBrowserKey(trimmed, context, apiKey);
    } catch {
      // Direct call failed — the caller falls back to the heuristic plan.
    }
  }

  return null;
}
