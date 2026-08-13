/**
 * Activity log viewer.
 *
 * The activity log has been written since the audit era but never READ by the
 * user (40-ENG §7): the palette surfaces it, the options page does not, the
 * doctor does not consult it. This is the minimal honest surface — a layer
 * listing the last N entries with their outcome, so "what did the app do to
 * my mail" has an answer inside the product.
 */

import { openLayer } from '../overlays/layers.js';
import { loadLog, describe } from './activity.js';

const SHOWN = 50;

export async function openActivityLog(ctx) {
  const doc = globalThis.document;
  if (!doc) return;
  const back = doc.createElement('div');
  back.className = 'activity-backdrop';

  const box = doc.createElement('div');
  box.className = 'activity-box';
  box.setAttribute('role', 'dialog');
  box.setAttribute('aria-modal', 'true');
  box.setAttribute('aria-labelledby', 'activity-title');

  const h = doc.createElement('h3');
  h.id = 'activity-title';
  h.textContent = 'Activity log';
  box.appendChild(h);

  const list = doc.createElement('ul');
  list.className = 'activity-list';
  box.appendChild(list);

  const foot = doc.createElement('p');
  foot.className = 'activity-foot';
  box.appendChild(foot);

  const closeBtn = doc.createElement('button');
  closeBtn.type = 'button';
  closeBtn.textContent = 'Close';
  closeBtn.className = 'primary';
  box.appendChild(closeBtn);

  back.appendChild(box);
  doc.body.appendChild(back);

  const layer = openLayer({
    name: 'activity',
    node: back,
    restoreFocusTo: doc.activeElement,
    dismissOnOutsideClick: true,
    onClose: () => back.remove(),
  });

  closeBtn.addEventListener('click', () => layer?.close?.());

  try {
    const entries = await loadLog();
    if (!entries.length) {
      const li = doc.createElement('li');
      li.className = 'activity-empty';
      li.textContent = 'Nothing recorded yet. Actions you take will appear here.';
      list.appendChild(li);
    } else {
      for (const e of entries.slice(0, SHOWN)) {
        const li = doc.createElement('li');
        li.className = `activity-row outcome-${e.outcome || 'ok'}`;
        const when = new Date(e.at).toLocaleString(undefined, {
          month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
        });
        li.textContent = `${when} — ${describe(e)}`;
        list.appendChild(li);
      }
      foot.textContent =
        entries.length > SHOWN
          ? `Showing the ${SHOWN} most recent of ${entries.length}.`
          : '';
    }
  } catch {
    const li = doc.createElement('li');
    li.className = 'activity-empty';
    li.textContent = 'Could not read the activity log.';
    list.appendChild(li);
  }
}
