export type ImageResult = {
  id: string;
  title: string;
  thumbUrl: string;
  fullUrl: string;
  license: string;
  author: string;
  sourcePage: string;
  provider: 'Wikimedia Commons' | 'Openverse' | 'Google';
};

type CommonsPage = {
  pageid: number;
  title?: string;
  imageinfo?: Array<{
    thumburl?: string;
    url?: string;
    descriptionurl?: string;
    extmetadata?: {
      LicenseShortName?: { value?: string };
      Artist?: { value?: string };
    };
  }>;
};

type OpenverseItem = {
  id: string;
  title?: string;
  thumbnail?: string;
  url?: string;
  license?: string;
  license_version?: string;
  creator?: string;
  foreign_landing_url?: string;
};

const STOPWORDS = new Set([
  'the', 'a', 'an', 'in', 'of', 'to', 'for', 'on', 'at', 'with', 'and', 'or', 'as', 'by', 'is', 'are', 'was', 'were',
  'has', 'have', 'had', 'be', 'been', 'his', 'her', 'its', 'their', 'this', 'that', 'these', 'those', 'from', 'into',
  'over', 'after', 'before', 'about', 'against', 'says', 'said', 'will', 'would', 'could', 'should', 'not', 'no',
  'new', 'more', 'most', 'key', 'top', 'amid', 'per', 'via', 'off', 'out', 'up', 'down', 'who', 'what', 'when',
  'where', 'why', 'how', 'gone', 'goes', 'going', 'get', 'gets', 'got', 'it', 'he', 'she', 'they', 'we', 'you',
]);

const categoryQueries: Record<string, string> = {
  'Ghana politics & governance': 'Ghana parliament Accra',
  'Ghana business & economy': 'Ghana cedi Accra market',
  Sports: 'Ghana Black Stars football',
  'Entertainment & culture': 'Ghana festival culture',
  'World news': 'Africa map news globe',
  'Tech / trending': 'technology digital abstract',
};

const ghanaCategories = new Set(['Ghana politics & governance', 'Ghana business & economy', 'Sports', 'Entertainment & culture']);
const ghanaMarkers = /\b(ghana|ghanaian|accra|kumasi|tamale|takoradi|cedi|gpl|gfa)\b/i;

// Ghana newsroom acronyms — searching the expansion finds the right entity instead of
// whatever Wikipedia fuzzy-matches the letters to (e.g. "BoG" → "Bog", the swamp).
const ghanaAcronyms: Record<string, string> = {
  bog: 'Bank of Ghana',
  gfa: 'Ghana Football Association',
  gpl: 'Ghana Premier League',
  gra: 'Ghana Revenue Authority',
  ges: 'Ghana Education Service',
  ghs: 'Ghana Health Service',
  ecg: 'Electricity Company of Ghana',
  nca: 'National Communications Authority Ghana',
  npa: 'National Petroleum Authority Ghana',
  gnpc: 'Ghana National Petroleum Corporation',
  cocobod: 'Ghana Cocoa Board',
  knust: 'Kwame Nkrumah University of Science and Technology',
  npp: 'New Patriotic Party',
  ndc: 'National Democratic Congress Ghana',
  ecowas: 'Economic Community of West African States',
  au: 'African Union',
  imf: 'International Monetary Fund',
  // Authorities, ministries, and public bodies frequently named in Ghana news.
  dvla: 'Driver and Vehicle Licensing Authority Ghana',
  gis: 'Ghana Immigration Service',
  gps: 'Ghana Police Service',
  gaf: 'Ghana Armed Forces',
  gnfs: 'Ghana National Fire Service',
  gpha: 'Ghana Ports and Harbours Authority',
  gwcl: 'Ghana Water Company Limited',
  vra: 'Volta River Authority',
  ssnit: 'Social Security and National Insurance Trust',
  nhia: 'National Health Insurance Authority Ghana',
  nhis: 'National Health Insurance Scheme Ghana',
  eoco: 'Economic and Organised Crime Office Ghana',
  gtec: 'Ghana Tertiary Education Commission',
  gse: 'Ghana Stock Exchange',
  gcb: 'GCB Bank Ghana',
  fda: 'Food and Drugs Authority Ghana',
  gsa: 'Ghana Standards Authority',
  nia: 'National Identification Authority Ghana',
  ug: 'University of Ghana',
  ucc: 'University of Cape Coast',
  moh: 'Ministry of Health Ghana',
  mof: 'Ministry of Finance Ghana',
  moe: 'Ministry of Education Ghana',
};

// Titles that mean "the person who leads <org>" — the query wants a face, but a free
// photo of a current Ghanaian office-holder rarely exists, so we depict the org instead.
const roleWords = new Set([
  'ceo', 'boss', 'md', 'director', 'director-general', 'dg', 'head', 'chief', 'executive',
  'minister', 'president', 'chairman', 'chairperson', 'chair', 'governor', 'commissioner',
  'administrator', 'mp', 'igp', 'gm', 'ag', 'spokesperson',
]);

// Acronyms that collide with a better-known foreign body — when the Ghana reading is meant,
// these terms in a result mean it's the wrong one and should be filtered out.
const acronymClashes: Record<string, string[]> = {
  dvla: ['Swansea', 'Dundee', 'United Kingdom', 'England', 'Wales', 'British', 'DVLA.gov.uk'],
  fda: ['United States', 'U.S.', 'Silver Spring', 'Maryland', 'FDA.gov'],
  gps: ['satellite', 'navigation', 'Global Positioning'],
};

const sensitiveMarkers = /\b(dead|death|died|killed|murder|rape|raped|victim|accident|suicide|corpse|bodies|body|minor|abuse)s?\b/i;

// A disambiguated, Ghana-aware plan for finding a licensed photo. Produced either by the
// Claude resolver (aiResolver.ts) or the key-free heuristic below; both feed the same search.
export type SearchPlan = {
  raw: string;
  interpretation: string;
  entity: string;
  person: string;
  country: string;
  searchQueries: string[];
  excludeTerms: string[];
  sensitive: boolean;
  source: 'ai' | 'heuristic';
};

// Key-free query understanding: expand Ghana acronyms, recognise "<org> <role>" queries,
// bias to Ghana, and flag the wrong-country matches to filter. Always available; also the
// fallback when the Claude resolver isn't reachable.
export function buildHeuristicPlan(query: string): SearchPlan {
  const raw = query.trim();
  const tokens = raw.split(/\s+/).filter(Boolean);
  const expand = (token: string) => ghanaAcronyms[token.toLowerCase()] ?? token;

  const roleIndex = tokens.findIndex((token) => roleWords.has(token.toLowerCase()));
  const hasRole = roleIndex > 0; // a leading role word (e.g. "President Mahama") is a name, not "<org> role"
  const orgTokens = hasRole ? tokens.slice(0, roleIndex) : tokens;
  const orgExpanded = orgTokens.map(expand).join(' ').trim();
  const orgRaw = orgTokens.join(' ').trim();

  const knownGhana = ghanaMarkers.test(raw) || orgTokens.some((token) => ghanaAcronyms[token.toLowerCase()]);
  const country = knownGhana ? 'Ghana' : '';
  const entity = orgExpanded || raw;

  const queries: string[] = [];
  const push = (candidate: string) => {
    const trimmed = candidate.trim();
    if (trimmed && !queries.includes(trimmed)) {
      queries.push(trimmed);
    }
  };

  if (hasRole) {
    push(orgExpanded);
    if (country && !orgExpanded.includes('Ghana')) push(`${orgExpanded} ${country}`);
    push(`${orgExpanded} headquarters`);
    push(`${orgExpanded} logo`);
  } else {
    push(orgExpanded);
    if (country && !orgExpanded.includes('Ghana')) push(`${orgExpanded} ${country}`);
  }
  if (orgRaw && orgRaw !== orgExpanded) push(orgRaw);

  const excludeTerms: string[] = [];
  for (const token of orgTokens) {
    const clash = acronymClashes[token.toLowerCase()];
    if (clash) excludeTerms.push(...clash);
  }

  const sensitive = sensitiveMarkers.test(raw);
  const interpretation = hasRole
    ? `${orgExpanded}${country ? ` (${country})` : ''} — showing the organisation; a free photo of the current office-holder may not exist`
    : `${entity}${country ? ` (${country})` : ''}`;

  return {
    raw,
    interpretation,
    entity,
    person: '',
    country,
    searchQueries: queries.length ? queries : [raw],
    excludeTerms,
    sensitive,
    source: 'heuristic',
  };
}

// Drop results whose title or author reveals a wrong-country / wrong-entity match.
export function filterByExcludeTerms(results: ImageResult[], excludeTerms: string[]) {
  if (excludeTerms.length === 0) {
    return results;
  }
  const needles = excludeTerms.map((term) => term.toLowerCase());
  return results.filter((result) => {
    const haystack = `${result.title} ${result.author}`.toLowerCase();
    return !needles.some((needle) => haystack.includes(needle));
  });
}

// Consecutive capitalized-word runs name the people, places, and organizations in a headline.
export function extractEntities(headline: string): string[] {
  const words = headline
    .replace(/[^\p{L}\p{N}\s'-]/gu, ' ')
    .split(/\s+/)
    .filter(Boolean);

  const entities: string[] = [];
  let run: string[] = [];

  words.forEach((word, index) => {
    const isCapitalized = /^[A-Z]/.test(word) && !STOPWORDS.has(word.toLowerCase());
    if (isCapitalized) {
      run.push(word);
    } else {
      // The first headline word is capitalized by convention; only keep a leading single word if it looks like a name elsewhere too.
      if (run.length > 1 || (run.length === 1 && index - run.length > 0)) {
        entities.push(run.join(' '));
      }
      run = [];
    }
  });
  if (run.length > 0) {
    entities.push(run.join(' '));
  }

  const expanded = entities.map((entity) => ghanaAcronyms[entity.toLowerCase()] ?? entity);

  return [...new Set(expanded)].filter((entity) => entity.length > 2).slice(0, 3);
}

type WikiSearchPage = {
  title?: string;
  pageimage?: string;
};

type CommonsFilePage = {
  title?: string;
  missing?: string;
  imageinfo?: Array<{
    thumburl?: string;
    url?: string;
    descriptionurl?: string;
    extmetadata?: {
      LicenseShortName?: { value?: string };
      Artist?: { value?: string };
    };
  }>;
};

// Wikipedia's lead image for an entity is usually the canonical photo of that person, place, or organization.
// Files that only exist on English Wikipedia (fair use) are filtered out by the Commons license lookup.
export async function searchWikipediaImages(query: string): Promise<ImageResult[]> {
  const searchParams = new URLSearchParams({
    action: 'query',
    generator: 'search',
    gsrsearch: query,
    gsrlimit: '4',
    prop: 'pageimages',
    piprop: 'name',
    format: 'json',
    origin: '*',
  });

  const searchResponse = await fetch(`https://en.wikipedia.org/w/api.php?${searchParams.toString()}`);
  if (!searchResponse.ok) {
    throw new Error(`HTTP ${searchResponse.status}`);
  }

  const searchData = (await searchResponse.json()) as { query?: { pages?: Record<string, WikiSearchPage> } };
  const pages = Object.values(searchData.query?.pages ?? {}).filter((page) => page.pageimage && page.title);
  if (pages.length === 0) {
    return [];
  }

  const entityByFile = new Map(pages.map((page) => [`File:${(page.pageimage ?? '').replace(/_/g, ' ')}`, page.title ?? '']));
  const licenseParams = new URLSearchParams({
    action: 'query',
    titles: [...entityByFile.keys()].join('|'),
    prop: 'imageinfo',
    iiprop: 'url|extmetadata',
    iiurlwidth: '400',
    format: 'json',
    origin: '*',
  });

  const licenseResponse = await fetch(`https://commons.wikimedia.org/w/api.php?${licenseParams.toString()}`);
  if (!licenseResponse.ok) {
    throw new Error(`HTTP ${licenseResponse.status}`);
  }

  const licenseData = (await licenseResponse.json()) as { query?: { pages?: Record<string, CommonsFilePage> } };

  return Object.values(licenseData.query?.pages ?? {}).flatMap((page) => {
    if (page.missing !== undefined) {
      return [];
    }

    const info = page.imageinfo?.[0];
    if (!info?.url) {
      return [];
    }

    const entity = entityByFile.get(page.title ?? '') ?? (page.title ?? '').replace(/^File:/, '');
    const parsedLicense = new DOMParser().parseFromString(info.extmetadata?.LicenseShortName?.value ?? '', 'text/html');
    const parsedArtist = new DOMParser().parseFromString(info.extmetadata?.Artist?.value ?? '', 'text/html');

    return [
      {
        id: `wiki-${page.title}`,
        title: `${entity} (Wikipedia lead image)`,
        thumbUrl: info.thumburl ?? info.url,
        fullUrl: info.url,
        license: (parsedLicense.body.textContent ?? '').trim() || 'See source',
        author: (parsedArtist.body.textContent ?? '').replace(/\s+/g, ' ').trim() || 'Unknown',
        sourcePage: info.descriptionurl ?? '',
        provider: 'Wikimedia Commons' as const,
      },
    ];
  });
}

export function dedupeResults(results: ImageResult[]) {
  const seen = new Set<string>();
  return results.filter((result) => {
    if (seen.has(result.fullUrl)) {
      return false;
    }
    seen.add(result.fullUrl);
    return true;
  });
}

export type StoryImageSearch = {
  results: ImageResult[];
  queries: string[];
};

// Multi-strategy story image search: entity lead images from Wikipedia first (most likely to be
// "the correct photo of the thing"), then Commons and Openverse keyword matches, then a category anchor.
export async function findStoryImages(headline: string, category: string): Promise<StoryImageSearch> {
  const entities = extractEntities(headline);
  const anchor = categoryQueries[category] ?? '';
  const needsGhanaBias = ghanaCategories.has(category) && !ghanaMarkers.test(headline);

  const tasks: Array<{ weight: number; run: () => Promise<ImageResult[]> }> = [];

  for (const entity of entities) {
    tasks.push({ weight: 3, run: () => searchWikipediaImages(entity) });
    tasks.push({ weight: 2, run: () => searchCommons(entity) });
  }
  if (needsGhanaBias && entities[0]) {
    tasks.push({ weight: 3, run: () => searchWikipediaImages(`${entities[0]} Ghana`) });
  }
  if (entities[0]) {
    tasks.push({ weight: 1.5, run: () => searchOpenverse(entities[0]) });
  }
  if (anchor) {
    tasks.push({ weight: 1, run: () => searchCommons(anchor) });
  }

  const settled = await Promise.allSettled(tasks.map((task) => task.run()));

  const headlineTerms = new Set(
    headline
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, ' ')
      .split(/\s+/)
      .filter((word) => word.length > 3 && !STOPWORDS.has(word)),
  );

  const scored = settled.flatMap((result, index) => {
    if (result.status !== 'fulfilled') {
      return [];
    }

    return result.value.map((image) => {
      const titleWords = image.title.toLowerCase().split(/\s+/);
      const overlap = titleWords.filter((word) => headlineTerms.has(word)).length;
      return { image, score: tasks[index].weight + overlap * 0.4 };
    });
  });

  const results = dedupeResults(scored.sort((a, b) => b.score - a.score).map((entry) => entry.image)).slice(0, 18);
  const queries = [...entities, ...(needsGhanaBias && entities[0] ? [`${entities[0]} Ghana`] : []), ...(anchor ? [anchor] : [])];

  return { results, queries };
}

function stripTags(html: string) {
  const parsed = new DOMParser().parseFromString(html, 'text/html');
  return (parsed.body.textContent ?? '').replace(/\s+/g, ' ').trim();
}

export async function searchCommons(query: string): Promise<ImageResult[]> {
  const params = new URLSearchParams({
    action: 'query',
    generator: 'search',
    gsrsearch: `filetype:bitmap ${query}`,
    gsrnamespace: '6',
    gsrlimit: '9',
    prop: 'imageinfo',
    iiprop: 'url|extmetadata',
    iiurlwidth: '400',
    format: 'json',
    origin: '*',
  });

  const response = await fetch(`https://commons.wikimedia.org/w/api.php?${params.toString()}`);
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }

  const data = (await response.json()) as { query?: { pages?: Record<string, CommonsPage> } };
  const pages = Object.values(data.query?.pages ?? {});

  return pages.flatMap((page) => {
    const info = page.imageinfo?.[0];
    if (!info?.url) {
      return [];
    }

    return [
      {
        id: `commons-${page.pageid}`,
        title: (page.title ?? '').replace(/^File:/, ''),
        thumbUrl: info.thumburl ?? info.url,
        fullUrl: info.url,
        license: stripTags(info.extmetadata?.LicenseShortName?.value ?? '') || 'See source',
        author: stripTags(info.extmetadata?.Artist?.value ?? '') || 'Unknown',
        sourcePage: info.descriptionurl ?? '',
        provider: 'Wikimedia Commons' as const,
      },
    ];
  });
}

export async function searchOpenverse(query: string): Promise<ImageResult[]> {
  const response = await fetch(`https://api.openverse.org/v1/images/?q=${encodeURIComponent(query)}&page_size=9`);
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }

  const data = (await response.json()) as { results?: OpenverseItem[] };

  return (data.results ?? []).flatMap((item) => {
    if (!item.url) {
      return [];
    }

    return [
      {
        id: `openverse-${item.id}`,
        title: item.title ?? 'Untitled',
        thumbUrl: item.thumbnail ?? item.url,
        fullUrl: item.url,
        license: `CC ${(item.license ?? '').toUpperCase()} ${item.license_version ?? ''}`.trim(),
        author: item.creator ?? 'Unknown',
        sourcePage: item.foreign_landing_url ?? '',
        provider: 'Openverse' as const,
      },
    ];
  });
}

type GoogleImageItem = {
  title?: string;
  link?: string;
  displayLink?: string;
  mime?: string;
  image?: { thumbnailLink?: string; contextLink?: string };
};

// Broad web image search via Google Programmable Search (Custom Search JSON API). Covers the
// millions of images the free-licensed repos don't — e.g. Ghanaian public figures. Results are
// general web images (usually copyrighted), so they're labelled "verify rights" and credited to
// their source domain; confirm you may use one before publishing. Returns [] when unconfigured.
export async function searchGoogleImages(query: string): Promise<ImageResult[]> {
  const key = import.meta.env.VITE_GOOGLE_CSE_KEY;
  const cx = import.meta.env.VITE_GOOGLE_CSE_CX;
  if (!key || !cx) {
    return [];
  }

  const params = new URLSearchParams({
    key,
    cx,
    q: query,
    searchType: 'image',
    num: '9',
    safe: 'active',
  });

  const response = await fetch(`https://www.googleapis.com/customsearch/v1?${params.toString()}`);
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }

  const data = (await response.json()) as { items?: GoogleImageItem[] };
  return (data.items ?? []).flatMap((item, index) => {
    if (!item.link) {
      return [];
    }
    return [
      {
        id: `google-${index}-${item.link}`,
        title: item.title ?? 'Web image',
        thumbUrl: item.image?.thumbnailLink ?? item.link,
        fullUrl: item.link,
        license: '⚠ Web — verify rights',
        author: item.displayLink ?? 'web',
        sourcePage: item.image?.contextLink ?? item.link,
        provider: 'Google' as const,
      },
    ];
  });
}

type SerperImage = {
  title?: string;
  imageUrl?: string;
  thumbnailUrl?: string;
  source?: string;
  domain?: string;
  link?: string;
};

// Broad web image search via Serper.dev (real Google Images). Serper is CORS-enabled, so it
// runs directly from the browser — no project/CSE/enable setup like Google's own API. Returns
// [] when unconfigured. Results are general web images (usually copyrighted), so they're
// labelled "verify rights" and credited to their source domain. gl=gh biases to Ghana.
export async function searchSerperImages(query: string): Promise<ImageResult[]> {
  const key = import.meta.env.VITE_SERPER_API_KEY;
  if (!key) {
    return [];
  }

  const response = await fetch('https://google.serper.dev/images', {
    method: 'POST',
    headers: { 'X-API-KEY': key, 'Content-Type': 'application/json' },
    body: JSON.stringify({ q: query, num: 10, gl: 'gh' }),
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }

  const data = (await response.json()) as { images?: SerperImage[] };
  return (data.images ?? []).flatMap((item, index) => {
    if (!item.imageUrl) {
      return [];
    }
    return [
      {
        id: `serper-${index}-${item.imageUrl}`,
        title: item.title ?? 'Web image',
        thumbUrl: item.thumbnailUrl ?? item.imageUrl,
        fullUrl: item.imageUrl,
        license: '⚠ Web — verify rights',
        author: item.source ?? item.domain ?? 'web',
        sourcePage: item.link ?? item.imageUrl,
        provider: 'Google' as const,
      },
    ];
  });
}

export function loadImage(url: string, crossOrigin = true) {
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image();
    if (crossOrigin) {
      image.crossOrigin = 'anonymous';
    }
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('Image failed to load'));
    image.src = url;
  });
}

export async function loadImageWithProxyFallback(url: string) {
  try {
    return await loadImage(url);
  } catch {
    return loadImage(`https://images.weserv.nl/?url=${encodeURIComponent(url)}`);
  }
}

// Best licensed photo for an editorial query: Wikipedia lead images first (the canonical
// photo of the entity), then Commons keyword matches. Returns the loaded image plus the
// attribution line that must appear on the card.
export async function findBestPhoto(query: string): Promise<{ image: HTMLImageElement; credit: string } | null> {
  // Tier 1 — freely-licensed sources (Wikipedia lead image, Commons, Openverse). Openverse alone
  // adds millions of CC-licensed images, so coverage is far wider than Commons+Wikipedia.
  const settled = await Promise.allSettled([searchWikipediaImages(query), searchCommons(query), searchOpenverse(query)]);
  const licensed = dedupeResults(settled.flatMap((result) => (result.status === 'fulfilled' ? result.value : [])));

  for (const candidate of licensed.slice(0, 5)) {
    try {
      const image = await loadImageWithProxyFallback(candidate.fullUrl);
      const author = candidate.author.length > 24 ? `${candidate.author.slice(0, 23)}…` : candidate.author;
      return { image, credit: `Photo: ${author} (${candidate.license})` };
    } catch {
      // Try the next candidate.
    }
  }

  // Tier 2 — broad web fallback (Serper / Google Images) when nothing licensed matched. Credited to
  // the source; rights aren't guaranteed, so this is a last resort for coverage.
  try {
    const broad = dedupeResults(await searchSerperImages(query));
    for (const candidate of broad.slice(0, 5)) {
      try {
        const image = await loadImageWithProxyFallback(candidate.fullUrl);
        return { image, credit: `Photo: via ${candidate.author || 'web'}` };
      } catch {
        // Try the next candidate.
      }
    }
  } catch {
    // Serper unavailable (no key) or failed — nothing more to try.
  }

  return null;
}
