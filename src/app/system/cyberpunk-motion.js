/** Cyberpunk finite visual signals. No idle loops and no content distortion. */

let activeClass = '';
let timer = 0;

function allowed() {
  if (typeof document === 'undefined') return false;
  const d = document.documentElement.dataset;
  if (d.theme !== 'cyberpunk') return false;
  if (d.cpIntensity === 'calm') return false;
  return !globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
}

function clear(root = document.documentElement) {
  clearTimeout(timer);
  timer = 0;
  if (activeClass) root.classList.remove(activeClass);
  activeClass = '';
}

export function cyberpunkSignal(kind, duration = 420) {
  if (!allowed()) return false;
  const root = document.documentElement;
  clear(root);
  activeClass = `cp-signal-${kind}`;
  root.classList.add(activeClass);
  const done = () => clear(root);
  root.addEventListener('animationend', done, { once: true });
  timer = setTimeout(done, duration);
  return true;
}

export function cyberpunkArrival() {
  if (typeof document === 'undefined') return false;
  const root = document.documentElement;
  clear(root);
  activeClass = 'cp-enter';
  root.classList.add(activeClass);
  const done = () => clear(root);
  root.addEventListener('animationend', done, { once: true });
  timer = setTimeout(done, 500);
  return true;
}

export function disposeCyberpunkMotion() {
  if (typeof document !== 'undefined') clear(document.documentElement);
}
