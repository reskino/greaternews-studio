// Headless batch renderer: fetches a card spec from the local render server,
// draws every card in every requested size, records the videos, and POSTs the
// files back to the server. Driven by scripts/render_assets.py.
import type { CardFormat, CardOptions, CardTemplate, ChipLabel } from './cardEngine';
import { drawCard, formatSizes } from './cardEngine';
import { fetchArticleImage } from './article';
import { findBestPhoto, loadImage, loadImageWithProxyFallback } from './imageSearch';
import { exportCardVideo, videoExportSupported } from './videoExport';

const SERVER = 'http://localhost:5198';

type CardSpec = {
  slug: string;
  template?: CardTemplate;
  headline?: string;
  subline?: string;
  highlight?: string;
  attribution?: string;
  chip?: ChipLabel;
  statValue?: string;
  postHandle?: string;
  postMeta?: string;
  footer?: string;
  handle?: string;
  accent?: string;
  dim?: number;
  headlineShift?: number;
  photoUrl?: string | null;
  articleUrl?: string | null;
  photoQuery?: string | null;
  formats?: CardFormat[];
  video?: boolean;
  scenes?: string[];
  narration?: string[];
  photoQueries?: (string | null)[];
  motion?: 'subtle' | 'dynamic' | 'minimal';
  sound?: 'none' | 'newsroom' | 'uplift' | 'calm';
  voice?: 'none' | 'google' | 'elevenlabs' | 'groq';
  voiceName?: string;
};

type RenderSpec = {
  date: string;
  cards: CardSpec[];
};

const logElement = document.getElementById('log') as HTMLElement;

function log(message: string, cls = '') {
  const line = document.createElement('div');
  line.textContent = message;
  if (cls) {
    line.className = cls;
  }
  logElement.appendChild(line);
}

async function upload(name: string, blob: Blob) {
  const response = await fetch(`${SERVER}/save?name=${encodeURIComponent(name)}`, { method: 'POST', body: blob });
  if (!response.ok) {
    throw new Error(`Upload failed: HTTP ${response.status}`);
  }
}

function canvasToBlob(canvas: HTMLCanvasElement) {
  return new Promise<Blob | null>((resolve) => canvas.toBlob((blob) => resolve(blob), 'image/png'));
}

// One stuck video (headless MediaRecorder can wedge) must never block the rest of the batch.
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => window.setTimeout(() => reject(new Error(`timed out after ${Math.round(ms / 1000)}s`)), ms)),
  ]);
}

async function run() {
  let rendered = 0;
  let failed = 0;

  try {
    await Promise.all([
      document.fonts.load("800 67px Poppins"),
      document.fonts.load("700 30px Poppins"),
      document.fonts.load("600 45px Poppins"),
      document.fonts.load("500 23px Poppins"),
    ]);

    const specResponse = await fetch(`${SERVER}/cards.json`);
    if (!specResponse.ok) {
      throw new Error(`Could not fetch card spec: HTTP ${specResponse.status}`);
    }
    const spec = (await specResponse.json()) as RenderSpec;
    log(`Spec loaded: ${spec.cards.length} cards for ${spec.date}`);

    let logo: HTMLImageElement | null = null;
    try {
      logo = await loadImage(`${import.meta.env.BASE_URL}logo.png`, false);
    } catch {
      log('Logo not found — using monogram fallback');
    }

    for (const card of spec.cards) {
      let photo: HTMLImageElement | null = null;
      let photoCredit = '';

      if (card.photoUrl) {
        try {
          photo = await loadImageWithProxyFallback(card.photoUrl);
        } catch {
          log(`${card.slug}: photo failed to load, rendering without it`, 'err');
        }
      }

      // Source-article image (outlet's own photo, credited to the outlet).
      if (!photo && card.articleUrl) {
        try {
          const ogImage = await fetchArticleImage(card.articleUrl);
          if (ogImage) {
            photo = await loadImageWithProxyFallback(ogImage);
            const host = new URL(card.articleUrl).hostname.replace(/^www\./, '');
            photoCredit = `Photo: via ${host}`;
            log(`${card.slug}: source image from ${host}`, 'ok');
          } else {
            log(`${card.slug}: article has no preview image — trying photoQuery`);
          }
        } catch {
          log(`${card.slug}: source image failed — trying photoQuery`, 'err');
        }
      }

      // Licensed auto-photo fallback: Wikipedia/Commons only, credit stamped on the card.
      if (!photo && card.photoQuery) {
        const best = await findBestPhoto(card.photoQuery).catch(() => null);
        if (best) {
          photo = best.image;
          photoCredit = best.credit;
          log(`${card.slug}: photo via "${card.photoQuery}" — ${best.credit}`, 'ok');
        } else {
          log(`${card.slug}: no licensed photo found for "${card.photoQuery}" — placeholder used`, 'err');
        }
      }

      const options: CardOptions = {
        template: card.template ?? 'headline',
        format: 'portrait',
        photo,
        logo,
        headline: card.headline ?? '',
        subline: card.subline ?? '',
        highlight: card.highlight ?? '',
        attribution: card.attribution ?? '',
        chip: card.chip ?? 'UPDATE',
        statValue: card.statValue ?? '',
        postHandle: card.postHandle ?? '',
        postMeta: card.postMeta ?? '',
        footer: [card.footer ?? '', photoCredit].filter(Boolean).join('  ·  '),
        handle: card.handle ?? '@GreaterNews · News You Can Trust',
        accent: card.accent ?? '#f3c457',
        dim: card.dim ?? 0.2,
        headlineShift: card.headlineShift ?? 0,
      };

      for (const format of card.formats ?? ['portrait', 'story']) {
        try {
          const canvas = document.createElement('canvas');
          drawCard(canvas, { ...options, format });
          const blob = await canvasToBlob(canvas);
          if (!blob) {
            throw new Error('empty blob');
          }
          await upload(`${card.slug}_${formatSizes[format].suffix}.png`, blob);
          rendered += 1;
          log(`✓ ${card.slug}_${formatSizes[format].suffix}.png`, 'ok');
        } catch (error) {
          failed += 1;
          log(`✗ ${card.slug} ${format}: ${String(error)}`, 'err');
        }
      }

      if (card.video && videoExportSupported()) {
        // Per-beat photos: a licensed image per beat from its photoQuery (falls back to the main photo).
        let beatPhotos: (HTMLImageElement | null)[] = [];
        if (card.photoQueries?.length) {
          beatPhotos = await Promise.all(
            card.photoQueries.map(async (query) => {
              if (!query) return null;
              const best = await findBestPhoto(query).catch(() => null);
              if (best) log(`${card.slug}: beat photo "${query}" — ${best.credit}`, 'ok');
              return best?.image ?? null;
            }),
          );
        }
        try {
          const { blob, extension } = await withTimeout(exportCardVideo({ ...options, format: 'story' }, { scenes: card.scenes ?? [], narration: card.narration, beatPhotos, motion: card.motion, sound: card.sound, voice: card.voice, voiceName: card.voiceName }), 90_000);
          await upload(`${card.slug}_9x16.${extension}`, blob);
          rendered += 1;
          log(`✓ ${card.slug}_9x16.${extension} (${Math.round(blob.size / 1024)} KB)`, 'ok');
        } catch (error) {
          failed += 1;
          log(`✗ ${card.slug} video: ${String(error)}`, 'err');
        }
      }
    }
  } catch (error) {
    log(`FATAL: ${String(error)}`, 'err');
    failed += 1;
  }

  log(`Done: ${rendered} files, ${failed} failures`);
  try {
    await fetch(`${SERVER}/done?rendered=${rendered}&failed=${failed}`);
  } catch {
    // Server already gone — nothing to report to.
  }
  document.title = 'RENDER-DONE';
}

void run();
