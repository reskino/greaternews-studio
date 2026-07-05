import type { CommandMode, FeedItem, FeedSource, PostedLogEntry, StoryBucket, StoryCategory, StoryDraft, StoryStatus } from './types';
import { decodeEntities, normalizeWhitespace } from './text';

export const storyBuckets: StoryBucket[] = [
  { title: 'Ghana politics & governance', emoji: '🇬🇭', note: 'Lead with attribution and avoid partisan framing.' },
  { title: 'Ghana business & economy', emoji: '💰', note: 'Keep figures exact and label any developing claim.' },
  { title: 'Sports', emoji: '⚽', note: 'Use lively language, but keep the facts clean.' },
  { title: 'Entertainment & culture', emoji: '🎭', note: 'Light Ghanaian expressions are fine here.' },
  { title: 'World news', emoji: '🌍', note: 'Prioritize Reuters, AP, BBC, AFP, or official statements.' },
  { title: 'Tech / trending', emoji: '📱', note: 'Use only when the story is verified and relevant.' },
];

export const categoryOrder: StoryCategory[] = [
  'Ghana politics & governance',
  'Ghana business & economy',
  'Sports',
  'Entertainment & culture',
  'World news',
  'Tech / trending',
];

const dailyLimits: Record<StoryCategory, number> = {
  'Ghana politics & governance': 2,
  'Ghana business & economy': 1,
  Sports: 2,
  'Entertainment & culture': 1,
  'World news': 2,
  'Tech / trending': 1,
};

export const storyTemplates: StoryDraft[] = [
  {
    id: 'politics',
    title: 'Politics slot',
    category: 'Ghana politics & governance',
    status: 'READY',
    headline: 'Paste the verified political headline here',
    primarySource: 'Official statement or government release',
    backupSources: 'GhanaWeb, MyJoyOnline, Citi Newsroom',
    sourcesSearched: 'Official website, GhanaWeb, MyJoyOnline',
    verificationNotes: 'Confirm the names, date, and office involved before posting.',
    keyFacts: 'Add 2 to 4 verified facts from current coverage.',
    angle: 'Explain why the update matters to everyday readers.',
    quote: 'Use one short attributed quote if needed.',
    cta: 'What do you think?',
    imageSuggestion: 'Use a clean government-themed graphic with a headline bar.',
    menuNote: 'Best for cabinet, parliament, policy, or governance updates.',
    isLive: false,
  },
  {
    id: 'economy',
    title: 'Business slot',
    category: 'Ghana business & economy',
    status: 'READY',
    headline: 'Paste the verified economy headline here',
    primarySource: 'Bank of Ghana, ministry, company statement, or Reuters',
    backupSources: 'Citi Newsroom, Graphic Online, Reuters',
    sourcesSearched: 'Official release, Reuters, Citi Newsroom',
    verificationNotes: 'Check figures carefully and keep the wording exact.',
    keyFacts: 'Use the exact rate, price, or market movement from the source.',
    angle: 'Translate the numbers into real-world impact for readers.',
    quote: 'Only use a quote if it is directly relevant to the figures.',
    cta: 'How is this affecting you?',
    imageSuggestion: 'Use charts, price tags, or a market-themed infographic.',
    menuNote: 'Best for cedi, fuel, inflation, banking, and market stories.',
    isLive: false,
  },
  {
    id: 'sports',
    title: 'Sports slot',
    category: 'Sports',
    status: 'READY',
    headline: 'Paste the verified sports headline here',
    primarySource: 'Club statement, GFA, FIFA, CAF, or Reuters',
    backupSources: '3News, GBC, BBC Sport',
    sourcesSearched: 'GFA, Reuters, BBC Sport',
    verificationNotes: 'Double-check scorelines, names, and match times.',
    keyFacts: 'Include the score, fixture, or transfer fact that is confirmed.',
    angle: 'Keep the tone lively while staying factual.',
    quote: 'Use one short reaction quote at most.',
    cta: 'Did your team get the result you wanted?',
    imageSuggestion: 'Use a bold sports card or scoreboard graphic.',
    menuNote: 'Best for Black Stars, GPL, transfers, and major world football.',
    isLive: false,
  },
  {
    id: 'entertainment',
    title: 'Entertainment slot',
    category: 'Entertainment & culture',
    status: 'READY',
    headline: 'Paste the verified entertainment headline here',
    primarySource: 'Official page, event organiser, or verified entertainment outlet',
    backupSources: 'GhanaWeb, 3News, MyJoyOnline',
    sourcesSearched: 'Official page, 3News, MyJoyOnline',
    verificationNotes: 'Use light language only after the facts are confirmed.',
    keyFacts: 'Add the event, release, or cultural update with names and date.',
    angle: 'Connect the story to audience interest without gossip.',
    quote: 'One direct quote only if it adds value.',
    cta: 'Would you watch or attend?',
    imageSuggestion: 'Use a clean entertainment poster or event-style graphic.',
    menuNote: 'Best for music, film, awards, festivals, and culture.',
    isLive: false,
  },
  {
    id: 'world',
    title: 'World news slot',
    category: 'World news',
    status: 'READY',
    headline: 'Paste the verified world headline here',
    primarySource: 'Reuters, AP, BBC, AFP, or an official statement',
    backupSources: 'BBC, Al Jazeera, Reuters',
    sourcesSearched: 'Reuters, AP, BBC',
    verificationNotes: 'Keep global reporting neutral and current.',
    keyFacts: 'Use the latest confirmed development only.',
    angle: 'Show the global significance in one line.',
    quote: 'Use a short attributed quote when the source is official.',
    cta: 'How do you see this affecting the world?',
    imageSuggestion: 'Use a world map, news desk, or clean breaking-news graphic.',
    menuNote: 'Best for Reuters/AP/BBC top stories and official statements.',
    isLive: false,
  },
  {
    id: 'tech',
    title: 'Tech slot',
    category: 'Tech / trending',
    status: 'READY',
    headline: 'Paste the verified tech or trending headline here',
    primarySource: 'Company post, official changelog, or reputable tech outlet',
    backupSources: 'Reuters, The Verge, TechCrunch',
    sourcesSearched: 'Company blog, Reuters, TechCrunch',
    verificationNotes: 'Do not turn rumors into facts.',
    keyFacts: 'Keep the feature, launch, or trend description tight.',
    angle: 'Explain why people should care now.',
    quote: 'Use one quote from the company or official announcement if needed.',
    cta: 'Would you try it?',
    imageSuggestion: 'Use a product mockup or clean futuristic graphic.',
    menuNote: 'Best for product updates, platform changes, and trend stories.',
    isLive: false,
  },
];

export const feedSources: FeedSource[] = [
  {
    label: 'Al Jazeera',
    newsDomain: 'aljazeera.com',
    url: 'https://www.aljazeera.com/xml/rss/all.xml',
    categoryHint: 'World news',
    priority: 1,
    backupSources: 'BBC, Reuters, AFP, official statement',
    sourcesSearched: 'Al Jazeera, BBC, Reuters',
    verificationNotes: 'Check the latest Al Jazeera update against a second outlet.',
    keyFactsPrefix: 'Al Jazeera reports',
    angle: 'A global development with direct impact on readers.',
    quote: 'Use a short official quote if the feed includes one.',
    cta: 'How do you see this affecting the world?',
    imageSuggestion: 'Use a world map or a clean breaking-news graphic.',
    menuNote: 'Global breaking and developing international stories.',
  },
  {
    label: 'BBC Africa',
    newsDomain: 'bbc.com',
    url: 'https://feeds.bbci.co.uk/news/world/africa/rss.xml',
    categoryHint: 'World news',
    priority: 2,
    backupSources: 'Reuters, Al Jazeera, AFP, official statement',
    sourcesSearched: 'BBC Africa, Reuters, Al Jazeera',
    verificationNotes: 'Confirm the country, names, and figures with a second outlet.',
    keyFactsPrefix: 'BBC Africa reports',
    angle: 'An African development that matters to Ghanaian readers.',
    quote: 'Use a short attributed quote only if it adds clarity.',
    cta: 'What do you think?',
    imageSuggestion: 'Use an Africa-focused editorial card with a location label.',
    menuNote: 'Continental stories with strong relevance to Ghana and West Africa.',
  },
  {
    label: 'France 24',
    newsDomain: 'france24.com',
    url: 'https://www.france24.com/en/rss',
    categoryHint: 'World news',
    priority: 3,
    backupSources: 'Reuters, BBC, AFP, official statement',
    sourcesSearched: 'France 24, Reuters, BBC',
    verificationNotes: 'Cross-check with Reuters, BBC, or an official statement.',
    keyFactsPrefix: 'France 24 reports',
    angle: 'Show the global significance in one line.',
    quote: 'Use a short official quote if available.',
    cta: 'How do you see this affecting the world?',
    imageSuggestion: 'Use a clean international-news graphic.',
    menuNote: 'International headlines with good Africa and Europe coverage.',
  },
  {
    label: 'BBC World',
    newsDomain: 'bbc.com',
    url: 'https://feeds.bbci.co.uk/news/world/rss.xml',
    categoryHint: 'World news',
    priority: 4,
    backupSources: 'Reuters, AP, AFP',
    sourcesSearched: 'BBC, Reuters, AP',
    verificationNotes: 'Cross-check with Reuters or an official statement.',
    keyFactsPrefix: 'BBC reports',
    angle: 'A global update with immediate relevance.',
    quote: 'Use a short official quote if available.',
    cta: 'What do you think?',
    imageSuggestion: 'Use a world news panel or location-based graphic.',
    menuNote: 'Top international stories from BBC World.',
  },
  {
    label: 'BBC Business',
    newsDomain: 'bbc.com',
    url: 'https://feeds.bbci.co.uk/news/business/rss.xml',
    categoryHint: 'Ghana business & economy',
    priority: 5,
    backupSources: 'Reuters, Bank of Ghana, official statement',
    sourcesSearched: 'BBC Business, Reuters, official source',
    verificationNotes: 'Keep the numbers exact and current.',
    keyFactsPrefix: 'BBC business coverage says',
    angle: 'Explain the effect on households or markets.',
    quote: 'Use a short attributed quote when it clarifies the numbers.',
    cta: 'How is this affecting you?',
    imageSuggestion: 'Use charts, markets, or currency visuals.',
    menuNote: 'Business, market, and economic developments.',
  },
  {
    label: 'BBC Sport',
    newsDomain: 'bbc.com',
    url: 'https://feeds.bbci.co.uk/sport/rss.xml?edition=uk',
    categoryHint: 'Sports',
    priority: 6,
    backupSources: 'Reuters, GFA, club statement',
    sourcesSearched: 'BBC Sport, Reuters, club statement',
    verificationNotes: 'Double-check the score, time, and player names.',
    keyFactsPrefix: 'BBC Sport reports',
    angle: 'Keep the tone lively while staying factual.',
    quote: 'One short reaction quote at most.',
    cta: 'Did your team get the result you wanted?',
    imageSuggestion: 'Use a scoreboard or strong sports card.',
    menuNote: 'Football, transfers, results, and major sports news.',
  },
  {
    label: 'BBC Technology',
    newsDomain: 'bbc.com',
    url: 'https://feeds.bbci.co.uk/news/technology/rss.xml',
    categoryHint: 'Tech / trending',
    priority: 7,
    backupSources: 'Reuters, official company blog, TechCrunch',
    sourcesSearched: 'BBC Technology, Reuters, official source',
    verificationNotes: 'Avoid rumor; keep only confirmed product details.',
    keyFactsPrefix: 'BBC Technology says',
    angle: 'Show why the update matters now.',
    quote: 'Use one attributed quote if the company is named.',
    cta: 'Would you try it?',
    imageSuggestion: 'Use a clean tech illustration or device mockup.',
    menuNote: 'Devices, apps, AI, and digital platform changes.',
  },
  {
    label: 'GhanaWeb',
    newsDomain: 'ghanaweb.com',
    url: 'https://www.ghanaweb.com/GhanaHomePage/NewsArchive/rss.php',
    priority: 8,
    backupSources: 'MyJoyOnline, Citi Newsroom, 3News',
    sourcesSearched: 'GhanaWeb, MyJoyOnline, Citi Newsroom',
    verificationNotes: 'Use for current Ghana headlines, but always confirm elsewhere.',
    keyFactsPrefix: 'GhanaWeb reports',
    angle: 'Explain the local impact in plain language.',
    quote: 'Use one direct quote only if it is important.',
    cta: 'What do you think?',
    imageSuggestion: 'Use a Ghana-focused editorial card.',
    menuNote: 'General Ghana news that can be filtered into local categories.',
  },
  {
    label: 'MyJoyOnline',
    newsDomain: 'myjoyonline.com',
    url: 'https://www.myjoyonline.com/feed/',
    priority: 9,
    backupSources: 'GhanaWeb, Citi Newsroom, 3News',
    sourcesSearched: 'MyJoyOnline, GhanaWeb, Citi Newsroom',
    verificationNotes: 'Use current Ghana coverage and verify names carefully.',
    keyFactsPrefix: 'MyJoyOnline reports',
    angle: 'Keep the update practical for readers.',
    quote: 'Use one short quote only if it adds value.',
    cta: 'What do you think?',
    imageSuggestion: 'Use a Ghana editorial graphic with a headline strip.',
    menuNote: 'Broad Ghana news coverage for politics, business, sports, and culture.',
  },
  {
    label: 'Citi Newsroom',
    newsDomain: 'citinewsroom.com',
    url: 'https://citinewsroom.com/feed/',
    priority: 10,
    backupSources: 'GhanaWeb, MyJoyOnline, 3News',
    sourcesSearched: 'Citi Newsroom, GhanaWeb, MyJoyOnline',
    verificationNotes: 'Confirm the exact names and figures before posting.',
    keyFactsPrefix: 'Citi Newsroom reports',
    angle: 'Translate the update into everyday impact.',
    quote: 'Use a short attributed quote only if necessary.',
    cta: 'How do you see this playing out?',
    imageSuggestion: 'Use a crisp newsroom graphic with a source line.',
    menuNote: 'Credible Ghana coverage across governance, business, and culture.',
  },
  {
    label: '3News',
    newsDomain: '3news.com',
    url: 'https://3news.com/feed/',
    priority: 11,
    backupSources: 'GhanaWeb, MyJoyOnline, Citi Newsroom',
    sourcesSearched: '3News, GhanaWeb, MyJoyOnline',
    verificationNotes: 'Use the feed as a current lead, then verify with a second source.',
    keyFactsPrefix: '3News reports',
    angle: 'Show why the story matters locally.',
    quote: 'One quote max, and keep it short.',
    cta: 'What do you think?',
    imageSuggestion: 'Use a bold Ghana news card with source label.',
    menuNote: 'Fresh Ghana stories that often span the main buckets.',
  },
  {
    label: 'GBC Ghana',
    newsDomain: 'gbcghanaonline.com',
    url: 'https://www.gbcghanaonline.com/feed/',
    priority: 12,
    backupSources: 'GhanaWeb, MyJoyOnline, Citi Newsroom',
    sourcesSearched: 'GBC Ghana, GhanaWeb, MyJoyOnline',
    verificationNotes: 'Use official public-service reporting when possible.',
    keyFactsPrefix: 'GBC Ghana reports',
    angle: 'Keep the language simple and factual.',
    quote: 'Use a short official quote if available.',
    cta: 'What do you think?',
    imageSuggestion: 'Use a government or civic-themed graphic.',
    menuNote: 'Public-interest Ghana updates and civic coverage.',
  },
];

type Rss2JsonResponse = {
  status: string;
  items?: Array<{
    title?: string;
    link?: string;
    description?: string;
    pubDate?: string;
  }>;
};

async function fetchViaRss2Json(url: string, signal?: AbortSignal): Promise<FeedItem[]> {
  const endpoint = `https://api.rss2json.com/v1/api.json?rss_url=${encodeURIComponent(url)}`;
  const response = await fetch(endpoint, { cache: 'no-store', signal });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }

  const data = (await response.json()) as Rss2JsonResponse;
  if (data.status !== 'ok' || !Array.isArray(data.items)) {
    throw new Error('Feed did not return any items');
  }

  return data.items.map((item) => ({
    title: decodeEntities(item.title ?? ''),
    link: normalizeWhitespace(item.link ?? ''),
    summary: decodeEntities(item.description ?? ''),
    publishedAt: item.pubDate,
  }));
}

function parseXmlFeed(xmlText: string): FeedItem[] {
  const parsed = new DOMParser().parseFromString(xmlText, 'text/xml');
  if (parsed.querySelector('parsererror')) {
    throw new Error('Feed XML did not parse');
  }

  const rssItems = Array.from(parsed.querySelectorAll('item'));
  if (rssItems.length > 0) {
    return rssItems.map((item) => ({
      title: decodeEntities(item.querySelector('title')?.textContent ?? ''),
      link: normalizeWhitespace(item.querySelector('link')?.textContent ?? ''),
      summary: decodeEntities(item.querySelector('description')?.textContent ?? ''),
      publishedAt: item.querySelector('pubDate')?.textContent ?? undefined,
    }));
  }

  return Array.from(parsed.querySelectorAll('entry')).map((entry) => ({
    title: decodeEntities(entry.querySelector('title')?.textContent ?? ''),
    link: normalizeWhitespace(entry.querySelector('link')?.getAttribute('href') ?? ''),
    summary: decodeEntities(entry.querySelector('summary')?.textContent ?? entry.querySelector('content')?.textContent ?? ''),
    publishedAt: entry.querySelector('published')?.textContent ?? entry.querySelector('updated')?.textContent ?? undefined,
  }));
}

async function fetchRawXml(feedUrl: string, signal?: AbortSignal): Promise<FeedItem[]> {
  const endpoint = `https://api.allorigins.win/raw?url=${encodeURIComponent(feedUrl)}`;
  const response = await fetch(endpoint, { cache: 'no-store', signal });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }

  const items = parseXmlFeed(await response.text());
  if (items.length === 0) {
    throw new Error('Feed XML contained no items');
  }

  return items;
}

function googleNewsFeedUrl(domain: string) {
  return `https://news.google.com/rss/search?q=site:${encodeURIComponent(domain)}&hl=en-GH&gl=GH&ceid=GH:en`;
}

// Outlets sometimes block rss2json's fetcher. Fall back to that outlet's stories
// via Google News RSS, then to the raw feed XML through a CORS proxy.
async function fetchFeedItems(source: FeedSource, signal?: AbortSignal): Promise<FeedItem[]> {
  // Google News appends " - Publisher" to every title; strip that trailing segment.
  const stripOutletSuffix = (items: FeedItem[]) =>
    items.map((item) => ({ ...item, title: item.title.replace(/\s+-\s+[^-]+$/, '').trim() || item.title }));

  const attempts: Array<() => Promise<FeedItem[]>> = [
    () => fetchViaRss2Json(source.url, signal),
    () => fetchViaRss2Json(googleNewsFeedUrl(source.newsDomain), signal).then(stripOutletSuffix),
    () => fetchRawXml(source.url, signal),
  ];

  let lastError: unknown = new Error('All feed routes failed');

  for (const attempt of attempts) {
    if (signal?.aborted) {
      break;
    }

    try {
      const items = await attempt();
      if (items.length > 0) {
        return items;
      }
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError instanceof Error ? lastError : new Error('All feed routes failed');
}

async function fetchFeedItemsWithTimeout(source: FeedSource, timeoutMs: number, parentSignal?: AbortSignal) {
  const controller = new AbortController();
  const timeoutId = window.setTimeout(() => controller.abort(), timeoutMs);

  if (parentSignal) {
    if (parentSignal.aborted) {
      controller.abort();
    } else {
      parentSignal.addEventListener('abort', () => controller.abort(), { once: true });
    }
  }

  try {
    return await fetchFeedItems(source, controller.signal);
  } finally {
    window.clearTimeout(timeoutId);
  }
}

function detectCategory(text: string, source: FeedSource): StoryCategory {
  if (source.categoryHint) {
    return source.categoryHint;
  }

  const searchable = text.toLowerCase();

  if (/\b(world|ukraine|israel|gaza|us |china|russia|france|eu|un|africa)\b/.test(searchable)) {
    return 'World news';
  }

  if (/\b(football|soccer|goal|league|match|sport|sports|black stars|gpl|transfer|fifa|caf)\b/.test(searchable)) {
    return 'Sports';
  }

  if (/\b(music|movie|film|album|concert|award|festival|showbiz|culture|artist|artiste|entertainment)\b/.test(searchable)) {
    return 'Entertainment & culture';
  }

  if (/\b(cedi|inflation|fuel|bank|economy|market|price|rates|money|finance|tax|business)\b/.test(searchable)) {
    return 'Ghana business & economy';
  }

  if (/\b(tech|technology|ai|app|software|device|platform|startup|digital|internet|phone|online)\b/.test(searchable)) {
    return 'Tech / trending';
  }

  return 'Ghana politics & governance';
}

function summarize(text: string, limit = 150) {
  if (!text) {
    return '';
  }

  const shortened = normalizeWhitespace(text).replace(/[\u0000-\u001F]+/g, '');
  if (shortened.length <= limit) {
    return shortened;
  }

  return `${shortened.slice(0, limit - 1).trimEnd()}…`;
}

function buildLiveDraft(seed: FeedItem, source: FeedSource): StoryDraft {
  const combinedText = `${seed.title} ${seed.summary} ${source.menuNote}`;
  const category = detectCategory(combinedText, source);
  const status: StoryStatus = 'READY';

  return {
    id: `${source.label}-${seed.link || seed.title}`.replace(/[^a-z0-9]+/gi, '-').toLowerCase(),
    title: seed.title || source.label,
    category,
    status,
    headline: seed.title || source.label,
    primarySource: source.label,
    backupSources: source.backupSources,
    sourcesSearched: source.sourcesSearched,
    verificationNotes: source.verificationNotes,
    keyFacts: seed.summary ? summarize(`${source.keyFactsPrefix} ${seed.summary}`) : `${source.keyFactsPrefix} the latest update in the feed.`,
    angle: source.angle,
    quote: source.quote,
    cta: source.cta,
    imageSuggestion: source.imageSuggestion,
    menuNote: seed.summary || source.menuNote,
    publishedAt: seed.publishedAt,
    link: seed.link,
    isLive: true,
  };
}

function dedupeStories(stories: StoryDraft[]) {
  const seen = new Set<string>();

  return stories.filter((story) => {
    const key = normalizeWhitespace(`${story.headline} ${story.primarySource}`).toLowerCase();
    if (seen.has(key)) {
      return false;
    }

    seen.add(key);
    return true;
  });
}

function sortStories(left: StoryDraft, right: StoryDraft) {
  const leftCategoryIndex = categoryOrder.indexOf(left.category);
  const rightCategoryIndex = categoryOrder.indexOf(right.category);

  if (leftCategoryIndex !== rightCategoryIndex) {
    return leftCategoryIndex - rightCategoryIndex;
  }

  const leftDate = left.publishedAt ? Date.parse(left.publishedAt) : 0;
  const rightDate = right.publishedAt ? Date.parse(right.publishedAt) : 0;

  if (leftDate !== rightDate) {
    return rightDate - leftDate;
  }

  return left.title.localeCompare(right.title);
}

function matchesTopic(text: string, topic: string) {
  const normalizedTopic = normalizeWhitespace(topic).toLowerCase();
  if (!normalizedTopic) {
    return true;
  }

  const searchable = text.toLowerCase();
  return normalizedTopic
    .split(/\s+/)
    .filter(Boolean)
    .some((part) => searchable.includes(part));
}

function filterByTopic(stories: StoryDraft[], topic: string) {
  if (!normalizeWhitespace(topic)) {
    return stories;
  }

  return stories.filter((story) => {
    const searchable = `${story.title} ${story.headline} ${story.menuNote} ${story.keyFacts} ${story.category} ${story.primarySource}`;
    return matchesTopic(searchable, topic);
  });
}

function selectDailyStories(stories: StoryDraft[]) {
  const result: StoryDraft[] = [];

  for (const category of categoryOrder) {
    const limit = dailyLimits[category];
    result.push(...stories.filter((story) => story.category === category).slice(0, limit));
  }

  return result.slice(0, 8);
}

export function isAlreadyPosted(story: StoryDraft, log: PostedLogEntry[]) {
  const key = normalizeWhitespace(story.headline).toLowerCase();
  return log.some((entry) => normalizeWhitespace(entry.title).toLowerCase() === key);
}

export function selectMenuStories(mode: CommandMode, topic: string, liveStories: StoryDraft[], postedLog: PostedLogEntry[]) {
  const filtered = filterByTopic(liveStories, topic);

  if (filtered.length === 0) {
    return storyTemplates;
  }

  const ordered = dedupeStories([...filtered].sort(sortStories));

  if (mode === 'breaking') {
    const breakingStory = ordered[0] ?? storyTemplates[0];
    const developingStory: StoryDraft = {
      ...breakingStory,
      status: 'DEVELOPING',
      verificationNotes: `${breakingStory.verificationNotes} This one is DEVELOPING until a second source confirms it.`,
      cta: 'Follow GreaterNews for updates.',
      menuNote: `${breakingStory.menuNote} This is currently marked DEVELOPING.`,
    };
    return [developingStory];
  }

  if (mode === 'auto' || mode === 'story') {
    const unposted = ordered.filter((story) => !isAlreadyPosted(story, postedLog));
    return (unposted.length > 0 ? unposted : ordered).slice(0, 5);
  }

  return selectDailyStories(ordered);
}

export async function fetchAllFeeds(signal?: AbortSignal) {
  const results = await Promise.allSettled(
    feedSources.map(async (source) => {
      const items = await fetchFeedItemsWithTimeout(source, 15000, signal);
      return { source, items };
    }),
  );

  const stories = dedupeStories(
    results
      .flatMap((result) => (result.status === 'fulfilled' ? result.value.items.map((item) => buildLiveDraft(item, result.value.source)) : []))
      .sort(sortStories),
  );

  const failedFeeds = results.flatMap((result, index) => (result.status === 'rejected' ? [feedSources[index].label] : []));

  return { stories, failedFeeds };
}
