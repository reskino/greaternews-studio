import type { CardOptions } from './cardEngine';
import { drawCard, formatSizes } from './cardEngine';

export type VideoExportResult = {
  blob: Blob;
  extension: 'mp4' | 'webm';
};

const DURATION_MS = 7000;
const HOLD_MS = 400;
const FPS = 30;

function pickMimeType() {
  const candidates = ['video/mp4;codecs=avc1', 'video/mp4', 'video/webm;codecs=vp9', 'video/webm'];
  for (const candidate of candidates) {
    if (typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(candidate)) {
      return candidate;
    }
  }
  return '';
}

export function videoExportSupported() {
  return typeof MediaRecorder !== 'undefined' && typeof HTMLCanvasElement.prototype.captureStream === 'function' && pickMimeType() !== '';
}

function easeOutCubic(t: number) {
  return 1 - Math.pow(1 - t, 3);
}

// Cinematic reveal: black → the card fades in with a slow settle-zoom and gentle drift,
// landing pixel-exact on the static card so the final frame matches the PNG export.
function drawFrame(ctx: CanvasRenderingContext2D, cardBitmap: HTMLCanvasElement, width: number, height: number, t: number) {
  ctx.fillStyle = '#000000';
  ctx.fillRect(0, 0, width, height);

  const fadeIn = Math.min(1, t / 0.14);
  const settle = easeOutCubic(Math.min(1, t / 0.85));
  const scale = 1.1 - 0.1 * settle;
  const driftY = (1 - settle) * height * 0.015;

  const drawnWidth = width * scale;
  const drawnHeight = height * scale;

  ctx.save();
  ctx.globalAlpha = fadeIn;
  ctx.drawImage(cardBitmap, (width - drawnWidth) / 2, (height - drawnHeight) / 2 + driftY, drawnWidth, drawnHeight);
  ctx.restore();

  // Accent line sweeps in along the bottom, then locks to full width.
  const sweep = Math.max(0, Math.min(1, (t - 0.25) / 0.45));
  if (sweep > 0) {
    ctx.fillStyle = 'rgba(243, 196, 87, 0.9)';
    ctx.fillRect(0, height - Math.max(4, Math.round(height * 0.004)), width * easeOutCubic(sweep), Math.max(4, Math.round(height * 0.004)));
  }
}

export async function exportCardVideo(options: CardOptions, onProgress?: (progress: number) => void): Promise<VideoExportResult> {
  const mimeType = pickMimeType();
  if (!mimeType) {
    throw new Error('This browser cannot record video from a canvas.');
  }

  const { width, height } = formatSizes[options.format];

  const cardBitmap = document.createElement('canvas');
  drawCard(cardBitmap, options);

  const stage = document.createElement('canvas');
  stage.width = width;
  stage.height = height;
  const ctx = stage.getContext('2d');
  if (!ctx) {
    throw new Error('Could not create the video canvas.');
  }

  drawFrame(ctx, cardBitmap, width, height, 0);

  const stream = stage.captureStream(FPS);
  const recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 8_000_000 });
  const chunks: Blob[] = [];
  recorder.ondataavailable = (event) => {
    if (event.data.size > 0) {
      chunks.push(event.data);
    }
  };

  const stopped = new Promise<Blob>((resolve) => {
    recorder.onstop = () => resolve(new Blob(chunks, { type: mimeType.split(';')[0] }));
  });

  recorder.start(250);
  const start = performance.now();

  await new Promise<void>((resolve) => {
    function tick(now: number) {
      // rAF timestamps can land just before the performance.now() captured at start.
      const t = Math.min(1, Math.max(0, (now - start) / DURATION_MS));
      drawFrame(ctx as CanvasRenderingContext2D, cardBitmap, width, height, t);
      onProgress?.(t);
      if (t < 1) {
        requestAnimationFrame(tick);
      } else {
        resolve();
      }
    }
    requestAnimationFrame(tick);
  });

  // Hold the finished card so the video doesn't cut on the last motion frame.
  await new Promise((resolve) => window.setTimeout(resolve, HOLD_MS));
  recorder.stop();

  const blob = await stopped;
  return { blob, extension: mimeType.includes('mp4') ? 'mp4' : 'webm' };
}
