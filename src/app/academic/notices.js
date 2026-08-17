/**
 * Class-change detection in email prose.  (Feature 57.)
 *
 * WHAT THIS IS *NOT*
 * ------------------
 * `timetable-mail.js` already has `matchNotice()`, which reads the OFFICIAL
 * change document -- a structured table with From and To columns, parsed by
 * `tools/parse-timetable.mjs` into 119 change rows. That is a document parser
 * and it is finished.
 *
 * This is different. Most class changes never reach that document: they arrive
 * as a sentence in a mail from the instructor, hours before the class.
 *
 *   "Tomorrow's CS F111 lecture will be held in 6117 instead of 5105."
 *   "The Thursday lab is cancelled."
 *   "Extra class for MATH F211 on Saturday at 4pm."
 *
 * These are the highest-urgency, lowest-volume messages on campus, and in a
 * list they look exactly like everything else. Surfacing them is the clearest
 * "Gmail could never" moment in the product -- and it is a MAIL feature: it
 * changes a message's prominence and position, which is why it survived the
 * identity filter when the timetable calendar and the today-strip did not.
 *
 * IT SHIPS READ-ONLY, DELIBERATELY
 *
 * The discovery pass proposed an "apply to my timetable" action. The
 * elimination pass kept the detection and cut the mutation. A parser working
 * on free prose written by a hurried professor at 11pm WILL be wrong
 * sometimes, and a wrong write to the user's timetable is silent, persistent
 * and hard to notice. Showing a card that says "this looks like a room change"
 * is useful even when it is wrong, because the mail is right there to check.
 *
 * PRECISION OVER RECALL, EVERYWHERE
 *
 * A missed notice costs what it costs today -- nothing new. A false notice
 * pinned to the top of the inbox trains the user to ignore the pin, which
 * destroys the feature permanently. Every pattern below is written to be
 * narrow, and `confidence` is reported so the caller can require a high bar
 * before promoting a message.
 */

/** The kinds of change worth distinguishing. */
export const NOTICE_KINDS = /** @type {const} */ ([
  'cancelled',
  'room',
  'reschedule',
  'extra',
]);

export const KIND_LABEL = {
  cancelled: 'Class cancelled',
  room: 'Room changed',
  reschedule: 'Time changed',
  extra: 'Extra class',
};

/**
 * Cancellation. The strongest and least ambiguous signal.
 *
 * Requires a class-ish noun near the word, so that "the event is cancelled" or
 * "my order was cancelled" does not fire.
 */
const CANCELLED = [
  /\b(class|lecture|lab|laboratory|tutorial|session|practical)e?s?\b[^.!?]{0,60}?\b(is|are|has been|have been|stands?|will be)?\s*(cancell?ed|called\s+off|not\s+be\s+held|will\s+not\s+be\s+held)\b/i,
  /\b(cancell?ation|no)\s+of?\s*(class|lecture|lab|tutorial|session)e?s?\b/i,
  /\bthere\s+(will\s+be|is)\s+no\s+(class|lecture|lab|tutorial|session)\b/i,
];

/**
 * Room change.
 *
 * The `instead of` / `shifted to` / `venue changed` family. A bare room number
 * is never enough -- rooms appear in every routine announcement.
 */
const ROOM = [
  /\b(?:shifted|moved|changed|relocated|rescheduled)\s+to\s+(?:room\s*(?:no\.?)?\s*)?([0-9]{3,4}[A-Z]?)\b/i,
  /\b(?:will\s+be\s+held|held|conducted|take\s+place)\s+in\s+(?:room\s*(?:no\.?)?\s*)?([0-9]{3,4}[A-Z]?)\s+(?:instead|in\s+place)/i,
  /\b(?:new\s+)?(?:venue|room)\s*(?:is|:|will\s+be|has\s+been\s+changed\s+to)\s*(?:room\s*(?:no\.?)?\s*)?([0-9]{3,4}[A-Z]?)\b/i,
  /\bin\s+(?:room\s*(?:no\.?)?\s*)?([0-9]{3,4}[A-Z]?)\s+instead\s+of\s+(?:room\s*(?:no\.?)?\s*)?([0-9]{3,4}[A-Z]?)\b/i,
];

/** The room being moved away from, when the sentence says so. */
const ROOM_FROM = /\binstead\s+of\s+(?:room\s*(?:no\.?)?\s*)?([0-9]{3,4}[A-Z]?)\b/i;

/** Rescheduling to a different time or day. */
const RESCHEDULE = [
  /\b(?:preponed|postponed|rescheduled|shifted|advanced|delayed)\s+to\s+([^.!?\n]{3,40})/i,
  /\b(?:class|lecture|lab|tutorial|session)e?s?\b[^.!?]{0,40}?\bwill\s+now\s+(?:be\s+held|start|begin|take\s+place)\s+(?:at|on)\s+([^.!?\n]{3,40})/i,
  /\bnew\s+(?:time|timing|slot)\s*(?:is|:)\s*([^.!?\n]{3,40})/i,
];

/** An additional class, not a replacement. */
const EXTRA = [
  /\b(?:extra|additional|make[\s-]?up|compensatory|remedial)\s+(?:class|lecture|lab|tutorial|session)e?s?\b/i,
  /\b(?:class|lecture|lab)\s+(?:will\s+be\s+)?(?:conducted|held)\s+on\s+(?:saturday|sunday)\b/i,
];

/**
 * Phrases that mean the message is talking about someone else's change, or
 * about a change that already happened.
 *
 * Without this, a mail forwarding last week's cancellation notice pins itself
 * to the top of the inbox as though it were live.
 */
/*
 * Text that means "this is NOT the notice it looks like" (round 11, B12).
 *
 * The first four are STALE — a notice about something already over. The rest
 * are NEGATIONS, and they were missing. Measured:
 *
 *   'CS F211 class is NOT cancelled'      -> kind 'cancelled', confidence 1
 *   'CS F211 class will not be cancelled' -> kind 'cancelled', confidence 1
 *   'The extra class has been withdrawn'  -> kind 'extra',     confidence 1
 *
 * Confidence 1 clears `shouldPromote`, so the notices rail showed a banner
 * reading "CS F211: class cancelled" for a message saying the opposite — and
 * a student who trusts the banner skips a class that is running. That is the
 * worst failure this feature has, because the whole point of the rail is to
 * be believed at a glance.
 *
 * `\bnot\b` is deliberately NOT in this list on its own: "please note" and
 * "notice" contain it only as a substring (\b protects that), but a long
 * notice legitimately says "do not park bicycles" while announcing a real
 * cancellation. Each pattern below therefore binds the negation TO the verb
 * it negates, which is the only reading that cannot fire on unrelated prose.
 */
const STALE = [
  /\bwas\s+cancell?ed\b/i,
  /\bhad\s+been\s+(?:cancell?ed|shifted|rescheduled)\b/i,
  /\bkindly\s+ignore\b/i,
  /\bplease\s+disregard\b/i,
  // Negations, bound to the verb.
  /\b(?:is|are|was|were|will\s+be|has\s+been|have\s+been)\s+not\s+(?:being\s+)?(?:cancell?ed|shifted|moved|rescheduled|changed|held)\b/i,
  /\bnot\s+(?:be\s+)?(?:cancell?ed|shifted|moved|rescheduled|changed)\b/i,
  /\b(?:notice|change|update|cancellation|reschedul\w*)\s+(?:has\s+been\s+|is\s+)?(?:withdrawn|revoked|retracted|cancell?ed)\b/i,
  /\b(?:has\s+been|is|stands?)\s+withdrawn\b/i,
  /\b(?:remains?|stands?|is)\s+unchanged\b/i,
  /\bno\s+change\s+(?:to|in)\b/i,
];

/** Day names, used to date a notice when it says one. */
const DAY_WORDS = {
  monday: 1, mon: 1,
  tuesday: 2, tue: 2, tues: 2,
  wednesday: 3, wed: 3,
  thursday: 4, thu: 4, thur: 4, thurs: 4,
  friday: 5, fri: 5,
  saturday: 6, sat: 6,
  sunday: 0, sun: 0,
};

/** Trim a matched fragment down to something a card can show. */
function tidy(s) {
  return String(s || '')
    .replace(/\s+/g, ' ')
    .replace(/[\s,;:.]+$/, '')
    .trim();
}

/**
 * Find the first match across a pattern list.
 * @returns {{match:RegExpMatchArray, pattern:RegExp}|null}
 */
function firstMatch(text, patterns) {
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) return { match, pattern };
  }
  return null;
}

/**
 * Detect a class change in one message.
 *
 * @param {{subject?:string, snippet?:string, body?:string, from?:string, date?:number}} msg
 * @param {{courses?:string[], isAcademicSender?:boolean}} [ctx]
 *   `courses` are the course numbers already detected by timetable-mail.js and
 *   already narrowed to the user's enrolment by my-courses.js. Passing them
 *   raises confidence; omitting them does not prevent detection.
 * @returns {{kind:string, label:string, confidence:number, evidence:string,
 *   room?:string, fromRoom?:string, when?:string, day?:number, courses:string[]}|null}
 */
export function detectNotice(msg, { courses = [], isAcademicSender = false } = {}) {
  if (!msg) return null;

  /*
   * The SUBJECT is weighted separately from the body.
   *
   * "Class cancelled" in a subject line is a notice. The same words three
   * paragraphs into a newsletter are a mention. Scanning them as one blob
   * loses that distinction, which is most of the available signal.
   */
  const subject = String(msg.subject || '');
  const body = `${msg.snippet || ''} ${msg.body || ''}`;
  const all = `${subject} ${body}`;

  if (firstMatch(all, STALE)) return null;

  let kind = null;
  let hit = null;

  // Order matters: a cancellation that also mentions a room is a cancellation.
  if ((hit = firstMatch(all, CANCELLED))) kind = 'cancelled';
  else if ((hit = firstMatch(all, EXTRA))) kind = 'extra';
  else if ((hit = firstMatch(all, ROOM))) kind = 'room';
  else if ((hit = firstMatch(all, RESCHEDULE))) kind = 'reschedule';

  if (!kind) return null;

  /*
   * CONFIDENCE.
   *
   * Starts low and is raised only by corroborating signals. A pattern match
   * alone is 0.4 -- deliberately below any sensible promotion threshold, so a
   * bare match never pins anything to the top of the inbox on its own.
   */
  let confidence = 0.4;
  if (courses.length > 0) confidence += 0.3; // it names a course the user takes
  if (isAcademicSender) confidence += 0.15;
  if (firstMatch(subject, [CANCELLED, EXTRA, ROOM, RESCHEDULE].flat())) confidence += 0.15;
  confidence = Math.min(1, Number(confidence.toFixed(2)));

  /** @type {any} */
  const out = {
    kind,
    label: KIND_LABEL[kind],
    confidence,
    evidence: tidy(hit.match[0]).slice(0, 160),
    courses,
  };

  if (kind === 'room') {
    const room = hit.match[1];
    if (room) out.room = room.toUpperCase();
    const from = all.match(ROOM_FROM);
    // Guard against "in 6117 instead of 6117" and against the from/to pair
    // being read backwards on the fourth pattern.
    if (from && from[1] && from[1].toUpperCase() !== out.room) out.fromRoom = from[1].toUpperCase();
  }

  if (kind === 'reschedule' && hit.match[1]) out.when = tidy(hit.match[1]).slice(0, 60);

  const day = all.match(/\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday|mon|tue|tues|wed|thu|thur|thurs|fri|sat|sun)\b/i);
  if (day) out.day = DAY_WORDS[day[1].toLowerCase()];

  return out;
}

/**
 * Should this notice be promoted to the top of the inbox?
 *
 * The threshold is high on purpose. A pinned false positive teaches the user
 * to ignore the pin, and the pin is the whole delivery mechanism.
 */
export function shouldPromote(notice, { threshold = 0.7 } = {}) {
  return !!notice && notice.confidence >= threshold;
}

/**
 * A one-line summary for the card.
 *
 * Kept here so the phrasing is testable and so the card, the notification and
 * any future digest cannot drift apart.
 */
export function summarise(notice) {
  if (!notice) return '';
  const course = notice.courses?.[0] ? `${notice.courses[0]}: ` : '';
  switch (notice.kind) {
    case 'cancelled':
      return `${course}class cancelled`;
    case 'room':
      return notice.fromRoom
        ? `${course}room ${notice.fromRoom} → ${notice.room}`
        : `${course}room changed${notice.room ? ` to ${notice.room}` : ''}`;
    case 'reschedule':
      return `${course}rescheduled${notice.when ? ` to ${notice.when}` : ''}`;
    case 'extra':
      return `${course}extra class`;
    default:
      return course || 'Timetable change';
  }
}

/**
 * Scan a batch, newest first, keeping only promotable notices.
 *
 * Returns at most `limit`, because this renders as pinned cards above the
 * inbox and three is already a lot of vertical space to take from the list.
 */
export function scanForNotices(messages, resolve, { limit = 3, threshold = 0.7 } = {}) {
  if (!Array.isArray(messages)) return [];
  const out = [];
  for (const m of messages) {
    const ctx = resolve ? resolve(m) : {};
    const notice = detectNotice(m, ctx);
    if (shouldPromote(notice, { threshold })) {
      out.push({ id: m.id, notice, date: m.date });
    }
  }
  return out.sort((a, b) => (b.date || 0) - (a.date || 0)).slice(0, limit);
}
