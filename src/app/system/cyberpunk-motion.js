/** Cyberpunk finite visual signals. No idle loops and no content distortion. */

let activeClass = '';
let timer = 0;
let generation = 0;
let animationRoot = null;
let animationHandler = null;

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
  if (animationRoot && animationHandler) {
    animationRoot.removeEventListener('animationend', animationHandler);
  }
  animationRoot = null;
  animationHandler = null;
  if (activeClass) root.classList.remove(activeClass);
  activeClass = '';
}

function arm(root, className, duration) {
  clear(root);
  const mine = ++generation;
  activeClass = className;
  root.classList.add(activeClass);
  const done = (event) => {
    if (event && event.target !== root) return;
    if (mine !== generation) return;
    clear(root);
  };
  animationRoot = root;
  animationHandler = done;
  root.addEventListener('animationend', done);
  timer = setTimeout(done, duration);
}

export function cyberpunkSignal(kind, duration = 420) {
  if (!allowed()) return false;
  arm(document.documentElement, `cp-signal-${kind}`, duration);
  return true;
}

export function cyberpunkArrival() {
  if (typeof document === 'undefined') return false;
  arm(document.documentElement, 'cp-enter', 500);
  return true;
}

export function disposeCyberpunkMotion() {
  generation++;
  if (typeof document !== 'undefined') clear(document.documentElement);
}
