import type { CardOptions } from './cardEngine';
import { formatSizes } from './cardEngine';
import { buildScenes } from './videoScenes';
import { scheduleBed } from './videoAudio';
import type { VideoSound } from './videoAudio';

export type { VideoSound } from './videoAudio';

export type VideoExportResult = {
  blob: Blob;
  extension: 'mp4' | 'webm';
};

export type VideoMotion = 'subtle' | 'dynamic' | 'minimal';

export type VideoConfig = {
  scenes?: string[];
  motion?: VideoMotion;
  sound?: VideoSound;
};

type MotionSpec = { zoom: number; transition: 'crossfade' | 'slide' | 'cut'; transitionMs: number };

const MOTION: Record<VideoMotion, MotionSpec> = {
  subtle: { zoom: 0.035, transition: 'crossfade', transitionMs: 450 },
  dynamic: { zoom: 0.07, transition: 'slide', transitionMs: 380 },
  minimal: { zoom: 0, transition: 'cut', transitionMs: 0 },
};

const HOLD_MS = 500;
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

// Draw a scene bitmap with a push-in zoom (p = 0..1 within the scene) and an optional horizontal
// offset (used by the slide transition). At p=0 with offset 0 the bitmap fills the frame exactly,
// so the hero's first frame is a pixel-exact card, and the zoom only ever grows it — no black edges.
function drawScene(ctx: CanvasRenderingContext2D, bitmap: HTMLCanvasElement, width: number, height: number, p: number, zoom: number, offsetX: number) {
  const scale = 1 + zoom * easeOutCubic(Math.max(0, Math.min(1, p)));
  const drawnWidth = width * scale;
  const drawnHeight = height * scale;
  ctx.drawImage(bitmap, (width - drawnWidth) / 2 + offsetX, (height - drawnHeight) / 2, drawnWidth, drawnHeight);
}

// Renders a card into a short video. Empty `scenes` → the single-hero clip (unchanged); with
// beats → hero → beats (alternating photo/brand) → close. `motion` sets zoom + transition style.
export async function exportCardVideo(
  options: CardOptions,
  config: VideoConfig = {},
  onProgress?: (progress: number) => void,
): Promise<VideoExportResult> {
  const mimeType = pickMimeType();
  if (!mimeType) {
    throw new Error('This browser cannot record video from a canvas.');
  }

  const { width, height } = formatSizes[options.format];
  const built = buildScenes(options, config.scenes ?? []);
  const style = MOTION[config.motion ?? 'subtle'];

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
    const p = local / duration;

    ctx!.fillStyle = '#000000';
    ctx!.fillRect(0, 0, width, height);

    const remaining = duration - local;
    const hasNext = index < built.length - 1;
    const inTransition = hasNext && style.transition !== 'cut' && remaining < style.transitionMs;
    const a = inTransition ? easeOutCubic((style.transitionMs - remaining) / style.transitionMs) : 0;

    if (inTransition && style.transition === 'slide') {
      drawScene(ctx!, built[index].bitmap, width, height, p, style.zoom, -width * a);
      drawScene(ctx!, built[index + 1].bitmap, width, height, 0, style.zoom, width * (1 - a));
    } else {
      drawScene(ctx!, built[index].bitmap, width, height, p, style.zoom, 0);
      if (inTransition && style.transition === 'crossfade') {
        ctx!.save();
        ctx!.globalAlpha = a;
        drawScene(ctx!, built[index + 1].bitmap, width, height, 0, style.zoom, 0);
        ctx!.restore();
      }
    }
  }

  paint(0);

  const videoStream = stage.captureStream(FPS);

  // Mix in a generated background bed as an audio track, when requested and supported.
  let recordStream: MediaStream = videoStream;
  let audioCtx: AudioContext | null = null;
  const sound = config.sound ?? 'none';
  if (sound !== 'none' && typeof AudioContext !== 'undefined') {
    try {
      audioCtx = new AudioContext();
      if (audioCtx.state === 'suspended') {
        await audioCtx.resume();
      }
      const master = audioCtx.createGain();
      const level = 0.6;
      const fullSeconds = (totalMs + HOLD_MS) / 1000;
      const now = audioCtx.currentTime;
      master.gain.setValueAtTime(0.0001, now);
      master.gain.exponentialRampToValueAtTime(level, now + 0.6);
      master.gain.setValueAtTime(level, now + Math.max(0.6, fullSeconds - 1.2));
      master.gain.exponentialRampToValueAtTime(0.0001, now + fullSeconds);
      const dest = audioCtx.createMediaStreamDestination();
      master.connect(dest);
      scheduleBed(audioCtx, master, sound, fullSeconds);
      recordStream = new MediaStream([...videoStream.getVideoTracks(), ...dest.stream.getAudioTracks()]);
    } catch {
      audioCtx = null;
      recordStream = videoStream;
    }
  }

  const recorder = new MediaRecorder(recordStream, { mimeType, videoBitsPerSecond: 8_000_000 });
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
  if (audioCtx) {
    void audioCtx.close();
  }
  return { blob, extension: mimeType.includes('mp4') ? 'mp4' : 'webm' };
}
