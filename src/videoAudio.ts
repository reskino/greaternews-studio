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
  gain.gain.setValueAtTime(0.0001, startAt);
  gain.gain.exponentialRampToValueAtTime(Math.max(0.0002, peak), startAt + attack);
  gain.gain.exponentialRampToValueAtTime(0.0001, startAt + dur);
  osc.start(startAt);
  osc.stop(startAt + dur + release);
}

// Schedule the chosen bed into `out` for durationSec, from ctx's current time.
export function scheduleBed(ctx: AudioContext, out: AudioNode, sound: VideoSound, durationSec: number) {
  const now = ctx.currentTime + 0.05;

  if (sound === 'newsroom') {
    // Low minor drone + a soft, steady pulse for gentle urgency.
    [110, 164.81, 220].forEach((freq) => tone(ctx, out, 'triangle', freq, now, durationSec, 0.12, 1.2, 1.5));
    for (let t = 0; t < durationSec - 0.5; t += 0.75) {
      tone(ctx, out, 'sine', 293.66, now + t, 0.22, 0.09, 0.01, 0.15);
    }
  } else if (sound === 'uplift') {
    // Major pad + a bright arpeggio.
    [130.81, 196].forEach((freq) => tone(ctx, out, 'triangle', freq, now, durationSec, 0.1, 1.0, 1.5));
    const arp = [261.63, 329.63, 392, 523.25];
    let i = 0;
    for (let t = 0; t < durationSec - 0.4; t += 0.4) {
      tone(ctx, out, 'triangle', arp[i % arp.length], now + t, 0.34, 0.08, 0.01, 0.1);
      i += 1;
    }
  } else if (sound === 'calm') {
    // Slow, sustained ambient pad.
    [110, 130.81, 164.81, 196].forEach((freq) => tone(ctx, out, 'sine', freq, now, durationSec, 0.1, 2.5, 2.5));
  }
}
