/**
 * RESPONSIBILITY: guarded DOM write primitives shared by the shell, the list
 * and the toast.
 *
 * OWNS: nothing but two pure helpers.
 * DOES NOT OWN: any element, any state.
 * DEPENDS ON: nothing.
 *
 * WHY THIS EXISTS: toast.js was extracted from main.js (round 46 modular
 * strategy), and both it and the list write text/attributes through the
 * same guarded helpers. Two copies of "only write when changed" would drift;
 * the guard is what keeps an unchanged row/toast at zero DOM writes.
 */

/** Write an attribute only when it changed. */
export function setAttr(node, name, value) {
  if (!node?.getAttribute) return;
  if (!node) return;
  const v = value || '';
  if (node.getAttribute(name) !== v) node.setAttribute(name, v);
}

/** Write text only when it changed. */
export function setText(node, value) {
  if (!node) return;
  const v = value || '';
  if (node.textContent !== v) node.textContent = v;
}
