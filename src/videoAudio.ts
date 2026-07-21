// Procedurally-generated background beds for the story video, built with the Web Audio API —
// royalty-free by construction (no bundled/licensed files) and mixed straight into the export.
// Subtle ambient beds meant to sit under the on-screen text, not to be produced music.
export type VideoSound = 'none' | 'newsroom' | 'uplift' | 'calm';

export const SOUND_LABELS: Record<VideoSound, string> = {
  none: 'None (silent)',
  newsroom: 'Newsroom — steady, understated',
  uplift: 'Uplift — bright, positive',
  calm: 'Calm — soft ambient pad',
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
  const chords: Record<VideoSound, { type: OscillatorType; freqs: number[]; peak: number }> = {
    none: { type: 'sine', freqs: [], peak: 0 },
    // A minor (A, E, A, C, E) — low, steady, understated.
    newsroom: { type: 'triangle', freqs: [110, 164.81, 220, 261.63, 329.63], peak: 0.13 },
    // C major (C, G, C, E, G) — bright, positive.
    uplift: { type: 'triangle', freqs: [130.81, 196, 261.63, 329.63, 392], peak: 0.12 },
    // Soft low sine pad.
    calm: { type: 'sine', freqs: [110, 130.81, 164.81, 196, 261.63], peak: 0.12 },
  };
  const bed = chords[sound];
  bed.freqs.forEach((freq) => tone(ctx, out, bed.type, freq, now, durationSec, bed.peak, 1.4, 1.5));
}
