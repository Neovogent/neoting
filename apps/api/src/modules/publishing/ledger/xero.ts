import { z } from 'zod';

import { LedgerApiError } from './ledger-http.js';
import { penceFromWire, penceToWireNumber } from './ledger-money.js';
import { LEDGER_LIST_KINDS, matchSupplier } from './reference-sync.js';
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
 * Xero (D50, build reference §1).
 *
 * ✅ **The best attachment story of the four** — a real file on the record AND a
 * clickable `Url` field, up to 10 files at 10 MB each. `accounting.attachments`
 * is in our granted granular scopes, confirmed on the app's Configuration page,
 * which is what makes D43 reachable through the API at all.
 *
 * ⚠ **The least forgiving place to learn, which is why it was not built
 * first.** Rotating refresh tokens, ~98 float-typed money fields, and an
 * idempotency window of only **six minutes** — short enough that a retry after
 * a timeout can genuinely duplicate a bill.
 *
 * ⚠ **There is no Xero sandbox.** A developer connects a REAL organisation. The
 * only safe target is Xero's own **Demo Company (UK)**, which is free and
 * resettable; the connection screen says so, because no environment variable
 * can make this one safe.
 *
 * ⚠ **An organisation may connect only two uncertified apps.** A client already
 * running Dext plus one other tool cannot add us, and the limit is invisible
 * until it blocks the consent screen.
 *
 * ⚠ **Bills are created as DRAFT.** Xero's own approval workflow belongs to the
 * practice, and a tool that posted straight to AUTHORISED would be skipping a
 * control somebody chose. Changing this is one line here, deliberately not an
 * environment variable — a setting that decides whether a client's books move
 * on their own should be a pull request, not a task-definition edit.
 */
const INVOICE_STATUS = 'DRAFT';

/** The tenant list — a separate host from the accounting API, so it is named in full. */
const CONNECTIONS_URL = 'https://api.xero.com/connections';

const ConnectionsSchema = z.array(
  z
    .object({
      tenantId: z.string().min(1),
      tenantName: z.string().optional(),
      tenantType: z.string().optional(),
    })
    .passthrough(),
);

const AccountSchema = z
  .object({
    AccountID: z.string().min(1),
    Code: z.string().optional(),
    Name: z.string(),
    Status: z.string().optional(),
    Type: z.string().optional(),
  })
  .passthrough();

const AccountsSchema = z.object({ Accounts: z.array(AccountSchema).optional() }).passthrough();

const ContactSchema = z
  .object({ ContactID: z.string().min(1), Name: z.string(), ContactStatus: z.string().optional() })
  .passthrough();
const ContactsSchema = z.object({ Contacts: z.array(ContactSchema).optional() }).passthrough();

const TaxRateSchema = z
  .object({
    Name: z.string(),
    TaxType: z.string(),
    // ⚠ `format: double`. Read through the money boundary, never used directly.
    EffectiveRate: z.number().optional(),
    Status: z.string().optional(),
  })
  .passthrough();
const TaxRatesSchema = z.object({ TaxRates: z.array(TaxRateSchema).optional() }).passthrough();

const InvoiceSchema = z
  .object({
    InvoiceID: z.string().min(1),
    InvoiceNumber: z.string().optional(),
    // ⚠ Every one of these is `format: double` in Xero's own schema.
    Total: z.union([z.number(), z.string()]).optional(),
    TotalTax: z.union([z.number(), z.string()]).optional(),
  })
  .passthrough();

const InvoicesSchema = z.object({ Invoices: z.array(InvoiceSchema).min(1) }).passthrough();
const AttachmentsSchema = z
  .object({ Attachments: z.array(z.object({ AttachmentID: z.string() }).passthrough()).optional() })
  .passthrough();

export const xeroLedger: VendorLedger = {
  async resolveOrgRef(api) {
    // ⚠ Tokens are keyed per USER, not per organisation, so this is the call
    // that turns a consent into something that can be routed. A practice who
    // consented for two organisations gets the first; the connection screen is
    // where a second one becomes a second connection.
    const connections = await api.get(ConnectionsSchema, CONNECTIONS_URL);
    return connections[0]?.tenantId ?? null;
  },

  async fetchLists(api) {
    const [accounts, contacts, taxRates] = await Promise.all([
      api.get(AccountsSchema, '/Accounts'),
      api.get(ContactsSchema, '/Contacts', { page: '1', includeArchived: 'false' }),
      api.get(TaxRatesSchema, '/TaxRates'),
    ]);

    return {
      [LEDGER_LIST_KINDS.accounts]: (accounts.Accounts ?? []).map((account) => ({
        id: account.AccountID,
        code: account.Code ?? null,
        name: account.Name,
        active: account.Status !== 'ARCHIVED',
      })),
      [LEDGER_LIST_KINDS.suppliers]: (contacts.Contacts ?? []).map((contact) => ({
        id: contact.ContactID,
        code: null,
        name: contact.Name,
        active: contact.ContactStatus !== 'ARCHIVED',
      })),
      [LEDGER_LIST_KINDS.taxRates]: (taxRates.TaxRates ?? []).map((rate) => ({
        id: rate.TaxType,
        code: rate.TaxType,
        name: rate.Name,
        // ⚠ A percentage, on the wire as a double. 20% arrives as `20` and
        // occasionally as `20.0`; basis points keep it an integer from here on.
        rateBasisPoints: rate.EffectiveRate === undefined ? null : Math.round(rate.EffectiveRate * 100),
        active: rate.Status !== 'DELETED',
      })),
      // Bank accounts are Accounts of type BANK — the same list, filtered,
      // rather than a second round trip for rows we already hold.
      [LEDGER_LIST_KINDS.bankAccounts]: (accounts.Accounts ?? [])
        .filter((account) => account.Type === 'BANK')
        .map((account) => ({ id: account.AccountID, code: account.Code ?? null, name: account.Name, active: true })),
    };
  },

  async publish(context) {
    const account = accountFor(context);
    if (isFailure(account)) return account;
    if (account.code === null) {
      return failed(
        `The ${context.connection.vendor.label} account "${account.name}" has no code, and a bill line has to name one. Pick an account with a code, or add one in ${context.connection.vendor.label}.`,
        false,
      );
    }

    const known = matchSupplier(context.suppliers, context.request.supplierName);
    const invoice: Record<string, unknown> = {
      Type: 'ACCPAY',
      // ⚠ Named by ContactID when we have one, by Name when we do not. Xero
      // creates a contact from a bare Name, which is what a first publish for a
      // new supplier needs — and matching first is what stops the second
      // publish creating a duplicate.
      Contact: known === null ? { Name: context.request.supplierName } : { ContactID: known.id },
      Date: dateOrToday(context.request),
      DueDate: dateOrToday(context.request),
      Status: INVOICE_STATUS,
      Reference: referenceOrDocNumber(context),
      // ⚠ The duplicate guard that outlives the six-minute window. A retry of
      // the same approval carries the same number, and Xero refuses a second
      // ACCPAY with an InvoiceNumber it already holds.
      InvoiceNumber: context.docNumber,
      CurrencyCode: context.request.currency,
      // ⚠ INCLUSIVE, and it matters. The document's `totalPence` is the GROSS
      // amount a human read off a receipt and approved. Declaring it exclusive
      // would make Xero add VAT on top of a figure that already contains it —
      // a 20% overstatement that looks entirely plausible in a books.
      LineAmountTypes: 'Inclusive',
      LineItems: [
        {
          Description: context.request.supplierName,
          Quantity: 1,
          // The one place pence become a decimal for Xero. Built from a string,
          // never by dividing.
          UnitAmount: penceToWireNumber(context.request.totalPence),
          AccountCode: account.code,
          TaxAmount: penceToWireNumber(context.request.taxPence),
        },
      ],
    };

    let created: z.infer<typeof InvoicesSchema>;
    try {
      created = await context.api.postJson(InvoicesSchema, '/Invoices?summarizeErrors=true', { Invoices: [invoice] });
    } catch (error) {
      return fromApiError(error);
    }

    const posted = created.Invoices[0];
    if (posted === undefined) {
      return failed(`${context.connection.vendor.label} accepted the request but returned no bill.`, true);
    }

    // ⚠ The attachment is a SECOND call, and its failure must not undo the
    // first. The bill is in the books; what is in question is only whether the
    // receipt reached it, and D43's answer is to say so rather than to pretend.
    const attachmentSent = await attach(context, posted.InvoiceID);

    reconcile(
      context.request,
      { totalPence: amountOrNull(posted.Total), taxPence: amountOrNull(posted.TotalTax) },
      context.connection.vendor.label,
    );

    // The vendor's own reference — the proof the books moved. The invoice
    // number is what an accountant will search for in Xero; the id is what a
    // machine needs. The number when there is one, the id otherwise.
    return published(posted.InvoiceNumber ?? posted.InvoiceID, attachmentSent);
  },
};

async function attach(context: PublishContext, invoiceId: string): Promise<boolean> {
  if (!context.attachment.ok) return false;
  try {
    // ⚠ Raw bytes, filename in the PATH, and `IncludeOnline=true` so the file
    // is visible on the invoice rather than only in the file library.
    const body = await context.api.postBytes(
      AttachmentsSchema,
      `/Invoices/${encodeURIComponent(invoiceId)}/Attachments/${encodeURIComponent(context.attachment.filename)}?IncludeOnline=true`,
      context.attachment.bytes,
      context.attachment.mimeType,
    );
    return (body.Attachments ?? []).length > 0;
  } catch {
    // Logged by `VendorApi`. False here is the honest answer and the whole
    // reason `attachmentSent` is a field rather than an assumption.
    return false;
  }
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
    // A duplicate InvoiceNumber is Xero telling us the bill is already there.
    // That is a SUCCESSFUL outcome wearing a 400, and reporting it as a failure
    // would invite a human to publish it a second time under a new number.
    if (error.status === 400 && /invoice number must be unique|already exists/i.test(error.message)) {
      return failed(
        'This document has already been published to Xero under this approval — it is in the books. Nothing was posted twice.',
        false,
      );
    }
    return failed(error.message, error.retryable);
  }
  return failed(`The bill could not be posted (${error instanceof Error ? error.message : 'unknown error'}).`, true);
}
