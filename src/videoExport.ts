import type { CardOptions } from './cardEngine';
import { formatSizes } from './cardEngine';
import { buildScenes } from './videoScenes';
import type { VideoScene } from './videoScenes';
import { scheduleBed } from './videoAudio';
import type { VideoSound } from './videoAudio';
import { Muxer, ArrayBufferTarget } from 'mp4-muxer';

export type { VideoSound } from './videoAudio';

export type VideoExportResult = {
  blob: Blob;
  extension: 'mp4' | 'webm';
};

export type VideoMotion = 'subtle' | 'dynamic' | 'minimal';
export type VideoVoice = 'none' | 'google' | 'elevenlabs' | 'groq';

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
const AUDIO_SR = 48000; // encode audio at 48k so AAC/opus is universally compatible
const VIDEO_BITRATE = 8_000_000;
const AUDIO_BITRATE = 192_000;
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

// Deterministic encode (no real-time capture, so audio is glitch-free) needs the WebCodecs API.
function webCodecsSupported() {
  return (
    typeof VideoEncoder !== 'undefined' &&
    typeof AudioEncoder !== 'undefined' &&
    typeof VideoFrame !== 'undefined' &&
    typeof AudioData !== 'undefined'
  );
}

export function videoExportSupported() {
  if (webCodecsSupported()) return true;
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

// Fetch narration and decode it to a 48k AudioBuffer. No live AudioContext needed — an
// OfflineAudioContext decodes and resamples, which also works in headless renders.
async function fetchVoiceover(voice: VideoVoice, text: string): Promise<AudioBuffer | null> {
  const response = await fetch(`${TTS_URL}?voice=${voice}&text=${encodeURIComponent(text)}`, { signal: AbortSignal.timeout(60000) });
  if (!response.ok) {
    return null;
  }
  const bytes = await response.arrayBuffer();
  const decodeCtx = new OfflineAudioContext(1, 1, AUDIO_SR);
  return decodeCtx.decodeAudioData(bytes);
}

// Draw a scene bitmap with a push-in zoom (p within scene) and an x offset (slide transitions).
function drawScene(ctx: CanvasRenderingContext2D, bitmap: HTMLCanvasElement, width: number, height: number, p: number, zoom: number, offsetX: number) {
  const scale = 1 + zoom * easeOutCubic(Math.max(0, Math.min(1, p)));
  const drawnWidth = width * scale;
  const drawnHeight = height * scale;
  ctx.drawImage(bitmap, (width - drawnWidth) / 2 + offsetX, (height - drawnHeight) / 2, drawnWidth, drawnHeight);
}

type Timeline = {
  width: number;
  height: number;
  built: VideoScene[];
  totalMs: number;
  stage: HTMLCanvasElement;
  paint: (elapsed: number) => void;
};

// Build the scene list, stretch it to the narration length, and produce a paint(elapsed) fn shared
// by both encode paths. Keeps all the timing/transition logic in one place.
function buildTimeline(options: CardOptions, config: VideoConfig, voiceBuffer: AudioBuffer | null): Timeline {
  const { width, height } = formatSizes[options.format];
  const scenes = config.scenes ?? [];
  const built = buildScenes(options, scenes);
  const style = MOTION[config.motion ?? 'subtle'];

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

  return { width, height, built, totalMs, stage, paint };
}

// Render music + narration into a single AudioBuffer, offline (faster than real-time, deterministic,
// and — crucially — not captured through MediaRecorder, so no ticking/glitches). Returns null when
// there's no audio at all.
async function renderAudioMix(sound: VideoSound, voiceBuffer: AudioBuffer | null, totalMs: number): Promise<AudioBuffer | null> {
  if (sound === 'none' && !voiceBuffer) {
    return null;
  }
  const durSec = (totalMs + HOLD_MS) / 1000;
  const octx = new OfflineAudioContext(2, Math.ceil(durSec * AUDIO_SR), AUDIO_SR);

  if (sound !== 'none') {
    const master = octx.createGain();
    const level = voiceBuffer ? 0.32 : 0.5; // duck music under narration, but keep it present to fill pauses
    master.gain.setValueAtTime(0.0001, 0);
    master.gain.exponentialRampToValueAtTime(level, 0.6);
    master.gain.setValueAtTime(level, Math.max(0.6, durSec - 1.2));
    master.gain.exponentialRampToValueAtTime(0.0001, durSec);
    master.connect(octx.destination);
    scheduleBed(octx as unknown as AudioContext, master, sound, durSec);
  }

  if (voiceBuffer) {
    const source = octx.createBufferSource();
    source.buffer = voiceBuffer;
    source.connect(octx.destination);
    source.start(0.2);
  }

  return octx.startRendering();
}

// Preferred path: encode frames + audio deterministically with WebCodecs and mux to MP4. The audio
// track is written straight from the rendered buffer, so it can't pick up capture artifacts.
async function encodeWithWebCodecs(timeline: Timeline, audioBuffer: AudioBuffer | null, onProgress?: (progress: number) => void): Promise<VideoExportResult> {
  const { width, height, totalMs, stage, paint } = timeline;

  // Pick an H.264 profile the encoder actually supports at this resolution.
  const avcCandidates = ['avc1.640028', 'avc1.4d0028', 'avc1.42e028', 'avc1.640033'];
  let videoCodec = '';
  for (const candidate of avcCandidates) {
    const support = await VideoEncoder.isConfigSupported({ codec: candidate, width, height, bitrate: VIDEO_BITRATE, framerate: FPS });
    if (support.supported) {
      videoCodec = candidate;
      break;
    }
  }
  if (!videoCodec) {
    throw new Error('No supported H.264 encoder configuration.');
  }

  // Pick an audio codec (AAC preferred for compatibility; opus as a fallback).
  let muxerAudioCodec: 'aac' | 'opus' | null = null;
  let audioEncoderCodec = '';
  if (audioBuffer) {
    for (const [muxName, encName] of [['aac', 'mp4a.40.2'], ['opus', 'opus']] as const) {
      const support = await AudioEncoder.isConfigSupported({ codec: encName, sampleRate: AUDIO_SR, numberOfChannels: 2, bitrate: AUDIO_BITRATE });
      if (support.supported) {
        muxerAudioCodec = muxName;
        audioEncoderCodec = encName;
        break;
      }
    }
    if (!muxerAudioCodec) {
      throw new Error('No supported audio encoder configuration.');
    }
  }

  const muxer = new Muxer({
    target: new ArrayBufferTarget(),
    video: { codec: 'avc', width, height, frameRate: FPS },
    audio: muxerAudioCodec ? { codec: muxerAudioCodec, numberOfChannels: 2, sampleRate: AUDIO_SR } : undefined,
    fastStart: 'in-memory',
  });

  let encodeError: unknown = null;
  const videoEncoder = new VideoEncoder({
    output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
    error: (err) => {
      encodeError = err;
    },
  });
  videoEncoder.configure({ codec: videoCodec, width, height, bitrate: VIDEO_BITRATE, framerate: FPS, latencyMode: 'quality' });

  let audioEncoder: AudioEncoder | null = null;
  if (muxerAudioCodec) {
    audioEncoder = new AudioEncoder({
      output: (chunk, meta) => muxer.addAudioChunk(chunk, meta),
      error: (err) => {
        encodeError = err;
      },
    });
    audioEncoder.configure({ codec: audioEncoderCodec, sampleRate: AUDIO_SR, numberOfChannels: 2, bitrate: AUDIO_BITRATE });
  }

  // Encode every frame from a freshly-painted canvas. Holds the final frame for HOLD_MS.
  const totalFrames = Math.max(1, Math.round(((totalMs + HOLD_MS) / 1000) * FPS));
  const frameDurUs = Math.round(1_000_000 / FPS);
  const audioWeight = muxerAudioCodec ? 0.9 : 1;
  for (let i = 0; i < totalFrames; i += 1) {
    if (encodeError) throw encodeError;
    const elapsed = (i * 1000) / FPS;
    paint(elapsed >= totalMs ? totalMs - 1 : elapsed);
    const frame = new VideoFrame(stage, { timestamp: Math.round((i * 1_000_000) / FPS), duration: frameDurUs });
    videoEncoder.encode(frame, { keyFrame: i % FPS === 0 });
    frame.close();
    onProgress?.(Math.min(1, (i + 1) / totalFrames) * audioWeight);
    // Backpressure: let the encoder drain so VideoFrames don't pile up in memory.
    if (videoEncoder.encodeQueueSize > 30) {
      await new Promise<void>((resolve) => {
        const check = () => (videoEncoder.encodeQueueSize <= 10 || encodeError ? resolve() : setTimeout(check, 4));
        check();
      });
    }
  }

  // Encode the mixed audio in small blocks with monotonically increasing timestamps.
  if (muxerAudioCodec && audioBuffer && audioEncoder) {
    const sampleRate = audioBuffer.sampleRate;
    const ch0 = audioBuffer.getChannelData(0);
    const ch1 = audioBuffer.numberOfChannels > 1 ? audioBuffer.getChannelData(1) : ch0;
    const totalSamples = audioBuffer.length;
    const block = Math.round(sampleRate * 0.1); // ~100ms blocks
    for (let offset = 0; offset < totalSamples; offset += block) {
      if (encodeError) throw encodeError;
      const count = Math.min(block, totalSamples - offset);
      const planar = new Float32Array(count * 2); // f32-planar: [ch0…][ch1…]
      planar.set(ch0.subarray(offset, offset + count), 0);
      planar.set(ch1.subarray(offset, offset + count), count);
      const audioData = new AudioData({
        format: 'f32-planar',
        sampleRate,
        numberOfFrames: count,
        numberOfChannels: 2,
        timestamp: Math.round((offset / sampleRate) * 1_000_000),
        data: planar,
      });
      audioEncoder.encode(audioData);
      audioData.close();
    }
  }

  await videoEncoder.flush();
  if (audioEncoder) {
    await audioEncoder.flush();
  }
  if (encodeError) throw encodeError;
  muxer.finalize();
  videoEncoder.close();
  if (audioEncoder) audioEncoder.close();

  onProgress?.(1);
  const { buffer } = muxer.target as ArrayBufferTarget;
  return { blob: new Blob([buffer], { type: 'video/mp4' }), extension: 'mp4' };
}

// Fallback for browsers without WebCodecs: real-time canvas + Web Audio capture via MediaRecorder.
// Audio can pick up capture artifacts here, but it keeps export working everywhere.
async function exportViaMediaRecorder(
  timeline: Timeline,
  sound: VideoSound,
  voiceBuffer: AudioBuffer | null,
  onProgress?: (progress: number) => void,
): Promise<VideoExportResult> {
  const mimeType = pickMimeType();
  if (!mimeType) {
    throw new Error('This browser cannot record video from a canvas.');
  }
  const { totalMs, stage, paint } = timeline;

  let audioCtx: AudioContext | null = null;
  if ((sound !== 'none' || voiceBuffer) && typeof AudioContext !== 'undefined') {
    try {
      audioCtx = new AudioContext();
      if (audioCtx.state === 'suspended') {
        await audioCtx.resume();
      }
    } catch {
      audioCtx = null;
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
      const level = voiceBuffer ? 0.32 : 0.5;
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

  const recorder = new MediaRecorder(recordStream, { mimeType, videoBitsPerSecond: VIDEO_BITRATE, audioBitsPerSecond: AUDIO_BITRATE });
  const chunks: Blob[] = [];
  recorder.ondataavailable = (event) => {
    if (event.data.size > 0) {
      chunks.push(event.data);
    }
  };
  const stopped = new Promise<Blob>((resolve) => {
    recorder.onstop = () => resolve(new Blob(chunks, { type: mimeType.split(';')[0] }));
  });

  recorder.start();
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

// Renders a card into a short video. Empty scenes → single-hero clip; with beats → hero → beats →
// close. motion sets zoom/transition; sound adds a music bed; voice (via the TTS proxy) adds
// narration, stretches the video to the narration length, and ducks music. Encodes with WebCodecs
// when available (deterministic, glitch-free audio), falling back to MediaRecorder otherwise.
export async function exportCardVideo(
  options: CardOptions,
  config: VideoConfig = {},
  onProgress?: (progress: number) => void,
): Promise<VideoExportResult> {
  const scenes = config.scenes ?? [];
  const sound = config.sound ?? 'none';
  const voice = config.voice ?? 'none';

  let voiceBuffer: AudioBuffer | null = null;
  if (voice !== 'none') {
    try {
      voiceBuffer = await fetchVoiceover(voice, voiceoverText(options, scenes));
    } catch {
      voiceBuffer = null;
    }
  }

  const timeline = buildTimeline(options, config, voiceBuffer);

  if (webCodecsSupported()) {
    try {
      const audioBuffer = await renderAudioMix(sound, voiceBuffer, timeline.totalMs);
      return await encodeWithWebCodecs(timeline, audioBuffer, onProgress);
    } catch (err) {
      // Any WebCodecs failure (unsupported config, encoder error) falls back to the capture path.
      console.warn('WebCodecs export failed; falling back to MediaRecorder.', err);
    }
  }

  return exportViaMediaRecorder(timeline, sound, voiceBuffer, onProgress);
}
