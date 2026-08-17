import { Store } from './store.js';

/** Pure fact model; raw IDs stay out of the everyday reader. */
export function messageFacts(message, store, lowConfidence) {
  if (!message || typeof message !== 'object') return [];
  const conversation = store?.thread(Store.threadOf(message));
  const confident = (message.confidence ?? 1) >= lowConfidence && message.source !== 'you';
  return [
    ['STATE', message.unread ? 'UNREAD' : 'READ'],
    ['THREAD', `${conversation?.count || 1} MESSAGE${conversation?.count === 1 ? '' : 'S'}`],
    ['SOURCE', String(message._provenance || 'gmail').toUpperCase()],
    ...(!confident ? [['CONFIDENCE', `${Math.round((message.confidence ?? 1) * 100)}%`]] : []),
  ];
}

/** Render a semantic definition list using text-only DOM writes. */
export function renderMessageFacts(container, message, store, lowConfidence, doc = document) {
  if (!container) return;
  const frag = doc.createDocumentFragment();
  for (const [key, value] of messageFacts(message, store, lowConfidence)) {
    const fact = doc.createElement('div');
    fact.className = 'r-fact';
    const term = doc.createElement('dt');
    term.textContent = key;
    const description = doc.createElement('dd');
    description.textContent = value;
    fact.append(term, description);
    frag.appendChild(fact);
  }
  container.replaceChildren(frag);
}
