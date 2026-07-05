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

export function buildStoryQueries(headline: string, category?: string): string[] {
  const words = headline
    .replace(/[^\p{L}\p{N}\s'-]/gu, ' ')
    .split(/\s+/)
    .filter(Boolean);

  // Proper nouns (mid-sentence capitalized words) usually name the people and places in the story.
  const proper = words.filter((word, index) => index > 0 && /^[A-Z]/.test(word) && !STOPWORDS.has(word.toLowerCase()));
  const keywords = words.filter((word) => word.length > 3 && !STOPWORDS.has(word.toLowerCase()));

  const queries: string[] = [];
  if (proper.length >= 2) {
    queries.push([...new Set(proper)].slice(0, 4).join(' '));
  }
  if (keywords.length >= 2) {
    queries.push([...new Set(keywords)].slice(0, 4).join(' '));
  }
  if (category && categoryQueries[category]) {
    queries.push(categoryQueries[category]);
  }

  return [...new Set(queries.map((query) => query.trim()).filter(Boolean))].slice(0, 3);
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
