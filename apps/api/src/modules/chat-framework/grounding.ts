import { z } from 'zod';

import type { ScopedClient } from '../../common/db/scoped-db.js';
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
  readonly type: 'document' | 'chase' | 'bankTransaction' | 'publish' | 'extraction';
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
  const [documents, transactions, chases] = await Promise.all([
    db.document.findMany({
      where: { businessId, archivedAt: null },
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
