import { useEffect, useRef, useState } from 'react';
import type { CardFormat, CardTemplate, ChipLabel } from './cardEngine';
import { drawCard, formatSizes, templateMeta } from './cardEngine';
import type { ImageResult, SearchPlan } from './imageSearch';
import { buildHeuristicPlan, dedupeResults, filterByExcludeTerms, findStoryImages, loadImage, loadImageWithProxyFallback, searchCommons, searchGoogleImages, searchOpenverse, searchSerperImages, searchWikipediaImages } from './imageSearch';
import { resolveQuery } from './aiResolver';
import { draftVideoBeats } from './videoBeats';
import type { VideoMotion, VideoSound, VideoVoice } from './videoExport';
import { exportCardVideo, videoExportSupported } from './videoExport';
import { SOUND_LABELS } from './videoAudio';

type CardDesignerProps = {
  suggestedHeadline: string;
  suggestedSubline: string;
  suggestedSource: string;
  suggestedCategory: string;
  suggestedLink: string;
  weeklyHeadlines: string[];
  weeklyRange: string;
};

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
  // Extra story beats for the video (one per line) — turns the clip into a multi-scene story.
  const [videoBeats, setVideoBeats] = useState(() => initialParam('beats', '').replace(/\s*\|\s*/g, '\n'));
  const [draftingBeats, setDraftingBeats] = useState(false);
  const [videoMotion, setVideoMotion] = useState<VideoMotion>('subtle');
  const [videoSound, setVideoSound] = useState<VideoSound>('newsroom');
  const [videoVoice, setVideoVoice] = useState<VideoVoice>('none');
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
  const [plan, setPlan] = useState<SearchPlan | null>(null);

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
    if (videoBeats.trim() && !window.confirm('Replace the current video script with a fresh draft from the card?')) {
      return;
    }
    setDraftingBeats(true);
    try {
      const beats = await draftVideoBeats({ headline, subline, source: footer });
      if (beats.length) {
        setVideoBeats(beats.join('\n'));
      }
    } catch {
      // Leave the box unchanged if drafting fails.
    }
    setDraftingBeats(false);
  }

  async function downloadVideo() {
    if (videoProgress >= 0) {
      return;
    }

    setVideoProgress(0);
    try {
      const { blob, extension } = await exportCardVideo(
        { template, format, photo, logo, headline, subline, highlight, attribution, chip, statValue, postHandle, postMeta, footer, handle, accent, dim, headlineShift: textShift },
        { scenes: videoBeats.split('\n').map((beat) => beat.trim()).filter(Boolean), motion: videoMotion, sound: videoSound, voice: videoVoice },
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

  return (
    <section className="card designer-card">
      <div className="section-heading">
        <div>
          <p className="eyebrow">Card studio</p>
          <h2>Branded news card</h2>
        </div>
        <span className="pill">{formatSizes[format].width}×{formatSizes[format].height}px</span>
      </div>

      <div className="template-grid">
        {templateOrder.map((key) => (
          <button
            key={key}
            type="button"
            className={template === key ? 'mode-button active' : 'mode-button'}
            onClick={() => setTemplate(key)}
            title={templateMeta[key].note}
          >
            {templateMeta[key].label}
          </button>
        ))}
      </div>
      <p className="designer-note">{templateMeta[template].note}</p>

      <div className="designer-grid">
        <div className="designer-controls">
          <label>
            <span>Search free-to-use photos (Wikimedia Commons + Openverse)</span>
            <div className="search-row">
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault();
                    void runImageSearch();
                  }
                }}
                placeholder="e.g. Ghana High Commission, Accra market, Black Stars"
              />
              <button type="button" className="secondary" onClick={() => void runImageSearch()} disabled={searching}>
                {searching ? 'Searching…' : 'Search'}
              </button>
            </div>
          </label>

          <button type="button" className="secondary story-finder" onClick={() => void findImagesForStory()} disabled={searching}>
            {searching ? 'Finding images…' : '✦ Find images for the selected story'}
          </button>

          {storyQueries.length > 0 ? (
            <div className="query-chips">
              <span className="designer-note">Steer the search:</span>
              {storyQueries.map((storyQuery) => (
                <button
                  key={storyQuery}
                  type="button"
                  className="bucket-chip query-chip"
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
                Click a photo to load it — the credit line is filled in automatically. Always confirm the license on the source page before publishing.
              </p>
            </>
          ) : null}

          <label>
            <span>Or upload your own photo (use one you have the rights to)</span>
            <input type="file" accept="image/*" onChange={(event) => handlePhotoUpload(event.target.files)} />
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
              <button type="button" className="secondary" onClick={() => void previewArticleImage()} disabled={refLoading}>
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

          <label>
            <span>Photo darkness — {Math.round(dim * 100)}% (darker suits somber stories)</span>
            <input
              type="range"
              min={0}
              max={80}
              step={5}
              value={Math.round(dim * 100)}
              onChange={(event) => setDim(Number(event.target.value) / 100)}
            />
          </label>

          <label>
            <span>{headlineLabels[template]}</span>
            <textarea value={headline} onChange={(event) => setHeadline(event.target.value)} rows={template === 'recap' ? 6 : 3} />
          </label>

          {template === 'headline' || template === 'update' ? (
            <>
              <label>
                <span>Subline (optional — one sentence of context under the headline)</span>
                <input value={subline} onChange={(event) => setSubline(event.target.value)} placeholder="e.g. Colombia 1-0 Ghana in the round of 32 — after a run that included holding England" />
              </label>
              <label>
                <span>Highlight phrase (colored words inside the headline — skip for tragedy)</span>
                <input value={highlight} onChange={(event) => setHighlight(event.target.value)} placeholder="e.g. End American Financial Aid" />
              </label>
              <label>
                <span>
                  Heading position — {textShift === 0 ? 'auto' : `${textShift > 0 ? 'higher' : 'lower'} ${Math.round(Math.abs(textShift) * 100)}%`}
                  {textShift !== 0 ? (
                    <button type="button" className="link-button" onClick={() => setTextShift(0)}>
                      reset
                    </button>
                  ) : null}
                </span>
                <input
                  type="range"
                  min={-100}
                  max={100}
                  step={5}
                  value={Math.round(textShift * 100)}
                  onChange={(event) => setTextShift(Number(event.target.value) / 100)}
                />
              </label>
            </>
          ) : null}

          {template === 'quote' ? (
            <label>
              <span>Who said it (name, title)</span>
              <input value={attribution} onChange={(event) => setAttribution(event.target.value)} placeholder="e.g. Ghana High Commissioner to South Africa" />
            </label>
          ) : null}

          {template === 'post' ? (
            <>
              <div className="field-grid">
                <label>
                  <span>Name (as shown on the post)</span>
                  <input value={attribution} onChange={(event) => setAttribution(event.target.value)} placeholder="e.g. Ministry of Information" />
                </label>
                <label>
                  <span>Handle / page name</span>
                  <input value={postHandle} onChange={(event) => setPostHandle(event.target.value)} placeholder="e.g. @moinfoghana" />
                </label>
              </div>
              <label>
                <span>Meta line (time · date · platform)</span>
                <input value={postMeta} onChange={(event) => setPostMeta(event.target.value)} placeholder="e.g. 6:41 PM · 5 Jul 2026 · X" />
              </label>
              <p className="designer-note">
                This renders our own styled graphic of the statement — always quote their exact words and keep the source line filled in.
              </p>
            </>
          ) : null}

          {template === 'update' ? (
            <label>
              <span>Banner</span>
              <div className="chip-row">
                {chipOrder.map((label) => (
                  <button
                    key={label}
                    type="button"
                    className={chip === label ? `chip-button active chip-${label.toLowerCase()}` : 'chip-button'}
                    onClick={() => setChip(label)}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </label>
          ) : null}

          {template === 'stat' ? (
            <label>
              <span>The number (e.g. GH₵ 12.4bn, 23, 87%)</span>
              <input value={statValue} onChange={(event) => setStatValue(event.target.value)} placeholder="e.g. 23" />
            </label>
          ) : null}

          {template === 'recap' ? (
            <>
              <button
                type="button"
                className="secondary story-finder"
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
              <label>
                <span>Subtitle (e.g. the date range)</span>
                <input value={attribution} onChange={(event) => setAttribution(event.target.value)} placeholder="e.g. June 29 – July 4, 2026" />
              </label>
            </>
          ) : null}

          <div className="field-grid">
            <label>
              <span>Accent color</span>
              <input type="color" value={accent} onChange={(event) => setAccent(event.target.value)} className="color-input" />
            </label>
            <label>
              <span>Format</span>
              <select value={format} onChange={(event) => setFormat(event.target.value as CardFormat)}>
                {(Object.keys(formatSizes) as CardFormat[]).map((key) => (
                  <option key={key} value={key}>
                    {formatSizes[key].label}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <div className="field-grid">
            <label>
              <span>Handle strip</span>
              <input value={handle} onChange={(event) => setHandle(event.target.value)} />
            </label>
            <label>
              <span>Credit / footer line</span>
              <input value={footer} onChange={(event) => setFooter(event.target.value)} placeholder="Photo: Author · License · Source" />
            </label>
          </div>

          <label>
            <span>
              Video script (one beat per line — optional [SECTION] label; plays as slides after the headline)
              <button type="button" className="link-button" onClick={() => void draftBeatsFromCard()} disabled={draftingBeats || (!headline.trim() && !subline.trim())}>
                {draftingBeats ? 'drafting…' : 'draft from card'}
              </button>
            </span>
            <textarea
              value={videoBeats}
              onChange={(event) => setVideoBeats(event.target.value)}
              rows={5}
              placeholder={'[THE STORY] Abu Trica pleads not guilty in a US court\n[THE DETAIL] Charged over an alleged $8m romance scam\n[WHO] Prosecutors say elderly Americans were targeted\n[WHAT’S NEXT] Trial is set for September 8'}
            />
          </label>
          <div className="field-grid">
            <label>
              <span>Video motion style</span>
              <select value={videoMotion} onChange={(event) => setVideoMotion(event.target.value as VideoMotion)}>
                <option value="subtle">Subtle — gentle zoom + crossfades</option>
                <option value="dynamic">Dynamic — bigger zoom + slide transitions</option>
                <option value="minimal">Minimal — no zoom, hard cuts</option>
              </select>
            </label>
            <label>
              <span>Video sound</span>
              <select value={videoSound} onChange={(event) => setVideoSound(event.target.value as VideoSound)}>
                {(Object.keys(SOUND_LABELS) as VideoSound[]).map((key) => (
                  <option key={key} value={key}>
                    {SOUND_LABELS[key]}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <label>
            <span>Voiceover (needs scripts/resolver.py running with a TTS key)</span>
            <select value={videoVoice} onChange={(event) => setVideoVoice(event.target.value as VideoVoice)}>
              <option value="none">None (music only)</option>
              <option value="google">Google voice — free, professional</option>
              <option value="elevenlabs">ElevenLabs — most human (needs plan for commercial)</option>
            </select>
          </label>

          <div className="designer-actions">
            <button type="button" className="secondary" onClick={useSelectedStory}>
              Use selected story
            </button>
            <button type="button" className="secondary" onClick={copyCardToClipboard}>
              {copied ? 'Copied ✓' : 'Copy image'}
            </button>
            {typeof navigator !== 'undefined' && 'canShare' in navigator ? (
              <button type="button" className="secondary" onClick={() => void shareCard()}>
                Share card
              </button>
            ) : null}
            <button type="button" className="secondary" onClick={() => void downloadAllSizes()}>
              Download all sizes
            </button>
            {videoExportSupported() ? (
              <button type="button" className="secondary" onClick={() => void downloadVideo()} disabled={videoProgress >= 0}>
                {videoProgress >= 0 ? `Rendering video… ${Math.round(videoProgress * 100)}%` : '🎬 Export video'}
              </button>
            ) : null}
            <button type="button" className="primary" onClick={() => void downloadCard()}>
              Download PNG
            </button>
          </div>
        </div>

        <div className="designer-preview">
          <canvas ref={canvasRef} aria-label="News card preview" />
        </div>
      </div>
    </section>
  );
}
