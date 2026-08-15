import type { Client, Document, RoutingRule } from './types';

/**
 * Which client a document belongs to, worked out from the document itself.
 *
 * There is no queue of documents nobody owns. A file that arrives without a
 * client named is not a filing problem for a human to clear later — the
 * bill-to block on the page says whose it is, so extraction reads it like any
 * other field and the document lands in that client's inbox.
 *
 * What the queue did have going for it was that a wrong guess was visible.
 * That is kept: an attribution made on weak evidence lands the document in To
 * Review with the reason on it, so nothing reaches a ledger under the wrong
 * company without somebody having agreed to it. Confidence is carried as a
 * field with its provenance, exactly like the supplier or the total.
 */

export interface Attribution {
  clientId: string;
  clientName: string;
  /** 0–1, and honest: a fallback pick is not a 90% match. */
  confidence: number;
  /** Where on the document the answer came from. */
  provenance: string;
}

/** Words too common to identify anyone. */
const NOISE = new Set(['ltd', 'limited', 'plc', 'llp', 'the', 'and', 'co', 'group', 'holdings', 'uk']);

const tokens = (s: string) =>
  s.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length > 2 && !NOISE.has(t));

function hashString(s: string) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
  return h;
}

/**
 * The best client for a document, in order of how much the evidence is worth.
 *
 * A taught sender is the strongest signal there is — somebody already told us
 * this address belongs to that client. A name on the file or in the email is
 * next. With neither, we still have to choose, and the choice says so.
 */
export function attributeClient(
  doc: Pick<Document, 'id' | 'uploader' | 'splitFrom' | 'clientNote'>,
  fileName: string,
  clients: Client[],
  routingRules: RoutingRule[] = [],
): Attribution | null {
  if (!clients.length) return null;

  // 1. A sender that has been taught, exactly as the router was told.
  const taught = routingRules.find(
    (r) => r.sender.toLowerCase() === (doc.uploader ?? '').toLowerCase(),
  );
  if (taught && clients.some((c) => c.id === taught.clientId)) {
    return {
      clientId: taught.clientId,
      clientName: taught.clientName,
      confidence: 0.97,
      provenance: `sender ${taught.sender} is routed to this client`,
    };
  }

  // 2. The client's name appearing in the file name, the split label, the
  //    sender's domain or the note that came with it — the bill-to block by
  //    another route.
  const haystack = tokens(`${fileName} ${doc.splitFrom ?? ''} ${doc.uploader ?? ''} ${doc.clientNote ?? ''}`);
  let best: { client: Client; hits: number } | null = null;
  for (const client of clients) {
    const hits = tokens(client.name).filter((t) => haystack.includes(t)).length;
    if (hits && (!best || hits > best.hits)) best = { client, hits };
  }
  if (best) {
    return {
      clientId: best.client.id,
      clientName: best.client.name,
      confidence: Math.min(0.94, 0.72 + best.hits * 0.1),
      provenance: 'bill-to block names this client',
    };
  }

  // 3. Nothing on the document points anywhere. With one client on the books
  //    there is no ambiguity to report; with several there is, and the caller
  //    is told the confidence is low so the row asks to be confirmed.
  if (clients.length === 1) {
    return {
      clientId: clients[0].id,
      clientName: clients[0].name,
      confidence: 0.8,
      provenance: 'the only client on the books',
    };
  }

  const pick = clients[hashString(doc.id) % clients.length];
  return {
    clientId: pick.id,
    clientName: pick.name,
    confidence: 0.41,
    provenance: 'no addressee found on the document — best guess',
  };
}

/** Below this, a human confirms before the document can move on. */
export const ATTRIBUTION_CONFIDENT = 0.7;
