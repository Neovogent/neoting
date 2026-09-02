import { z } from 'zod';

import type { ScopedClient } from '../../common/db/scoped-db.js';
import { notDeleted } from '../../common/documents/deleted-documents.js';
import { wrapUntrusted } from '../../common/untrusted-content.js';

/**
 * Client-scoped grounding (Governance §9.4).
 *
 * The rule is absolute: a client-scoped answer comes **exclusively** from that
 * client's pipeline records, retrieved through the same RLS-scoped services the
 * UI uses. This module is the retrieval half and the verification half, and the
 * second half is what makes the first half worth anything:
 *
 * - `retrieveRecords` reads through the caller's `ScopedClient`, so RLS decides
 *   what exists. There is no `businessId` filter written by hand anywhere in
 *   here — a hand-written tenancy clause alongside an RLS policy is two
 *   mechanisms that can disagree, and the permissive one wins exactly when it
 *   matters (the documents-module rule).
 * - `verifyCitations` rejects any record id the model cited that was not in the
 *   set we handed it. §9.4 forbids inventing; this is the enforcement, not the
 *   aspiration. A model that fabricates a plausible id fails the turn.
 *
 * Every retrieved value that originated outside the practice — a supplier name
 * off a scanned receipt, a bank narrative, a description a client typed — is
 * wrapped before it is rendered into the prompt (§9.6). Supplier names come off
 * documents that arrived by email and WhatsApp; treating them as trusted
 * because they now live in our database is exactly the mistake the wrapper
 * exists to prevent.
 */

export interface GroundedRecord {
  readonly id: string;
  readonly type: 'document' | 'chase' | 'bankTransaction' | 'publish' | 'extraction' | 'statement';
  /** Short, already client-scoped, for the UI's reference chip. */
  readonly label: string;
  /** The line the model reads. Untrusted fragments already wrapped. */
  readonly line: string;
}

export interface CategoryOption {
  readonly code: string;
  readonly name: string;
}

const CoaPayloadSchema = z.object({
  categories: z.array(z.object({ code: z.string(), name: z.string() })).max(500),
});

const RETRIEVAL_LIMIT = 40;

/**
 * The client's own synced reference list. A rule's category MUST come from
 * here — §9.4's "cannot invent" applied to the chart of accounts, which is the
 * field an accountant is least able to spot as wrong at a glance.
 *
 * Returns empty when the client has no synced integration, and an empty list
 * makes every rule draft fail validation rather than fall back to a global
 * default. That is deliberate: coding a client's books against another client's
 * chart is worse than refusing to code them.
 */
export async function loadCategories(db: ScopedClient, businessId: string): Promise<readonly CategoryOption[]> {
  const syncs = await db.referenceSync.findMany({
    where: { listKind: 'chart_of_accounts', integration: { businessId } },
    orderBy: { syncedAt: 'desc' },
    take: 1,
  });

  const payload = syncs[0]?.payload;
  if (payload === undefined || payload === null) return [];

  const parsed = CoaPayloadSchema.safeParse(payload);
  // A malformed reference list is a broken sync, not a reason to guess. Empty
  // means every rule draft is refused, which is the visible failure.
  if (!parsed.success) return [];
  return parsed.data.categories.map((c) => ({ code: c.code, name: c.name }));
}

/**
 * The records a question may be answered from. Deliberately a fixed, small,
 * recent window rather than a search: §9.5 caps token spend per session, and an
 * unbounded retrieval on a chat turn is the cost bug that ships quietly.
 */
export async function retrieveRecords(db: ScopedClient, businessId: string): Promise<readonly GroundedRecord[]> {
  const [documents, transactions, statements, chases] = await Promise.all([
    // `notDeleted()` beside the existing `archivedAt: null` — two columns, two
    // clauses. This window IS the answer's evidence, so a deleted document here
    // does not merely show up, it gets CITED: the model would answer "the £420
    // Amazon invoice" about a document the accountant removed, with a record id
    // attached to make it credible. It also costs a retrieval slot — the window
    // is a fixed `RETRIEVAL_LIMIT` (§9.5), so every trashed row crowds out a
    // live one the question may actually have been about.
    db.document.findMany({
      where: { businessId, archivedAt: null, ...notDeleted() },
      orderBy: { receivedAt: 'desc' },
      take: RETRIEVAL_LIMIT,
      select: {
        id: true,
        supplierName: true,
        totalPence: true,
        taxPence: true,
        documentDate: true,
        state: true,
        categoryCode: true,
        currency: true,
      },
    }),
    db.bankTransaction.findMany({
      where: { businessId },
      orderBy: { bookedAt: 'desc' },
      take: RETRIEVAL_LIMIT,
      select: {
        id: true,
        descriptionRaw: true,
        merchantName: true,
        amountPence: true,
        bookedAt: true,
        matchState: true,
        chaseSuppressed: true,
      },
    }),
    // D40 makes manual statement upload the ONLY bank input in ID, so a
    // client's statements are this product's own pipeline records — not
    // something that lives in a banking platform we could send someone to.
    // Newest period first, then newest import: the same order `GET /statements`
    // uses, so the Bank tab and the chat never disagree about which upload is
    // the latest attempt at a month.
    db.statement.findMany({
      where: { businessId },
      orderBy: [{ periodEnd: 'desc' }, { createdAt: 'desc' }],
      take: RETRIEVAL_LIMIT,
      select: {
        id: true,
        periodStart: true,
        periodEnd: true,
        rowCount: true,
        gapAnalysis: true,
      },
    }),
    db.chase.findMany({
      where: { businessId },
      orderBy: { createdAt: 'desc' },
      take: 20,
      select: { id: true, state: true, createdAt: true, detectionEngine: true },
    }),
  ]);

  const records: GroundedRecord[] = [];

  for (const doc of documents) {
    const supplier = doc.supplierName ?? 'unknown supplier';
    records.push({
      id: doc.id,
      type: 'document',
      label: `${supplier} — ${money(doc.totalPence, doc.currency)}`,
      line: `[${doc.id}] document · supplier ${wrapUntrusted(supplier)} · total ${money(doc.totalPence, doc.currency)} · VAT ${money(doc.taxPence, doc.currency)} · dated ${day(doc.documentDate)} · state ${doc.state} · category ${doc.categoryCode ?? 'uncoded'}`,
    });
  }

  for (const tx of transactions) {
    const narrative = tx.merchantName ?? tx.descriptionRaw;
    records.push({
      id: tx.id,
      type: 'bankTransaction',
      label: `${narrative} — ${money(tx.amountPence, 'GBP')}`,
      line: `[${tx.id}] bank transaction · ${wrapUntrusted(narrative)} · ${money(tx.amountPence, 'GBP')} · booked ${day(tx.bookedAt)} · ${tx.matchState}${tx.chaseSuppressed ? ' · chase-suppressed' : ''}`,
    });
  }

  for (const statement of statements) {
    const verdict = readVerdict(statement.gapAnalysis);
    const rows = statement.rowCount ?? 0;
    records.push({
      id: statement.id,
      type: 'statement',
      label: `statement ${period(statement.periodStart, statement.periodEnd)} — ${rows} transactions · ${verdict.assurance}`,
      line:
        `[${statement.id}] bank statement · period ${period(statement.periodStart, statement.periodEnd)}` +
        ` · ${rows} transactions imported · ${verdict.sentence}`,
    });
  }

  for (const chase of chases) {
    records.push({
      id: chase.id,
      type: 'chase',
      label: `chase ${chase.state.toLowerCase()}`,
      line: `[${chase.id}] chase · state ${chase.state} · opened ${day(chase.createdAt)} · detected by ${chase.detectionEngine}`,
    });
  }

  return records;
}

/**
 * §9.4's enforcement: every cited id must be one we supplied.
 *
 * Returns the matched records, or `null` when ANY citation is unknown. Null is
 * a failed turn, not a filtered list — quietly dropping the fabricated citation
 * and rendering the rest would leave an answer standing on a source that does
 * not exist, which is the exact failure the citation requirement exists to
 * catch.
 */
export function verifyCitations(
  supplied: readonly GroundedRecord[],
  citedIds: readonly string[],
): readonly GroundedRecord[] | null {
  const byId = new Map(supplied.map((record) => [record.id, record]));
  const matched: GroundedRecord[] = [];

  for (const id of citedIds) {
    const record = byId.get(id);
    if (record === undefined) return null;
    matched.push(record);
  }
  return matched;
}

/** §9.4's literal fallback, verbatim. Not a template — the exact sentence. */
export const NO_RECORDS_ANSWER = "Information not available in this client's records.";

function money(pence: number | null, currency: string | null): string {
  if (pence === null) return 'unknown';
  const symbol = currency === null || currency === 'GBP' ? '£' : `${currency} `;
  return `${pence < 0 ? '-' : ''}${symbol}${(Math.abs(pence) / 100).toFixed(2)}`;
}

function day(value: Date | null): string {
  // UTC in storage, and the model is told the UTC date. Europe/London rendering
  // is the UI's job (Governance §12) — converting here would put two different
  // dates on one screen.
  return value === null ? 'undated' : value.toISOString().slice(0, 10);
}

/** A statement's covered period, or the honest statement that it has none. */
function period(start: Date | null, end: Date | null): string {
  if (start === null && end === null) return 'not stated on the file';
  return `${day(start)} to ${day(end)}`;
}

/**
 * The shape `banking-matching/statement-ingest/completeness.ts` writes into
 * `Statement.gapAnalysis`. Mirrored rather than imported: `no-cross-module-internals`
 * forbids reaching into that module, and the column is `Json?` anyway — what is
 * actually in it is a runtime question, not a compile-time one.
 */
interface StoredGapAnalysis {
  readonly assurance?: unknown;
  readonly provenBy?: unknown;
  readonly findings?: unknown;
}

/**
 * D41's verdict, in words the model can restate without softening.
 *
 * **This is the one field on a statement that must not be flattened.** "We read
 * every line and proved none is missing" and "we could not check whether any
 * line is missing" are opposite claims, and D40 makes the difference load-bearing:
 * statement upload is the only bank input in this release, so a transaction the
 * reader dropped is a payment nobody will ever be chased for and nothing else
 * will catch it. An answer that renders both as "the statement is imported"
 * tells an accountant their books are in a state they are not.
 *
 * ⚠ **An unreadable analysis reports `reduced`, never `complete`** — the same
 * rule, and the same reason, as `statements.service.ts`, which serves the Bank
 * tab from this column. `gapAnalysis` is a `Json?` column, so a row written by
 * an older build may carry anything; claiming a statement was proven whole
 * because its proof could not be parsed is the exact lie D41 exists to prevent.
 */
function readVerdict(value: unknown): { assurance: string; sentence: string } {
  const stored = (value as StoredGapAnalysis | null) ?? null;
  const assurance = stored?.assurance === 'complete' || stored?.assurance === 'incomplete' ? stored.assurance : 'reduced';
  const reason = firstFinding(stored?.findings);

  if (assurance === 'complete') {
    // `provenBy` names the method. An unrecognised one still means the gate
    // proved it — we simply cannot name how, and inventing a method is worse
    // than omitting one.
    const how = stored?.provenBy === 'balanceContinuity' ? 'balance continuity to the penny' : 'the completeness check';
    return {
      assurance,
      sentence: `completeness PROVEN — every line is accounted for, checked by ${how}`,
    };
  }

  if (assurance === 'incomplete') {
    return {
      assurance,
      sentence: `completeness CHECKED AND FAILED — lines are missing or unreadable${reason}`,
    };
  }

  return {
    assurance,
    sentence: `completeness COULD NOT BE CHECKED — the rows imported, but nothing proves none is missing${reason}`,
  };
}

/**
 * The gate's own words for what it found, wrapped (§9.6).
 *
 * A finding's `detail` quotes the uploaded file — a source line's preview, a
 * description off a client's bank statement — so it is content that arrived
 * from outside the practice, however deterministic the code that composed the
 * sentence around it. One finding plus a count: the model needs the reason, not
 * the register.
 */
function firstFinding(value: unknown): string {
  if (!Array.isArray(value) || value.length === 0) return '';
  const first = value[0] as Record<string, unknown> | null;
  const detail =
    typeof first?.['detail'] === 'string'
      ? first['detail']
      : typeof first?.['kind'] === 'string'
        ? first['kind']
        : null;
  if (detail === null) return '';
  const others = value.length - 1;
  return ` · reason ${wrapUntrusted(detail)}${others > 0 ? ` (and ${others} more finding${others === 1 ? '' : 's'})` : ''}`;
}
