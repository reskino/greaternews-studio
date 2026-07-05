export type ImageResult = {
  id: string;
  title: string;
  thumbUrl: string;
  fullUrl: string;
  license: string;
  author: string;
  sourcePage: string;
  provider: 'Wikimedia Commons' | 'Openverse';
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
};

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
