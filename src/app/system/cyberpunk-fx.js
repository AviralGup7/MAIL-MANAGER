/**
 * CYBERPUNK FX — the theme's voice and its arrival blink.
 *
 * The brief for the Cyberpunk theme was that it should control more than
 * colour: buttons, animation, textures AND SOUND. This module is the sound.
 * Everything is SYNTHESIZED in code — oscillator chirps shaped by envelopes —
 * an original composition in the spirit of neon-terminal UI audio. No
 * sampled or downloaded game audio ships in this repo, and no asset files
 * ship at all: the whole kit is arithmetic.
 *
 * THE GATE. Silence unless documentElement.dataset.theme === 'cyberpunk',
 * checked AT PLAY TIME (not at init), so switching themes mid-session
 * silences the next interaction and re-arming is instant. There is no
 * separate setting: the theme IS the switch, which is exactly the isolation
 * the brief asked for — leave the theme and it is as if this module never
 * existed. The skin side (classes, textures) lives in 88-cyberpunk.css.
 *
 * LAZY CONTEXT. An AudioContext created before a user gesture starts
 * 'suspended' and warns in the console — and boot/console-clean is a smoke
 * gate — so the context is born inside the first qualifying pointer event.
 * The integration harness has no AudioContext at all; every entry point
 * tolerates that and quietly does nothing, because in tests there is also
 * no cyberpunk theme.
 *
 * MASTER GAIN sits at 0.05: these are UI textures felt more than heard, not
 * notifications. If a user ever asks for quieter, turn the one number.
 */

let _ctx = null;
let _master = null;
let _lastHover = 0;

/** Double duty: play-time gate. Everything asks this first.
 *
 * Two conditions, one attribute each:
 *   data-theme === 'cyberpunk'  — the theme grants the voice;
 *   data-sounds !== 'off'       — SETTINGS OUTRANK IT. The root attribute is
 * the published truth (applyVisualPrefs stamps it at boot and on every
 * write), so this module never imports the settings store and never caches
 * a value that could go stale. Flip the setting and the very next click is
 * silent, theme unchanged.
 */
function active() {
  if (typeof document === 'undefined') return false;
  const d = document.documentElement.dataset;
  return d.theme === 'cyberpunk' && d.sounds !== 'off';
}

/** The context, created inside a gesture or not at all. Null when absent. */
function audio() {
  if (!active()) return null;
  if (_ctx === null) {
    if (typeof AudioContext === 'undefined') return null; // jsdom, old shells
    _ctx = new AudioContext();
    _master = _ctx.createGain();
    _master.gain.value = 0.05;
    _master.connect(_ctx.destination);
  }
  // A context parked by the autoplay policy wakes inside a real gesture —
  // every call here rides one (click / pointerover), so resume is legal now.
  if (_ctx.state === 'suspended') _ctx.resume();
  return { ctx: _ctx, out: _master };
}

/**
 * One shaped chirp. `from -> to` is the pitch glide in Hz over `ms`, through
 * a lowpass so the square/saw edges read as "terminal" rather than "alarm".
 * The envelope is a 4ms attack and an exponential decay to avoid clicks.
 */
function chirp({ from, to, ms, type, peak = 1 }) {
  const a = audio();
  if (!a) return;
  const t = a.ctx.currentTime;
  const osc = a.ctx.createOscillator();
  const amp = a.ctx.createGain();
  const lp = a.ctx.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.value = 2200;
  osc.type = type;
  osc.frequency.setValueAtTime(from, t);
  osc.frequency.exponentialRampToValueAtTime(to, t + ms / 1000);
  amp.gain.setValueAtTime(0, t);
  amp.gain.linearRampToValueAtTime(peak, t + 0.004);
  amp.gain.exponentialRampToValueAtTime(0.0001, t + ms / 1000);
  osc.connect(lp).connect(amp).connect(a.out);
  osc.start(t);
  osc.stop(t + ms / 1000 + 0.02);
}

/** Controls worth a voice. Rows are excluded on purpose: pointer wandering
    a long list would read as static, and the game's own lists are quiet. */
const VOICED = 'button, [role="button"], [role="menuitem"], [role="option"], [role="tab"], a, input, select, label';

function onClick(e) {
  if (!(e.target instanceof Element) || !e.target.closest(VOICED)) return;
  chirp({ from: 1180, to: 1560, ms: 45, type: 'square' });
}

function onHover(e) {
  if (!(e.target instanceof Element) || !e.target.closest(VOICED)) return;
  const now = Date.now();
  if (now - _lastHover < 90) return; // pointer sweep is one tick, not twenty
  _lastHover = now;
  chirp({ from: 2350, to: 1800, ms: 25, type: 'sine', peak: 0.5 });
}

/**
 * Wire the delegation. Called once at boot; every sound still gates on the
 * theme at play time, so this costs two listeners and nothing else until —
 * and unless — Cyberpunk is chosen.
 */
export function initCyberpunkFx(root = document) {
  root.addEventListener('click', onClick, true);
  root.addEventListener('pointerover', onHover, true);
}

/**
 * THE ARRIVAL. Called by setTheme when the theme lands on cyberpunk: a CRT
 * blink on the shell (the .cp-enter class; 88-cyberpunk.css owns the look)
 * plus a three-note rising sting. Both are bounded: the class comes off on
 * animationend or a timeout — jsdom never fires animationend, and a stale
 * class is inert anyway because the CSS rule also gates on data-theme.
 */
export function cyberpunkEnterFx() {
  if (typeof document !== 'undefined') {
    const root = document.documentElement;
    root.classList.add('cp-enter');
    const drop = () => root.classList.remove('cp-enter');
    root.addEventListener('animationend', drop, { once: true });
    setTimeout(drop, 500);
  }
  chirp({ from: 440, to: 660, ms: 60, type: 'sawtooth', peak: 0.8 });
  setTimeout(() => chirp({ from: 660, to: 880, ms: 60, type: 'sawtooth', peak: 0.8 }), 70);
  setTimeout(() => chirp({ from: 880, to: 1320, ms: 90, type: 'sawtooth' }), 140);
}
