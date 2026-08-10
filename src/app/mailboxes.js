/**
 * System mailboxes: Inbox, Sent, Drafts, Snoozed, Spam, Trash.
 *
 * THE GAP THIS CLOSES
 * -------------------
 * Every sidebar entry used to be a BITS category, and sync hard-coded
 * `labelIds: ['INBOX']`. So there was no way to see what you had sent, find a
 * draft, or check whether something had been marked as spam -- the answer was
 * always "go back to Gmail", and once the user is in Gmail they have no reason
 * to come back. The audit called this the single biggest leak in the product,
 * and it is: it undermines every other feature.
 *
 * DESIGN
 *
 *   - A mailbox is a Gmail LABEL QUERY, not a new data model. `listIds` and
 *     `syncPage` already accepted `labelIds`; nothing called them with
 *     anything but INBOX. Most of this feature was already built and simply
 *     unreachable.
 *
 *   - Each mailbox gets its OWN Store. The alternative -- one store filtered
 *     by label -- sounds cheaper but is wrong: the stores have independent
 *     pagination cursors, independent sort orders, and independent search
 *     indexes, and mixing 2000 sent messages into the inbox's index makes
 *     inbox search worse to no benefit.
 *
 *   - Only the inbox is CLASSIFIED. Running the BITS classifier over Sent
 *     would bucket your own outgoing mail by whichever rule matched the
 *     recipient, which is meaningless. Sent, Drafts and Trash show a flat
 *     list, which is what those views are actually for.
 *
 *   - Trash and Spam are DESTRUCTIVE-ADJACENT and are ordered last, away from
 *     the everyday targets.
 */

import { SNOOZE_LABEL } from '../shared/labels.js';

/**
 * @typedef {Object} Mailbox
 * @property {string} id
 * @property {string} label       sidebar text
 * @property {string[]} labelIds  Gmail label ids to list
 * @property {boolean} classified run the BITS classifier and show categories
 * @property {boolean} [byLabelName] resolve `labelIds` by NAME at sync time
 * @property {string} [empty]     empty-state copy
 * @property {'from'|'to'} [people] which header identifies the other party
 */

/** @type {Mailbox[]} */
export const MAILBOXES = [
  {
    id: 'inbox',
    label: 'Inbox',
    labelIds: ['INBOX'],
    classified: true,
    people: 'from',
    empty: 'Nothing here.',
  },
  {
    id: 'snoozed',
    label: 'Snoozed',
    labelIds: [SNOOZE_LABEL],
    byLabelName: true,
    classified: false,
    people: 'from',
    empty: 'Nothing snoozed. Press z on a message to deal with it later.',
  },
  {
    id: 'sent',
    label: 'Sent',
    labelIds: ['SENT'],
    classified: false,
    people: 'to',
    empty: 'You have not sent anything yet.',
  },
  {
    id: 'drafts',
    label: 'Drafts',
    labelIds: ['DRAFT'],
    classified: false,
    people: 'to',
    empty: 'No drafts.',
  },
  {
    id: 'starred',
    label: 'Starred',
    labelIds: ['STARRED'],
    classified: false,
    people: 'from',
    empty: 'Nothing starred.',
  },
  {
    id: 'spam',
    label: 'Spam',
    labelIds: ['SPAM'],
    classified: false,
    people: 'from',
    empty: 'No spam. Gmail catches most of it before you see it.',
  },
  {
    id: 'trash',
    label: 'Trash',
    labelIds: ['TRASH'],
    classified: false,
    people: 'from',
    empty: 'Trash is empty. Gmail deletes it permanently after 30 days.',
  },
];

const BY_ID = new Map(MAILBOXES.map((m) => [m.id, m]));

export const DEFAULT_MAILBOX = 'inbox';

export function getMailbox(id) {
  return BY_ID.get(id) || BY_ID.get(DEFAULT_MAILBOX);
}

export function isMailbox(id) {
  return BY_ID.has(id);
}

/** Only the inbox shows the BITS category rail. */
export function showsCategories(id) {
  return !!getMailbox(id).classified;
}

/**
 * Which actions make sense here.
 *
 * Offering "Archive" in Trash, or "Delete" in Trash (where the message is
 * already deleted), is the kind of dead control that makes a UI feel
 * untrustworthy. Gmail gets this right and it is cheap to match.
 */
export function actionsFor(id) {
  switch (id) {
    case 'trash':
      return { star: false, archive: false, trash: false, snooze: false, spam: false,
        restore: true, unsnooze: false, edit: false };
    case 'spam':
      return { star: false, archive: false, trash: true, snooze: false, spam: true,
        notSpam: true, restore: false, unsnooze: false, edit: false };
    case 'drafts':
      return { star: false, archive: false, trash: true, snooze: false, spam: false,
        edit: true, restore: false, unsnooze: false };
    case 'sent':
      return { star: true, archive: false, trash: true, snooze: false, spam: false,
        restore: false, unsnooze: false, edit: false };
    case 'snoozed':
      return { star: true, archive: true, trash: true, snooze: false, spam: true,
        unsnooze: true, restore: false, edit: false };
    default:
      return { star: true, archive: true, trash: true, snooze: true, spam: true,
        restore: false, unsnooze: false, edit: false };
  }
}
