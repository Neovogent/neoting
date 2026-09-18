import { z } from 'zod';

import type { ScopedClient } from '../../../common/db/scoped-db.js';

/**
 * The `ReferenceSync` service (D50, build brief Stage 1) — pulling the client's
 * own nominal codes, suppliers, tax rates and bank accounts out of their ledger
 * so our coding matches theirs.
 *
 * ## ⚠ The table is NOT empty, and that is the important thing to know first
 *
 * The brief describes `reference_syncs` as "table only — there is no code
 * behind it". That is true of the LEDGER half and false in general:
 * `rules-suggestions/chart-of-accounts/chart-of-accounts.service.ts` already
 * writes `listKind: 'chart_of_accounts'`, `chat-framework/grounding.ts` already
 * reads it, and that service's own header states a rule this one must not
 * break — *"It never overwrites. §24.4.1 says the chart is owned and edited by
 * the accountant thereafter."*
 *
 * So a ledger sync **does not touch `chart_of_accounts`**. The vendor's real
 * lists land under their own `listKind`s, beside the accountant's chart rather
 * than over it, and the publish path resolves a document's category against the
 * vendor's list at the moment of posting. An accountant's edit therefore
 * survives every sync, and a client who renames an account in Xero sees the
 * change at the next sync without anybody's work being silently replaced.
 *
 * ## Shape
 *
 * One row per `(integrationId, listKind)` — the unique index the schema already
 * has — holding a whole list as one JSON payload. Not one row per account:
 * these lists are read whole, written whole, and are a few hundred entries at
 * most, so a row per entry would be a join to rebuild something that was never
 * usefully apart.
 */

/** The four lists a ledger connection keeps in step. Values are stored in a string column — do not rename. */
export const LEDGER_LIST_KINDS = {
  accounts: 'ledger_accounts',
  suppliers: 'ledger_suppliers',
  taxRates: 'ledger_tax_rates',
  bankAccounts: 'ledger_bank_accounts',
} as const;

export type LedgerListKind = (typeof LEDGER_LIST_KINDS)[keyof typeof LEDGER_LIST_KINDS];

/**
 * One entry in a synced list.
 *
 * `id` is the vendor's own identifier and `code` is what a human types — for a
 * nominal account those differ on three of the four platforms, and posting
 * needs the first while matching a document's `categoryCode` needs the second.
 * Both are kept rather than picking one and regretting it at the first
 * platform that disagrees.
 */
export const ReferenceItemSchema = z.object({
  id: z.string().min(1),
  code: z.string().nullable(),
  name: z.string(),
  /** Tax rates only: the percentage as an integer in basis points — 20% is 2000. No floats. */
  rateBasisPoints: z.number().int().nullable().optional(),
  /** Whether the vendor still offers this entry for new transactions. */
  active: z.boolean().optional(),
});

export type ReferenceItem = z.infer<typeof ReferenceItemSchema>;

/**
 * The stored payload.
 *
 * Versioned for the same reason the chart's payload is: a shape change has to
 * be distinguishable at read time, because rows written by an older build are
 * still in the table.
 */
export const REFERENCE_PAYLOAD_VERSION = 1;

const StoredListSchema = z.object({
  version: z.number().int(),
  items: z.array(ReferenceItemSchema).max(5000),
  /** Vendors' own incremental cursor, where they have one. QuickBooks' Change Data Capture uses it. */
  cursor: z.string().nullable().optional(),
});

/** Every list one sync produced. A vendor that does not offer a list simply omits it. */
export type ReferenceLists = Partial<Record<LedgerListKind, readonly ReferenceItem[]>>;

/**
 * Write the lists for one connection.
 *
 * ⚠ **Takes an OPEN `ScopedClient` rather than a Prisma client and a context.**
 * A sync runs after a vendor round trip, never during one, and the caller is
 * what owns that ordering — this function is the short transaction at the end
 * of it. `ScopedClient` has no `$transaction`, so it structurally cannot open a
 * second one inside somebody else's.
 */
export async function writeReferenceLists(
  db: ScopedClient,
  integrationId: string,
  lists: ReferenceLists,
  cursor: string | null = null,
  mode: ReferenceWriteMode = 'replace',
): Promise<number> {
  let written = 0;
  for (const [listKind, items] of Object.entries(lists)) {
    if (items === undefined) continue;
    const merged = mode === 'merge' ? await mergeOver(db, integrationId, listKind as LedgerListKind, items) : items;
    const payload = { version: REFERENCE_PAYLOAD_VERSION, items: merged, cursor };
    await db.referenceSync.upsert({
      where: { integrationId_listKind: { integrationId, listKind } },
      create: { integrationId, listKind, payload },
      update: { payload, syncedAt: new Date() },
    });
    written += merged.length;
  }
  return written;
}

/**
 * ⚠ **`merge` exists because a DELTA overwrote a full list and emptied it.**
 *
 * QuickBooks' Change Data Capture returns only what MOVED since the last sync —
 * which is the whole point of it, and Intuit meters reads — and this writer
 * replaced the stored list with it. On 18 Sep 2026 a manual Sync on a live
 * connection returned *0 accounts, 2 suppliers, 0 tax codes* and wrote exactly
 * that: **76 accounts became 0**, and the client's chart of accounts ceased to
 * exist. No error, a 200, and a green "OK" on the connection.
 *
 * A delta is merged over what is stored; a full list still replaces, because a
 * full list is the whole truth and merging one would resurrect rows the vendor
 * has stopped returning.
 */
export type ReferenceWriteMode = 'replace' | 'merge';

/**
 * Stored items with the incoming ones written over them, keyed by vendor id.
 *
 * ⚠ **A row the delta does not mention SURVIVES.** That is the entire point;
 * the alternative is the bug this exists to close.
 *
 * ⚠ It cannot see DELETIONS, and that is a known and deliberate shortfall: a
 * merge keeps an account the client has since archived, so it stays codeable
 * until the next full sync. That is a smaller wrong than deleting a client's
 * whole chart, and it is why `syncIntegration` still forces a full read when
 * the stored list is empty.
 */
async function mergeOver(
  db: ScopedClient,
  integrationId: string,
  listKind: LedgerListKind,
  incoming: readonly ReferenceItem[],
): Promise<readonly ReferenceItem[]> {
  const stored = await readReferenceList(db, integrationId, listKind);
  return mergeItems(stored?.items ?? [], incoming);
}

/**
 * The merge itself, pure so it can be tested without a database.
 *
 * Nothing stored means the incoming list IS the list. Otherwise every stored
 * row survives unless the delta names it.
 */
export function mergeItems(
  stored: readonly ReferenceItem[],
  incoming: readonly ReferenceItem[],
): readonly ReferenceItem[] {
  if (stored.length === 0) return incoming;
  const byId = new Map(stored.map((item) => [item.id, item]));
  for (const item of incoming) byId.set(item.id, item);
  return [...byId.values()];
}

/**
 * Read one list back, or null when it has never been synced.
 *
 * ⚠ **Parsed, not cast.** `payload` is `jsonb`: the row was written by some
 * build of this code, possibly an older one, and Postgres guarantees it is
 * valid JSON and nothing else. A cast here would put an unvalidated shape into
 * the middle of the posting path.
 */
export async function readReferenceList(
  db: ScopedClient,
  integrationId: string,
  listKind: LedgerListKind,
): Promise<{ readonly items: readonly ReferenceItem[]; readonly cursor: string | null; readonly syncedAt: Date } | null> {
  const row = await db.referenceSync.findUnique({
    where: { integrationId_listKind: { integrationId, listKind } },
    select: { payload: true, syncedAt: true },
  });
  if (row === null) return null;
  const parsed = StoredListSchema.safeParse(row.payload);
  if (!parsed.success) return null;
  return { items: parsed.data.items, cursor: parsed.data.cursor ?? null, syncedAt: row.syncedAt };
}

/**
 * Find the ledger account a document's `categoryCode` means.
 *
 * ⚠ **It refuses rather than guessing, and that is the whole design.** Posting
 * to the wrong nominal is a silent error an accountant finds at the year end;
 * refusing the item puts it on the Rejected surface with a reason today. So the
 * match is exact on code, then exact on name (case- and space-insensitive,
 * because "Motor Vehicle Expenses" and "motor vehicle expenses" are the same
 * account and nobody should have to know that), and then nothing.
 *
 * The name fallback exists because our own chart codes and a client's Xero
 * codes genuinely differ — `429` in one is not `429` in the other — while the
 * account NAMES are the part an accountant recognises.
 */
export function matchAccount(items: readonly ReferenceItem[], categoryCode: string): ReferenceItem | null {
  const wanted = categoryCode.trim();
  if (wanted === '') return null;
  const usable = items.filter((item) => item.active !== false);

  const byCode = usable.find((item) => item.code !== null && item.code.trim() === wanted);
  if (byCode !== undefined) return byCode;

  // ⚠ By the vendor's own ID, because that is what a connected client's chart
  // CODE now is when the vendor gives its accounts no code of their own —
  // QuickBooks' `AcctNum` is optional and most sandbox accounts have none.
  // Without this the chart would offer a category that could never resolve, and
  // the publish would refuse "nothing to code this to" on a code the product
  // itself had just handed the accountant.
  const byId = usable.find((item) => item.id === wanted);
  if (byId !== undefined) return byId;

  const normalised = normalise(wanted);
  const byName = usable.find((item) => normalise(item.name) === normalised);
  return byName ?? null;
}

/**
 * The VAT rate this document actually carries, in basis points.
 *
 * ⚠ **Derived from the paper, never assumed.** 2000 is the standard UK rate and
 * also the wrong answer for most of a food wholesaler's delivery, which is
 * largely zero-rated — posting 20% on it would put VAT in a client's books that
 * they never paid and that nothing downstream would flag.
 *
 * Integer arithmetic throughout: a rate is not money, but it is computed FROM
 * money, and `tax * 10000 / net` in integers cannot drift the way a float
 * division would. Net is the gross minus the tax, because `totalPence` is the
 * GROSS figure a human read off the document and approved.
 *
 * A zero or negative net means there is nothing to charge VAT on, and the
 * honest rate is zero rather than a division nobody can defend.
 */
export function documentRateBasisPoints(totalPence: number, taxPence: number): number {
  const net = totalPence - taxPence;
  if (net <= 0) return 0;
  return Math.round((taxPence * 10_000) / net);
}

/**
 * The vendor's tax code for a rate, or null when they publish nothing that
 * matches.
 *
 * ⚠ **Null is a REFUSAL, not a licence to send the standard rate.** The caller
 * fails the item with a sentence naming the rate it wanted; a vendor that
 * offers no zero-rate code is a real situation and guessing past it writes a
 * VAT figure into somebody's books on our authority.
 *
 * ⚠ **The tolerance is 1 basis point, and it is not slack** — it absorbs the
 * rounding in `documentRateBasisPoints` (a £482.40 gross at 20% lands a point
 * either side depending on the pence), and nothing wider, because 1750 and 2000
 * are different taxes rather than different roundings.
 */
export function matchTaxRate(items: readonly ReferenceItem[], basisPoints: number): ReferenceItem | null {
  const usable = items.filter((item) => item.active !== false && item.rateBasisPoints !== null);
  return usable.find((item) => Math.abs((item.rateBasisPoints ?? -1) - basisPoints) <= 1) ?? null;
}

/** Find a supplier the client already has, so publishing does not create a second one. */
export function matchSupplier(items: readonly ReferenceItem[], supplierName: string): ReferenceItem | null {
  const wanted = normalise(supplierName);
  if (wanted === '') return null;
  return items.find((item) => normalise(item.name) === wanted) ?? null;
}

/**
 * Case-, space- and punctuation-insensitive.
 *
 * `Amazon Web Services, Inc.` and `AMAZON WEB SERVICES INC` are one supplier,
 * and a match that missed them would create a duplicate contact in the client's
 * books on every publish — the "republishing historically creates duplicate
 * vendors" failure SoT §17.1 names by name.
 */
function normalise(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}
