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
export type VideoVoice = 'none' | 'google' | 'elevenlabs';

export type VideoConfig = {
  scenes?: string[];
  motion?: VideoMotion;
  sound?: VideoSound;
  voice?: VideoVoice;
};

type MotionSpec = { zoom: number; transition: 'crossfade' | 'slide' | 'cut'; transitionMs: number };

const MOTION: Record<VideoMotion, MotionSpec> = {
  subtle: { zoom: 0.035, transition: 'crossfade', transitionMs: 450 },
  dynamic: { zoom: 0.07, transition: 'slide', transitionMs: 380 },
  minimal: { zoom: 0, transition: 'cut', transitionMs: 0 },
};

const HOLD_MS = 500;
const FPS = 30;
// Voiceover endpoint: the hosted Cloudflare proxy when set (works on any device), otherwise the
// local resolver (scripts/resolver.py) for desktop use. The key lives server-side either way.
const TTS_URL = import.meta.env.VITE_TTS_PROXY_URL || 'http://localhost:5199/tts';

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

// The spoken script: headline (hook) → beat lines (labels stripped) → close.
function voiceoverText(options: CardOptions, scenes: string[]) {
  const beats = scenes.map((s) => s.replace(/^\s*\[[^\]]*\]\s*/, '').trim()).filter(Boolean);
  return [options.headline.trim(), ...beats, 'Follow GreaterNews. News you can trust.'].filter(Boolean).join('. ');
}

async function fetchVoiceover(voice: VideoVoice, text: string, ctx: AudioContext): Promise<AudioBuffer | null> {
  const response = await fetch(`${TTS_URL}?voice=${voice}&text=${encodeURIComponent(text)}`, { signal: AbortSignal.timeout(60000) });
  if (!response.ok) {
    return null;
  }
  return ctx.decodeAudioData(await response.arrayBuffer());
}

// Draw a scene bitmap with a push-in zoom (p within scene) and an x offset (slide transitions).
function drawScene(ctx: CanvasRenderingContext2D, bitmap: HTMLCanvasElement, width: number, height: number, p: number, zoom: number, offsetX: number) {
  const scale = 1 + zoom * easeOutCubic(Math.max(0, Math.min(1, p)));
  const drawnWidth = width * scale;
  const drawnHeight = height * scale;
  ctx.drawImage(bitmap, (width - drawnWidth) / 2 + offsetX, (height - drawnHeight) / 2, drawnWidth, drawnHeight);
}

// Renders a card into a short video. Empty scenes → single-hero clip (unchanged); with beats →
// hero → beats → close. motion sets zoom/transition; sound adds a music bed; voice (via the local
// resolver's /tts) adds narration, stretches the video to the narration length, and ducks music.
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
  const scenes = config.scenes ?? [];
  const built = buildScenes(options, scenes);
  const style = MOTION[config.motion ?? 'subtle'];
  const sound = config.sound ?? 'none';
  const voice = config.voice ?? 'none';

  // Audio context (shared by music + voice); created only if either is requested.
  let audioCtx: AudioContext | null = null;
  if ((sound !== 'none' || voice !== 'none') && typeof AudioContext !== 'undefined') {
    try {
      audioCtx = new AudioContext();
      if (audioCtx.state === 'suspended') {
        await audioCtx.resume();
      }
    } catch {
      audioCtx = null;
    }
  }

  // Fetch narration first so we can size the video to it.
  let voiceBuffer: AudioBuffer | null = null;
  if (voice !== 'none' && audioCtx) {
    try {
      voiceBuffer = await fetchVoiceover(voice, voiceoverText(options, scenes), audioCtx);
    } catch {
      voiceBuffer = null;
    }
  }

  // Stretch the scenes to cover the narration (with a short tail), within sane bounds.
  if (voiceBuffer && built.length > 0) {
    const currentTotal = built.reduce((sum, scene) => sum + scene.durationMs, 0);
    const targetTotal = voiceBuffer.duration * 1000 + 900;
    const scale = Math.max(0.6, Math.min(2.8, targetTotal / currentTotal));
    built.forEach((scene) => {
      scene.durationMs = Math.round(scene.durationMs * scale);
    });
  }

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
    if (audioCtx) void audioCtx.close();
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

    const remaining = duration - local;
    const hasNext = index < built.length - 1;
    const inTransition = hasNext && style.transition !== 'cut' && remaining < style.transitionMs;
    const a = inTransition ? easeOutCubic((style.transitionMs - remaining) / style.transitionMs) : 0;

    if (inTransition && style.transition === 'slide') {
      drawScene(ctx!, built[index].bitmap, width, height, local / duration, style.zoom, -width * a);
      drawScene(ctx!, built[index + 1].bitmap, width, height, 0, style.zoom, width * (1 - a));
    } else {
      drawScene(ctx!, built[index].bitmap, width, height, local / duration, style.zoom, 0);
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
  let recordStream: MediaStream = videoStream;

  if (audioCtx && (sound !== 'none' || voiceBuffer)) {
    const dest = audioCtx.createMediaStreamDestination();
    const now = audioCtx.currentTime;
    const fullSeconds = (totalMs + HOLD_MS) / 1000;

    if (sound !== 'none') {
      const master = audioCtx.createGain();
      const level = voiceBuffer ? 0.32 : 0.5; // duck music under narration, but keep it present to fill pauses
      master.gain.setValueAtTime(0.0001, now);
      master.gain.exponentialRampToValueAtTime(level, now + 0.6);
      master.gain.setValueAtTime(level, now + Math.max(0.6, fullSeconds - 1.2));
      master.gain.exponentialRampToValueAtTime(0.0001, now + fullSeconds);
      master.connect(dest);
      scheduleBed(audioCtx, master, sound, fullSeconds);
    }

    if (voiceBuffer) {
      const source = audioCtx.createBufferSource();
      source.buffer = voiceBuffer;
      source.connect(dest);
      source.start(now + 0.2);
    }

    recordStream = new MediaStream([...videoStream.getVideoTracks(), ...dest.stream.getAudioTracks()]);
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

  paint(totalMs - 1);
  await new Promise((resolve) => window.setTimeout(resolve, HOLD_MS));
  recorder.stop();

  const blob = await stopped;
  if (audioCtx) {
    void audioCtx.close();
  }
  return { blob, extension: mimeType.includes('mp4') ? 'mp4' : 'webm' };
}
