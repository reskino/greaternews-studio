// Real news footage for the short videos — only when a free-to-reuse copy exists.
// Wikimedia Commons hosts public-domain US-government news video (DVIDS military footage, VOA, the
// White House) and Creative Commons clips of news events. Broadcaster footage (TV news, YouTube news
// channels) is deliberately NOT used: Facebook's Rights Manager matches it and mutes/blocks the reel.
// Same rules as the Deep Dive pipeline (scripts/deep_dive_build.py → find_clip): the clip must NAME
// the subject, match most of the query's words, and be recent — old footage of a different strike
// or flood under today's narration would mislead viewers.

export type ClipResult = {
  title: string;
  description: string;
  src: string; // a web-playable transcode (webm), ≤720p
  poster: string;
  durationS: number;
  year: number | null;
  license: string;
  by: string;
  sourcePage: string;
};

export type LoadedClip = {
  video: HTMLVideoElement;
  /** On-screen credit, e.g. "VIDEO: VOA · 2026 · Public domain" ("FILE · " prefix if older than this year). */
  label: string;
  /** Where to start playing (skips opening slates). */
  start: number;
  title: string;
  credit: string;
};

type VideoInfo = {
  url?: string;
  descriptionurl?: string;
  thumburl?: string;
  duration?: number;
  height?: number;
  derivatives?: Array<{ src: string; type?: string; height?: number | string }>;
  extmetadata?: Record<string, { value?: string } | undefined>;
};
type VideoPage = { pageid: number; index?: number; title?: string; videoinfo?: VideoInfo[] };

const NAME_STOP = new Set(['the', 'a', 'an', 'of', 'in', 'on', 'at', 'for', 'and', 'or', 'to', 'with', 'by', 'from', 'as']);
const GENERIC = new Set(['the', 'and', 'with', 'for', 'from', 'into', 'near', 'over', 'view', 'shot', 'video', 'footage',
  'clip', 'close', 'slow', 'motion', 'scene', 'people', 'person', 'man', 'woman', 'very']);

function normalize(text: string) {
  return ` ${text.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()} `;
}

function stripHtml(html: string | undefined) {
  if (!html) return '';
  const parsed = new DOMParser().parseFromString(html, 'text/html');
  return (parsed.body.textContent ?? '').replace(/\s+/g, ' ').trim();
}

/** The specific people/places a query names = its capitalised words ("Mahama", "Iran"). */
export function clipNames(query: string): string[] {
  const words: string[] = [];
  for (const raw of query.match(/\b[A-Z][\w'-]*/g) ?? []) {
    for (const token of normalize(raw).trim().split(' ')) {
      if (token.length > 1 && !NAME_STOP.has(token)) words.push(token);
    }
  }
  const specific = words.filter((word) => word !== 'ghana' && word !== 'ghanaian');
  return specific.length ? specific : words;
}

/** Crude stems: 'strikes'~'strike', 'celebrating'~'celebration'. */
export function clipStems(text: string): Set<string> {
  const out = new Set<string>();
  for (let word of text.toLowerCase().match(/[a-z]+/g) ?? []) {
    if (word.length <= 2 || GENERIC.has(word)) continue;
    if (word === 'soccer') word = 'football';
    if (word.endsWith('s') && word.length > 3) word = word.slice(0, -1);
    out.add(word.slice(0, 5));
  }
  return out;
}

function yearOf(meta: VideoInfo['extmetadata']): number | null {
  for (const key of ['DateTimeOriginal', 'DateTime']) {
    const match = String(meta?.[key]?.value ?? '').match(/\b(19|20)\d\d\b/);
    if (match) return Number(match[0]);
  }
  return null;
}

function byOf(meta: VideoInfo['extmetadata']): string {
  const artist = stripHtml(meta?.Artist?.value);
  const cats = String(meta?.Categories?.value ?? '');
  if (artist && !/null/i.test(artist) && artist.length <= 48) return artist;
  if (/Voice of America|VOA/.test(cats)) return 'VOA';
  if (/PD US Military|Department of Defense|DVIDS/.test(cats)) return 'U.S. Dept. of Defense (DVIDS)';
  if (/White House/.test(cats)) return 'The White House';
  if (/PD US Government/.test(cats)) return 'U.S. Government';
  return 'Wikimedia Commons';
}

function playableSrc(info: VideoInfo): string | null {
  const webm = (info.derivatives ?? []).filter((d) => /webm/.test(d.type ?? '') && Number(d.height ?? 0) >= 360 && Number(d.height ?? 0) <= 720);
  if (webm.length) return webm.sort((a, b) => Number(b.height ?? 0) - Number(a.height ?? 0))[0].src;
  return null;
}

/** Search Commons for video files (search-rank order), with license + credit. */
export async function searchCommonsVideos(query: string): Promise<ClipResult[]> {
  const params = new URLSearchParams({
    action: 'query', format: 'json', origin: '*', generator: 'search', gsrnamespace: '6', gsrlimit: '15',
    gsrsearch: `filetype:video ${query}`, prop: 'videoinfo', viprop: 'url|size|extmetadata|derivatives', viurlwidth: '640',
  });
  // A stalled request must never hang a render (2026-11-26: one beat's lookup froze the whole run).
  const response = await fetch(`https://commons.wikimedia.org/w/api.php?${params.toString()}`, { signal: AbortSignal.timeout(15000) });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const data = (await response.json()) as { query?: { pages?: Record<string, VideoPage> } };
  const pages = Object.values(data.query?.pages ?? {}).sort((a, b) => (a.index ?? 1e9) - (b.index ?? 1e9)); // rank, not page id
  return pages.flatMap((page) => {
    const info = page.videoinfo?.[0];
    const src = info ? playableSrc(info) : null;
    if (!info || !src) return [];
    const meta = info.extmetadata;
    return [{
      title: (page.title ?? '').replace(/^File:/, '').replace(/\.[a-z0-9]+$/i, ''),
      description: stripHtml(meta?.ImageDescription?.value).slice(0, 300),
      src,
      poster: info.thumburl ?? '',
      durationS: Number(info.duration ?? 0),
      year: yearOf(meta),
      license: stripHtml(meta?.LicenseShortName?.value) || 'free license',
      by: byOf(meta),
      sourcePage: info.descriptionurl ?? '',
    }];
  });
}

/** Rank clips for a query: they must name the subject, match enough of its words, and be recent. */
export function pickClip(results: ClipResult[], query: string, opts: { since?: number; strict?: boolean; used?: Set<string> } = {}): ClipResult | null {
  const names = clipNames(query);
  const want = clipStems(query);
  const ratio = opts.strict ? 2 / 3 : 1 / 2;
  const need = Math.max(1, Math.ceil(want.size * ratio));
  const since = opts.since ?? new Date().getFullYear() - 1;
  // Automatic picks need a named subject (person / place / organisation): a generic query like
  // "oil prices" could otherwise match some unrelated recent clip.
  if (opts.strict && names.length === 0) return null;
  let best: { score: number; year: number; clip: ClipResult } | null = null;
  for (const clip of results) {
    const text = `${clip.title} ${clip.description}`;
    const norm = normalize(text);
    if (opts.used?.has(clip.title)) continue;
    if (names.length && !names.every((name) => norm.includes(` ${name}`))) continue;
    const have = clipStems(text);
    const score = [...want].filter((stem) => have.has(stem)).length;
    if (score < need || clip.durationS < 4 || clip.durationS > 1800) continue;
    if (!clip.year || clip.year < since) continue;
    if (!best || score > best.score || (score === best.score && clip.year > best.year)) best = { score, year: clip.year, clip };
  }
  return best?.clip ?? null;
}

export function clipLabel(clip: ClipResult) {
  const file = clip.year !== null && clip.year < new Date().getFullYear() ? 'FILE · ' : '';
  return `${file}VIDEO: ${clip.by} · ${clip.year ?? ''} · ${clip.license}`;
}

/** Load a clip into a muted, CORS-clean <video> (so it can be drawn into the export canvas). */
export function loadClipVideo(src: string, timeoutMs = 25000): Promise<HTMLVideoElement> {
  return new Promise((resolve, reject) => {
    const video = document.createElement('video');
    video.crossOrigin = 'anonymous';
    video.muted = true;
    video.playsInline = true;
    video.preload = 'auto';
    const timer = window.setTimeout(() => {
      video.removeAttribute('src'); // stop the download too, not just the wait
      video.load();
      reject(new Error('clip load timed out'));
    }, timeoutMs);
    video.onloadeddata = () => {
      window.clearTimeout(timer);
      resolve(video);
    };
    video.onerror = () => {
      window.clearTimeout(timer);
      reject(new Error('clip failed to load'));
    };
    video.src = src;
  });
}

/** Search + pick + load the best free news clip for a query, or null (caller uses a photo). */
export async function findBestClip(query: string, opts: { since?: number; strict?: boolean; used?: Set<string> } = {}): Promise<LoadedClip | null> {
  const results = await searchCommonsVideos(query).catch(() => [] as ClipResult[]);
  const clip = pickClip(results, query, opts);
  if (!clip) return null;
  try {
    const video = await loadClipVideo(clip.src);
    opts.used?.add(clip.title);
    const length = Number.isFinite(video.duration) ? video.duration : clip.durationS;
    const start = length > 8 ? Math.min(Math.max(2, length * 0.12), length - 6) : 0; // skip opening slates
    return { video, label: clipLabel(clip), start, title: clip.title, credit: `${clip.by} · ${clip.license} · ${clip.sourcePage}` };
  } catch {
    return null;
  }
}
