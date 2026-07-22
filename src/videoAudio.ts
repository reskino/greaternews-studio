// Procedurally-generated background beds for the story video, built with the Web Audio API —
// royalty-free by construction (no bundled/licensed files) and mixed straight into the export.
// Subtle ambient beds meant to sit under the on-screen text, not to be produced music.
export type VideoSound = 'none' | 'newsroom' | 'uplift' | 'calm' | 'breaking' | 'documentary' | 'tech' | 'afro' | 'lofi' | 'anthem';

export const SOUND_LABELS: Record<VideoSound, string> = {
  none: 'None (silent)',
  newsroom: 'Newsroom — steady, understated',
  uplift: 'Uplift — bright, positive',
  calm: 'Calm — soft ambient pad',
  breaking: 'Breaking — tense, urgent pulse',
  documentary: 'Documentary — warm, cinematic',
  tech: 'Tech — bright, modern pulse',
  afro: 'Afrobeat — lively, rhythmic',
  lofi: 'Lo-fi — mellow, chilled',
  anthem: 'Anthem — bold, inspiring',
};

// One enveloped oscillator note. Exponential ramps never hit 0, so they start/end at ~0.0001.
function tone(
  ctx: AudioContext,
  out: AudioNode,
  type: OscillatorType,
  freq: number,
  startAt: number,
  dur: number,
  peak: number,
  attack: number,
  release: number,
) {
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = type;
  osc.frequency.value = freq;
  osc.connect(gain);
  gain.connect(out);
  const level = Math.max(0.0002, peak);
  gain.gain.setValueAtTime(0.0001, startAt);
  gain.gain.exponentialRampToValueAtTime(level, startAt + attack); // attack
  gain.gain.setValueAtTime(level, startAt + Math.max(attack, dur - release)); // SUSTAIN at level
  gain.gain.exponentialRampToValueAtTime(0.0001, startAt + dur); // release
  osc.start(startAt);
  osc.stop(startAt + dur + release);
}

// Schedule the chosen bed into `out` for durationSec, from ctx's current time. Every bed is a
// set of SUSTAINED tones spanning the whole clip — no rhythmic gaps — so the music runs
// continuously and fills the pauses between narration sentences (no "breaks").
export function scheduleBed(ctx: AudioContext, out: AudioNode, sound: VideoSound, durationSec: number) {
  const now = ctx.currentTime + 0.05;
  // Each bed varies chord, waveform and register for a distinct mood; `pulse` (Hz) adds a gentle
  // tremolo so some beds feel rhythmic rather than a flat pad.
  const beds: Record<VideoSound, { type: OscillatorType; freqs: number[]; peak: number; pulse?: number }> = {
    none: { type: 'sine', freqs: [], peak: 0 },
    // A minor — low, steady, understated.
    newsroom: { type: 'triangle', freqs: [110, 164.81, 220, 261.63, 329.63], peak: 0.11 },
    // C major — bright, positive.
    uplift: { type: 'triangle', freqs: [130.81, 196, 261.63, 329.63, 392], peak: 0.1 },
    // Soft low sine pad.
    calm: { type: 'sine', freqs: [110, 130.81, 164.81, 196, 261.63], peak: 0.11 },
    // Low tense drone (E minor-ish) with an urgent pulse.
    breaking: { type: 'sawtooth', freqs: [82.41, 110, 123.47, 164.81], peak: 0.07, pulse: 1.7 },
    // Warm, wide cinematic pad (G major add9).
    documentary: { type: 'sine', freqs: [98, 146.83, 220, 246.94, 392], peak: 0.1 },
    // Bright modern chord with a faster pulse.
    tech: { type: 'triangle', freqs: [146.83, 220, 293.66, 440], peak: 0.08, pulse: 2.4 },
    // Lively bright major with a groove-speed pulse (afrobeat-flavoured).
    afro: { type: 'triangle', freqs: [164.81, 207.65, 246.94, 329.63], peak: 0.09, pulse: 2.8 },
    // Mellow warm Cmaj7 pad with a slow sway.
    lofi: { type: 'sine', freqs: [130.81, 164.81, 196, 246.94], peak: 0.1, pulse: 0.5 },
    // Bold, wide major spread — inspiring.
    anthem: { type: 'triangle', freqs: [98, 146.83, 196, 246.94, 392], peak: 0.1 },
  };
  const bed = beds[sound];
  if (!bed || bed.freqs.length === 0) {
    return;
  }

  // Shared bus so an optional tremolo LFO can modulate the whole chord together.
  const bus = ctx.createGain();
  bus.gain.value = bed.pulse ? 0.82 : 1;
  bus.connect(out);
  if (bed.pulse) {
    const lfo = ctx.createOscillator();
    const depth = ctx.createGain();
    lfo.type = 'sine';
    lfo.frequency.value = bed.pulse;
    depth.gain.value = 0.28;
    lfo.connect(depth);
    depth.connect(bus.gain);
    lfo.start(now);
    lfo.stop(now + durationSec + 1.5);
  }

  bed.freqs.forEach((freq) => tone(ctx, bus, bed.type, freq, now, durationSec, bed.peak, 1.4, 1.5));
}
