/**
 * Cyberpunk audio synthesizer.
 *
 * Original oscillator envelopes only: no samples or proprietary assets. The
 * controller decides WHICH semantic cue to request; this module owns context
 * lifetime, intensity, throttling, envelopes and voice cleanup.
 */

let ctx = null;
let master = null;
let limiter = null;
let lastCueAt = 0;
const voices = new Set();
const MAX_VOICES = 12;

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
    /** @type {any} */ const browser = globalThis;
    const AudioCtor = browser.AudioContext || browser.webkitAudioContext;
    if (!allowCreate || typeof AudioCtor !== 'function') return null;
    ctx = new AudioCtor();
    master = ctx.createGain();
    limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = -10;
    limiter.knee.value = 8;
    limiter.ratio.value = 6;
    limiter.attack.value = 0.003;
    limiter.release.value = 0.12;
    master.gain.value = level();
    master.connect(limiter).connect(ctx.destination);
  }
  const now = ctx.currentTime;
  master.gain.cancelScheduledValues(now);
  master.gain.setTargetAtTime(level(), now, 0.015);
  if (ctx.state === 'suspended' && allowCreate) void ctx.resume();
  return { ctx, out: master };
}

function noiseLayer(a, spec, start, seconds) {
  if (!spec.noise || voices.size >= MAX_VOICES) return;
  const frames = Math.max(1, Math.floor(a.ctx.sampleRate * seconds));
  const buffer = a.ctx.createBuffer(1, frames, a.ctx.sampleRate);
  const data = buffer.getChannelData(0);
  // Short generated electrical texture: no sample asset and no persistent
  // random loop. Its own bandpass/envelope makes it a tactile transient rather
  // than broadband hiss.
  for (let i = 0; i < frames; i++) data[i] = Math.random() * 2 - 1;
  const source = a.ctx.createBufferSource();
  const filter = a.ctx.createBiquadFilter();
  const amp = a.ctx.createGain();
  source.buffer = buffer;
  filter.type = 'bandpass';
  filter.frequency.value = spec.noiseCenter || 1400;
  filter.Q.value = 1.4;
  amp.gain.setValueAtTime(0.0001, start);
  amp.gain.linearRampToValueAtTime(spec.noise, start + Math.min(0.003, seconds / 3));
  amp.gain.exponentialRampToValueAtTime(0.0001, start + seconds);
  source.connect(filter).connect(amp).connect(a.out);
  voices.add(source);
  source.onended = () => {
    voices.delete(source);
    try { source.disconnect(); filter.disconnect(); amp.disconnect(); } catch { /* already detached */ }
  };
  source.start(start);
  source.stop(start + seconds);
}

function tone(spec, allowCreate) {
  const a = audio(allowCreate);
  if (!a) return;
  const needed = spec.noise ? 2 : 1;
  if (voices.size + needed > MAX_VOICES) return;
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
  noiseLayer(a, spec, start, seconds);
  voices.add(osc);
  osc.onended = () => {
    voices.delete(osc);
    try { osc.disconnect(); filter.disconnect(); amp.disconnect(); } catch { /* already detached */ }
  };
  osc.start(start);
  osc.stop(start + seconds + 0.02);
}

const CUES = {
  navigate: [
    { from: 2200, to: 1740, ms: 24, type: 'sine', peak: 0.22, noise: 0.035, noiseCenter: 2300 },
  ],
  activate: [
    { from: 980, to: 1380, ms: 48, type: 'square', peak: 0.42, noise: 0.055, noiseCenter: 1700 },
  ],
  open: [
    { from: 610, to: 1040, ms: 72, type: 'triangle', peak: 0.38, noise: 0.05, noiseCenter: 1200 },
  ],
  close: [
    { from: 980, to: 410, ms: 78, type: 'triangle', peak: 0.34, noise: 0.045, noiseCenter: 900 },
  ],
  valueUp: [
    { from: 820, to: 1120, ms: 34, type: 'square', peak: 0.3 },
  ],
  valueDown: [
    { from: 1120, to: 790, ms: 34, type: 'square', peak: 0.28 },
  ],
  data: [
    { from: 1450, to: 2380, ms: 58, type: 'sine', peak: 0.3, noise: 0.04, noiseCenter: 2600 },
  ],
  success: [
    { from: 520, to: 720, ms: 55, type: 'sine', peak: 0.42 },
    { from: 760, to: 1080, ms: 72, delay: 48, type: 'sine', peak: 0.5 },
  ],
  warning: [
    { from: 880, to: 620, ms: 85, type: 'triangle', peak: 0.48, cutoff: 1700 },
  ],
  error: [
    { from: 210, to: 145, ms: 115, type: 'sawtooth', peak: 0.42, cutoff: 900, noise: 0.08, noiseCenter: 520 },
    { from: 155, to: 120, ms: 90, delay: 75, type: 'square', peak: 0.22, cutoff: 700 },
  ],
  arrival: [
    { from: 440, to: 660, ms: 60, type: 'sawtooth', peak: 0.45 },
    { from: 660, to: 880, ms: 60, delay: 70, type: 'sawtooth', peak: 0.45 },
    { from: 880, to: 1320, ms: 90, delay: 140, type: 'sawtooth', peak: 0.55 },
  ],
};

function profileAllows(cue) {
  const profile = rootData().cpAudio || 'semantic';
  if (profile === 'minimal') return cue === 'warning' || cue === 'error';
  if (profile === 'semantic') return cue !== 'navigate';
  return true;
}

/**
 * @param {'navigate'|'activate'|'open'|'close'|'valueUp'|'valueDown'|'data'|'success'|'warning'|'error'|'arrival'} cue
 * @param {{gesture?:boolean, minGap?:number}} opts
 */
export function playCyberpunkCue(cue, { gesture = false, minGap = 35 } = {}) {
  if (!CUES[cue] || !cyberpunkAudioActive() || !profileAllows(cue)) return false;
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
  limiter = null;
  lastCueAt = 0;
  for (const voice of voices) {
    try { voice.stop(); voice.disconnect(); } catch { /* already ended */ }
  }
  voices.clear();
  if (old && old.state !== 'closed') {
    try { await old.close(); } catch { /* teardown is best-effort */ }
  }
}

export function _audioState() {
  return {
    created: ctx !== null,
    active: cyberpunkAudioActive(),
    intensity: rootData().cpIntensity || 'balanced',
    profile: rootData().cpAudio || 'semantic',
    voices: voices.size,
  };
}
