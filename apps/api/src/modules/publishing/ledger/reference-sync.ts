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
): Promise<number> {
  let written = 0;
  for (const [listKind, items] of Object.entries(lists)) {
    if (items === undefined) continue;
    const payload = { version: REFERENCE_PAYLOAD_VERSION, items, cursor };
    await db.referenceSync.upsert({
      where: { integrationId_listKind: { integrationId, listKind } },
      create: { integrationId, listKind, payload },
      update: { payload, syncedAt: new Date() },
    });
    written += items.length;
  }
  return written;
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

  const normalised = normalise(wanted);
  const byName = usable.find((item) => normalise(item.name) === normalised);
  return byName ?? null;
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
