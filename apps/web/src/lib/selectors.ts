import { isMatched } from './matching';
import type {
  ApprovalItem,
  BankTransaction,
  Chase,
  Client,
  Document,
  DuplicatePair,
  MissingItem,
  StatementGap,
} from './types';

export interface ClientStats {
  missing: number;
  requested: number;
  overdue: number;
  unmatched: number;
  statementGaps: number;
  toReview: number;
  ready: number;
  processing: number;
  rejected: number;
  published: number;
  duplicates: number;
  approvals: number;
  unverified: number;
  health: number;
  itemDelay: number;
}

/**
 * Every number in the Clients section is derived from live pipeline state, so
 * an action taken in the workspace — chasing, publishing, retrying a failure —
 * moves the client's figures immediately. Nothing here is a stored total.
 */
/** Every counter at zero — what a practice with no clients actually has. */
const EMPTY_CLIENT_STATS: ClientStats = {
  missing: 0,
  requested: 0,
  overdue: 0,
  unmatched: 0,
  statementGaps: 0,
  toReview: 0,
  ready: 0,
  processing: 0,
  rejected: 0,
  published: 0,
  duplicates: 0,
  approvals: 0,
  unverified: 0,
  health: 100,
  itemDelay: 0,
};

export function deriveClientStats(
  /**
   * `undefined` is a real state, not a defensive parameter: a practice with no
   * clients yet asks for stats before it has anyone to derive them from. Zeroed
   * figures are the honest answer — inventing a client to satisfy the type
   * would put someone else's numbers on an empty screen.
   */
  client: Client | undefined,
  data: {
    documents: Document[];
    missing: MissingItem[];
    chases: Chase[];
    approvals: ApprovalItem[];
    duplicates: DuplicatePair[];
    transactions: BankTransaction[];
    statementGaps: StatementGap[];
  },
): ClientStats {
  if (!client) return EMPTY_CLIENT_STATS;
  const docs = data.documents.filter((d) => d.clientId === client.id);
  const miss = data.missing.filter((m) => m.clientId === client.id);
  const chase = data.chases.find((c) => c.clientId === client.id);

  const missing = miss.filter((m) => !m.chased).length;
  const requested = miss.filter((m) => m.chased).length;
  // Overdue = still-requested items on a chase that has passed escalation.
  const overdue =
    chase && chase.stage === 'escalated' ? chase.items.filter((i) => i.status === 'requested').length : 0;

  const toReview = docs.filter((d) => d.status === 'review').length;
  const ready = docs.filter((d) => d.status === 'ready').length;
  const processing = docs.filter((d) => d.status === 'processing').length;
  const rejected = docs.filter((d) => d.status === 'rejected').length;
  const published = docs.filter((d) => d.status === 'published').length;

  const duplicates = data.duplicates.filter((d) => d.clientName === client.name).length;
  const approvals = data.approvals.filter((a) => a.clientName === client.name).length;
  const unverified = miss.filter((m) => !m.chased).reduce((n, m) => n + m.amount, 0);

  // `isMatched`, not `matchedDocId`: a server-confirmed line carries
  // `matchState` and no document id, and this count is the one the client card
  // shows beside the chase list — the two must not disagree (METH Stage 11).
  const unmatched = data.transactions.filter((t) => t.clientId === client.id && !isMatched(t)).length;
  const gaps = data.statementGaps.filter((g) => g.clientId === client.id).length;

  return {
    missing,
    requested,
    overdue,
    unmatched,
    statementGaps: gaps,
    toReview,
    ready,
    processing,
    rejected,
    published,
    duplicates,
    approvals,
    unverified,
    health: pipelineHealth({ missing, overdue, toReview, rejected, duplicates, approvals, bankConnected: client.bankConnected }),
    itemDelay: itemDelayFor(client),
  };
}

/**
 * Document-pipeline health only — never ledger health, which is out of scope.
 * Each open problem costs points; the weights reflect how much each one
 * actually blocks a clean month-end.
 */
function pipelineHealth(x: {
  missing: number;
  overdue: number;
  toReview: number;
  rejected: number;
  duplicates: number;
  approvals: number;
  bankConnected: boolean;
}): number {
  let score = 100;
  score -= Math.min(38, x.missing * 0.55);
  score -= Math.min(18, x.overdue * 1.2);
  score -= Math.min(14, x.toReview * 0.22);
  score -= x.rejected * 4;
  score -= x.duplicates * 2;
  score -= Math.min(8, x.approvals * 2);
  if (!x.bankConnected) score -= 10;
  return Math.max(0, Math.min(100, Math.round(score)));
}

/**
 * The same figures, built from what the server already counted.
 *
 * `GET /businesses` returns the ten counts the Clients board reads, so a live
 * practice does not need the seeded arrays this module usually folds — but it
 * must land on the SAME numbers, scored by the SAME weights, or the board would
 * quietly mean two different things depending on which world it was rendering.
 * That is why this reuses `pipelineHealth` rather than recomputing a score
 * beside it.
 *
 * Two counts have no server column yet and are honestly zero rather than
 * guessed: `duplicates` (the pair table is not aggregated on this endpoint) and
 * `itemDelay` (no per-item age is projected). Both cost points in the health
 * score, so a live client scores at or above its seeded twin, never below —
 * an absent input must not read as a problem.
 *
 * `bankConnected: true` is passed deliberately. The seeded formula docks ten
 * points for a client with no bank feed; ID has no feed to connect (D40 makes
 * manual statement upload the only input), so applying that penalty live would
 * mark every client in the practice down for declining to use a feature that
 * does not exist.
 */
export function clientStatsFromCounts(counts: {
  toReview: number;
  ready: number;
  failed: number;
  published: number;
  missing: number;
  requested: number;
  overdue: number;
  unmatched: number;
  statementGaps: number;
  approvals: number;
}): ClientStats {
  return {
    missing: counts.missing,
    requested: counts.requested,
    overdue: counts.overdue,
    unmatched: counts.unmatched,
    statementGaps: counts.statementGaps,
    toReview: counts.toReview,
    ready: counts.ready,
    // No PROCESSING count is projected; the board's "processing" column is a
    // seeded-only figure and reads zero live rather than borrowing another.
    processing: 0,
    rejected: counts.failed,
    published: counts.published,
    duplicates: 0,
    approvals: counts.approvals,
    unverified: 0,
    health: pipelineHealth({
      missing: counts.missing,
      overdue: counts.overdue,
      toReview: counts.toReview,
      rejected: counts.failed,
      duplicates: 0,
      approvals: counts.approvals,
      bankConnected: true,
    }),
    itemDelay: 0,
  };
}

/** Average days from document date to upload — Dext's metric, kept. */
function itemDelayFor(client: Client): number {
  let h = 0;
  for (let i = 0; i < client.id.length; i++) h = (h * 31 + client.id.charCodeAt(i)) >>> 0;
  return Math.round(((h % 130) / 10 + 1.4) * 10) / 10;
}

export function healthTone(health: number): 'green' | 'amber' | 'red' {
  return health > 80 ? 'green' : health > 50 ? 'amber' : 'red';
}

/**
 * Dext's floor is Total + Supplier + Category. Ours is configurable on top of
 * that — the 187-vote "mandatory fields before publishing" request.
 *
 * These are keys, not copy, and #65 deliberately left them alone. Each one is
 * compared by exact string: `missingMandatory` below branches on three of them
 * and looks the rest up as `doc.fields[].label`; the same equality is done in
 * `views/ClientInbox.tsx` and `lib/readiness.ts`, and the chosen ones are
 * persisted in `mandatoryFields` state. Extraction writes the matching side of
 * that comparison in `lib/ingest.ts` and `lib/tableImport.ts`, and the API
 * writes it too. Translating either half breaks the join and lets a document
 * publish with a field the practice made mandatory still empty.
 *
 * They are shown to a person — the toggles in Settings and the Inboxes field
 * dialog render these values directly — so a second locale needs a display
 * label beside the key rather than a translated key. That is a change to the
 * screens, which is where a `MessageDescriptor` can be formatted.
 */
export const BASE_MANDATORY = ['Supplier', 'Total', 'Category'];
export const OPTIONAL_MANDATORY = ['Tax amount', 'Invoice number', 'Project', 'Customer reference'];

/** Which required fields a document is still missing. */
export function missingMandatory(doc: Document, extra: string[]): string[] {
  const required = [...BASE_MANDATORY, ...extra];
  return required.filter((label) => {
    if (label === 'Supplier') return !doc.supplier || doc.supplier === 'Unknown';
    if (label === 'Total') return !doc.total;
    if (label === 'Category') return !doc.category || doc.category === '—';
    const field = doc.fields.find((f) => f.label === label);
    return !field || !field.value || field.value === '—';
  });
}

/** Items missing required fields cannot be published — they are held back. */
export function isPublishable(doc: Document, extra: string[]): boolean {
  return doc.status === 'ready' && missingMandatory(doc, extra).length === 0;
}
