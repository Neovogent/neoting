import type { ApprovalItem, Chase, Client, Document, MissingItem } from './types';

/**
 * What to suggest typing, based on what is actually waiting.
 *
 * The old placeholder said "Type something to generate…", which asks the
 * accountant to invent the product's vocabulary from nothing — the blank-page
 * problem, on the screen they land on every morning. The five chips underneath
 * were fixed strings, so they named clients who might have nothing wrong and
 * stayed identical after the work was done.
 *
 * These are read off the same state the dashboards read: what is missing, what
 * is overdue, what is sitting in review, what failed. Ranked by what would
 * actually hurt to leave — a failed publish is money not in the ledger; a
 * chase overdue by a week is a client relationship going quiet — so the
 * first thing offered is usually the first thing worth doing.
 */

export interface Suggestion {
  /** The sentence typed into the box. */
  text: string;
  /** Why it is being offered, for the line under the box. */
  because: string;
  /** Higher is more urgent. Ties keep source order. */
  weight: number;
}

export interface SuggestionInput {
  clients: Client[];
  documents: Document[];
  missing: MissingItem[];
  chases: Chase[];
  approvals: ApprovalItem[];
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** The client with the most of something, for naming a specific company. */
function worst<T>(items: T[], keyOf: (item: T) => string): { key: string; count: number } | null {
  const counts = new Map<string, number>();
  for (const item of items) {
    const key = keyOf(item);
    if (key) counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  let best: { key: string; count: number } | null = null;
  for (const [key, count] of counts) if (!best || count > best.count) best = { key, count };
  return best;
}

export function suggestPrompts({ clients, documents, missing, chases, approvals }: SuggestionInput): Suggestion[] {
  const out: Suggestion[] = [];

  // Failed publishes: the ledger is wrong until these clear.
  const failed = documents.filter((d) => d.status === 'rejected');
  if (failed.length) {
    out.push({
      text: `What failed to publish, and why?`,
      because: `${plural(failed.length, 'document')} failed`,
      weight: 100,
    });
  }

  // Chases nobody has answered, oldest first — this is the relationship risk.
  const stale = chases.filter((c) => c.stage !== 'closed' && c.hoursSinceSent >= 72);
  if (stale.length) {
    const oldest = [...stale].sort((a, b) => b.hoursSinceSent - a.hoursSinceSent)[0];
    out.push({
      text: `Which chases have had no reply, and what should I do about ${oldest.clientName}?`,
      because: `${plural(stale.length, 'chase')} unanswered for 3 days or more`,
      weight: 90,
    });
  }

  // Missing documents, named at the client who has the most of them.
  if (missing.length) {
    const top = worst(missing, (m) => m.clientName);
    if (top) {
      out.push({
        text: `Chase ${top.key} for the ${plural(top.count, 'document')} still missing`,
        because: `${top.key} is short ${plural(top.count, 'document')}`,
        weight: 80,
      });
    }
    out.push({
      text: `Show everything missing across all clients`,
      because: `${plural(missing.length, 'item')} outstanding in total`,
      weight: 55,
    });
  }

  // Approvals aging: someone is waiting on a signature.
  const aging = approvals.filter((a) => a.state === 'pending' && a.waitingDays >= 5);
  if (aging.length) {
    out.push({
      text: `What is waiting on my approval, oldest first?`,
      because: `${plural(aging.length, 'approval')} waiting 5 days or more`,
      weight: 85,
    });
  } else if (approvals.some((a) => a.state === 'pending')) {
    out.push({ text: `Anything need approving?`, because: 'items are pending approval', weight: 45 });
  }

  // The review queue, where a document cannot move without a human.
  const review = documents.filter((d) => d.status === 'review');
  if (review.length) {
    const blocked = review.filter((d) => d.category === '—' || !d.category).length;
    out.push({
      text: blocked
        ? `Which documents are missing a category?`
        : `Show me everything waiting to be reviewed`,
      because: blocked ? `${plural(blocked, 'document')} with no category` : `${plural(review.length, 'document')} to review`,
      weight: 70,
    });
  }

  // Ready to publish: the satisfying one, and genuinely the next action.
  const ready = documents.filter((d) => d.status === 'ready');
  if (ready.length) {
    const value = ready.reduce((sum, d) => sum + d.total, 0);
    out.push({
      text: `Publish everything that is ready`,
      because: `${plural(ready.length, 'document')} ready · £${value.toLocaleString('en-GB', { minimumFractionDigits: 2 })}`,
      weight: 60,
    });
  }

  // A rule, which is the feature people forget exists.
  const supplier = worst(
    documents.filter((d) => d.kind === 'cost' && d.supplier && d.supplier !== 'Unknown'),
    (d) => d.supplier,
  );
  if (supplier && supplier.count > 1) {
    out.push({
      text: `Whenever ${supplier.key} invoices arrive, code them the same way every time`,
      because: `${supplier.key} has sent ${plural(supplier.count, 'document')}`,
      weight: 40,
    });
  }

  // Always something to say, even on a clean morning.
  if (out.length < 3) {
    const name = clients[0]?.name;
    out.push({ text: `How is the month looking?`, because: 'nothing urgent is outstanding', weight: 10 });
    if (name) {
      out.push({ text: `Give me a summary for ${name}`, because: 'a client overview', weight: 5 });
    }
  }

  return out.sort((a, b) => b.weight - a.weight).slice(0, 6);
}
