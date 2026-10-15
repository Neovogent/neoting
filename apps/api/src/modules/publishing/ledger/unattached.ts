import { z } from 'zod';

import type { PrismaClient } from '../../../common/db/prisma.js';
import type { ScopeContext } from '../../../common/db/scope-context.js';
import { scopedDb } from '../../../common/db/scoped-db.js';
import { credentialsFor, type LedgerEnv, vaultKeyFor, vendorConfigForKind } from './ledger-config.js';
import { VendorApi } from './ledger-http.js';
import { penceFromWire } from './ledger-money.js';
import type { ResolvedConnection } from './token-store.js';
import { LedgerTokenStore } from './token-store.js';
import { isLedgerKind, type VendorSlug } from './vendors.js';

/**
 * Detection engine (d) — a ledger transaction with no receipt attached
 * (SoT §4 Stage 8). A best-effort READ: nothing here writes to a ledger.
 *
 * Every vendor answer is Zod-parsed; a vendor this file cannot read is skipped
 * (`ok: false`) rather than guessed at, and the caller must not resolve
 * findings off a failed read. Sage is skipped outright — its purchase invoices
 * carry no attachment flag on the list endpoint.
 *
 * ponytail: page 1 / 100 rows per entity since `since`; paginate when a client
 * posts more than that per lookback window.
 */

export interface UnattachedLedgerTxn {
  /** `<vendor>:<kind>:<id>` — stable across runs, the finding's identity. */
  readonly ref: string;
  readonly supplierName: string | null;
  /** Unsigned pence as the ledger stored it. */
  readonly amountPence: number | null;
  /** `YYYY-MM-DD` */
  readonly date: string | null;
  readonly label: string;
}

export interface UnattachedRead {
  readonly vendor: VendorSlug;
  readonly ok: boolean;
  readonly items: readonly UnattachedLedgerTxn[];
}

type Reader = (api: VendorApi, connection: ResolvedConnection, since: string) => Promise<UnattachedLedgerTxn[]>;

function pence(value: unknown): number | null {
  try {
    return value === undefined || value === null ? null : Math.abs(penceFromWire(value, 'total'));
  } catch {
    return null;
  }
}

// ── Xero ────────────────────────────────────────────────────────────────────

const XeroInvoice = z
  .object({
    InvoiceID: z.string(),
    InvoiceNumber: z.string().nullish(),
    Contact: z.object({ Name: z.string().nullish() }).passthrough().nullish(),
    DateString: z.string().nullish(),
    Total: z.union([z.number(), z.string()]).nullish(),
    HasAttachments: z.boolean().nullish(),
    Status: z.string().nullish(),
  })
  .passthrough();
const XeroBankTxn = z
  .object({
    BankTransactionID: z.string(),
    Contact: z.object({ Name: z.string().nullish() }).passthrough().nullish(),
    DateString: z.string().nullish(),
    Total: z.union([z.number(), z.string()]).nullish(),
    HasAttachments: z.boolean().nullish(),
    Status: z.string().nullish(),
  })
  .passthrough();

const readXero: Reader = async (api, _connection, since) => {
  const [y, m, d] = since.split('-');
  const date = `DateTime(${y},${m},${d})`;
  const [invoices, bank] = await Promise.all([
    api.get(z.object({ Invoices: z.array(XeroInvoice).optional() }).passthrough(), '/Invoices', {
      where: `Type=="ACCPAY" AND Date>=${date}`,
      page: '1',
    }),
    api.get(z.object({ BankTransactions: z.array(XeroBankTxn).optional() }).passthrough(), '/BankTransactions', {
      where: `Type=="SPEND" AND Date>=${date}`,
      page: '1',
    }),
  ]);
  const out: UnattachedLedgerTxn[] = [];
  for (const row of invoices.Invoices ?? []) {
    if (row.HasAttachments !== false || row.Status === 'DELETED' || row.Status === 'VOIDED') continue;
    out.push({
      ref: `xero:bill:${row.InvoiceID}`,
      supplierName: row.Contact?.Name ?? null,
      amountPence: pence(row.Total),
      date: row.DateString?.slice(0, 10) ?? null,
      label: `Xero bill ${row.InvoiceNumber ?? row.InvoiceID}`,
    });
  }
  for (const row of bank.BankTransactions ?? []) {
    if (row.HasAttachments !== false || row.Status === 'DELETED') continue;
    out.push({
      ref: `xero:spend:${row.BankTransactionID}`,
      supplierName: row.Contact?.Name ?? null,
      amountPence: pence(row.Total),
      date: row.DateString?.slice(0, 10) ?? null,
      label: 'Xero spend money',
    });
  }
  return out;
};

// ── QuickBooks Online ───────────────────────────────────────────────────────

const QboTxn = z
  .object({
    Id: z.string(),
    DocNumber: z.string().nullish(),
    TxnDate: z.string().nullish(),
    TotalAmt: z.union([z.number(), z.string()]).nullish(),
    VendorRef: z.object({ name: z.string().nullish() }).passthrough().nullish(),
    EntityRef: z.object({ name: z.string().nullish() }).passthrough().nullish(),
  })
  .passthrough();
const QboAttachable = z
  .object({
    AttachableRef: z
      .array(z.object({ EntityRef: z.object({ type: z.string().nullish(), value: z.string() }).passthrough() }).passthrough())
      .nullish(),
  })
  .passthrough();
const QboQuery = z
  .object({
    QueryResponse: z
      .object({
        Bill: z.array(QboTxn).optional(),
        Purchase: z.array(QboTxn).optional(),
        Attachable: z.array(QboAttachable).optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

const readQuickBooks: Reader = async (api, connection, since) => {
  const q = (statement: string) =>
    api.get(QboQuery, `/${connection.orgRef ?? ''}/query`, { query: statement, minorversion: '75' });
  const [bills, purchases, attachables] = await Promise.all([
    q(`select * from Bill where TxnDate >= '${since}' MAXRESULTS 100`),
    q(`select * from Purchase where TxnDate >= '${since}' MAXRESULTS 100`),
    q(`select * from Attachable MAXRESULTS 1000`),
  ]);
  // QuickBooks keeps attachments as their own entity pointing AT the bill.
  const attached = new Set<string>();
  for (const row of attachables.QueryResponse?.Attachable ?? []) {
    for (const ref of row.AttachableRef ?? []) attached.add(`${(ref.EntityRef.type ?? '').toLowerCase()}:${ref.EntityRef.value}`);
  }
  const out: UnattachedLedgerTxn[] = [];
  for (const [kind, rows] of [
    ['bill', bills.QueryResponse?.Bill ?? []],
    ['purchase', purchases.QueryResponse?.Purchase ?? []],
  ] as const) {
    for (const row of rows) {
      if (attached.has(`${kind}:${row.Id}`)) continue;
      out.push({
        ref: `quickbooks:${kind}:${row.Id}`,
        supplierName: row.VendorRef?.name ?? row.EntityRef?.name ?? null,
        amountPence: pence(row.TotalAmt),
        date: row.TxnDate ?? null,
        label: `QuickBooks ${kind} ${row.DocNumber ?? row.Id}`,
      });
    }
  }
  return out;
};

// ── FreeAgent ───────────────────────────────────────────────────────────────

const FreeAgentBill = z
  .object({
    url: z.string(),
    reference: z.string().nullish(),
    dated_on: z.string().nullish(),
    total_value: z.union([z.number(), z.string()]).nullish(),
    contact_name: z.string().nullish(),
    attachment: z.unknown().optional(),
  })
  .passthrough();

const readFreeAgent: Reader = async (api, _connection, since) => {
  const body = await api.get(z.object({ bills: z.array(FreeAgentBill).optional() }).passthrough(), '/bills', {
    view: 'all',
    from_date: since,
    per_page: '100',
  });
  return (body.bills ?? [])
    .filter((row) => row.attachment === undefined || row.attachment === null)
    .map((row) => ({
      ref: `freeagent:bill:${row.url.split('/').pop() ?? row.url}`,
      supplierName: row.contact_name ?? null,
      amountPence: pence(row.total_value),
      date: row.dated_on ?? null,
      label: `FreeAgent bill ${row.reference ?? ''}`.trim(),
    }));
};

const READERS: Partial<Record<VendorSlug, Reader>> = {
  xero: readXero,
  quickbooks: readQuickBooks,
  freeagent: readFreeAgent,
};

/**
 * Every live ledger connection of one business, read for unattached
 * transactions since `since` (`YYYY-MM-DD`). Token refresh and every database
 * touch are short scoped transactions; the vendor calls sit between them.
 */
export async function readUnattachedLedgerTransactions(
  prisma: PrismaClient,
  ctx: ScopeContext,
  env: LedgerEnv,
  businessId: string,
  since: string,
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<UnattachedRead[]> {
  if (env.LEDGER_ADAPTER !== 'http') return [];
  const rows = await scopedDb(prisma, ctx, (db) =>
    db.integration.findMany({
      where: { businessId, isActive: true, NOT: { tokenRef: null } },
      select: { id: true, kind: true },
    }),
  );
  const store = new LedgerTokenStore(
    prisma,
    ctx,
    vaultKeyFor(env),
    (slug) => credentialsFor(env, slug),
    (kind) => vendorConfigForKind(env, kind),
    fetchImpl,
  );

  const results: UnattachedRead[] = [];
  for (const row of rows.filter((r) => isLedgerKind(r.kind))) {
    let connection: ResolvedConnection;
    try {
      connection = await store.connection(row.id);
    } catch {
      continue;
    }
    const reader = READERS[connection.vendor.slug];
    if (reader === undefined) {
      results.push({ vendor: connection.vendor.slug, ok: false, items: [] });
      continue;
    }
    try {
      results.push({ vendor: connection.vendor.slug, ok: true, items: await reader(new VendorApi(connection, fetchImpl), connection, since) });
    } catch {
      // A vendor that will not answer is a skipped read, never "nothing missing".
      results.push({ vendor: connection.vendor.slug, ok: false, items: [] });
    }
  }
  return results;
}
