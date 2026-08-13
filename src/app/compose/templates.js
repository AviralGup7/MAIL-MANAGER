import { STORAGE } from '../../platform/storage.js';

/**
 * Message templates.  (Feature 16, absorbing feature 18's reply presets.)
 *
 * WHY THIS SCORED HIGHEST ON VALUE PER LINE
 * -----------------------------------------
 * A BITS student writes the same four or five mails all semester: a leave
 * request, a deadline-extension request, a mess rebate, a recommendation-letter
 * follow-up, a "please find attached" submission. Each is retyped from scratch
 * every time, each takes several minutes because the phrasing has to be right
 * for a professor or a warden, and none of them changes except for two or three
 * facts.
 *
 * There is no clever technology here. That is the point: the elimination pass
 * kept it because the ratio of time saved to code written is the best in the
 * document.
 *
 * PLACEHOLDERS ARE DELIBERATELY DUMB
 *
 * `{{name}}`, not an expression language. A template system that can compute
 * becomes a template system that can fail, and the failure lands in a mail to
 * a Dean. Unknown placeholders are LEFT AS THEY ARE rather than blanked, so a
 * typo shows up as `{{nmae}}` in the compose window -- visible, and fixable
 * before sending -- instead of a silent hole in a sentence.
 *
 * THE STARTER SET SHIPS WITH THE PRODUCT
 *
 * An empty template list teaches nothing and gets ignored, the same reasoning
 * that gave the smart views their defaults. The five below are written in the
 * register that actually works with BITS faculty and admin: brief, specific,
 * no padding.
 */

const KEY = 'templates';

/**
 * Placeholders the app can fill without asking.
 *
 * Anything not in here is filled from the message being replied to, or left
 * visible for the user to complete.
 */
export const AUTO_FIELDS = ['name', 'date', 'today', 'subject', 'sender', 'course'];

/**
 * @typedef {Object} Template
 * @property {string} id
 * @property {string} name       shown in the picker
 * @property {string} [subject]  optional; blank leaves the existing subject
 * @property {string} body
 * @property {boolean} [builtin]
 * @property {string} [shortcut] optional palette hint
 */

/** The shipped set. */
export const BUILTIN_TEMPLATES = [
  {
    id: 'tpl-leave',
    name: 'Leave request',
    subject: 'Leave request — {{date}}',
    body:
      'Respected Sir/Ma\'am,\n\n' +
      'I am writing to request leave on {{date}} due to {{reason}}.\n\n' +
      'I will ensure that I cover the material missed and submit any pending work on time.\n\n' +
      'Thank you for considering my request.\n\n' +
      'Regards,\n{{name}}',
    builtin: true,
  },
  {
    id: 'tpl-extension',
    name: 'Deadline extension',
    subject: 'Request for extension — {{course}}',
    body:
      'Respected Sir/Ma\'am,\n\n' +
      'I am writing regarding the {{course}} submission due on {{date}}. ' +
      'Because of {{reason}}, I would like to request a short extension.\n\n' +
      'I have completed most of the work and would be able to submit by {{newDate}}.\n\n' +
      'I understand if this is not possible.\n\n' +
      'Regards,\n{{name}}',
    builtin: true,
  },
  {
    id: 'tpl-ack',
    name: 'Acknowledge',
    // Feature 18 lived here. A one-click acknowledgement is a template with a
    // short body, not a separate chip system on the reader.
    body: 'Noted with thanks.\n\nRegards,\n{{name}}',
    builtin: true,
  },
  {
    id: 'tpl-willdo',
    name: 'Will do by a date',
    body: 'Noted. I will complete this by {{date}}.\n\nRegards,\n{{name}}',
    builtin: true,
  },
  {
    id: 'tpl-cannot-attend',
    name: 'Cannot attend',
    body:
      'Thank you for the invitation. Unfortunately I have a clash at that time and will not be able to attend.\n\n' +
      'Regards,\n{{name}}',
    builtin: true,
  },
  {
    id: 'tpl-submission',
    name: 'Submission with attachment',
    subject: '{{course}} — submission',
    body:
      'Respected Sir/Ma\'am,\n\n' +
      'Please find attached my submission for {{course}}.\n\n' +
      'Regards,\n{{name}}',
    builtin: true,
  },
];

function makeId() {
  return `tpl-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

/** Coerce storage into a usable list. Never throws. */
export function normaliseTemplates(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const t of raw) {
    if (!t || typeof t !== 'object') continue;
    if (typeof t.body !== 'string' || !t.body.trim()) continue;
    out.push({
      id: typeof t.id === 'string' && t.id ? t.id : makeId(),
      name: typeof t.name === 'string' && t.name.trim() ? t.name.trim() : 'Untitled',
      ...(typeof t.subject === 'string' ? { subject: t.subject } : {}),
      body: t.body,
      builtin: t.builtin === true,
    });
  }
  return out;
}

export async function loadTemplates(storage = STORAGE) {
  let custom = [];
  let hidden = [];
  try {
    const got = (await storage.get(KEY)) || {};
    const blob = got[KEY];
    if (blob && Array.isArray(blob.items)) custom = normaliseTemplates(blob.items);
    if (blob && Array.isArray(blob.hidden)) hidden = blob.hidden.filter((x) => typeof x === 'string');
  } catch {
    /* a corrupt blob degrades to the defaults, not to an error */
  }
  return [...BUILTIN_TEMPLATES.filter((t) => !hidden.includes(t.id)), ...custom];
}

export async function saveTemplate(tpl, storage = STORAGE) {
  try {
    const got = (await storage.get(KEY)) || {};
    const blob = got[KEY] || {};
    const items = normaliseTemplates(blob.items || []);
    const built = normaliseTemplates([{ ...tpl, id: tpl.id || makeId(), builtin: false }])[0];
    if (!built) return null;
    const at = items.findIndex((t) => t.id === built.id);
    if (at >= 0) items[at] = built;
    else items.push(built);
    await storage.set({ [KEY]: { ...blob, items } });
    return built;
  } catch {
    return null;
  }
}

/**
 * Remove a template.
 *
 * A BUILT-IN IS HIDDEN, NOT DELETED. Same pattern the saved views already use:
 * the shipped set is code, so "deleting" one has to be recorded as a hide or
 * it returns on the next load and the user thinks the app is broken.
 */
export async function removeTemplate(id, storage = STORAGE) {
  try {
    const got = (await storage.get(KEY)) || {};
    const blob = got[KEY] || {};
    const isBuiltin = BUILTIN_TEMPLATES.some((t) => t.id === id);
    if (isBuiltin) {
      const hidden = new Set(blob.hidden || []);
      hidden.add(id);
      await storage.set({ [KEY]: { ...blob, hidden: [...hidden] } });
    } else {
      const items = normaliseTemplates(blob.items || []).filter((t) => t.id !== id);
      await storage.set({ [KEY]: { ...blob, items } });
    }
    return true;
  } catch {
    return false;
  }
}

/** Which placeholders does this template use, in order of first appearance? */
export function placeholdersIn(text) {
  const out = [];
  const seen = new Set();
  for (const m of String(text || '').matchAll(/\{\{\s*([a-zA-Z][a-zA-Z0-9_]*)\s*\}\}/g)) {
    const key = m[1];
    if (!seen.has(key)) {
      seen.add(key);
      out.push(key);
    }
  }
  return out;
}

/**
 * Substitute known values.
 *
 * UNKNOWN PLACEHOLDERS SURVIVE. Blanking them produces "I am writing to request
 * leave on  due to ." -- a sentence that reads as a bug and that a hurried user
 * will send anyway. Leaving `{{reason}}` visible in the compose body makes the
 * gap impossible to miss.
 */
export function fill(text, values = {}) {
  return String(text || '').replace(
    /\{\{\s*([a-zA-Z][a-zA-Z0-9_]*)\s*\}\}/g,
    (whole, key) => {
      const v = values[key];
      return v === undefined || v === null || v === '' ? whole : String(v);
    }
  );
}

/** Are any placeholders still unfilled? Used to warn before sending. */
export function unfilled(text) {
  return placeholdersIn(text);
}

/**
 * Apply a template to a draft.
 *
 * The subject is only replaced when the template HAS one and the draft does
 * not already carry a reply subject -- overwriting "Re: Fee payment" with a
 * template's generic subject silently breaks the thread the user was in.
 *
 * @param {Template} tpl
 * @param {object} draft   the current compose draft
 * @param {object} values  auto-fill values
 */
export function applyTemplate(tpl, draft = {}, values = {}) {
  const body = fill(tpl.body, values);
  const isReply = /^\s*(re|fwd|fw)\s*:/i.test(draft.subject || '');
  const subject =
    tpl.subject && !isReply ? fill(tpl.subject, values) : draft.subject || '';

  return {
    ...draft,
    subject,
    /*
     * The template goes ABOVE anything already typed rather than replacing it.
     * Destroying a half-written message because someone browsed the template
     * list is the kind of loss that makes a feature unusable.
     */
    body: draft.body ? `${body}\n\n${draft.body}` : body,
    _unfilled: unfilled(body),
  };
}

/** Values the app can supply without asking. */
export function autoValues({ profileName, message, now = Date.now() } = {}) {
  const d = new Date(now);
  const date = d.toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' });
  return {
    ...(profileName ? { name: profileName } : {}),
    today: date,
    ...(message?.subject ? { subject: message.subject } : {}),
    ...(message?.from ? { sender: message.from } : {}),
    ...(message?.course ? { course: message.course } : {}),
  };
}
