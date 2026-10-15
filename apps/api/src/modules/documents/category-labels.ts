import { z } from 'zod';

import { LEDGER_KINDS, LEDGER_LIST_KINDS } from '../publishing/index.js';
import { accountCatalogue, analysisAccount } from '../rules-suggestions/index.js';

import type { ScopedClient } from '../../common/db/scoped-db.js';
import type { CategoryLabels } from '../../common/documents/document-response.js';

/**
 * `documents.category_code` → the ledger-prefixed account name, for
 * `DocumentSummary.categoryLabel`.
 *
 * ## What was wrong
 *
 * The boards printed the raw enum. A document coded to
 * `REPAIRS_AND_MAINTENANCE` read `REPAIRS_AND_MAINTENANCE` on the Ready board,
 * in the document preview, on the bank-match candidate card and on the
 * approvals queue — while the publish review card and the exported VT file,
 * both composed server-side, said `Expenses: Repairs and maintenance`. One
 * document wore two vocabularies depending on which screen you were on (found
 * on the live walk, 8 Sep 2026). The name is DATA, not a transformation: the
 * ledger prefix appears nowhere inside the code, so no browser-side helper
 * could ever have produced it.
 *
 * ## Why the catalogue and not this client's own chart
 *
 * `exports-public-api` resolves the same join per business, off
 * `ChartOfAccountsService.getChartOfAccounts(...).categories`, and that is
 * right for a file somebody imports into their books. It is the wrong shape
 * here, for two measured reasons:
 *
 * - **`getChartOfAccounts` WRITES.** It seeds the client's chart on first read.
 *   `GET /documents` is `x-nt-side-effect: none` and POLLS every five seconds
 *   in every open browser; a read surface that seeds rows per page of results
 *   is not a read surface.
 * - **It would answer the same thing.** A code's `(ledger, name)` is a property
 *   of the account DEFINITION, not of a chart — checked over all 51 accounts in
 *   `accountCatalogue()`, none carries two — and a profile only decides WHICH
 *   codes a client's chart holds, never what they are called. Nothing in this
 *   release edits a stored chart either: the only writer is the seeder, and it
 *   writes exactly these names.
 *
 * So the label is the same string on every path, at the cost of no query at
 * all. If a chart-EDITING surface is ever built, this is what has to become a
 * per-business read — and `exports-public-api/api/analysis-account-chart.ts` is
 * the shape to copy.
 *
 * ## `null` is a real answer
 *
 * `documents.category_code` is free text in the schema and an accountant's
 * explicit rule may legitimately name a code no chart carries, so a code that
 * is not in the catalogue resolves to nothing — never to the near miss it is
 * one character away from, and never to an invented ledger. The projection then
 * emits `categoryLabel: null` and the boards render the bare code, exactly as
 * they did before this existed.
 */
let cached: CategoryLabels | undefined;

export function categoryLabels(): CategoryLabels {
  // Built once per process: `accountCatalogue()` is a pure function over module
  // constants, so the map can never go stale, and rebuilding it per request
  // would be 51 string concatenations on the hottest read in the product.
  cached ??= new Map(accountCatalogue().map((account) => [account.code, analysisAccount(account)]));
  return cached;
}

const LedgerAccountsPayload = z.object({
  items: z.array(z.object({ id: z.string().min(1), code: z.string().nullable().optional(), name: z.string().min(1) })),
});

/**
 * Per business, the catalogue labels plus the CONNECTED ledger's own account
 * names. A connected client's `category_code` is the vendor's account code (or
 * its id, where QuickBooks gives none — `chart-of-accounts.service.ts`'s
 * `readLedgerAccounts` rule), which the catalogue cannot name, so the boards
 * printed "42". The synced `ledger_accounts` list can. Read-only: two queries
 * per page, no seeding.
 */
export async function labelsForBusinesses(
  db: ScopedClient,
  businessIds: readonly string[],
): Promise<(businessId: string) => CategoryLabels> {
  const base = categoryLabels();
  const ids = [...new Set(businessIds)];
  if (ids.length === 0) return () => base;

  const live = await db.integration.findMany({
    where: { businessId: { in: ids }, isActive: true, kind: { in: [...LEDGER_KINDS] }, tokenRef: { not: null } },
    orderBy: { createdAt: 'asc' },
    select: { id: true, businessId: true },
  });
  // The first live connection per business — the one the release lane adopts.
  const integrationFor = new Map<string, string>();
  for (const row of live) if (!integrationFor.has(row.businessId)) integrationFor.set(row.businessId, row.id);
  if (integrationFor.size === 0) return () => base;

  const syncs = await db.referenceSync.findMany({
    where: { integrationId: { in: [...integrationFor.values()] }, listKind: LEDGER_LIST_KINDS.accounts },
    select: { integrationId: true, payload: true },
  });
  const byIntegration = new Map<string, CategoryLabels>();
  for (const sync of syncs) {
    const parsed = LedgerAccountsPayload.safeParse(sync.payload);
    if (!parsed.success) continue;
    const merged = new Map(base);
    for (const item of parsed.data.items) {
      merged.set(item.id, item.name);
      const code = item.code?.trim();
      if (code) merged.set(code, item.name);
    }
    byIntegration.set(sync.integrationId, merged);
  }
  return (businessId) => {
    const integrationId = integrationFor.get(businessId);
    return (integrationId === undefined ? undefined : byIntegration.get(integrationId)) ?? base;
  };
}
