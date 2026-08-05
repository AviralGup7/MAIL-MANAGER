/**
 * Gmail REST layer. Lives in the service worker so the access token never
 * enters a document that renders untrusted mail HTML.
 *
 * WHY A REAL MULTIPART BATCH
 * --------------------------
 * Fetching 200 message headers one request at a time is 200 TLS round trips
 * and 200 chances to hit a per-request quota. Gmail's /batch endpoint takes up
 * to 100 sub-requests in ONE HTTP request. The old version used it too; this
 * is the one thing it got right about the network layer and it is carried over.
 *
 * We ask for `format=metadata` with an explicit header allow-list. That is a
 * fraction of the bytes of `format=full` and it is everything the list view
 * needs. Bodies are fetched lazily, one message at a time, only when the user
 * actually opens something.
 */

import { getToken } from './auth.js';

const BASE = 'https://gmail.googleapis.com/gmail/v1/users/me';
const BATCH_URL = 'https://gmail.googleapis.com/batch/gmail/v1';

/** Headers we need for the list view. Anything else is wasted bandwidth. */
const META_HEADERS = ['From', 'Subject', 'Date', 'List-Unsubscribe'];

/** Gmail's own limit. Do not raise it; the endpoint rejects >100. */
export const BATCH_SIZE = 100;

async function authHeaders(extra = {}) {
  const token = await getToken();
  return { Authorization: `Bearer ${token}`, ...extra };
}

/** Single authenticated call. `path` is relative to /users/me. */
export async function api(path, init = {}) {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: await authHeaders(init.headers || {}),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Gmail ${res.status} ${path} ${body.slice(0, 200)}`);
  }
  if (res.status === 204) return null;
  return res.json();
}

/**
 * One page of message ids.
 * Returns { ids, nextPageToken }.
 */
export async function listIds({ q = '', labelIds = ['INBOX'], max = 100, pageToken = '' } = {}) {
  const params = new URLSearchParams();
  params.set('maxResults', String(Math.min(max, 500)));
  for (const l of labelIds) params.append('labelIds', l);
  if (q) params.set('q', q);
  if (pageToken) params.set('pageToken', pageToken);
  const data = await api(`/messages?${params}`);
  return {
    ids: (data.messages || []).map((m) => m.id),
    nextPageToken: data.nextPageToken || '',
  };
}

/**
 * Metadata for up to BATCH_SIZE ids in ONE request.
 * Returns an array of normalised message records (see `normalise`).
 * Sub-requests that fail are dropped, not thrown — one dead message must not
 * kill a sync of a hundred good ones.
 */
export async function batchMetadata(ids) {
  if (ids.length === 0) return [];
  if (ids.length > BATCH_SIZE) throw new Error(`batchMetadata: ${ids.length} > ${BATCH_SIZE}`);

  const boundary = `bmm_${Math.random().toString(36).slice(2)}_${Date.now()}`;
  const qs = new URLSearchParams();
  qs.set('format', 'metadata');
  for (const h of META_HEADERS) qs.append('metadataHeaders', h);

  const body =
    ids
      .map(
        (id, i) =>
          `--${boundary}\r\n` +
          `Content-Type: application/http\r\n` +
          `Content-ID: <bmm-${i}>\r\n\r\n` +
          `GET /gmail/v1/users/me/messages/${encodeURIComponent(id)}?${qs}\r\n\r\n`
      )
      .join('') + `--${boundary}--\r\n`;

  const res = await fetch(BATCH_URL, {
    method: 'POST',
    headers: await authHeaders({ 'Content-Type': `multipart/mixed; boundary=${boundary}` }),
    body,
  });
  if (!res.ok) {
    throw new Error(`Gmail batch ${res.status}`);
  }
  const text = await res.text();
  return parseBatch(text).map(normalise).filter(Boolean);
}

/**
 * Parse a multipart/mixed batch response into JSON objects.
 *
 * Deliberately tolerant: Google has changed the exact header casing and line
 * endings in this response before, and a strict parser silently returns an
 * empty inbox when that happens. We find the JSON payload of each part by
 * looking for the last blank-line separator inside the part.
 */
export function parseBatch(text) {
  const m = text.match(/--([^\s-][^\r\n]*?)(?:\r?\n)/);
  if (!m) return [];
  const boundary = m[1].replace(/--$/, '');
  const out = [];
  for (const raw of text.split(`--${boundary}`)) {
    const part = raw.trim();
    if (!part || part === '--') continue;
    // part = <mime headers>\n\n<HTTP status + headers>\n\n<body>
    const chunks = part.split(/\r?\n\r?\n/);
    if (chunks.length < 3) continue;
    const status = chunks[1].split(/\r?\n/)[0] || '';
    if (!/\s2\d\d\s/.test(` ${status} `)) continue; // drop failed sub-requests
    const bodyText = chunks.slice(2).join('\n\n').trim();
    if (!bodyText.startsWith('{')) continue;
    try {
      out.push(JSON.parse(bodyText));
    } catch {
      /* one malformed part must not poison the batch */
    }
  }
  return out;
}

/**
 * Gmail's wire format -> our flat record.
 *
 * Flat on purpose. The old version kept Gmail's nested payload/headers array
 * in the store, which meant every render walked an array of ~20 header objects
 * per message just to find the subject.
 */
export function normalise(g) {
  if (!g?.id) return null;
  const h = Object.create(null);
  for (const { name, value } of g.payload?.headers || []) {
    h[name.toLowerCase()] = value;
  }
  const labels = g.labelIds || [];
  return {
    id: g.id,
    threadId: g.threadId || g.id,
    from: h.from || '',
    subject: h.subject || '(no subject)',
    snippet: decodeEntities(g.snippet || ''),
    // internalDate is ms-since-epoch as a STRING, and it is authoritative.
    // The Date: header is attacker-controlled and is routinely wrong.
    date: Number(g.internalDate) || Date.parse(h.date) || 0,
    unread: labels.includes('UNREAD'),
    starred: labels.includes('STARRED'),
    important: labels.includes('IMPORTANT'),
    labels,
  };
}

function decodeEntities(s) {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ');
}

/** Full body for one message, fetched only when the user opens it. */
export async function getFull(id) {
  return api(`/messages/${encodeURIComponent(id)}?format=full`);
}

/** Add/remove labels. Used for read, star, archive. */
export async function modify(id, addLabelIds = [], removeLabelIds = []) {
  return api(`/messages/${encodeURIComponent(id)}/modify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ addLabelIds, removeLabelIds }),
  });
}

/** Bulk modify — one request for up to 1000 ids. */
export async function batchModify(ids, addLabelIds = [], removeLabelIds = []) {
  if (!ids.length) return null;
  await api('/messages/batchModify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ids, addLabelIds, removeLabelIds }),
  });
  return { ok: true };
}

export async function trash(id) {
  return api(`/messages/${encodeURIComponent(id)}/trash`, { method: 'POST' });
}

export async function profile() {
  return api('/profile');
}

/**
 * Delta sync. Returns { changes, historyId } or { tooOld: true } when the
 * stored historyId has expired (Gmail keeps ~1 week) and a full resync is
 * required. Callers must handle `tooOld`; the old version did not, which is
 * why it silently stopped updating after a long absence.
 */
export async function history(startHistoryId) {
  const params = new URLSearchParams({
    startHistoryId: String(startHistoryId),
    maxResults: '500',
  });
  for (const t of ['messageAdded', 'messageDeleted', 'labelAdded', 'labelRemoved']) {
    params.append('historyTypes', t);
  }
  try {
    const data = await api(`/history?${params}`);
    return { changes: data.history || [], historyId: data.historyId };
  } catch (err) {
    if (String(err).includes('404')) return { tooOld: true };
    throw err;
  }
}
