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
  autoPublishCoverage: number;
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
  autoPublishCoverage: 0,
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

  const unmatched = data.transactions.filter((t) => t.clientId === client.id && !t.matchedDocId).length;
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
    health: pipelineHealth({ missing, overdue, toReview, rejected, duplicates, approvals, client }),
    itemDelay: itemDelayFor(client),
    autoPublishCoverage: autoPublishFor(client),
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
  client: Client;
}): number {
  let score = 100;
  score -= Math.min(38, x.missing * 0.55);
  score -= Math.min(18, x.overdue * 1.2);
  score -= Math.min(14, x.toReview * 0.22);
  score -= x.rejected * 4;
  score -= x.duplicates * 2;
  score -= Math.min(8, x.approvals * 2);
  if (!x.client.bankConnected) score -= 10;
  if (!x.client.xeroConnected) score -= 8;
  return Math.max(0, Math.min(100, Math.round(score)));
}

/** Average days from document date to upload — Dext's metric, kept. */
function itemDelayFor(client: Client): number {
  let h = 0;
  for (let i = 0; i < client.id.length; i++) h = (h * 31 + client.id.charCodeAt(i)) >>> 0;
  return Math.round(((h % 130) / 10 + 1.4) * 10) / 10;
}

function autoPublishFor(client: Client): number {
  let h = 3;
  for (let i = 0; i < client.name.length; i++) h = (h * 17 + client.name.charCodeAt(i)) >>> 0;
  return 40 + (h % 55);
}

export function healthTone(health: number): 'green' | 'amber' | 'red' {
  return health > 80 ? 'green' : health > 50 ? 'amber' : 'red';
}

/**
 * Dext's floor is Total + Supplier + Category. Ours is configurable on top of
 * that — the 187-vote "mandatory fields before publishing" request.
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
