/**
 * Timetable builder UI.
 *
 * FEATURES layer: builds DOM, opens a layer, and calls into the pure model
 * (timetable.js) and the platform store (timetable-store.js). It holds no
 * scheduling rules of its own — every decision about what may change and what
 * must be asked lives in the model, so the UI cannot accidentally invent a
 * policy the tests do not cover.
 *
 * THE SHAPE OF THE INTERACTION
 * ----------------------------
 * The builder is a wizard for the one-time build and a manager afterwards.
 * That is deliberate: the two tasks have opposite defaults. Building wants to
 * move quickly through course → teacher → section. Managing wants to change
 * one thing without touching anything else. One screen doing both would make
 * the common case of "fix this room" feel like starting over.
 */

import { openLayer } from './layers.js';
import { icon } from './icons.js';
import {
  emptyState, addCourse, removeCourse, manualEdit, setLocked,
  switchSection, finalize, resetTimetable,
  restoreFromSource, applyFieldChange, detectConflicts,
  linkedSections, instructorsFor, sectionsByKind,
  weekView, summariseMeetings, explainEntry, fmtTime,
  SOURCE_LABEL, entryId, entriesForMessage, examEvents, validateAgainstSource,
} from './timetable.js';
import {
  loadTimetable, saveTimetable, searchCourses, courseByComCode, loadSourceData,
} from './timetable-store.js';
import { scanMessages, matchNotice } from './timetable-mail.js';

const $ = (id) => document.getElementById(id);

/** Module state. Reset by _resetTimetableUI for tests. */
let state = emptyState();
let source = null;
let layer = null;
let ctxRef = null;
/** Findings awaiting the user's decision. */
let pending = [];

export function _resetTimetableUI() {
  state = emptyState();
  source = null;
  pending = [];
  if (layer) { try { layer.close(); } catch { /* gone */ } }
  layer = null;
  ctxRef = null;
}

/** Read-only access, for the app shell and tests. */
export function getTimetableState() { return state; }

/**
 * What did this message do to the timetable?
 *
 * The reader asks this; the model answers it. Kept here rather than imported
 * straight into app.js so the shell needs to know about one timetable module
 * instead of three, and so `state` stays private to this file.
 *
 * @returns {{entry:object, fields:string[], current:string, previous:string}[]}
 */
export function timetableEffectsOf(messageId) {
  return entriesForMessage(state, messageId);
}

/* ========================================================================== *
 * BOOT
 * ========================================================================== */

/**
 * Load the stored timetable and the source catalogue.
 *
 * Called once at app start. Both loads degrade rather than throw, so a
 * packaging error or a corrupt blob costs the timetable feature and nothing
 * else.
 */
export async function initTimetable(ctx) {
  ctxRef = ctx;
  state = await loadTimetable();
  source = await loadSourceData();

  /*
   * If the loader had to discard corrupt records, SAY SO.
   *
   * Dropping them silently trades one failure (an unopenable panel) for a
   * quieter one (a timetable missing classes the user still believes are
   * there). The count is all we can honestly report -- the records were
   * unreadable, so we cannot name what they were -- but "three could not be
   * read" tells them to check, which is the whole point.
   */
  if (state.dropped) {
    ctx?.toast?.(
      `${state.dropped} timetable ${state.dropped === 1 ? 'entry was' : 'entries were'} ` +
      'unreadable and had to be removed. Please check your classes.',
      { kind: 'error' }
    );
  }

  updateBadge();
  return state;
}

async function persist() {
  const r = await saveTimetable(state);
  if (!r.ok && ctxRef?.toast) {
    ctxRef.toast(`Could not save the timetable: ${r.error}`, { kind: 'error' });
  }
  return r.ok;
}

/** The sidebar button shows how many entries and whether anything needs input. */
function updateBadge() {
  const btn = $('btn-timetable');
  if (!btn) return;
  const n = state.entries.length;
  const needs = state.conflicts.filter((c) => c.severity !== 'info').length + pending.length;
  const label = btn.querySelector('.tt-badge');
  if (!label) return;
  label.textContent = needs ? String(needs) : n ? String(n) : '';
  label.dataset.kind = needs ? 'attention' : 'count';
  btn.title = needs
    ? `Timetable — ${needs} thing${needs === 1 ? '' : 's'} need your attention`
    : n
      ? `Timetable — ${n} class${n === 1 ? '' : 'es'}`
      : 'Build your timetable';
}

/* ========================================================================== *
 * MAIL AND NOTICE INTEGRATION
 * ========================================================================== */

/**
 * Scan mail for timetable-relevant changes.
 *
 * Produces PROPOSALS, never silent mutations. Even an actionable finding from
 * a high-precedence source is queued, because the user asked for a schedule
 * they can trust and a class that moves without being announced is the exact
 * opposite of that. The only thing precedence decides here is whether the
 * proposal CAN be applied at all.
 */
export function scanForUpdates(messages) {
  if (!state.entries.length) return [];
  const found = scanMessages(messages || [], state);
  const notices = source?.changes ? matchNotice(source.changes, state) : [];

  // A notice for an entry we have already reconciled is not news.
  const seen = new Set(state.appliedMail || []);
  const fresh = [...notices, ...found].filter((f) => {
    const key = f.messageId || `notice:${f.noticeRef}:${f.kind}`;
    return !seen.has(key);
  });

  pending = dedupePending([...pending, ...fresh]);
  updateBadge();
  return fresh;
}

function dedupePending(list) {
  const seen = new Set();
  const out = [];
  for (const f of list) {
    const k = `${f.kind}|${f.entryId}|${f.messageId || f.noticeRef || ''}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(f);
  }
  return out;
}

/** Accept a proposal: apply it under precedence, then record it as handled. */
export async function acceptFinding(finding) {
  const entry = state.entries.find((e) => e.id === finding.entryId);
  if (!entry) return { ok: false, reason: 'that class is no longer in your timetable' };

  if (!finding.actionable || !finding.field) {
    // Notification-only: nothing to apply, but the user has seen it.
    return dismissFinding(finding, 'acknowledged');
  }

  const src = finding.noticeRef ? 'notice' : 'mail';
  const r = applyFieldChange(entry, finding.field, finding.value, {
    source: src,
    ref: finding.messageId || finding.noticeRef || '',
    note: finding.evidence || '',
  });

  if (!r.applied) return { ok: false, reason: r.reason, needsPermission: r.needsPermission };

  state = {
    ...state,
    entries: state.entries.map((e) => (e.id === entry.id ? r.entry : e)),
    updatedAt: Date.now(),
  };
  state.conflicts = detectConflicts(state.entries);
  await dismissFinding(finding, 'applied');
  return { ok: true, reason: '' };
}

/** Dismiss a proposal without applying it, remembering the decision. */
export async function dismissFinding(finding, how = 'dismissed') {
  const key = finding.messageId || `notice:${finding.noticeRef}:${finding.kind}`;
  pending = pending.filter((f) => f !== finding);
  state = {
    ...state,
    appliedMail: [...new Set([...(state.appliedMail || []), key])],
    updatedAt: Date.now(),
  };
  await persist();
  updateBadge();
  render();
  return { ok: true, how };
}

/* ========================================================================== *
 * THE PANEL
 * ========================================================================== */

export function openTimetable(ctx) {
  ctxRef = ctx || ctxRef;
  if (layer) return;

  const node = document.createElement('div');
  node.className = 'tt-panel';
  node.setAttribute('role', 'dialog');
  node.setAttribute('aria-modal', 'true');
  node.setAttribute('aria-label', 'Timetable');
  node.id = 'tt-panel';

  document.body.appendChild(node);
  layer = openLayer({
    name: 'timetable',
    node,
    dismissOnOutsideClick: true,
    onClose: () => {
      node.remove();
      layer = null;
    },
  });
  render();
  node.querySelector('input, button')?.focus();
}

export function closeTimetable() {
  if (layer) layer.close();
}

function render() {
  const node = $('tt-panel');
  if (!node) return;
  const scroll = node.querySelector('.tt-body')?.scrollTop || 0;

  node.replaceChildren(
    header(),
    state.entries.length ? manageView() : buildView()
  );
  const body = node.querySelector('.tt-body');
  if (body) body.scrollTop = scroll;
}

function header() {
  const h = document.createElement('div');
  h.className = 'tt-head';

  const title = document.createElement('h2');
  title.textContent = 'Timetable';
  const sub = document.createElement('span');
  sub.className = 'tt-sub';
  sub.textContent = source?.semester || '';

  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'ghost small';
  close.textContent = 'Close';
  close.addEventListener('click', () => closeTimetable());

  h.append(title, sub);

  /*
   * FINALISE and RESET only appear once there is a timetable to act on. On the
   * build screen they would be two disabled buttons explaining themselves.
   */
  if (state.entries.length) {
    const done = document.createElement('button');
    done.type = 'button';
    done.className = 'ghost small';
    // A milestone, not a lock -- official notices still land afterwards. The
    // label says "complete", not "freeze", so it does not promise otherwise.
    done.textContent = state.finalisedAt ? 'Finalised' : 'Mark complete';
    done.disabled = Boolean(state.finalisedAt);
    done.title = state.finalisedAt
      ? `Marked complete. Official changes still apply.`
      : 'Mark the course set complete. Official changes still apply afterwards.';
    done.addEventListener('click', async () => {
      const r = finalize(state);
      if (!r.ok) { ctxRef?.toast?.(r.reason, { kind: 'error' }); return; }
      state = r.state;
      await persist();
      render();
      ctxRef?.toast?.('Timetable marked complete');
    });
    h.appendChild(done);

    const wipe = document.createElement('button');
    wipe.type = 'button';
    wipe.className = 'ghost small';
    wipe.textContent = 'Reset';
    wipe.title = 'Delete the whole timetable and build it again';
    wipe.addEventListener('click', async () => {
      /*
       * Destructive and irreversible -- the undo stack covers mail, not this.
       * Everything else in this system updates incrementally, so throwing the
       * timetable away is the one action that deserves a confirm.
       */
      const ok = typeof confirm === 'function'
        ? confirm(
          `Delete all ${state.entries.length} classes and start again?\n\n` +
          'Your manual edits and change history will be lost.'
        )
        : true;
      if (!ok) return;
      state = resetTimetable(state);
      await persist();
      updateBadge();
      render();
      ctxRef?.toast?.('Timetable reset');
    });
    h.appendChild(wipe);
  }

  h.appendChild(close);
  return h;
}

/* --------------------------------------------------------- the empty case -- */

function buildView() {
  const b = el('div', 'tt-body');

  if (source?.error) {
    b.appendChild(notice(
      'The timetable data did not load.',
      `${source.error}. The extension may be packaged incorrectly.`
    ));
    return b;
  }

  const intro = el('p', 'tt-intro');
  intro.textContent =
    'Build your timetable once from the official BITS timetable. After that it '
    + 'updates itself only when an official change or a matching academic email '
    + 'arrives, and never overwrites anything you have edited.';
  b.append(intro, courseSearch());
  return b;
}

/* ----------------------------------------------------------- course search -- */

function courseSearch() {
  const wrap = el('div', 'tt-search');

  const label = el('label', 'tt-label');
  label.textContent = 'Add a course';
  label.htmlFor = 'tt-q';

  const input = document.createElement('input');
  input.id = 'tt-q';
  input.type = 'search';
  input.placeholder = 'Course number or title — e.g. CS F111';
  input.autocomplete = 'off';

  const results = el('ul', 'tt-results');
  results.id = 'tt-results';

  input.addEventListener('input', () => {
    const found = searchCourses(source, input.value, 12);
    results.replaceChildren(...found.map(courseRow));
    results.hidden = found.length === 0;
  });

  wrap.append(label, input, results);
  return wrap;
}

function courseRow(course) {
  const li = el('li', 'tt-result');
  const main = el('span', 'tt-result-main');
  main.textContent = `${course.courseNo} · ${course.title}`;

  const meta = el('span', 'tt-result-meta');
  const k = sectionsByKind(course);
  const bits = [`${k.lecture.length} lecture${k.lecture.length === 1 ? '' : 's'}`];
  if (k.tutorial.length) bits.push(`${k.tutorial.length} tutorial${k.tutorial.length === 1 ? '' : 's'}`);
  if (k.practical.length) bits.push(`${k.practical.length} lab${k.practical.length === 1 ? '' : 's'}`);
  // Two offerings can share a course number; the units tell them apart.
  if (course.credits?.length) bits.push(`${course.credits[course.credits.length - 1]} units`);
  meta.textContent = bits.join(' · ');

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'ghost small';
  btn.textContent = 'Choose';
  btn.addEventListener('click', () => openChooser(course));

  li.append(main, meta, btn);
  return li;
}

/* ---------------------------------------------------------------- chooser -- */

/**
 * Course → teacher → lecture section → linked sections.
 *
 * Teacher is offered FIRST because it is the choice students actually have an
 * opinion about; picking a teacher then narrows the section list, which is
 * shorter and easier to scan than thirty sections in document order.
 */
function openChooser(course) {
  const body = $('tt-panel')?.querySelector('.tt-body');
  if (!body) return;

  const box = el('div', 'tt-chooser');
  const teachers = instructorsFor(course);
  let chosenTeacher = '';

  const title = el('h3', 'tt-chooser-title');
  title.textContent = `${course.courseNo} · ${course.title}`;
  box.appendChild(title);

  if (teachers.length > 1) {
    box.appendChild(fieldset('Teacher', teachers.map((name) => {
      const b = chip(name, () => {
        chosenTeacher = chosenTeacher === name ? '' : name;
        drawSections();
        [...box.querySelectorAll('.tt-chip')].forEach((c) => {
          c.setAttribute('aria-pressed', String(c.textContent === chosenTeacher));
        });
      });
      return b;
    }), 'Optional — narrows the sections below.'));
  }

  const secWrap = el('div', 'tt-sections');
  box.appendChild(secWrap);

  function drawSections() {
    const lectures = sectionsByKind(course).lecture.filter(
      (s) => !chosenTeacher || (s.instructors || []).some((i) => i === chosenTeacher)
    );
    secWrap.replaceChildren(fieldset(
      'Lecture section',
      lectures.length
        ? lectures.map((s) => sectionButton(course, s))
        : [note('No lecture section matches that teacher.')],
      lectures.length ? 'Pick the section you are registered for.' : ''
    ));
  }
  drawSections();

  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.className = 'ghost small';
  cancel.textContent = 'Cancel';
  cancel.addEventListener('click', () => box.remove());
  box.appendChild(cancel);

  body.querySelector('.tt-chooser')?.remove();
  body.appendChild(box);
  box.scrollIntoView?.({ block: 'nearest' });
}

function sectionButton(course, section) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'tt-section';

  const name = el('span', 'tt-section-name');
  name.textContent = section.section;

  const when = el('span', 'tt-section-when');
  when.textContent = summariseMeetings(section.meetings);

  const who = el('span', 'tt-section-who');
  who.textContent = (section.instructors || []).join(', ') || 'instructor not listed';

  const where = el('span', 'tt-section-where');
  where.textContent = section.room ? `Room ${section.room}` : 'no room listed';

  b.append(name, when, who, where);
  if (section.unresolved?.length) {
    const flag = el('span', 'tt-flag');
    flag.textContent = `${section.unresolved.join(' and ')} not in the timetable`;
    b.appendChild(flag);
  }
  b.addEventListener('click', () => chooseLecture(course, section));
  return b;
}

/**
 * A lecture was chosen. Attach what is deterministic, ask about the rest.
 */
async function chooseLecture(course, lecture) {
  const links = linkedSections(course, lecture.section);
  const extras = links.auto.map((a) => a.section);

  if (links.choose.length) {
    // Ambiguous linked sections: ask, do not guess. The chosen lecture is
    // added immediately so the user sees progress, and the question is asked
    // against the real timetable.
    const r = addCourse(state, course, { lecture, extraSections: extras, ref: 'official timetable' });
    state = r.state;
    await persist();
    updateBadge();
    render();
    askForLinked(course, lecture, links.choose);
    return;
  }

  const r = addCourse(state, course, { lecture, extraSections: extras, ref: 'official timetable' });
  state = r.state;
  await persist();
  updateBadge();
  render();

  if (extras.length && ctxRef?.toast) {
    const kinds = links.auto.map((a) => `${a.kind} ${a.section.section}`).join(' and ');
    ctxRef.toast(`Added ${course.courseNo} ${lecture.section}, with ${kinds}`);
  }
}

function askForLinked(course, lecture, choices) {
  const body = $('tt-panel')?.querySelector('.tt-body');
  if (!body) return;

  const box = el('div', 'tt-chooser');
  const h = el('h3', 'tt-chooser-title');
  h.textContent = `${course.courseNo} — choose your ${choices.map((c) => c.kind).join(' and ')}`;
  box.appendChild(h);

  box.appendChild(note(
    'The official timetable does not say which of these goes with '
    + `${lecture.section}, so it cannot be filled in automatically. Pick the one `
    + 'you are registered for.'
  ));

  for (const choice of choices) {
    box.appendChild(fieldset(
      choice.kind === 'tutorial' ? 'Tutorial section' : 'Lab section',
      choice.options.map((s) => {
        const b = sectionButton(course, s);
        b.addEventListener('click', async () => {
          const r = addCourse(state, course, {
            lecture: null, extraSections: [s], ref: 'official timetable',
          });
          state = r.state;
          // Record which lecture it hangs off, for the manage view.
          state.entries = state.entries.map((e) =>
            e.id === entryId(course.comCode, s.section)
              ? { ...e, linkedTo: lecture.section }
              : e);
          await persist();
          updateBadge();
          render();
        });
        return b;
      })
    ));
  }

  const skip = document.createElement('button');
  skip.type = 'button';
  skip.className = 'ghost small';
  skip.textContent = 'Skip for now';
  skip.addEventListener('click', () => box.remove());
  box.appendChild(skip);

  body.querySelector('.tt-chooser')?.remove();
  body.appendChild(box);
}

/* ------------------------------------------------------------ manage view -- */

function manageView() {
  const b = el('div', 'tt-body');

  if (pending.length) b.appendChild(pendingSection());
  /*
   * Staleness is computed at RENDER time, not stored in `state.conflicts`.
   *
   * It is a function of (state, catalogue), while detectConflicts is a
   * function of entries alone. Folding it into the stored list would make the
   * conflict set depend on whether an async fetch had landed yet -- so a
   * reload with a slow network would silently show fewer problems.
   */
  const stale = validateAgainstSource(state, source);
  const problems = [...state.conflicts, ...stale];
  if (problems.length) b.appendChild(conflictSection(problems));

  b.appendChild(gridSection());
  const exams = examSection();
  if (exams) b.appendChild(exams);
  b.appendChild(listSection());
  b.appendChild(courseSearch());
  return b;
}

/** The entry a finding targets, or a harmless stand-in if it has gone. */
function entry(f) {
  return state.entries.find((e) => e.id === f.entryId) || { provenance: {}, unresolved: [], history: [] };
}

function pendingSection() {
  const s = el('section', 'tt-block tt-pending');
  s.appendChild(blockTitle(`${pending.length} update${pending.length === 1 ? '' : 's'} to review`));

  for (const f of pending) {
    const row = el('div', 'tt-proposal');

    const what = el('div', 'tt-proposal-what');
    what.textContent = `${f.label}: ${f.courseNo} ${f.section}`;

    const why = el('blockquote', 'tt-evidence');
    why.textContent = f.evidence || '(no text)';

    const act = el('div', 'tt-proposal-actions');

    /*
     * "APPLY" MUST ONLY APPEAR WHEN APPLYING WOULD ACTUALLY WORK.
     *
     * A finding can be actionable in the sense that a value was stated, and
     * still be refused by precedence: an email is below the official
     * timetable, so mail cannot silently correct the document. Offering a
     * button that reports "kept official timetable over academic email" when
     * pressed is a worse experience than not offering it — the user would
     * reasonably read the refusal as a bug.
     *
     * So the outcome is computed FIRST, against the real entry, and the UI
     * offers what the model will actually permit. Where mail cannot win, the
     * honest affordance is to accept it as YOUR decision, which is precedence
     * 5 and always wins — the user is the authority the email is not.
     */
    const dryRun = f.actionable && f.field
      ? applyFieldChange(entry(f), f.field, f.value, {
        source: f.noticeRef ? 'notice' : 'mail',
        ref: f.messageId || f.noticeRef || '',
      })
      : null;

    if (dryRun?.applied) {
      const apply = document.createElement('button');
      apply.type = 'button';
      apply.className = 'primary small';
      apply.textContent = f.field === 'room' ? `Change room to ${f.value}` : 'Apply';
      apply.addEventListener('click', async () => {
        const r = await acceptFinding(f);
        if (!r.ok && ctxRef?.toast) ctxRef.toast(r.reason, { kind: 'error' });
        render();
      });
      act.appendChild(apply);
    } else if (f.actionable && f.field) {
      const why = el('p', 'tt-note');
      why.textContent = dryRun?.needsPermission
        ? `This class is locked, so the change was not applied automatically.`
        : `Not applied automatically: ${dryRun?.reason || 'a stronger source already set this'}.`;
      row.appendChild(why);

      const mine = document.createElement('button');
      mine.type = 'button';
      mine.className = 'primary small';
      mine.textContent = f.field === 'room' ? `Set room to ${f.value}` : 'Accept this change';
      mine.title = 'Records this as your own edit, which outranks every other source';
      mine.addEventListener('click', async () => {
        // Pass the message id: the edit is the user's, but this mail is what
        // prompted it, and the reader shows that link back.
        const r = manualEdit(
          state, f.entryId, f.field, f.value, Date.now(),
          f.messageId || f.noticeRef || 'user'
        );
        if (!r.applied) { ctxRef?.toast?.(r.reason, { kind: 'error' }); return; }
        state = r.state;
        await dismissFinding(f, 'accepted-as-manual');
      });
      act.appendChild(mine);
    } else {
      const seen = document.createElement('button');
      seen.type = 'button';
      seen.className = 'ghost small';
      seen.textContent = 'Got it';
      seen.addEventListener('click', () => acceptFinding(f));
      act.appendChild(seen);
    }

    const open = document.createElement('button');
    open.type = 'button';
    open.className = 'ghost small';
    open.textContent = 'Open email';
    open.hidden = !f.messageId;
    open.addEventListener('click', () => ctxRef?.openMessage?.(f.messageId));
    act.appendChild(open);

    const skip = document.createElement('button');
    skip.type = 'button';
    skip.className = 'ghost small';
    skip.textContent = 'Ignore';
    skip.addEventListener('click', () => dismissFinding(f));
    act.appendChild(skip);

    row.append(what, why, act);
    s.appendChild(row);
  }
  return s;
}

function conflictSection(problems = state.conflicts) {
  const s = el('section', 'tt-block tt-conflicts');
  s.appendChild(blockTitle(`${problems.length} thing${problems.length === 1 ? '' : 's'} to check`));
  for (const c of problems) {
    const row = el('div', `tt-conflict tt-${c.severity}`);
    const msg = el('span', 'tt-conflict-msg');
    msg.textContent = c.message;
    row.appendChild(msg);
    s.appendChild(row);
  }
  return s;
}

const DAYS = ['M', 'T', 'W', 'Th', 'F', 'S'];
const DAY_LABEL = { M: 'Mon', T: 'Tue', W: 'Wed', Th: 'Thu', F: 'Fri', S: 'Sat' };

/**
 * Mid-semester and comprehensive exams, soonest first.
 *
 * These dates were parsed and stored from the very first version and never
 * shown, so the one part of the timetable a student most needs to plan around
 * was invisible. The clock times come from the document's legend, not from a
 * guess -- a session the legend does not describe shows its date and no time.
 *
 * Returns null when there are none, so lab-and-project timetables do not get
 * an empty heading.
 */
function examSection() {
  const events = examEvents(state.entries);
  if (!events.length) return null;

  const s = el('section', 'tt-block');
  s.appendChild(blockTitle('Exams'));

  /*
   * Sort by DD/MM without inventing a year.
   *
   * The document prints no year, and the academic year straddles December to
   * May, so a naive numeric sort would put January before October. Comparing
   * month-then-day and rotating so the semester's own start month leads keeps
   * the order right without fabricating a date.
   */
  const key = (e) => {
    const [dd, mm] = e.date.split('/').map(Number);
    if (!Number.isFinite(dd) || !Number.isFinite(mm)) return Number.MAX_SAFE_INTEGER;
    // Semester runs Aug -> Dec then Jan -> May: months before August wrap.
    const ordered = mm >= 8 ? mm - 8 : mm + 4;
    return ordered * 100 + dd;
  };
  const sorted = [...events].sort((a, b) => key(a) - key(b));

  const list = el('div', 'tt-exams');
  for (const e of sorted) {
    const row = el('div', 'tt-exam');

    const kind = el('span', `tt-kind tt-exam-${e.type}`);
    kind.textContent = e.type === 'midsem' ? 'Mid-sem' : 'Compre';

    const what = el('span', 'tt-exam-course');
    what.textContent = `${e.courseNo} ${e.section}`;

    const when = el('span', 'tt-exam-when');
    // The session code is kept alongside the converted time, because the
    // official notices refer to sessions by name and the two must be
    // reconcilable by eye.
    when.textContent = e.time
      ? `${e.date} · ${e.session} · ${e.time}`
      : `${e.date}${e.session ? ` · ${e.session}` : ''} · time not stated`;
    if (!e.time) when.classList.add('tt-unresolved');

    row.append(kind, what, when);
    list.appendChild(row);
  }
  s.appendChild(list);
  return s;
}

function gridSection() {
  const s = el('section', 'tt-block');
  s.appendChild(blockTitle('Your week'));

  const week = weekView(state.entries);
  const grid = el('div', 'tt-grid');

  for (const d of DAYS) {
    const col = el('div', 'tt-col');
    const head = el('div', 'tt-col-head');
    head.textContent = DAY_LABEL[d];
    col.appendChild(head);

    if (!week[d].length) {
      const none = el('div', 'tt-none');
      none.textContent = '—';
      col.appendChild(none);
    }
    for (const m of week[d]) {
      const cell = el('div', `tt-cell tt-${m.kind}`);
      const t = el('span', 'tt-cell-time');
      t.textContent = fmtTime(m.startMin);
      const c = el('span', 'tt-cell-course');
      c.textContent = m.courseNo;
      const r = el('span', 'tt-cell-room');
      r.textContent = m.room ? m.room : '—';
      cell.append(t, c, r);
      cell.title = `${m.courseNo} ${m.section} · ${m.title}\n`
        + `${fmtTime(m.startMin)}–${fmtTime(m.endMin)}`
        + `${m.room ? ` · Room ${m.room}` : ''}`
        + `${m.instructors?.length ? `\n${m.instructors.join(', ')}` : ''}`
        + (m.beyondLegend ? '\n\nThis hour is not in the printed legend — please confirm.' : '');
      if (m.beyondLegend) cell.dataset.confirm = 'true';
      if (m.locked) cell.dataset.locked = 'true';
      col.appendChild(cell);
    }
    grid.appendChild(col);
  }
  s.appendChild(grid);
  return s;
}

function listSection() {
  const s = el('section', 'tt-block');
  s.appendChild(blockTitle('Classes'));

  const byCourse = new Map();
  for (const e of state.entries) {
    if (!byCourse.has(e.comCode)) byCourse.set(e.comCode, []);
    byCourse.get(e.comCode).push(e);
  }

  for (const [comCode, entries] of byCourse) {
    const card = el('div', 'tt-course');
    const head = el('div', 'tt-course-head');
    const name = el('span', 'tt-course-name');
    name.textContent = `${entries[0].courseNo} · ${entries[0].title}`;

    const drop = document.createElement('button');
    drop.type = 'button';
    drop.className = 'ghost small';
    drop.textContent = 'Remove';
    drop.addEventListener('click', async () => {
      state = removeCourse(state, comCode);
      await persist();
      updateBadge();
      render();
    });

    head.append(name, drop);
    card.appendChild(head);
    for (const e of entries) card.appendChild(entryRow(e));
    s.appendChild(card);
  }
  return s;
}

function entryRow(e) {
  const row = el('div', 'tt-entry');

  const tag = el('span', `tt-kind tt-${e.kind}`);
  tag.textContent = e.section;

  const when = el('span', 'tt-when');
  when.textContent = summariseMeetings(e.meetings);

  const where = el('span', 'tt-where');
  where.textContent = e.room ? `Room ${e.room}` : 'no room';

  /*
   * The instructor-in-charge gets a mark, because they are who you email
   * about a clash, a makeup or a grade. The document distinguishes them in
   * BLOCK CAPITALS and we were flattening that away.
   *
   * A dot rather than a word: the row is already four columns, and the
   * tooltip carries the meaning for anyone who wonders.
   */
  const who = el('span', 'tt-who');
  if (e.inCharge) {
    const lead = el('span', 'tt-lead');
    lead.textContent = e.inCharge;
    lead.title = `${e.inCharge} is the instructor-in-charge`;
    const rest = e.instructors.filter((n) => n !== e.inCharge);
    who.append(lead);
    if (rest.length) who.append(document.createTextNode(`, ${rest.join(', ')}`));
  } else {
    who.textContent = e.instructors.join(', ') || '—';
  }

  const acts = el('span', 'tt-entry-acts');

  const why = document.createElement('button');
  why.type = 'button';
  why.className = 'ghost small';
  why.textContent = 'Source';
  why.setAttribute('aria-expanded', 'false');
  why.addEventListener('click', () => {
    const open = why.getAttribute('aria-expanded') === 'true';
    why.setAttribute('aria-expanded', String(!open));
    row.querySelector('.tt-prov')?.remove();
    if (!open) row.appendChild(provenance(e));
  });

  const lock = document.createElement('button');
  lock.type = 'button';
  lock.className = 'ghost small';
  lock.textContent = e.locked ? 'Unlock' : 'Lock';
  lock.title = e.locked
    ? 'Automatic updates are being held back for this class'
    : 'Stop automatic updates from changing this class';
  lock.setAttribute('aria-pressed', String(e.locked));
  lock.addEventListener('click', async () => {
    state = setLocked(state, e.id, !e.locked);
    await persist();
    render();
  });

  /*
   * SWITCH SECTION. Previously the only route was Remove then Add, which threw
   * away the history of everything else on the course -- and swapping section
   * is routine in the first fortnight of a semester.
   *
   * Offered only when the source actually has another section of this kind to
   * move to; a button that opens an empty list is worse than no button.
   */
  const course = source?.courses?.find((c) => c.comCode === e.comCode);
  const alternatives = (course?.sections || []).filter(
    (sec) => sec.kind === e.kind && sec.section !== e.section
  );

  if (alternatives.length) {
    const swap = document.createElement('button');
    swap.type = 'button';
    swap.className = 'ghost small';
    swap.textContent = 'Switch';
    swap.title = `Move to a different ${e.kind} section`;
    swap.setAttribute('aria-expanded', 'false');
    swap.addEventListener('click', () => {
      const open = swap.getAttribute('aria-expanded') === 'true';
      swap.setAttribute('aria-expanded', String(!open));
      row.querySelector('.tt-switch')?.remove();
      if (open) return;

      const box = el('div', 'tt-switch');
      for (const sec of alternatives) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'tt-section';
        b.textContent =
          `${sec.section} · ${(sec.instructors || []).join(', ') || 'no instructor'}` +
          ` · ${sec.daysHours || 'no time'}${sec.room ? ` · ${sec.room}` : ''}`;
        b.addEventListener('click', async () => {
          state = switchSection(state, e.comCode, e.section, course, sec);
          await persist();
          updateBadge();
          render();
        });
        box.appendChild(b);
      }
      row.appendChild(box);
    });
    acts.append(why, swap, lock);
  } else {
    acts.append(why, lock);
  }

  row.append(tag, when, where, who, acts);
  if (e.locked) row.dataset.locked = 'true';
  return row;
}

/** Where every field came from, and how to put it back. */
function provenance(e) {
  const box = el('div', 'tt-prov');

  for (const line of explainEntry(e)) {
    const r = el('div', 'tt-prov-row');
    const f = el('span', 'tt-prov-field');
    f.textContent = line.field === 'instructors' ? 'teacher' : line.field;
    const v = el('span', 'tt-prov-value');
    v.textContent = line.value;
    const s = el('span', 'tt-prov-source');
    s.textContent = `from ${line.sourceLabel}${line.ref ? ` (${line.ref})` : ''}`;
    r.append(f, v, s);

    if (line.source === 'manual') {
      const undo = document.createElement('button');
      undo.type = 'button';
      undo.className = 'ghost small';
      undo.textContent = 'Restore official';
      undo.addEventListener('click', async () => {
        const course = courseByComCode(source, e.comCode);
        const res = restoreFromSource(state, e.id, line.field, course);
        if (!res.applied) { ctxRef?.toast?.(res.reason, { kind: 'error' }); return; }
        state = res.state;
        await persist();
        render();
      });
      r.appendChild(undo);
    }
    box.appendChild(r);
  }

  if (e.history.length) {
    const h = el('details', 'tt-history');
    const sum = document.createElement('summary');
    sum.textContent = `History — ${e.history.length} change${e.history.length === 1 ? '' : 's'}`;
    h.appendChild(sum);
    for (const item of [...e.history].reverse()) {
      const line = el('div', 'tt-history-row');
      const when = new Date(item.at);
      line.textContent = item.from !== undefined
        ? `${when.toLocaleDateString()} — ${item.detail}: "${item.from}" → "${item.to}"`
        : `${when.toLocaleDateString()} — ${item.detail}`;
      h.appendChild(line);
    }
    box.appendChild(h);
  }
  return box;
}

/* ------------------------------------------------------------------ atoms -- */

function el(tag, className) {
  const n = document.createElement(tag);
  if (className) n.className = className;
  return n;
}

function blockTitle(text) {
  const h = el('h3', 'tt-block-title');
  h.textContent = text;
  return h;
}

function note(text) {
  const n = el('p', 'tt-note');
  n.textContent = text;
  return n;
}

function notice(title, detail) {
  const n = el('div', 'tt-notice');
  const t = el('strong', '');
  t.textContent = title;
  const d = el('span', '');
  d.textContent = detail;
  n.append(t, d);
  return n;
}

function chip(text, onClick) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'tt-chip';
  b.setAttribute('aria-pressed', 'false');
  b.textContent = text;
  b.addEventListener('click', onClick);
  return b;
}

function fieldset(legend, children, hint) {
  const f = el('div', 'tt-field');
  const l = el('div', 'tt-legend');
  l.textContent = legend;
  f.appendChild(l);
  if (hint) {
    const h = el('div', 'tt-hint');
    h.textContent = hint;
    f.appendChild(h);
  }
  const box = el('div', 'tt-options');
  box.append(...children);
  f.appendChild(box);
  return f;
}
