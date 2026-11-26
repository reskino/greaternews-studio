import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { CardFormat, CardTemplate, ChipLabel } from './cardEngine';
import { drawCard, formatSizes, templateMeta } from './cardEngine';
import type { ImageResult, SearchPlan } from './imageSearch';
import { buildHeuristicPlan, dedupeResults, filterByExcludeTerms, findBestPhoto, findStoryImages, loadImage, loadImageWithProxyFallback, searchCommons, searchGoogleImages, searchOpenverse, searchSerperImages, searchWikipediaImages } from './imageSearch';
import { resolveQuery } from './aiResolver';
import { draftVideoBeats } from './videoBeats';
import type { VideoMotion, VideoSound, VideoVoice } from './videoExport';
import { exportCardVideo, videoExportSupported } from './videoExport';
import { SOUND_LABELS, scheduleBed } from './videoAudio';
import { isTrackId, loadMusicTracks, musicUrlFor } from './music';
import type { MusicTrack } from './music';
import { clipLabel, loadClipVideo, searchCommonsVideos } from './newsClips';
import type { ClipResult } from './newsClips';
import { isBeatClip } from './videoScenes';
import type { BeatMedia } from './videoScenes';
import StepHead, { Panel } from './ui/StepHead';
import { RAIL_QUERY, useMediaQuery } from './ui/useMediaQuery';

/** Read-only facts the page shows in its checklist, sidebar ticks and status chips. */
export type CardStatus = {
  hasPhoto: boolean;
  hasCredit: boolean;
  headline: string;
  captions: number;
  voice: string;
};

type CardDesignerProps = {
  suggestedHeadline: string;
  suggestedSubline: string;
  suggestedSource: string;
  suggestedCategory: string;
  suggestedLink: string;
  weeklyHeadlines: string[];
  weeklyRange: string;
  /** Where the live preview lives on wide screens (the page's right rail). Below that width it sits in step 4. */
  previewHost?: HTMLElement | null;
  /** Slot in the rail's action card for Download PNG / Export video. */
  actionsHost?: HTMLElement | null;
  onStatusChange?: (status: CardStatus) => void;
};

const formatOrder: Array<{ key: CardFormat; label: string }> = [
  { key: 'portrait', label: '4:5' },
  { key: 'story', label: '9:16' },
  { key: 'square', label: '1:1' },
];

function mediaSrc(media: BeatMedia | undefined) {
  return media && !isBeatClip(media) ? media.src : '';
}

function formatDuration(seconds: number) {
  const whole = Math.max(0, Math.round(seconds));
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`;
}

function voiceLabel(voice: VideoVoice, groqName: string) {
  if (voice === 'groq') return `Groq · ${groqName}`;
  if (voice === 'elevenlabs') return 'ElevenLabs';
  if (voice === 'google') return 'Google';
  return 'Off';
}

const templateOrder: CardTemplate[] = ['headline', 'quote', 'update', 'stat', 'recap', 'post'];
const chipOrder: ChipLabel[] = ['UPDATE', 'DEVELOPING', 'BREAKING'];
const defaultHandle = '@GreaterNews · News You Can Trust';

const headlineLabels: Record<CardTemplate, string> = {
  headline: 'Card headline',
  quote: 'The quote (exact words, attributed)',
  update: 'The update headline',
  stat: 'Stat label (what the number means)',
  recap: 'Headlines — one per line (max 5)',
  post: 'The post text (their exact words)',
};

function initialParam(name: string, fallback: string) {
  if (typeof window === 'undefined') {
    return fallback;
  }
  return new URLSearchParams(window.location.search).get(name) ?? fallback;
}

function initialNumber(name: string, fallback: number) {
  const raw = initialParam(name, '');
  const value = Number(raw);
  return raw !== '' && Number.isFinite(value) ? value : fallback;
}

function initialTemplate(): CardTemplate {
  const requested = initialParam('template', 'headline');
  return (templateOrder as string[]).includes(requested) ? (requested as CardTemplate) : 'headline';
}

export default function CardDesigner({
  suggestedHeadline,
  suggestedSubline,
  suggestedSource,
  suggestedCategory,
  suggestedLink,
  weeklyHeadlines,
  weeklyRange,
  previewHost = null,
  actionsHost = null,
  onStatusChange,
}: CardDesignerProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const photoUrlRef = useRef<string>('');
  const [template, setTemplate] = useState<CardTemplate>(initialTemplate);
  const [headline, setHeadline] = useState(() => initialParam('headline', suggestedHeadline));
  const [subline, setSubline] = useState(() => initialParam('subline', ''));
  const [highlight, setHighlight] = useState(() => initialParam('highlight', ''));
  const [attribution, setAttribution] = useState(() => initialParam('attribution', ''));
  const [chip, setChip] = useState<ChipLabel>('UPDATE');
  const [statValue, setStatValue] = useState(() => initialParam('stat', ''));
  const [postHandle, setPostHandle] = useState(() => initialParam('posthandle', ''));
  const [postMeta, setPostMeta] = useState(() => initialParam('postmeta', ''));
  const [refImage, setRefImage] = useState('');
  const [refError, setRefError] = useState('');
  const [refLoading, setRefLoading] = useState(false);
  const [videoProgress, setVideoProgress] = useState(-1);
  const [footer, setFooter] = useState(() => initialParam('footer', ''));
  const [handle, setHandle] = useState(defaultHandle);
  const [accent, setAccent] = useState('#f3c457');
  const [dim, setDim] = useState(0.2);
  const [textShift, setTextShift] = useState(() => initialNumber('shift', 0));
  // Optional fuller story text the drafter reads to write a richer script.
  const [storyDetails, setStoryDetails] = useState('');
  // On-screen captions (one per line) — turns the clip into a multi-scene story.
  const [videoBeats, setVideoBeats] = useState(() => initialParam('beats', '').replace(/\s*\|\s*/g, '\n'));
  // Fuller spoken narration (one line per beat) — what the voice reads; slides stay short.
  const [videoNarration, setVideoNarration] = useState('');
  // Per-beat photo subjects the drafter suggests + the loaded image for each beat.
  const [videoImageQueries, setVideoImageQueries] = useState<string[]>([]);
  // Per beat: a photo, a real news clip (BeatClip), or nothing.
  const [beatImages, setBeatImages] = useState<BeatMedia[]>([]);
  const [fetchingBeatImages, setFetchingBeatImages] = useState(false);
  const [beatOptions, setBeatOptions] = useState<Record<number, ImageResult[]>>({});
  const [beatOptionsOpen, setBeatOptionsOpen] = useState<number | null>(null);
  const [loadingOptions, setLoadingOptions] = useState<number | null>(null);
  const [draftingBeats, setDraftingBeats] = useState(false);
  const [videoMotion, setVideoMotion] = useState<VideoMotion>('subtle');
  const [videoSound, setVideoSound] = useState<string>('newsroom'); // a SOUND_LABELS key or a `track:<file>` id
  const [musicTracks, setMusicTracks] = useState<MusicTrack[]>([]);
  const [videoVoice, setVideoVoice] = useState<VideoVoice>('none');
  const [groqVoiceName, setGroqVoiceName] = useState('hannah'); // Orpheus voice when videoVoice==='groq'
  const [previewingSound, setPreviewingSound] = useState(false);
  const previewCtxRef = useRef<AudioContext | null>(null);
  const [format, setFormat] = useState<CardFormat>('portrait');
  const [photo, setPhoto] = useState<HTMLImageElement | null>(null);
  const [photoName, setPhotoName] = useState('');
  const [photoSourcePage, setPhotoSourcePage] = useState('');
  const [logo, setLogo] = useState<HTMLImageElement | null>(null);
  const [fontsReady, setFontsReady] = useState(false);
  const [copied, setCopied] = useState(false);
  const [query, setQuery] = useState('');
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState('');
  const [results, setResults] = useState<ImageResult[]>([]);
  const [storyQueries, setStoryQueries] = useState<string[]>([]);
  const [loadingImageId, setLoadingImageId] = useState('');
  // Where a clicked main-search result goes: the card's main photo, or a specific beat (clip) index.
  const [searchTarget, setSearchTarget] = useState<'main' | number>('main');
  const [plan, setPlan] = useState<SearchPlan | null>(null);
  const [safeZones, setSafeZones] = useState(false);
  // Media search mode: licensed photos, or real news footage from Wikimedia Commons (beats only).
  const [mediaMode, setMediaMode] = useState<'photos' | 'clips'>('photos');
  const [clipResults, setClipResults] = useState<ClipResult[]>([]);
  const [clipSearching, setClipSearching] = useState(false);
  const [clipSearched, setClipSearched] = useState(false);
  const [clipError, setClipError] = useState('');
  const [loadingClip, setLoadingClip] = useState('');
  // Display-only metadata (poster, credit) for clips the editor picked, keyed by their <video>.
  const clipMetaRef = useRef(new WeakMap<HTMLVideoElement, ClipResult>());

  // The live preview renders into a node this component owns, so the <canvas> is never remounted;
  // the node is moved between the page's right rail (wide screens) and step 4 (narrow screens).
  const [previewNode] = useState(() => {
    const node = document.createElement('div');
    node.className = 'card-preview';
    return node;
  });
  const stepPreviewRef = useRef<HTMLDivElement>(null);
  const wide = useMediaQuery(RAIL_QUERY);

  useLayoutEffect(() => {
    const target = wide && previewHost ? previewHost : stepPreviewRef.current;
    if (target && previewNode.parentElement !== target) {
      target.appendChild(previewNode);
    }
  }, [previewHost, previewNode, wide]);

  useEffect(() => () => previewNode.remove(), [previewNode]);

  useEffect(() => {
    onStatusChange?.({
      hasPhoto: photo !== null,
      hasCredit: footer.trim() !== '',
      headline,
      captions: videoBeats.split('\n').filter((line) => line.trim()).length,
      voice: voiceLabel(videoVoice, groqVoiceName),
    });
  }, [footer, groqVoiceName, headline, onStatusChange, photo, videoBeats, videoVoice]);

  useEffect(() => {
    void loadMusicTracks().then(setMusicTracks);
  }, []);

  useEffect(() => {
    let cancelled = false;

    void document.fonts.ready.then(() => {
      if (!cancelled) {
        setFontsReady(true);
      }
    });

    loadImage(`${import.meta.env.BASE_URL}logo.png`, false)
      .then((image) => {
        if (!cancelled) {
          setLogo(image);
        }
      })
      .catch(() => {
        // No logo file — the engine falls back to the GN monogram.
      });

    return () => {
      cancelled = true;
      if (photoUrlRef.current) {
        URL.revokeObjectURL(photoUrlRef.current);
      }
    };
  }, []);

  useEffect(() => {
    if (canvasRef.current) {
      drawCard(canvasRef.current, {
        template,
        format,
        photo,
        logo,
        headline,
        subline,
        highlight,
        attribution,
        chip,
        statValue,
        postHandle,
        postMeta,
        footer,
        handle,
        accent,
        dim,
        headlineShift: textShift,
      });
    }
  }, [accent, attribution, chip, dim, fontsReady, footer, format, handle, headline, highlight, logo, photo, postHandle, postMeta, statValue, subline, template, textShift]);

  function handlePhotoUpload(files: FileList | null) {
    const file = files?.[0];
    if (!file) {
      return;
    }

    const url = URL.createObjectURL(file);
    const image = new Image();
    image.onload = () => {
      if (photoUrlRef.current) {
        URL.revokeObjectURL(photoUrlRef.current);
      }
      photoUrlRef.current = url;
      setPhoto(image);
      setPhotoName(file.name);
      setPhotoSourcePage('');
    };
    image.onerror = () => {
      URL.revokeObjectURL(url);
    };
    image.src = url;
  }

  // Core search: fetch every query across all sources, dedupe, drop wrong-country/entity
  // matches, cap at 18. Wikipedia lead images are the best hit for a named person; Commons
  // and Openverse cover places, organisations, and concepts.
  async function runQueries(queries: string[], excludeTerms: string[] = []) {
    const freeSources = queries.flatMap((term) => [searchWikipediaImages(term), searchCommons(term), searchOpenverse(term)]);
    // One web search per run (conserves quotas) on the best query; both web sources no-op
    // when unconfigured. Free-licensed sources are listed first so dedupe prefers them.
    const best = queries[0] ?? '';
    const settled = await Promise.allSettled([...freeSources, searchGoogleImages(best), searchSerperImages(best)]);
    const deduped = dedupeResults(settled.flatMap((result) => (result.status === 'fulfilled' ? result.value : [])));
    const found = filterByExcludeTerms(deduped, excludeTerms).slice(0, 18);
    setResults(found);
    const allRejected = settled.every((result) => result.status === 'rejected');
    if (found.length === 0) {
      setSearchError(
        allRejected
          ? 'Image search is unreachable right now. Check the connection and try again.'
          : 'No images found for that search. Try fewer or broader words, or upload your own photo.',
      );
    }
    return found;
  }

  async function executeSearch(queries: string[], excludeTerms: string[] = []) {
    if (queries.length === 0 || searching) {
      return;
    }
    setSearching(true);
    setSearchError('');
    setResults([]);
    await runQueries(queries, excludeTerms);
    setSearching(false);
  }

  // Manual search: let Claude disambiguate the query (Ghana-aware, "<org> role" savvy),
  // falling back to the key-free heuristic, then search the resolved plan's queries.
  async function runImageSearch() {
    const trimmed = query.trim();
    if (!trimmed || searching) {
      return;
    }
    setSearching(true);
    setSearchError('');
    setResults([]);
    setPlan(null);

    const resolved = (await resolveQuery(trimmed, suggestedHeadline).catch(() => null)) ?? buildHeuristicPlan(trimmed);
    setPlan(resolved);
    setStoryQueries(resolved.searchQueries);
    await runQueries(resolved.searchQueries, resolved.excludeTerms);
    setSearching(false);
  }

  async function findImagesForStory() {
    if (!suggestedHeadline.trim() || searching) {
      setSearchError('Select a story with a headline first.');
      return;
    }

    setSearching(true);
    setSearchError('');
    setResults([]);

    try {
      // Claude (via the GreaterNews helper on this PC) reads the headline like an editor: "NPP" here is
      // Ghana's New Patriotic Party, not a nuclear power plant, and the person quoted is the photo.
      // Sensitive stories keep the neutral-imagery path in findStoryImages; no helper -> heuristics.
      const plan = await resolveQuery(
        suggestedHeadline,
        `This is a news headline (${suggestedCategory}). Plan searches for the best photo SUBJECT for its card: the person quoted or named first, else the organisation, place or object the story is about.`,
      ).catch(() => null);
      if (plan && !plan.sensitive && plan.searchQueries.length) {
        setPlan(plan);
        setStoryQueries(plan.searchQueries);
        await runQueries(plan.searchQueries, plan.excludeTerms);
        setSearching(false);
        return;
      }
      const { results: found, queries } = await findStoryImages(suggestedHeadline, suggestedCategory);
      setStoryQueries(queries);
      setResults(found);
      if (found.length === 0) {
        setSearchError('No matching free images found. Try a chip below, search the place or organization by hand, or upload your own photo.');
      }
    } catch {
      setSearchError('Image search is unreachable right now. Check the connection and try again.');
    }
    setSearching(false);
  }

  async function useSearchResult(result: ImageResult) {
    setLoadingImageId(result.id);
    setSearchError('');

    try {
      const image = await loadImageWithProxyFallback(result.fullUrl);
      if (typeof searchTarget === 'number') {
        // Assign to a specific beat/clip instead of the main photo.
        const idx = searchTarget;
        setBeatImages((prev) => {
          const next = prev.slice();
          while (next.length <= idx) next.push(null);
          next[idx] = image;
          return next;
        });
      } else {
        if (photoUrlRef.current) {
          URL.revokeObjectURL(photoUrlRef.current);
          photoUrlRef.current = '';
        }
        setPhoto(image);
        setPhotoName(`${result.title} — ${result.provider}`);
        setPhotoSourcePage(result.sourcePage);
        // Some Wikimedia Artist fields are whole paragraphs — keep the credit line short.
        const author = result.author.length > 40 ? `${result.author.slice(0, 39).trimEnd()}…` : result.author;
        setFooter(`Photo: ${author} · ${result.license} · ${result.provider}`);
      }
    } catch {
      setSearchError('Could not load that image (the source may block downloads). Try another result, or download it manually and upload it.');
    } finally {
      setLoadingImageId('');
    }
  }

  function useSelectedStory() {
    setHeadline(suggestedHeadline);
    setSubline(suggestedSubline);
    if (!footer.trim()) {
      setFooter(`(Source: ${suggestedSource})`);
    }
  }

  function renderToBlob(targetFormat: CardFormat) {
    return new Promise<Blob | null>((resolve) => {
      const scratch = document.createElement('canvas');
      drawCard(scratch, {
        template,
        format: targetFormat,
        photo,
        logo,
        headline,
        subline,
        highlight,
        attribution,
        chip,
        statValue,
        postHandle,
        postMeta,
        footer,
        handle,
        accent,
        dim,
        headlineShift: textShift,
      });
      scratch.toBlob((blob) => resolve(blob), 'image/png');
    });
  }

  async function previewArticleImage() {
    if (!suggestedLink || refLoading) {
      return;
    }

    setRefLoading(true);
    setRefError('');
    setRefImage('');

    try {
      const response = await fetch(`https://api.allorigins.win/raw?url=${encodeURIComponent(suggestedLink)}`);
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      const html = await response.text();
      const parsed = new DOMParser().parseFromString(html, 'text/html');
      const image = parsed
        .querySelector('meta[property="og:image"], meta[name="og:image"], meta[name="twitter:image"], meta[property="twitter:image"]')
        ?.getAttribute('content');
      if (image) {
        setRefImage(image);
      } else {
        setRefError('No preview image found in that article.');
      }
    } catch {
      setRefError('Could not fetch the article — the site may block proxies.');
    }
    setRefLoading(false);
  }

  function triggerDownload(blob: Blob, suffix: string) {
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `greaternews_${template}_${new Date().toISOString().slice(0, 10)}_${suffix}.png`;
    anchor.click();
    URL.revokeObjectURL(url);
  }

  async function downloadCard() {
    const blob = await renderToBlob(format);
    if (blob) {
      triggerDownload(blob, formatSizes[format].suffix);
    }
  }

  async function downloadAllSizes() {
    for (const key of Object.keys(formatSizes) as CardFormat[]) {
      const blob = await renderToBlob(key);
      if (blob) {
        triggerDownload(blob, formatSizes[key].suffix);
      }
    }
  }

  async function draftBeatsFromCard() {
    if (draftingBeats) {
      return;
    }
    if ((videoBeats.trim() || videoNarration.trim()) && !window.confirm('Replace the current video script with a fresh draft from the card?')) {
      return;
    }
    setDraftingBeats(true);
    try {
      const { captions, narration, imageQueries } = await draftVideoBeats({ headline, subline, details: storyDetails, source: footer });
      if (captions.length) {
        setVideoBeats(captions.join('\n'));
        setVideoNarration(narration.join('\n'));
        setVideoImageQueries(imageQueries);
      }
    } catch {
      // Leave the boxes unchanged if drafting fails.
    }
    setDraftingBeats(false);
  }

  function captionLines() {
    return videoBeats.split('\n').map((line) => line.trim()).filter(Boolean);
  }

  // The search subject for beat i: the drafter's suggestion, else the caption text (label stripped).
  function beatQuery(index: number) {
    const suggested = (videoImageQueries[index] ?? '').trim();
    if (suggested) return suggested;
    return (captionLines()[index] ?? '').replace(/^\[[^\]]*\]\s*/, '').trim();
  }

  function setBeatQuery(index: number, value: string) {
    setVideoImageQueries((prev) => {
      const next = prev.slice();
      while (next.length <= index) next.push('');
      next[index] = value;
      return next;
    });
  }

  // Gather several candidates for a beat (Google Images first for relevance, then licensed).
  async function searchBeatCandidates(query: string): Promise<ImageResult[]> {
    const settled = await Promise.allSettled([
      searchSerperImages(query),
      searchGoogleImages(query),
      searchOpenverse(query),
      searchCommons(query),
      searchWikipediaImages(query),
    ]);
    const all = settled.flatMap((result) => (result.status === 'fulfilled' ? result.value : []));
    return dedupeResults(all).slice(0, 8);
  }

  // Open the options grid for a beat and load candidates to choose from.
  async function showBeatOptions(index: number) {
    const query = beatQuery(index);
    if (!query) return;
    if (beatOptionsOpen === index) {
      setBeatOptionsOpen(null);
      return;
    }
    setBeatOptionsOpen(index);
    setLoadingOptions(index);
    try {
      const results = await searchBeatCandidates(query);
      setBeatOptions((prev) => ({ ...prev, [index]: results }));
    } catch {
      setBeatOptions((prev) => ({ ...prev, [index]: [] }));
    }
    setLoadingOptions(null);
  }

  // Pick a candidate for a beat — load the full image and set it, then close the grid.
  async function chooseBeatImage(index: number, result: ImageResult) {
    try {
      const image = await loadImageWithProxyFallback(result.fullUrl);
      setBeatImages((prev) => {
        const next = prev.slice();
        while (next.length <= index) next.push(null);
        next[index] = image;
        return next;
      });
      setBeatOptionsOpen(null);
    } catch {
      // That image wouldn't load — leave the grid open so they can pick another.
    }
  }

  async function autoFillBeatImages() {
    const captions = captionLines();
    if (!captions.length || fetchingBeatImages) return;
    setFetchingBeatImages(true);
    try {
      const images = await Promise.all(
        captions.map(async (_, index) => {
          const query = beatQuery(index);
          if (!query) return null;
          const best = await findBestPhoto(query, { broadFirst: true }).catch(() => null);
          return best?.image ?? null;
        }),
      );
      // Keep any real news clip the editor picked; auto-fill only supplies photos.
      setBeatImages((prev) => images.map((image, index) => (isBeatClip(prev[index]) ? prev[index] : image)));
    } catch {
      // Leave existing images in place on failure.
    }
    setFetchingBeatImages(false);
  }

  // ---- real news clips (Wikimedia Commons, free to reuse) — for video beats only ----

  function switchMediaMode(next: 'photos' | 'clips') {
    setMediaMode(next);
    // Clips play under a caption's beat, never as the card photo.
    if (next === 'clips' && searchTarget === 'main' && captionLines().length > 0) {
      setSearchTarget(0);
    }
  }

  async function runClipSearch() {
    const trimmed = query.trim();
    if (!trimmed || clipSearching) {
      return;
    }
    setClipSearching(true);
    setClipError('');
    setClipResults([]);
    try {
      setClipResults(await searchCommonsVideos(trimmed));
    } catch {
      setClipError('Wikimedia Commons is unreachable right now. Check the connection and try again.');
    }
    setClipSearched(true);
    setClipSearching(false);
  }

  async function useClipResult(result: ClipResult) {
    if (typeof searchTarget !== 'number' || loadingClip) {
      return;
    }
    const index = searchTarget;
    setLoadingClip(result.src);
    setClipError('');
    try {
      const video = await loadClipVideo(result.src);
      const length = Number.isFinite(video.duration) ? video.duration : result.durationS;
      const start = length > 8 ? Math.min(Math.max(2, length * 0.12), length - 6) : 0; // skip opening slates (same rule as findBestClip)
      clipMetaRef.current.set(video, result);
      setBeatImages((prev) => {
        const next = prev.slice();
        while (next.length <= index) next.push(null);
        next[index] = { video, label: clipLabel(result), start };
        return next;
      });
    } catch {
      setClipError('That clip would not load (it may be too large or blocked). Try another one, or use a photo for this beat.');
    } finally {
      setLoadingClip('');
    }
  }

  function clearBeatMedia(index: number) {
    setBeatImages((prev) => {
      const next = prev.slice();
      if (index < next.length) next[index] = null;
      return next;
    });
  }

  function stopSoundPreview() {
    if (previewCtxRef.current) {
      void previewCtxRef.current.close();
      previewCtxRef.current = null;
    }
    setPreviewingSound(false);
  }

  // Play the selected sound (synth bed or user track) for a few seconds so it can be judged before
  // rendering a video, at the same mix level the video would use.
  async function previewSound() {
    stopSoundPreview();
    if (videoSound === 'none' || typeof AudioContext === 'undefined') {
      return;
    }
    try {
      const ctx = new AudioContext();
      previewCtxRef.current = ctx;
      const master = ctx.createGain();
      const seconds = 5;
      master.gain.value = videoVoice === 'none' ? 0.4 : 0.2; // match the mix level used in the video
      master.connect(ctx.destination);
      setPreviewingSound(true);

      if (isTrackId(videoSound)) {
        const url = musicUrlFor(videoSound, musicTracks);
        const response = url ? await fetch(url) : null;
        if (!response || !response.ok || previewCtxRef.current !== ctx) {
          stopSoundPreview();
          return;
        }
        const buffer = await ctx.decodeAudioData(await response.arrayBuffer());
        if (previewCtxRef.current !== ctx) return; // stopped while loading
        const source = ctx.createBufferSource();
        source.buffer = buffer;
        source.connect(master);
        source.start();
      } else {
        scheduleBed(ctx, master, videoSound as VideoSound, seconds);
      }

      master.gain.setValueAtTime(master.gain.value, ctx.currentTime + seconds - 0.4);
      master.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + seconds);
      window.setTimeout(() => {
        if (previewCtxRef.current === ctx) stopSoundPreview();
      }, (seconds + 0.25) * 1000);
    } catch {
      stopSoundPreview();
    }
  }

  async function downloadVideo() {
    if (videoProgress >= 0) {
      return;
    }

    setVideoProgress(0);
    try {
      const { blob, extension } = await exportCardVideo(
        { template, format, photo, logo, headline, subline, highlight, attribution, chip, statValue, postHandle, postMeta, footer, handle, accent, dim, headlineShift: textShift },
        { scenes: videoBeats.split('\n').map((beat) => beat.trim()).filter(Boolean), narration: videoNarration.split('\n').map((line) => line.trim()).filter(Boolean), beatPhotos: beatImages, motion: videoMotion, sound: (isTrackId(videoSound) ? 'none' : (videoSound as VideoSound)), musicUrl: isTrackId(videoSound) ? (musicUrlFor(videoSound, musicTracks) ?? undefined) : undefined, voice: videoVoice, voiceName: videoVoice === 'groq' ? groqVoiceName : undefined },
        (progress) => setVideoProgress(progress),
      );
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `greaternews_${template}_${new Date().toISOString().slice(0, 10)}_${formatSizes[format].suffix}.${extension}`;
      anchor.click();
      URL.revokeObjectURL(url);
    } catch {
      // Unsupported browser — the button is hidden in that case, so this is a rare race.
    }
    setVideoProgress(-1);
  }

  async function shareCard() {
    const blob = await renderToBlob(format);
    if (!blob) {
      return;
    }

    const file = new File([blob], `greaternews_${template}.png`, { type: 'image/png' });
    if (navigator.canShare?.({ files: [file] })) {
      try {
        await navigator.share({ files: [file], title: headline });
      } catch {
        // User dismissed the share sheet.
      }
    }
  }

  function copyCardToClipboard() {
    canvasRef.current?.toBlob(async (blob) => {
      if (!blob) {
        return;
      }

      try {
        await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1600);
      } catch {
        // Clipboard image support varies by browser; the download button always works.
      }
    }, 'image/png');
  }

  const captions = captionLines();
  const beatsWithMedia = captions.filter((_, index) => beatImages[index]).length;
  const clipCount = captions.filter((_, index) => isBeatClip(beatImages[index])).length;
  const narrationLines = videoNarration.split('\n').filter((line) => line.trim()).length;
  const isStory = format === 'story';
  const canExportVideo = videoExportSupported();
  const size = formatSizes[format];

  const preview = (
    <>
      <div className="card-preview__head">
        <div className="gn-seg card-preview__formats" role="group" aria-label="Card format">
          {formatOrder.map((option) => (
            <button
              key={option.key}
              type="button"
              className={format === option.key ? 'is-on is-gold' : undefined}
              aria-pressed={format === option.key}
              title={formatSizes[option.key].label}
              onClick={() => setFormat(option.key)}
            >
              {option.label}
            </button>
          ))}
        </div>
        <button
          type="button"
          className={safeZones && isStory ? 'gn-btn gn-btn--xs gn-btn--ghost is-on' : 'gn-btn gn-btn--xs gn-btn--ghost'}
          aria-pressed={safeZones && isStory}
          disabled={!isStory}
          onClick={() => setSafeZones((on) => !on)}
          title={isStory ? 'Show the areas the Reels / Status interface covers' : 'Safe zones apply to the 9:16 format'}
        >
          Safe zones
        </button>
      </div>
      <div className={isStory ? 'gn-phone card-device' : `card-frame card-device card-device--${format}`}>
        <div className={isStory ? 'gn-phone__screen' : 'card-frame__screen'}>
          <canvas ref={canvasRef} aria-label="News card preview" />
          {isStory ? <div className={safeZones ? 'gn-safe is-on' : 'gn-safe'} /> : null}
        </div>
        {isStory ? <div className="gn-phone__notch" /> : null}
      </div>
      <p className="card-preview__caption" title={size.label}>
        {size.label.split(' — ')[1] ?? size.label} · {size.width}×{size.height}
      </p>
    </>
  );

  return (
    <>
      <section id="step-card" className="gn-card app-section designer-card">
        <StepHead
          step={4}
          name="Card studio"
          title="Branded news card"
          sub={wide ? 'Pick a template and a licensed photo — the preview on the right updates live.' : 'Pick a template and a licensed photo — the preview updates live.'}
        >
          <span className="gn-chip gn-chip--plain">
            {size.width}×{size.height}px
          </span>
        </StepHead>

        <div className="designer-templates">
          <div className="gn-seg app-seg" role="group" aria-label="Card template">
            {templateOrder.map((key) => (
              <button
                key={key}
                type="button"
                className={template === key ? 'is-on is-gold' : undefined}
                aria-pressed={template === key}
                onClick={() => setTemplate(key)}
                title={templateMeta[key].note}
              >
                {templateMeta[key].label}
              </button>
            ))}
          </div>
          <p className="designer-note">{templateMeta[template].note}</p>
        </div>

        <div ref={stepPreviewRef} className="designer-preview-host" />

        <div className="designer-groups">
          <Panel
            icon="photo"
            title="Photo & clips"
            className="media-panel"
            aside={
              <div className="gn-seg media-seg" role="group" aria-label="Search for">
                <button type="button" className={mediaMode === 'photos' ? 'is-on' : undefined} aria-pressed={mediaMode === 'photos'} onClick={() => switchMediaMode('photos')}>
                  Photos
                </button>
                <button type="button" className={mediaMode === 'clips' ? 'is-on' : undefined} aria-pressed={mediaMode === 'clips'} onClick={() => switchMediaMode('clips')}>
                  News clips
                </button>
              </div>
            }
          >
            {mediaMode === 'clips' ? (
              <p className="designer-note clip-note">Real news footage that's free to reuse (public domain / Creative Commons) — credited on screen.</p>
            ) : null}

            <label className="gn-field">
              <span className="gn-label">
                {mediaMode === 'clips' ? (
                  <>
                    Search news footage <span className="gn-hint">(Wikimedia Commons)</span>
                  </>
                ) : (
                  <>
                    Search free-to-use photos <span className="gn-hint">(Wikimedia Commons + Openverse)</span>
                  </>
                )}
              </span>
              <div className="search-row">
                <input
                  className="gn-input"
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                      event.preventDefault();
                      void (mediaMode === 'clips' ? runClipSearch() : runImageSearch());
                    }
                  }}
                  placeholder={mediaMode === 'clips' ? 'e.g. Accra floods, AU summit, Ghana parliament' : 'e.g. Ghana High Commission, Accra market, Black Stars'}
                />
                {mediaMode === 'clips' ? (
                  <button type="button" className="gn-btn" onClick={() => void runClipSearch()} disabled={clipSearching}>
                    {clipSearching ? 'Searching…' : 'Search'}
                  </button>
                ) : (
                  <button type="button" className="gn-btn" onClick={() => void runImageSearch()} disabled={searching}>
                    {searching ? 'Searching…' : 'Search'}
                  </button>
                )}
              </div>
            </label>

            {mediaMode === 'clips' ? (
              <>
                {captions.length > 0 ? (
                  <div className="query-chips">
                    <span className="designer-note">Use for:</span>
                    {captions.map((_, index) => (
                      <button
                        key={index}
                        type="button"
                        className={searchTarget === index ? 'gn-chip gn-chip--plain gn-chip--btn is-on' : 'gn-chip gn-chip--plain gn-chip--btn'}
                        aria-pressed={searchTarget === index}
                        onClick={() => setSearchTarget(index)}
                      >
                        Clip {index + 1}
                        {isBeatClip(beatImages[index]) ? ' ▶' : beatImages[index] ? ' ✓' : ''}
                      </button>
                    ))}
                  </div>
                ) : (
                  <p className="designer-note">Add on-screen captions in step 5 first — each news clip plays under one caption.</p>
                )}

                {clipError ? <p className="designer-note danger-note">{clipError}</p> : null}

                {clipResults.length > 0 ? (
                  <>
                    <div className="clip-results">
                      {clipResults.map((result) => (
                        <div key={result.src} className={loadingClip === result.src ? 'clip-tile is-loading' : 'clip-tile'}>
                          <button
                            type="button"
                            className="clip-tile__pick"
                            onClick={() => void useClipResult(result)}
                            disabled={typeof searchTarget !== 'number' || Boolean(loadingClip)}
                            title={result.description || result.title}
                          >
                            <span className="clip-tile__poster">
                              {result.poster ? <img src={result.poster} alt="" loading="lazy" /> : null}
                              <span className="clip-tile__play" aria-hidden="true">
                                ▶
                              </span>
                              <span className="clip-tile__dur">{formatDuration(result.durationS)}</span>
                              {result.year ? <span className="clip-tile__year">{result.year}</span> : null}
                            </span>
                            <span className="clip-tile__title">{loadingClip === result.src ? 'Loading clip…' : result.title}</span>
                          </button>
                          <span className="clip-tile__credit">
                            {result.by} · {result.license}
                            {result.sourcePage ? (
                              <>
                                {' · '}
                                <a href={result.sourcePage} target="_blank" rel="noreferrer">
                                  source ↗
                                </a>
                              </>
                            ) : null}
                          </span>
                        </div>
                      ))}
                    </div>
                    <p className="designer-note">
                      {typeof searchTarget === 'number'
                        ? `Click a clip to play it under Clip ${searchTarget + 1}. Check the license on its source page before publishing.`
                        : 'Pick a clip number above, then click a clip to use it for that beat.'}
                    </p>
                  </>
                ) : clipSearched && !clipSearching && !clipError ? (
                  <div className="gn-empty clip-empty">
                    <strong>No free-to-reuse footage for “{query.trim()}”.</strong>
                    <span>
                      Commons mostly has real video of big filmed events — strikes, disasters, summits, heads of state. Try the event, place or person by name, or
                      use a photo for this beat.
                    </span>
                  </div>
                ) : null}
              </>
            ) : (
              <>
                <button type="button" className="gn-btn app-finder" onClick={() => void findImagesForStory()} disabled={searching}>
                  {searching ? 'Finding images…' : '✦ Find images for the selected story'}
                </button>

                {storyQueries.length > 0 ? (
                  <div className="query-chips">
                    <span className="designer-note">Steer the search:</span>
                    {storyQueries.map((storyQuery) => (
                      <button
                        key={storyQuery}
                        type="button"
                        className="gn-chip gn-chip--plain gn-chip--btn"
                        disabled={searching}
                        onClick={() => {
                          setQuery(storyQuery);
                          void executeSearch([storyQuery]);
                        }}
                      >
                        {storyQuery}
                      </button>
                    ))}
                  </div>
                ) : null}

                {plan ? (
                  <p className="designer-note">
                    {plan.source === 'ai' ? '✦ ' : ''}Read “{plan.raw}” as: <strong>{plan.interpretation}</strong>
                    {plan.sensitive ? ' · sensitive story — avoid a person photo' : ''}
                  </p>
                ) : null}

                {searchError ? <p className="designer-note danger-note">{searchError}</p> : null}

                {results.length > 0 ? (
                  <>
                    {captions.length > 0 ? (
                      <div className="query-chips">
                        <span className="designer-note">Apply pick to:</span>
                        {(['main', ...captions.map((_, i) => i)] as ('main' | number)[]).map((target) => {
                          const active = searchTarget === target;
                          const label = target === 'main' ? 'Main photo' : `Clip ${target + 1}${beatImages[target] ? ' ✓' : ''}`;
                          return (
                            <button
                              key={String(target)}
                              type="button"
                              className={active ? 'gn-chip gn-chip--plain gn-chip--btn is-on' : 'gn-chip gn-chip--plain gn-chip--btn'}
                              aria-pressed={active}
                              onClick={() => setSearchTarget(target)}
                            >
                              {label}
                            </button>
                          );
                        })}
                      </div>
                    ) : null}
                    <div className="image-results">
                      {results.map((result) => (
                        <button
                          key={result.id}
                          type="button"
                          className={loadingImageId === result.id ? 'image-result loading' : 'image-result'}
                          onClick={() => void useSearchResult(result)}
                          title={`${result.title} — ${result.author} (${result.license})`}
                        >
                          <img src={result.thumbUrl} alt={result.title} loading="lazy" />
                          <span>{loadingImageId === result.id ? 'Loading…' : `${result.license} · ${result.provider}`}</span>
                        </button>
                      ))}
                    </div>
                    <p className="designer-note">
                      {typeof searchTarget === 'number'
                        ? `Click a photo to use it for Clip ${searchTarget + 1}. Confirm the license on the source page before publishing.`
                        : 'Click a photo to load it as the main photo — the credit line is filled in automatically. Always confirm the license on the source page before publishing.'}
                    </p>
                  </>
                ) : null}

                <label className="gn-field">
                  <span className="gn-label">
                    Or upload your own photo <span className="gn-hint">(use one you have the rights to)</span>
                  </span>
                  <input className="gn-input app-file" type="file" accept="image/*" onChange={(event) => handlePhotoUpload(event.target.files)} />
                </label>
                {photoName ? (
                  <p className="designer-note">
                    Loaded: {photoName}
                    {photoSourcePage ? (
                      <>
                        {' · '}
                        <a href={photoSourcePage} target="_blank" rel="noreferrer">
                          View source & license
                        </a>
                      </>
                    ) : null}
                  </p>
                ) : (
                  <p className="designer-note">No photo yet — a placeholder background is shown.</p>
                )}

                {suggestedLink ? (
                  <>
                    <button type="button" className="gn-btn gn-btn--sm gn-btn--ghost app-btn-start" onClick={() => void previewArticleImage()} disabled={refLoading}>
                      {refLoading ? 'Fetching…' : "👁 Preview the article's own photo (reference only)"}
                    </button>
                    {refError ? <p className="designer-note danger-note">{refError}</p> : null}
                    {refImage ? (
                      <div className="ref-preview">
                        <img src={refImage} alt="Article preview — reference only" />
                        <p className="designer-note danger-note">
                          Reference only — this is the outlet's copyrighted photo. Do not put it on a card. Use it to decide what to search for above.
                        </p>
                      </div>
                    ) : null}
                  </>
                ) : null}

                <label className="gn-field">
                  <span className="gn-label">
                    Photo darkness — {Math.round(dim * 100)}% <span className="gn-hint">(darker suits somber stories)</span>
                  </span>
                  <input
                    className="app-range"
                    type="range"
                    min={0}
                    max={80}
                    step={5}
                    value={Math.round(dim * 100)}
                    onChange={(event) => setDim(Number(event.target.value) / 100)}
                  />
                </label>
              </>
            )}
          </Panel>

          <Panel
            icon="text"
            title="Card text"
            aside={
              <button type="button" className="gn-btn gn-btn--xs" onClick={useSelectedStory}>
                Use selected story
              </button>
            }
          >
            <label className="gn-field">
              <span className="gn-label">{headlineLabels[template]}</span>
              <textarea className="gn-textarea" value={headline} onChange={(event) => setHeadline(event.target.value)} rows={template === 'recap' ? 6 : 3} />
            </label>

            {template === 'headline' || template === 'update' ? (
              <>
                <label className="gn-field">
                  <span className="gn-label">
                    Subline <span className="gn-hint">(optional — one sentence of context under the headline)</span>
                  </span>
                  <input className="gn-input" value={subline} onChange={(event) => setSubline(event.target.value)} placeholder="e.g. Colombia 1-0 Ghana in the round of 32 — after a run that included holding England" />
                </label>
                <label className="gn-field">
                  <span className="gn-label">
                    Highlight phrase <span className="gn-hint">(colored words inside the headline — skip for tragedy)</span>
                  </span>
                  <input className="gn-input" value={highlight} onChange={(event) => setHighlight(event.target.value)} placeholder="e.g. End American Financial Aid" />
                </label>
                <div className="gn-field">
                  <span className="gn-label app-label-row">
                    <label htmlFor="card-heading-shift">
                      Heading position — {textShift === 0 ? 'auto' : `${textShift > 0 ? 'higher' : 'lower'} ${Math.round(Math.abs(textShift) * 100)}%`}
                    </label>
                    {textShift !== 0 ? (
                      <button type="button" className="link-button" onClick={() => setTextShift(0)}>
                        reset
                      </button>
                    ) : null}
                  </span>
                  <input
                    id="card-heading-shift"
                    className="app-range"
                    type="range"
                    min={-100}
                    max={100}
                    step={5}
                    value={Math.round(textShift * 100)}
                    onChange={(event) => setTextShift(Number(event.target.value) / 100)}
                  />
                </div>
              </>
            ) : null}

            {template === 'quote' ? (
              <label className="gn-field">
                <span className="gn-label">Who said it (name, title)</span>
                <input className="gn-input" value={attribution} onChange={(event) => setAttribution(event.target.value)} placeholder="e.g. Ghana High Commissioner to South Africa" />
              </label>
            ) : null}

            {template === 'post' ? (
              <>
                <div className="field-grid">
                  <label className="gn-field">
                    <span className="gn-label">Name (as shown on the post)</span>
                    <input className="gn-input" value={attribution} onChange={(event) => setAttribution(event.target.value)} placeholder="e.g. Ministry of Information" />
                  </label>
                  <label className="gn-field">
                    <span className="gn-label">Handle / page name</span>
                    <input className="gn-input" value={postHandle} onChange={(event) => setPostHandle(event.target.value)} placeholder="e.g. @moinfoghana" />
                  </label>
                </div>
                <label className="gn-field">
                  <span className="gn-label">Meta line (time · date · platform)</span>
                  <input className="gn-input" value={postMeta} onChange={(event) => setPostMeta(event.target.value)} placeholder="e.g. 6:41 PM · 5 Jul 2026 · X" />
                </label>
                <p className="designer-note">
                  This renders our own styled graphic of the statement — always quote their exact words and keep the source line filled in.
                </p>
              </>
            ) : null}

            {template === 'update' ? (
              <div className="gn-field">
                <span className="gn-label">Banner</span>
                <div className="chip-row" role="group" aria-label="Banner">
                  {chipOrder.map((label) => (
                    <button
                      key={label}
                      type="button"
                      className={chip === label ? `chip-button active chip-${label.toLowerCase()}` : 'chip-button'}
                      aria-pressed={chip === label}
                      onClick={() => setChip(label)}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </div>
            ) : null}

            {template === 'stat' ? (
              <label className="gn-field">
                <span className="gn-label">The number (e.g. GH₵ 12.4bn, 23, 87%)</span>
                <input className="gn-input" value={statValue} onChange={(event) => setStatValue(event.target.value)} placeholder="e.g. 23" />
              </label>
            ) : null}

            {template === 'recap' ? (
              <>
                <button
                  type="button"
                  className="gn-btn app-finder"
                  onClick={() => {
                    setHeadline(weeklyHeadlines.join('\n'));
                    setAttribution(weeklyRange);
                  }}
                  disabled={weeklyHeadlines.length === 0}
                >
                  {weeklyHeadlines.length > 0
                    ? `✦ Fill from this week's log (${weeklyHeadlines.length} stories)`
                    : 'No logged stories this week yet'}
                </button>
                <label className="gn-field">
                  <span className="gn-label">Subtitle (e.g. the date range)</span>
                  <input className="gn-input" value={attribution} onChange={(event) => setAttribution(event.target.value)} placeholder="e.g. June 29 – July 4, 2026" />
                </label>
              </>
            ) : null}
          </Panel>

          <Panel icon="palette" title="Look & format" className="designer-groups__wide">
            <div className="look-grid look-grid--accent">
              <label className="gn-field">
                <span className="gn-label">Accent color</span>
                <input type="color" value={accent} onChange={(event) => setAccent(event.target.value)} className="gn-input color-input" />
              </label>
              <label className="gn-field">
                <span className="gn-label">Format</span>
                <select className="gn-select" value={format} onChange={(event) => setFormat(event.target.value as CardFormat)}>
                  {(Object.keys(formatSizes) as CardFormat[]).map((key) => (
                    <option key={key} value={key}>
                      {formatSizes[key].label}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <div className="look-grid">
              <label className="gn-field">
                <span className="gn-label">Handle strip</span>
                <input className="gn-input" value={handle} onChange={(event) => setHandle(event.target.value)} />
              </label>
              <label className="gn-field">
                <span className="gn-label">Credit / footer line</span>
                <input className="gn-input" value={footer} onChange={(event) => setFooter(event.target.value)} placeholder="Photo: Author · License · Source" />
              </label>
            </div>
          </Panel>
        </div>

        <div className="designer-export">
          <span className="designer-export__label">Export this card</span>
          <div className="gn-actions">
            <button type="button" className="gn-btn gn-btn--sm" onClick={copyCardToClipboard}>
              {copied ? 'Copied ✓' : 'Copy image'}
            </button>
            {typeof navigator !== 'undefined' && 'canShare' in navigator ? (
              <button type="button" className="gn-btn gn-btn--sm" onClick={() => void shareCard()}>
                Share card
              </button>
            ) : null}
            <button type="button" className="gn-btn gn-btn--sm" onClick={() => void downloadAllSizes()}>
              Download all sizes
            </button>
            <button type="button" className="gn-btn gn-btn--sm gn-btn--primary" onClick={() => void downloadCard()}>
              Download PNG
            </button>
          </div>
        </div>
      </section>

      <section id="step-video" className="gn-card app-section">
        <StepHead step={5} name="Video & voice" title="Turn the card into a video" sub="Short captions on screen, a fuller narration for the voice, a photo or real news clip per beat — then export.">
          {canExportVideo ? (
            <button type="button" className="gn-btn gn-btn--primary" onClick={() => void downloadVideo()} disabled={videoProgress >= 0}>
              {videoProgress >= 0 ? <span className="gn-spin" aria-hidden="true" /> : null}
              {videoProgress >= 0 ? `Rendering video… ${Math.round(videoProgress * 100)}%` : '🎬 Export video'}
            </button>
          ) : null}
        </StepHead>
        {videoProgress >= 0 ? (
          <div className="video-progress" role="progressbar" aria-label="Video render progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(videoProgress * 100)}>
            <span style={{ width: `${Math.round(videoProgress * 100)}%` }} />
          </div>
        ) : null}

        <div className="gn-stats video-stats">
          <div className="gn-stat">
            <span className="gn-stat__v">{captions.length}</span>
            <span className="gn-stat__k">Captions</span>
          </div>
          <div className="gn-stat">
            <span className="gn-stat__v">{narrationLines || '—'}</span>
            <span className="gn-stat__k">Narration lines</span>
          </div>
          <div className="gn-stat">
            <span className="gn-stat__v">{captions.length ? `${beatsWithMedia}/${captions.length}` : '—'}</span>
            <span className="gn-stat__k">Beats with media</span>
          </div>
          <div className="gn-stat">
            <span className="gn-stat__v">{clipCount}</span>
            <span className="gn-stat__k">News clips</span>
          </div>
        </div>

        <div className="video-groups">
          <Panel
            icon="script"
            title="Script"
            aside={
              <button
                type="button"
                className="gn-btn gn-btn--xs gn-btn--primary"
                onClick={() => void draftBeatsFromCard()}
                disabled={draftingBeats || (!headline.trim() && !subline.trim() && !storyDetails.trim())}
              >
                {draftingBeats ? 'Drafting…' : '✦ Draft from card'}
              </button>
            }
          >
            <label className="gn-field">
              <span className="gn-label">
                Story details for the script <span className="gn-hint">(optional — paste the article or key facts so the voice can tell the full story)</span>
              </span>
              <textarea
                className="gn-textarea"
                value={storyDetails}
                onChange={(event) => setStoryDetails(event.target.value)}
                rows={4}
                placeholder={'Paste the verified article text or the key facts here, then click “draft from card”. The more you give, the more the video can actually say.'}
              />
            </label>
            <label className="gn-field">
              <span className="gn-label">
                On-screen captions <span className="gn-hint">(one short line per slide — optional [SECTION] label)</span>
              </span>
              <textarea
                className="gn-textarea"
                value={videoBeats}
                onChange={(event) => setVideoBeats(event.target.value)}
                rows={5}
                placeholder={'[THE STORY] Aboagye on EOCO stop list\n[THE DETAIL] Name added without notice\n[WHO] NPP communications director\n[THE SOURCE] MyJoyOnline'}
              />
            </label>
            <label className="gn-field">
              <span className="gn-label">
                Voiceover narration <span className="gn-hint">(fuller — what the voice says; one line per caption, drafted for you)</span>
              </span>
              <textarea
                className="gn-textarea"
                value={videoNarration}
                onChange={(event) => setVideoNarration(event.target.value)}
                rows={5}
                placeholder={'Leave blank to speak the captions. Or click “draft from card” to get a fuller, flowing narration here — the slides stay short while the voice tells the whole story.'}
              />
            </label>
          </Panel>

          <Panel icon="film" title="Pictures & sound">
            {captions.length > 0 ? (
              <div className="beat-images">
                <div className="beat-images__head">
                  <span className="gn-label">
                    Clip media <span className="gn-hint">— auto-fill a quick photo per caption, edit a query and Find to choose, or pick a news clip in step 4</span>
                  </span>
                  <button type="button" className="gn-btn gn-btn--xs" onClick={() => void autoFillBeatImages()} disabled={fetchingBeatImages}>
                    {fetchingBeatImages ? 'finding…' : 'auto-fill images'}
                  </button>
                </div>
                <div className="beat-list">
                  {captions.map((caption, index) => {
                    const media = beatImages[index];
                    const clip = isBeatClip(media) ? media : null;
                    const clipMeta = clip ? clipMetaRef.current.get(clip.video) : undefined;
                    return (
                      <div key={index} className={clip ? 'beat has-clip' : 'beat'}>
                        <div className="beat-row">
                          <div className={clip ? 'beat-thumb is-clip' : 'beat-thumb'}>
                            {clip ? (
                              clipMeta?.poster ? <img src={clipMeta.poster} alt="" /> : null
                            ) : media ? (
                              <img src={mediaSrc(media)} alt="" />
                            ) : (
                              <span aria-hidden="true">▢</span>
                            )}
                            {clip ? (
                              <span className="beat-thumb__play" aria-hidden="true">
                                ▶
                              </span>
                            ) : null}
                            <span className="beat-thumb__n">{index + 1}</span>
                          </div>
                          <input
                            className="gn-input"
                            value={videoImageQueries[index] ?? ''}
                            onChange={(event) => setBeatQuery(index, event.target.value)}
                            placeholder={caption.replace(/^\[[^\]]*\]\s*/, '') || 'photo subject'}
                          />
                          <button type="button" className="gn-btn gn-btn--sm" onClick={() => void showBeatOptions(index)}>
                            {beatOptionsOpen === index ? 'close' : 'find'}
                          </button>
                        </div>
                        {clip ? (
                          <div className="beat-clip">
                            <span className="gn-chip gn-chip--violet">News clip</span>
                            <span className="beat-clip__label" title={clipMeta?.title}>
                              {clip.label}
                            </span>
                            <button type="button" className="link-button" onClick={() => clearBeatMedia(index)}>
                              use a photo instead
                            </button>
                          </div>
                        ) : null}
                        {beatOptionsOpen === index ? (
                          <div className="beat-options">
                            {loadingOptions === index ? (
                              <span className="designer-note">searching…</span>
                            ) : (beatOptions[index] ?? []).length === 0 ? (
                              <span className="designer-note">no images found — try a different query</span>
                            ) : (
                              (beatOptions[index] ?? []).map((result) => (
                                <button
                                  key={result.id}
                                  type="button"
                                  className={mediaSrc(beatImages[index]) === result.fullUrl ? 'beat-option is-on' : 'beat-option'}
                                  onClick={() => void chooseBeatImage(index, result)}
                                  title={`${result.title} — ${result.provider}`}
                                >
                                  <img src={result.thumbUrl} alt="" />
                                </button>
                              ))
                            )}
                          </div>
                        ) : null}
                      </div>
                    );
                  })}
                </div>
              </div>
            ) : (
              <p className="designer-note">Add on-screen captions to pick a photo or news clip for each beat.</p>
            )}

            <div className="field-grid">
              <label className="gn-field">
                <span className="gn-label">Video motion style</span>
                <select className="gn-select" value={videoMotion} onChange={(event) => setVideoMotion(event.target.value as VideoMotion)}>
                  <option value="subtle">Subtle — gentle zoom + crossfades</option>
                  <option value="dynamic">Dynamic — bigger zoom + slide transitions</option>
                  <option value="minimal">Minimal — no zoom, hard cuts</option>
                </select>
              </label>
              <div className="gn-field">
                <span className="gn-label app-label-row">
                  <label htmlFor="video-sound">Video sound</label>
                  <button type="button" className="link-button" onClick={() => (previewingSound ? stopSoundPreview() : void previewSound())} disabled={videoSound === 'none'}>
                    {previewingSound ? 'stop' : 'preview'}
                  </button>
                </span>
                <select id="video-sound" className="gn-select" value={videoSound} onChange={(event) => { stopSoundPreview(); setVideoSound(event.target.value); }}>
                  <optgroup label="Moods">
                    {(Object.keys(SOUND_LABELS) as VideoSound[]).map((key) => (
                      <option key={key} value={key}>
                        {SOUND_LABELS[key]}
                      </option>
                    ))}
                  </optgroup>
                  {musicTracks.length > 0 ? (
                    <optgroup label="My music">
                      {musicTracks.map((track) => (
                        <option key={track.id} value={track.id}>
                          {track.label}
                        </option>
                      ))}
                    </optgroup>
                  ) : null}
                </select>
              </div>
            </div>
            <div className="field-grid">
              <label className="gn-field">
                <span className="gn-label">Voiceover</span>
                <select className="gn-select" value={videoVoice} onChange={(event) => setVideoVoice(event.target.value as VideoVoice)}>
                  <option value="none">None (music only)</option>
                  <option value="groq">Groq (Orpheus) — free, natural</option>
                  <option value="elevenlabs">ElevenLabs — most human (needs plan for commercial)</option>
                  <option value="google">Google voice — needs billing enabled</option>
                </select>
              </label>
              {videoVoice === 'groq' ? (
                <label className="gn-field">
                  <span className="gn-label">Groq voice</span>
                  <select className="gn-select" value={groqVoiceName} onChange={(event) => setGroqVoiceName(event.target.value)}>
                    <option value="hannah">Hannah (female)</option>
                    <option value="autumn">Autumn (female)</option>
                    <option value="diana">Diana (female)</option>
                    <option value="austin">Austin (male)</option>
                    <option value="daniel">Daniel (male)</option>
                    <option value="troy">Troy (male)</option>
                  </select>
                </label>
              ) : null}
            </div>
          </Panel>
        </div>
      </section>

      {createPortal(preview, previewNode)}
      {actionsHost
        ? createPortal(
            <>
              <button type="button" className="gn-btn" onClick={() => void downloadCard()}>
                Download PNG
              </button>
              {canExportVideo ? (
                <button type="button" className="gn-btn" onClick={() => void downloadVideo()} disabled={videoProgress >= 0}>
                  {videoProgress >= 0 ? `Rendering ${Math.round(videoProgress * 100)}%` : 'Export video'}
                </button>
              ) : null}
            </>,
            actionsHost,
          )
        : null}
    </>
  );
}
