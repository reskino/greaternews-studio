import type { CardOptions } from './cardEngine';
import { formatSizes } from './cardEngine';
import { buildScenes } from './videoScenes';

export type VideoExportResult = {
  blob: Blob;
  extension: 'mp4' | 'webm';
};

const HOLD_MS = 500;
const FPS = 30;
const XFADE_MS = 450;

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

// Draw a scene bitmap with a gentle push-in zoom (p = 0..1 within the scene). At p=0 the bitmap
// fills the frame exactly, so the hero's first frame is a pixel-exact card (great thumbnail);
// the zoom only ever grows it, so the frame is always fully covered — never black at the edges.
function drawScene(ctx: CanvasRenderingContext2D, bitmap: HTMLCanvasElement, width: number, height: number, p: number) {
  const scale = 1 + 0.035 * easeOutCubic(Math.max(0, Math.min(1, p)));
  const drawnWidth = width * scale;
  const drawnHeight = height * scale;
  ctx.drawImage(bitmap, (width - drawnWidth) / 2, (height - drawnHeight) / 2, drawnWidth, drawnHeight);
}

// Renders a card into a short video. `scenes` are the extra story beats: with none, it's the
// single-hero clip (unchanged); with beats, it's hero → beats (alternating photo/brand) → close.
export async function exportCardVideo(
  options: CardOptions,
  scenes: string[] = [],
  onProgress?: (progress: number) => void,
): Promise<VideoExportResult> {
  const mimeType = pickMimeType();
  if (!mimeType) {
    throw new Error('This browser cannot record video from a canvas.');
  }

  const { width, height } = formatSizes[options.format];
  const built = buildScenes(options, scenes);

  const starts: number[] = [];
  let acc = 0;
  for (const scene of built) {
    starts.push(acc);
    acc += scene.durationMs;
  }
  const totalMs = acc;

  const stage = document.createElement('canvas');
  stage.width = width;
  stage.height = height;
  const ctx = stage.getContext('2d');
  if (!ctx) {
    throw new Error('Could not create the video canvas.');
  }

  function paint(elapsed: number) {
    const clamped = Math.max(0, Math.min(elapsed, totalMs - 1));
    let index = built.length - 1;
    while (index > 0 && clamped < starts[index]) {
      index -= 1;
    }
    const local = clamped - starts[index];
    const duration = built[index].durationMs;

    ctx!.fillStyle = '#000000';
    ctx!.fillRect(0, 0, width, height);
    drawScene(ctx!, built[index].bitmap, width, height, local / duration);

    // Crossfade the next scene in over the last XFADE_MS of this one.
    const remaining = duration - local;
    if (index < built.length - 1 && remaining < XFADE_MS) {
      ctx!.save();
      ctx!.globalAlpha = Math.max(0, Math.min(1, (XFADE_MS - remaining) / XFADE_MS));
      drawScene(ctx!, built[index + 1].bitmap, width, height, 0);
      ctx!.restore();
    }
  }

  paint(0);

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
      const elapsed = now - start;
      paint(elapsed);
      onProgress?.(Math.min(1, elapsed / totalMs));
      if (elapsed < totalMs) {
        requestAnimationFrame(tick);
      } else {
        resolve();
      }
    }
    requestAnimationFrame(tick);
  });

  // Hold the final (close) frame so the video doesn't cut on the last motion frame.
  paint(totalMs - 1);
  await new Promise((resolve) => window.setTimeout(resolve, HOLD_MS));
  recorder.stop();

  const blob = await stopped;
  return { blob, extension: mimeType.includes('mp4') ? 'mp4' : 'webm' };
}
