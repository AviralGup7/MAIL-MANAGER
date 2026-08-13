/**
 * Notices rail tenant (extracted per the architecture audit).
 *
 * Only PROMOTED notices appear -- confidence >= 0.7, which requires the
 * message to name a course the user actually takes, or come from an academic
 * sender, or carry the phrase in its subject. A bare pattern match scores
 * 0.4 and never pins itself, because a false pin teaches people to ignore
 * the pin and that is the whole delivery mechanism.
 */
import { detectNotice, shouldPromote, summarise } from './notices.js';
import * as myCourses from './my-courses.js';
import { isAcademicSender } from './timetable-mail.js';

let ctx = null;
export function wireNotices(c) { ctx = c; }

export function renderNotices() {
  const wrap = document.getElementById('notices');
  if (!wrap) return;

  const found = [];
  for (const id of ctx.visibleIds().slice(0, 60)) {
    const m = ctx.getMessage(id);
    if (!m) continue;
    const mine = myCourses.mineAmong(m.courses || [], ctx.getEnrolment());
    const notice = detectNotice(m, {
      courses: mine,
      isAcademicSender: isAcademicSender(m.from),
    });
    if (shouldPromote(notice)) found.push({ m, notice });
    if (found.length >= 3) break;
  }

  wrap.hidden = found.length === 0;
  if (found.length === 0) return;

  const frag = document.createDocumentFragment();
  for (const { m, notice } of found) {
    const li = document.createElement('li');
    li.className = `notice notice-${notice.kind}`;

    const what = document.createElement('span');
    what.className = 'notice-what';
    what.textContent = summarise(notice);

    const why = document.createElement('span');
    why.className = 'notice-why';
    // Quote the sentence it read, so a wrong card can be judged at a glance
    // rather than taken on faith.
    why.textContent = notice.evidence;

    li.append(what, why);
    li.tabIndex = 0;
    li.setAttribute('role', 'button');
    li.onclick = () => ctx.openMessage(m.id);
    li.onkeydown = (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); ctx.openMessage(m.id); }
    };
    frag.appendChild(li);
  }
  wrap.replaceChildren(frag);
}
