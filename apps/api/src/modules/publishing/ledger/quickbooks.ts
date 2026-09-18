import { z } from 'zod';

import { LedgerApiError, type VendorApi } from './ledger-http.js';
import { penceFromWire, penceToWireNumber } from './ledger-money.js';
import {
  documentRateBasisPoints,
  LEDGER_LIST_KINDS,
  matchSupplier,
  matchTaxRate,
  type ReferenceLists,
} from './reference-sync.js';
import type { ResolvedConnection } from './token-store.js';
import {
  accountFor,
  dateOrToday,
  failed,
  isFailure,
  type PublishContext,
  published,
  reconcile,
  referenceOrDocNumber,
  type VendorLedger,
} from './vendor-ledger.js';

/**
 * QuickBooks Online (D50, build reference §2).
 *
 * ⚠ **No idempotency support at all.** `DocNumber` is the only duplicate guard
 * there is, so this adapter generates one from the approval and stores it on
 * the bill; QuickBooks then refuses a second bill carrying the same number for
 * the same vendor, which is what turns a retry into a no-op instead of a second
 * entry in a client's books.
 *
 * ⚠ **`realmId` arrives on the CALLBACK, not in the token.** It is the company
 * identifier and every single API path contains it. `resolveOrgRef` reads it
 * from the callback parameters for that reason, and without it nothing can be
 * routed at all.
 *
 * ⚠ **Reads are metered and this pipeline is read-heavy**, so reference sync
 * uses **Change Data Capture** after the first pull rather than re-reading whole
 * lists — one call carrying only what moved since the last sync.
 *
 * ⚠ **`UnitPrice` overrides `Amount` when both are present.** Only `Amount` is
 * ever sent from here; adding a unit price later would silently re-price every
 * line.
 *
 * ⚠ **There is no URL field on the record — bytes or nothing.** So where the
 * file is rejected, D43 degrades and `attachmentSent` has to say so.
 */

/** Pinned, and pinned here rather than in `env.ts` — the same stance as the Stripe API version. */
const MINOR_VERSION = '75';

const AccountSchema = z
  .object({
    Id: z.string().min(1),
    Name: z.string(),
    AcctNum: z.string().optional(),
    Active: z.boolean().optional(),
    AccountType: z.string().optional(),
  })
  .passthrough();

const VendorSchema = z
  .object({ Id: z.string().min(1), DisplayName: z.string().optional(), CompanyName: z.string().optional(), Active: z.boolean().optional() })
  .passthrough();

const TaxCodeSchema = z.object({ Id: z.string().min(1), Name: z.string(), Active: z.boolean().optional() }).passthrough();

const QuerySchema = z
  .object({
    QueryResponse: z
      .object({
        Account: z.array(AccountSchema).optional(),
        Vendor: z.array(VendorSchema).optional(),
        TaxCode: z.array(TaxCodeSchema).optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

const BillSchema = z
  .object({
    Id: z.string().min(1),
    DocNumber: z.string().optional(),
    // ⚠ A JSON decimal number. Read through the money boundary, never directly.
    TotalAmt: z.union([z.number(), z.string()]).optional(),
    TxnTaxDetail: z.object({ TotalTax: z.union([z.number(), z.string()]).optional() }).passthrough().optional(),
  })
  .passthrough();

const CreatedBillSchema = z.object({ Bill: BillSchema }).passthrough();
const CreatedVendorSchema = z.object({ Vendor: VendorSchema }).passthrough();
const UploadSchema = z
  .object({
    AttachableResponse: z
      .array(z.object({ Attachable: z.object({ Id: z.string() }).passthrough().optional(), Fault: z.unknown().optional() }).passthrough())
      .optional(),
  })
  .passthrough();

export const quickBooksLedger: VendorLedger = {
  async resolveOrgRef(_api, callbackParams) {
    // ⚠ Straight off the callback query string. There is nowhere else it exists.
    const realmId = callbackParams['realmId'];
    return realmId !== undefined && realmId.trim() !== '' ? realmId.trim() : null;
  },

  async fetchLists(api, connection, since) {
    // ✅ CHANGE DATA CAPTURE after the first pull. Intuit meters reads and this
    // pipeline is read-heavy — re-reading three whole lists on a schedule is
    // exactly the cost the reference doc says to design out from the start.
    if (since !== null) {
      const changed = await changeDataCapture(api, connection, since);
      if (changed !== null) return changed;
    }

    const [accounts, vendors, taxCodes] = await Promise.all([
      query(api, connection, 'select * from Account maxresults 1000'),
      query(api, connection, 'select * from Vendor maxresults 1000'),
      query(api, connection, 'select * from TaxCode maxresults 200'),
    ]);

    return toLists(
      accounts.QueryResponse?.Account ?? [],
      vendors.QueryResponse?.Vendor ?? [],
      taxCodes.QueryResponse?.TaxCode ?? [],
    );
  },

  async publish(context) {
    const account = accountFor(context);
    if (isFailure(account)) return account;

    let vendorId: string;
    try {
      vendorId = await resolveVendor(context);
    } catch (error) {
      return fromApiError(error);
    }

    // ⚠ Derived from what the document says, then matched against what THIS
    // client's QuickBooks actually offers. A miss refuses the item with the
    // rate named; it does not fall back to the standard rate, because most of a
    // food wholesaler's delivery is zero-rated and a plausible 20% is the
    // hardest kind of wrong to notice afterwards.
    const wantedRate = documentRateBasisPoints(context.request.totalPence, context.request.taxPence);
    const taxCode = matchTaxRate(context.taxRates, wantedRate);
    if (taxCode === null) {
      return failed(
        `This client's ${context.connection.vendor.label} has no tax code at ${(wantedRate / 100).toFixed(2)}%, which is the rate this document works out at. Add one in ${context.connection.vendor.label} and sync the connection, or correct the document's tax figure.`,
        false,
      );
    }

    const bill = {
      VendorRef: { value: vendorId },
      TxnDate: dateOrToday(context.request),
      // ⚠ THE ONLY DUPLICATE GUARD THIS PLATFORM HAS.
      DocNumber: context.docNumber.slice(0, 21),
      PrivateNote: `Neoting reference ${referenceOrDocNumber(context)}`,
      CurrencyRef: { value: context.request.currency },
      // ⚠ Inclusive, because `totalPence` is the GROSS figure a human read off
      // the receipt and approved. `TaxExcluded` here would add VAT on top of a
      // number that already contains it.
      GlobalTaxCalculation: 'TaxInclusive',
      Line: [
        {
          DetailType: 'AccountBasedExpenseLineDetail',
          // ⚠ `Amount` only. `UnitPrice` would override it.
          Amount: penceToWireNumber(context.request.totalPence),
          Description: context.request.supplierName,
          AccountBasedExpenseLineDetail: {
            AccountRef: { value: account.id },
            // ⚠ **MANDATORY, and its absence is why the first real post was
            // refused** (18 Sep 2026): "Business Validation Error: All items
            // need a tax rate. Please add one where it's missing." A UK
            // QuickBooks company is VAT-enabled and every expense line must
            // name a code. Derived from the document, never defaulted.
            TaxCodeRef: { value: taxCode.id },
          },
        },
      ],
      TxnTaxDetail: { TotalTax: penceToWireNumber(context.request.taxPence) },
    };

    let created: z.infer<typeof CreatedBillSchema>;
    try {
      created = await context.api.postJson(CreatedBillSchema, path(context.connection, 'bill'), bill);
    } catch (error) {
      return fromApiError(error);
    }

    const attachmentSent = await attach(context, created.Bill.Id);

    reconcile(
      context.request,
      {
        totalPence: amountOrNull(created.Bill.TotalAmt),
        taxPence: amountOrNull(created.Bill.TxnTaxDetail?.TotalTax),
      },
      context.connection.vendor.label,
    );

    return published(created.Bill.DocNumber ?? created.Bill.Id, attachmentSent);
  },
};

/**
 * ⚠ The attachment is a multipart upload to a DIFFERENT endpoint, then bound to
 * the bill by `AttachableRef`. There is no URL field to fall back on — bytes or
 * nothing — so a refusal here is the one case where D43 genuinely degrades, and
 * `attachmentSent: false` is how it is reported rather than hidden.
 */
async function attach(context: PublishContext, billId: string): Promise<boolean> {
  if (!context.attachment.ok) return false;
  try {
    const form = new FormData();
    form.append(
      'file_metadata_01',
      new Blob(
        [
          JSON.stringify({
            AttachableRef: [{ EntityRef: { type: 'Bill', value: billId }, IncludeOnSend: false }],
            FileName: context.attachment.filename,
            ContentType: context.attachment.mimeType,
          }),
        ],
        { type: 'application/json' },
      ),
      'file_metadata_01',
    );
    form.append(
      'file_content_01',
      new Blob([new Uint8Array(context.attachment.bytes)], { type: context.attachment.mimeType }),
      context.attachment.filename,
    );

    const body = await context.api.postForm(UploadSchema, path(context.connection, 'upload'), form);
    const first = body.AttachableResponse?.[0];
    // ⚠ Intuit answers 200 with a per-part Fault. A status check alone would
    // report an attachment that was refused as one that landed.
    return first !== undefined && first.Fault === undefined && first.Attachable !== undefined;
  } catch {
    return false;
  }
}

async function resolveVendor(context: PublishContext): Promise<string> {
  const known = matchSupplier(context.suppliers, context.request.supplierName);
  if (known !== null) return known.id;

  // ⚠ Escaped for QuickBooks' own query language: a supplier called
  // `O'Brien Ltd` would otherwise end the string literal mid-name.
  const escaped = context.request.supplierName.replace(/'/g, "\\'");
  const live = await query(context.api, context.connection, `select * from Vendor where DisplayName = '${escaped}'`);
  const found = live.QueryResponse?.Vendor?.[0];
  if (found !== undefined) return found.Id;

  const created = await context.api.postJson(CreatedVendorSchema, path(context.connection, 'vendor'), {
    DisplayName: context.request.supplierName,
  });
  return created.Vendor.Id;
}

async function query(api: VendorApi, connection: ResolvedConnection, statement: string) {
  return api.get(QuerySchema, path(connection, 'query'), { query: statement, minorversion: MINOR_VERSION });
}

/**
 * Change Data Capture — everything that moved since the last sync, in one call.
 *
 * Returns null when CDC cannot answer (too long since the last sync is the
 * usual reason; Intuit caps the lookback at 30 days), which sends the caller
 * back to a full read rather than silently syncing nothing.
 */
async function changeDataCapture(
  api: VendorApi,
  connection: ResolvedConnection,
  since: Date,
): Promise<ReferenceLists | null> {
  const thirtyDaysAgo = Date.now() - 30 * 24 * 60 * 60 * 1000;
  if (since.getTime() < thirtyDaysAgo) return null;

  const CdcSchema = z
    .object({
      CDCResponse: z
        .array(
          z
            .object({
              QueryResponse: z
                .array(
                  z
                    .object({
                      Account: z.array(AccountSchema).optional(),
                      Vendor: z.array(VendorSchema).optional(),
                      TaxCode: z.array(TaxCodeSchema).optional(),
                    })
                    .passthrough(),
                )
                .optional(),
            })
            .passthrough(),
        )
        .optional(),
    })
    .passthrough();

  try {
    const body = await api.get(CdcSchema, path(connection, 'cdc'), {
      entities: 'Account,Vendor,TaxCode',
      changedSince: since.toISOString(),
      minorversion: MINOR_VERSION,
    });
    const groups = body.CDCResponse?.[0]?.QueryResponse ?? [];
    return toLists(
      groups.flatMap((group) => group.Account ?? []),
      groups.flatMap((group) => group.Vendor ?? []),
      groups.flatMap((group) => group.TaxCode ?? []),
    );
  } catch {
    return null;
  }
}

/**
 * "20.0% S" -> 2000 · "0.0% Z" -> 0 · "Exempt" / "No VAT" / "Out of Scope" -> 0.
 *
 * ⚠ Anything else is **null**, which `matchTaxRate` then never selects. A code
 * whose rate we cannot read is not a code we may put on a client's bill.
 */
function taxCodeRateBasisPoints(name: string): number | null {
  const percent = /([0-9]+(?:\.[0-9]+)?)\s*%/.exec(name);
  if (percent !== null) return Math.round(Number.parseFloat(percent[1] ?? '0') * 100);
  return /(exempt|no vat|zero|out of scope)/i.test(name) ? 0 : null;
}

function toLists(
  accounts: readonly z.infer<typeof AccountSchema>[],
  vendors: readonly z.infer<typeof VendorSchema>[],
  taxCodes: readonly z.infer<typeof TaxCodeSchema>[],
): ReferenceLists {
  return {
    [LEDGER_LIST_KINDS.accounts]: accounts.map((account) => ({
      id: account.Id,
      code: account.AcctNum ?? null,
      name: account.Name,
      active: account.Active !== false,
    })),
    [LEDGER_LIST_KINDS.suppliers]: vendors.map((vendor) => ({
      id: vendor.Id,
      code: null,
      name: vendor.DisplayName ?? vendor.CompanyName ?? vendor.Id,
      active: vendor.Active !== false,
    })),
    [LEDGER_LIST_KINDS.taxRates]: taxCodes.map((code) => ({
      id: code.Id,
      code: code.Id,
      name: code.Name,
      // ⚠ **The rate comes out of the NAME, because QuickBooks does not put
      // it on the TaxCode.** A TaxCode points at TaxRate entities through
      // Purchase/SalesTaxRateList, so the alternative is a second query and a
      // join for a number a UK company's own naming already states —
      // "20.0% S", "0.0% Z", "Exempt", "No VAT". A name we cannot read yields
      // null, and a null rate is never matched rather than guessed at.
      //
      // ⚠ This replaced a hardcoded `null` whose own comment said the rate
      // "is not on the code itself" and left it there — which is why the first
      // real post to QuickBooks had no tax code to choose and was refused.
      rateBasisPoints: taxCodeRateBasisPoints(code.Name),
      active: code.Active !== false,
    })),
    [LEDGER_LIST_KINDS.bankAccounts]: accounts
      .filter((account) => account.AccountType === 'Bank')
      .map((account) => ({ id: account.Id, code: account.AcctNum ?? null, name: account.Name, active: account.Active !== false })),
  };
}

/** ⚠ Every path contains the realm. A connection without one cannot make a single call. */
function path(connection: ResolvedConnection, resource: string): string {
  return `/${connection.orgRef ?? ''}/${resource}`;
}

function amountOrNull(value: unknown): number | null {
  if (value === undefined || value === null) return null;
  try {
    return penceFromWire(value, 'amount');
  } catch {
    return null;
  }
}

function fromApiError(error: unknown) {
  if (error instanceof LedgerApiError) {
    // A duplicate DocNumber is QuickBooks saying the bill is already there.
    if (error.status === 400 && /duplicate.*document number|docnumber/i.test(error.message)) {
      return failed(
        'This document has already been published to QuickBooks under this approval — it is in the books. Nothing was posted twice.',
        false,
      );
    }
    return failed(error.message, error.retryable);
  }
  return failed(`The bill could not be posted (${error instanceof Error ? error.message : 'unknown error'}).`, true);
}
