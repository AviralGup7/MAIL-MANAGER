/**
 * In-app prompt dialog — replaces the browser-native `prompt()`.
 *
 * WHY (audit 39 P1 / audit(4) P2-02): a native prompt cannot show the query
 * being saved, cannot validate while typing, is invisible to the app's
 * styling, and is hostile to keyboard and screen-reader users. This uses the
 * layer primitive so Escape/outside-click/focus-return come from the one
 * lifecycle the app already trusts.
 *
 * Contract: resolves with the submitted value, or `null` when cancelled.
 * `submit` may be async and return `{ ok:false, error }` — the dialog stays
 * open and shows the error (e.g. a duplicate view name) instead of dumping
 * the user back to a toast.
 */

import { openLayer } from './layers.js';

export function promptDialog({ title, label, value = '', hint, submit }) {
  return new Promise((resolve) => {
    const doc = globalThis.document;
    if (!doc) { resolve(null); return; }

    const back = doc.createElement('div');
    back.className = 'prompt-backdrop';
    const box = doc.createElement('div');
    box.className = 'prompt-box';
    box.setAttribute('role', 'dialog');
    box.setAttribute('aria-modal', 'true');
    box.setAttribute('aria-labelledby', 'prompt-title');

    const h = doc.createElement('h3');
    h.id = 'prompt-title';
    h.textContent = title;
    box.appendChild(h);

    const labelEl = doc.createElement('label');
    labelEl.textContent = label || '';
    const input = doc.createElement('input');
    input.type = 'text';
    input.value = value;
    input.maxLength = 40;
    labelEl.appendChild(input);
    box.appendChild(labelEl);

    if (hint) {
      const hintEl = doc.createElement('p');
      hintEl.className = 'prompt-hint';
      hintEl.textContent = hint;
      box.appendChild(hintEl);
    }

    const err = doc.createElement('p');
    err.className = 'prompt-err';
    err.setAttribute('role', 'alert');
    box.appendChild(err);

    const row = doc.createElement('div');
    row.className = 'prompt-actions';
    const saveBtn = doc.createElement('button');
    saveBtn.type = 'button';
    saveBtn.className = 'primary';
    saveBtn.textContent = 'Save';
    const cancelBtn = doc.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.textContent = 'Cancel';
    row.append(saveBtn, cancelBtn);
    box.appendChild(row);

    back.appendChild(box);
    doc.body.appendChild(back);

    const layer = openLayer({
      name: 'prompt',
      node: back,
      restoreFocusTo: doc.activeElement,
      dismissOnOutsideClick: true,
      onClose: () => {
        back.remove();
        resolve(null);
      },
    });

    let busy = false;
    const finish = (v) => {
      if (busy) return;
      busy = true;
      // RESOLVE FIRST: the layer's onClose also resolves (null, for cancel),
      // and a promise settles with whichever call wins — closing before
      // resolving would silently convert every Save into a cancel.
      resolve(v);
      if (layer?.close) layer.close();
    };

    const runSubmit = async () => {
      if (busy) return;
      const name = input.value.trim();
      if (!name) {
        err.textContent = 'Give it a name.';
        input.focus();
        return;
      }
      saveBtn.disabled = true;
      try {
        const res = submit ? await submit(name) : { ok: true };
        if (res && res.ok === false) {
          err.textContent = res.error || 'Could not save.';
          saveBtn.disabled = false;
          input.focus();
          return;
        }
        finish(name);
      } catch {
        err.textContent = 'Could not save.';
        saveBtn.disabled = false;
      }
    };

    saveBtn.addEventListener('click', runSubmit);
    cancelBtn.addEventListener('click', () => finish(null));
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); runSubmit(); }
      if (e.key === 'Escape') { e.preventDefault(); finish(null); }
    });
    input.focus();
    input.select();
  });
}

/**
 * In-app confirm dialog — replaces the browser-native `confirm()`.
 *
 * Same reasons as promptDialog, plus one more: the native dialog's buttons
 * cannot be named, so a destructive question says only "OK" — the word that
 * trains the click. Here the action button names the ACTION ("Discard",
 * "Send anyway"), the safe button is the default focus, and a destructive
 * question wears the danger style.
 *
 * Contract: resolves true when confirmed, false on cancel/Escape/outside.
 * The ONE focus contract (trap, Esc, focus-return) comes from the layer
 * primitive, exactly like every other surface.
 */
export function confirmDialog({
  title, body, confirmLabel = 'OK', cancelLabel = 'Cancel', danger = false,
}) {
  return new Promise((resolve) => {
    const doc = globalThis.document;
    if (!doc) { resolve(false); return; }

    const back = doc.createElement('div');
    back.className = 'prompt-backdrop';
    const box = doc.createElement('div');
    box.className = 'prompt-box';
    box.setAttribute('role', danger ? 'alertdialog' : 'dialog');
    box.setAttribute('aria-modal', 'true');
    box.setAttribute('aria-labelledby', 'prompt-title');
    if (danger) box.dataset.danger = 'true';

    const h = doc.createElement('h3');
    h.id = 'prompt-title';
    h.textContent = title;
    box.appendChild(h);

    if (body) {
      const p = doc.createElement('p');
      p.className = 'prompt-hint';
      p.textContent = body;
      box.appendChild(p);
    }

    const row = doc.createElement('div');
    row.className = 'prompt-actions';
    const confirmBtn = doc.createElement('button');
    confirmBtn.type = 'button';
    confirmBtn.className = danger ? 'danger' : 'primary';
    confirmBtn.textContent = confirmLabel;
    const cancelBtn = doc.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.textContent = cancelLabel;
    // Safe choice first and focused: the accidental Enter must never be the
    // destructive one.
    row.append(cancelBtn, confirmBtn);
    box.appendChild(row);
    back.appendChild(box);
    doc.body.appendChild(back);

    const finish = (v) => {
      resolve(v);
      if (layer?.close) layer.close();
    };

    const layer = openLayer({
      name: 'confirm',
      node: back,
      restoreFocusTo: doc.activeElement,
      dismissOnOutsideClick: true,
      onClose: () => {
        back.remove();
        resolve(false);
      },
    });

    // Minimal focus trap: two buttons, Tab cycles between them.
    box.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { e.preventDefault(); finish(false); return; }
      if (e.key !== 'Tab') return;
      e.preventDefault();
      (doc.activeElement === cancelBtn ? confirmBtn : cancelBtn).focus();
    });

    confirmBtn.addEventListener('click', () => finish(true));
    cancelBtn.addEventListener('click', () => finish(false));
    cancelBtn.focus();
  });
}
