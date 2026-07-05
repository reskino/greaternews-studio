import { useEffect, useRef, useState } from 'react';
import type { CardFormat, CardTemplate, ChipLabel } from './cardEngine';
import { drawCard, formatSizes, templateMeta } from './cardEngine';
import type { ImageResult } from './imageSearch';
import { dedupeResults, findStoryImages, loadImage, loadImageWithProxyFallback, searchCommons, searchOpenverse } from './imageSearch';

type CardDesignerProps = {
  suggestedHeadline: string;
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

function initialTemplate(): CardTemplate {
  const requested = initialParam('template', 'headline');
  return (templateOrder as string[]).includes(requested) ? (requested as CardTemplate) : 'headline';
}

export default function CardDesigner({
  suggestedHeadline,
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
  const [highlight, setHighlight] = useState(() => initialParam('highlight', ''));
  const [attribution, setAttribution] = useState(() => initialParam('attribution', ''));
  const [chip, setChip] = useState<ChipLabel>('UPDATE');
  const [statValue, setStatValue] = useState(() => initialParam('stat', ''));
  const [postHandle, setPostHandle] = useState(() => initialParam('posthandle', ''));
  const [postMeta, setPostMeta] = useState(() => initialParam('postmeta', ''));
  const [refImage, setRefImage] = useState('');
  const [refError, setRefError] = useState('');
  const [refLoading, setRefLoading] = useState(false);
  const [footer, setFooter] = useState(() => initialParam('footer', ''));
  const [handle, setHandle] = useState(defaultHandle);
  const [accent, setAccent] = useState('#f3c457');
  const [dim, setDim] = useState(0.2);
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
      });
    }
  }, [accent, attribution, chip, dim, fontsReady, footer, format, handle, headline, highlight, logo, photo, postHandle, postMeta, statValue, template]);

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

  async function executeSearch(queries: string[]) {
    if (queries.length === 0 || searching) {
      return;
    }

    setSearching(true);
    setSearchError('');
    setResults([]);

    const settled = await Promise.allSettled(queries.flatMap((term) => [searchCommons(term), searchOpenverse(term)]));
    const found = dedupeResults(settled.flatMap((result) => (result.status === 'fulfilled' ? result.value : []))).slice(0, 18);

    setResults(found);
    if (found.length === 0) {
      setSearchError(
        settled.every((result) => result.status === 'rejected')
          ? 'Image search is unreachable right now. Check the connection and try again.'
          : 'No images found for that search. Try fewer or broader words.',
      );
    }
    setSearching(false);
  }

  async function runImageSearch() {
    const trimmed = query.trim();
    if (trimmed) {
      await executeSearch([trimmed]);
    }
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
      setFooter(`Photo: ${result.author} · ${result.license} · ${result.provider}`);
    } catch {
      setSearchError('Could not load that image (the source may block downloads). Try another result, or download it manually and upload it.');
    } finally {
      setLoadingImageId('');
    }
  }

  function useSelectedStory() {
    setHeadline(suggestedHeadline);
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
            <label>
              <span>Highlight phrase (colored words inside the headline — skip for tragedy)</span>
              <input value={highlight} onChange={(event) => setHighlight(event.target.value)} placeholder="e.g. End American Financial Aid" />
            </label>
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

          <div className="designer-actions">
            <button type="button" className="secondary" onClick={useSelectedStory}>
              Use selected story
            </button>
            <button type="button" className="secondary" onClick={copyCardToClipboard}>
              {copied ? 'Copied ✓' : 'Copy image'}
            </button>
            <button type="button" className="secondary" onClick={() => void downloadAllSizes()}>
              Download all sizes
            </button>
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
