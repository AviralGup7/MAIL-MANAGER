/**
 * Cyberpunk audio synthesizer.
 *
 * Original oscillator envelopes only: no samples or proprietary assets. The
 * controller decides WHICH semantic cue to request; this module owns context
 * lifetime, intensity, throttling, envelopes and voice cleanup.
 */

let ctx = null;
let master = null;
let lastCueAt = 0;

function rootData() {
  return typeof document === 'undefined' ? {} : document.documentElement.dataset;
}

export function cyberpunkAudioActive() {
  const d = rootData();
  return d.theme === 'cyberpunk' && d.sounds !== 'off';
}

function level() {
  const intensity = rootData().cpIntensity || 'balanced';
  if (intensity === 'calm') return 0.022;
  if (intensity === 'maximum') return 0.065;
  return 0.042;
}

/** Create only inside a trusted pointer/click gesture. */
function audio(allowCreate) {
  if (!cyberpunkAudioActive()) return null;
  if (ctx === null) {
    if (!allowCreate || typeof AudioContext === 'undefined') return null;
    ctx = new AudioContext();
    master = ctx.createGain();
    master.gain.value = level();
    master.connect(ctx.destination);
  }
  master.gain.value = level();
  if (ctx.state === 'suspended' && allowCreate) void ctx.resume();
  return { ctx, out: master };
}

function tone(spec, allowCreate) {
  const a = audio(allowCreate);
  if (!a) return;
  const start = a.ctx.currentTime + (spec.delay || 0) / 1000;
  const seconds = spec.ms / 1000;
  const osc = a.ctx.createOscillator();
  const amp = a.ctx.createGain();
  const filter = a.ctx.createBiquadFilter();
  filter.type = spec.filterType || 'lowpass';
  filter.frequency.value = spec.cutoff || 2200;
  osc.type = spec.type || 'sine';
  osc.frequency.setValueAtTime(Math.max(1, spec.from), start);
  osc.frequency.exponentialRampToValueAtTime(Math.max(1, spec.to), start + seconds);
  amp.gain.setValueAtTime(0.0001, start);
  amp.gain.linearRampToValueAtTime(spec.peak ?? 0.7, start + Math.min(0.006, seconds / 3));
  amp.gain.exponentialRampToValueAtTime(0.0001, start + seconds);
  osc.connect(filter).connect(amp).connect(a.out);
  osc.start(start);
  osc.stop(start + seconds + 0.02);
}

const CUES = {
  navigate: [
    { from: 2200, to: 1740, ms: 24, type: 'sine', peak: 0.28 },
  ],
  activate: [
    { from: 980, to: 1380, ms: 48, type: 'square', peak: 0.52 },
  ],
  success: [
    { from: 520, to: 720, ms: 55, type: 'sine', peak: 0.42 },
    { from: 760, to: 1080, ms: 72, delay: 48, type: 'sine', peak: 0.5 },
  ],
  warning: [
    { from: 880, to: 620, ms: 85, type: 'triangle', peak: 0.48, cutoff: 1700 },
  ],
  error: [
    { from: 210, to: 145, ms: 115, type: 'sawtooth', peak: 0.42, cutoff: 900 },
    { from: 155, to: 120, ms: 90, delay: 75, type: 'square', peak: 0.22, cutoff: 700 },
  ],
  arrival: [
    { from: 440, to: 660, ms: 60, type: 'sawtooth', peak: 0.45 },
    { from: 660, to: 880, ms: 60, delay: 70, type: 'sawtooth', peak: 0.45 },
    { from: 880, to: 1320, ms: 90, delay: 140, type: 'sawtooth', peak: 0.55 },
  ],
};

/**
 * @param {'navigate'|'activate'|'success'|'warning'|'error'|'arrival'} cue
 * @param {{gesture?:boolean, minGap?:number}} opts
 */
export function playCyberpunkCue(cue, { gesture = false, minGap = 35 } = {}) {
  if (!CUES[cue] || !cyberpunkAudioActive()) return false;
  if (cue === 'navigate' && rootData().cpIntensity === 'calm') return false;
  const now = Date.now();
  if (now - lastCueAt < minGap) return false;
  // Feedback events may occur without a user gesture. They can reuse a context
  // created by an earlier click, but must never create one and trigger autoplay
  // warnings by themselves.
  if (!gesture && ctx === null) return false;
  lastCueAt = now;
  for (const spec of CUES[cue]) tone(spec, gesture);
  return true;
}

export async function disposeCyberpunkAudio() {
  const old = ctx;
  ctx = null;
  master = null;
  lastCueAt = 0;
  if (old && old.state !== 'closed') {
    try { await old.close(); } catch { /* teardown is best-effort */ }
  }
}

export function _audioState() {
  return { created: ctx !== null, active: cyberpunkAudioActive(), intensity: rootData().cpIntensity || 'balanced' };
}
