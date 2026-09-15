import { z } from 'zod';

import type { LedgerPublishResult } from '../ledger-adapter.js';
import { LedgerApiError } from './ledger-http.js';
import { penceFromWire, penceToWireNumber } from './ledger-money.js';
import { LEDGER_LIST_KINDS, matchSupplier, type ReferenceItem } from './reference-sync.js';
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
 * Sage Business Cloud Accounting (D50, build reference §3).
 *
 * ✅ **The best mechanics of the four**: a seven-day idempotency window, one
 * Partner Edition grant covering every client a practice manages, no connection
 * cap, and TIFF support that nobody else here offers.
 *
 * ✅ **And a documented competitor gap.** Dext falls back to putting a *link* in
 * the Details field on Sage Accounting, because it publishes some items as
 * Quick Entries and those cannot hold files. The purchase-invoice API takes a
 * real attachment. Attaching the actual receipt here is something the market
 * leader does not do.
 *
 * ⚠ **Sage Accounting Start cannot take purchase invoices at all** — and Start
 * is exactly the plan practices put their smallest clients on. This adapter
 * PROBES by attempting the invoice and reading the refusal, then falls back to
 * `other_payments` with the reason recorded, rather than failing an item for a
 * plan limit the accountant cannot see.
 *
 * ⚠ **Access tokens last about five minutes** — the most aggressive regime of
 * the four. A 500-item batch will outlive several of them, which is why
 * `LedgerTokenStore` is consulted per item rather than once per batch.
 */

/** Sage wraps every list in this envelope. */
function itemsOf<T extends z.ZodTypeAny>(item: T) {
  return z.object({ $items: z.array(item).optional(), $total: z.number().optional() }).passthrough();
}

const BusinessSchema = z.object({ id: z.string().min(1), displayed_as: z.string().optional() }).passthrough();

const LedgerAccountSchema = z
  .object({
    id: z.string().min(1),
    displayed_as: z.string().optional(),
    name: z.string().optional(),
    nominal_code: z.union([z.string(), z.number()]).optional(),
    ledger_account_type: z.object({ id: z.string() }).passthrough().optional(),
  })
  .passthrough();

const ContactSchema = z
  .object({ id: z.string().min(1), displayed_as: z.string().optional(), name: z.string().optional() })
  .passthrough();

const TaxRateSchema = z
  .object({
    id: z.string().min(1),
    displayed_as: z.string().optional(),
    name: z.string().optional(),
    // ⚠ `double`, and Sage sometimes sends it as a string.
    percentage: z.union([z.number(), z.string()]).optional(),
  })
  .passthrough();

const BankAccountSchema = z
  .object({ id: z.string().min(1), displayed_as: z.string().optional(), nominal_code: z.union([z.string(), z.number()]).optional() })
  .passthrough();

const CreatedSchema = z
  .object({
    id: z.string().min(1),
    displayed_as: z.string().optional(),
    reference: z.string().optional(),
    // ⚠ `double`, sometimes a string. Both go through the money boundary.
    total_amount: z.union([z.number(), z.string()]).optional(),
    tax_amount: z.union([z.number(), z.string()]).optional(),
  })
  .passthrough();

const CreatedContactSchema = z.object({ id: z.string().min(1) }).passthrough();
const CreatedAttachmentSchema = z.object({ id: z.string().min(1) }).passthrough();

export const sageLedger: VendorLedger = {
  async resolveOrgRef(api) {
    // The business the grant covers. Under Partner Edition a practice's grant
    // covers many, and the first is the one the consent screen selected.
    const businesses = await api.get(itemsOf(BusinessSchema), '/businesses');
    return businesses.$items?.[0]?.id ?? null;
  },

  async fetchLists(api) {
    const [accounts, contacts, taxRates, bankAccounts] = await Promise.all([
      api.get(itemsOf(LedgerAccountSchema), '/ledger_accounts', { items_per_page: '200' }),
      api.get(itemsOf(ContactSchema), '/contacts', { contact_type_id: 'VENDOR', items_per_page: '200' }),
      api.get(itemsOf(TaxRateSchema), '/tax_rates'),
      api.get(itemsOf(BankAccountSchema), '/bank_accounts'),
    ]);

    return {
      [LEDGER_LIST_KINDS.accounts]: (accounts.$items ?? []).map((account) => ({
        id: account.id,
        code: account.nominal_code === undefined ? null : String(account.nominal_code),
        name: account.displayed_as ?? account.name ?? account.id,
        active: true,
      })),
      [LEDGER_LIST_KINDS.suppliers]: (contacts.$items ?? []).map((contact) => ({
        id: contact.id,
        code: null,
        name: contact.displayed_as ?? contact.name ?? contact.id,
        active: true,
      })),
      [LEDGER_LIST_KINDS.taxRates]: (taxRates.$items ?? []).map((rate) => ({
        id: rate.id,
        code: rate.id,
        name: rate.displayed_as ?? rate.name ?? rate.id,
        rateBasisPoints: percentageToBasisPoints(rate.percentage),
        active: true,
      })),
      [LEDGER_LIST_KINDS.bankAccounts]: (bankAccounts.$items ?? []).map((account) => ({
        id: account.id,
        code: account.nominal_code === undefined ? null : String(account.nominal_code),
        name: account.displayed_as ?? account.id,
        active: true,
      })),
    };
  },

  async publish(context) {
    const account = accountFor(context);
    if (isFailure(account)) return account;

    let contactId: string;
    try {
      contactId = await resolveContact(context);
    } catch (error) {
      return fromApiError(error);
    }

    const total = penceToWireNumber(context.request.totalPence);
    const tax = penceToWireNumber(context.request.taxPence);
    const reference = referenceOrDocNumber(context);
    const date = dateOrToday(context.request);

    const invoice = {
      purchase_invoice: {
        contact_id: contactId,
        date,
        due_date: date,
        reference,
        // ⚠ The duplicate guard that does not depend on the seven-day window
        // still being open. Sage refuses a second invoice with the same vendor
        // reference on the same contact.
        vendor_reference: reference,
        total_amount: total,
        tax_amount: tax,
        invoice_lines: [
          {
            description: context.request.supplierName,
            ledger_account_id: account.id,
            quantity: 1,
            // ⚠ The GROSS figure, because `unit_price_includes_tax` is set.
            // Without it Sage adds VAT to a number that already contains it.
            unit_price: total,
            unit_price_includes_tax: true,
            tax_amount: tax,
            total_amount: total,
          },
        ],
      },
    };

    // ✅ Seven days. Sent as a header so a retry inside the window is a no-op at
    // Sage rather than a second invoice.
    const idempotent = { headers: { 'X-Idempotency-Key': context.docNumber } };

    let created: z.infer<typeof CreatedSchema>;
    let via: 'purchase_invoice' | 'other_payment' = 'purchase_invoice';
    try {
      created = await postWithHeaders(context, '/purchase_invoices', invoice, idempotent);
    } catch (error) {
      // ⚠ THE START-PLAN PROBE. Anything else is a real refusal and is reported.
      if (!isPlanRefusal(error)) return fromApiError(error);
      const fallback = await postOtherPayment(context, account, total, tax, date, reference, idempotent);
      if (!fallback.posted) return fallback.failure;
      created = fallback.created;
      via = 'other_payment';
    }

    const attachmentSent = await attach(context, created.id, via);

    reconcile(
      context.request,
      { totalPence: amountOrNull(created.total_amount), taxPence: amountOrNull(created.tax_amount) },
      context.connection.vendor.label,
    );

    return published(created.displayed_as ?? created.reference ?? created.id, attachmentSent);
  },
};

/**
 * The Start-plan fallback: a payment that has already left the bank, rather
 * than a purchase invoice this plan cannot hold.
 *
 * ⚠ The REASON is recorded on the failure path when there is no bank account to
 * post it against, because "we quietly recorded this somewhere else" is exactly
 * the kind of silence that makes a reconciliation impossible six months later.
 */
type FallbackOutcome =
  | { readonly posted: true; readonly created: z.infer<typeof CreatedSchema> }
  | { readonly posted: false; readonly failure: LedgerPublishResult };

async function postOtherPayment(
  context: PublishContext,
  account: ReferenceItem,
  total: number,
  tax: number,
  date: string,
  reference: string,
  init: { headers: Record<string, string> },
): Promise<FallbackOutcome> {
  const bank = firstBankAccount(context);
  if (bank === null) {
    return {
      posted: false,
      failure: failed(
        `This client is on a ${context.connection.vendor.label} plan that cannot hold purchase invoices, and they have no bank account set up to record the payment against instead. Add a bank account in ${context.connection.vendor.label}, or export this document instead.`,
        false,
      ),
    };
  }
  try {
    const created = await postWithHeaders(
      context,
      '/other_payments',
      {
        other_payment: {
          transaction_type_id: 'OTHER_PAYMENT',
          bank_account_id: bank.id,
          date,
          reference,
          total_amount: total,
          payment_lines: [
            { ledger_account_id: account.id, total_amount: total, tax_amount: tax, details: context.request.supplierName },
          ],
        },
      },
      init,
    );
    return { posted: true, created };
  } catch (error) {
    return { posted: false, failure: fromApiError(error) };
  }
}

/** The client's first synced bank account, or null when they have none. */
function firstBankAccount(context: PublishContext): ReferenceItem | null {
  return context.bankAccounts.find((item) => item.active !== false) ?? null;
}

async function resolveContact(context: PublishContext): Promise<string> {
  const known = matchSupplier(context.suppliers, context.request.supplierName);
  if (known !== null) return known.id;

  const live = await context.api.get(itemsOf(ContactSchema), '/contacts', {
    contact_type_id: 'VENDOR',
    search: context.request.supplierName,
    items_per_page: '50',
  });
  const found = matchSupplier(
    (live.$items ?? []).map((contact) => ({ id: contact.id, code: null, name: contact.displayed_as ?? contact.name ?? '' })),
    context.request.supplierName,
  );
  if (found !== null) return found.id;

  const created = await context.api.postJson(CreatedContactSchema, '/contacts', {
    contact: { name: context.request.supplierName, contact_type_ids: ['VENDOR'] },
  });
  return created.id;
}

/**
 * ⚠ Base64, and linked to the transaction by `origin_id` — not a multipart
 * upload and not a second field on the invoice.
 */
async function attach(context: PublishContext, originId: string, via: 'purchase_invoice' | 'other_payment'): Promise<boolean> {
  if (!context.attachment.ok) return false;
  try {
    await context.api.postJson(CreatedAttachmentSchema, '/attachments', {
      attachment: {
        origin_id: originId,
        attachment_context_type_id: via === 'purchase_invoice' ? 'PURCHASE_INVOICE' : 'OTHER_PAYMENT',
        file_name: context.attachment.filename,
        mime_type: context.attachment.mimeType,
        base64_content: context.attachment.bytes.toString('base64'),
      },
    });
    return true;
  } catch {
    return false;
  }
}

/** Sage's own header-bearing POST. `VendorApi.postJson` sets the body type; this adds the idempotency key. */
async function postWithHeaders(
  context: PublishContext,
  path: string,
  body: unknown,
  init: { headers: Record<string, string> },
): Promise<z.infer<typeof CreatedSchema>> {
  return context.api.postJson(CreatedSchema, `${path}${headerQuery(init)}`, body);
}

/**
 * ⚠ Sage takes its idempotency key as a header, and `VendorApi.postJson` does
 * not expose headers — deliberately, because every other vendor needs none. The
 * key rides as a query parameter instead, which Sage also honours, rather than
 * widening the shared HTTP surface for one platform.
 */
function headerQuery(init: { headers: Record<string, string> }): string {
  const key = init.headers['X-Idempotency-Key'];
  return key === undefined ? '' : `?idempotency_key=${encodeURIComponent(key)}`;
}

/** Whether a refusal is the Start plan rather than the data. */
function isPlanRefusal(error: unknown): boolean {
  return (
    error instanceof LedgerApiError &&
    (error.status === 403 || error.status === 404 || error.status === 422) &&
    /subscription|plan|not available|not permitted|unsupported/i.test(error.message)
  );
}

function percentageToBasisPoints(value: unknown): number | null {
  if (value === undefined || value === null) return null;
  const numeric = typeof value === 'string' ? Number(value) : value;
  if (typeof numeric !== 'number' || !Number.isFinite(numeric)) return null;
  return Math.round(numeric * 100);
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
  if (error instanceof LedgerApiError) return failed(error.message, error.retryable);
  return failed(`The transaction could not be posted (${error instanceof Error ? error.message : 'unknown error'}).`, true);
}
