import { z } from 'zod';

import { LedgerApiError } from './ledger-http.js';
import { penceFromWire, penceToDecimalString } from './ledger-money.js';
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
 * FreeAgent (D50, build reference §4).
 *
 * ✅ The gentlest of the four, and the one the shared layer was proved against
 * first: money is decimal **strings** so nothing ever becomes a double, the
 * sandbox is a hostname swap on the same application, the refresh token lasts
 * about twenty years, and the attachment rides on the SAME request as the bill
 * rather than needing a second round trip.
 *
 * ⚠ **5 MB attachment limit — the tightest of the four**, against an intake
 * that accepts phone photographs well past it. `attachment.ts` downscales
 * before we get here; where even that is not enough, `attachmentSent` reports
 * false and says why.
 *
 * ⚠ **PDFs go up as `application/x-pdf`**, which is not the standard type and
 * is what FreeAgent expects. Sending `application/pdf` is accepted and then
 * renders as a broken attachment, which is the worst kind of wrong.
 *
 * ⚠ **The 1 December 2026 breaking change does not touch this path.** It moves
 * BANK TRANSACTION EXPLANATION attachments to a new endpoint and stops
 * returning the singular `attachment` attribute there. Bills are unaffected,
 * and bills are what we post. Recorded here so the next reader does not go
 * looking for a migration this file needs and does not have.
 */

const CompanySchema = z.object({
  company: z.object({ url: z.string().url().optional(), name: z.string().optional() }).passthrough(),
});

const CategorySchema = z
  .object({
    url: z.string().url(),
    description: z.string(),
    nominal_code: z.string().optional(),
  })
  .passthrough();

const CategoriesSchema = z
  .object({
    admin_expenses_categories: z.array(CategorySchema).optional(),
    cost_of_sales_categories: z.array(CategorySchema).optional(),
    income_categories: z.array(CategorySchema).optional(),
    general_categories: z.array(CategorySchema).optional(),
  })
  .passthrough();

const ContactSchema = z
  .object({
    url: z.string().url(),
    organisation_name: z.string().optional(),
    first_name: z.string().optional(),
    last_name: z.string().optional(),
    status: z.string().optional(),
  })
  .passthrough();

const ContactsSchema = z.object({ contacts: z.array(ContactSchema).optional() }).passthrough();
const CreatedContactSchema = z.object({ contact: ContactSchema });

const BankAccountSchema = z
  .object({ url: z.string().url(), name: z.string(), account_number: z.string().optional() })
  .passthrough();
const BankAccountsSchema = z.object({ bank_accounts: z.array(BankAccountSchema).optional() }).passthrough();

/**
 * The created bill, read back.
 *
 * `total_value` and `sales_tax_value` are decimal STRINGS — the read-back
 * reconciliation gets them for free with no conversion risk at all, which is
 * the one place this platform is simply better than the other three.
 */
const CreatedBillSchema = z.object({
  bill: z
    .object({
      url: z.string().url(),
      reference: z.string().optional(),
      total_value: z.union([z.string(), z.number()]).optional(),
      sales_tax_value: z.union([z.string(), z.number()]).optional(),
      // Present when an attachment was accepted. Its absence is how we learn
      // one was silently dropped.
      attachment: z.object({ url: z.string().url().optional() }).passthrough().nullish(),
    })
    .passthrough(),
});

export const freeAgentLedger: VendorLedger = {
  async resolveOrgRef(api) {
    // FreeAgent's token is already company-specific, so there is nothing to
    // route on — but the company URL is what proves the connection works and
    // is what the connection screen shows a practice.
    const body = await api.get(CompanySchema, '/company');
    return body.company.url ?? body.company.name ?? null;
  },

  async fetchLists(api) {
    const [categories, contacts, bankAccounts] = await Promise.all([
      api.get(CategoriesSchema, '/categories'),
      // `view=active` keeps a client with years of history from paging through
      // suppliers they stopped using in 2019.
      api.get(ContactsSchema, '/contacts', { view: 'active', per_page: '100' }),
      api.get(BankAccountsSchema, '/bank_accounts'),
    ]);

    const accounts: ReferenceItem[] = [
      ...(categories.admin_expenses_categories ?? []),
      ...(categories.cost_of_sales_categories ?? []),
      ...(categories.general_categories ?? []),
      ...(categories.income_categories ?? []),
    ].map((category) => ({
      id: category.url,
      code: category.nominal_code ?? null,
      name: category.description,
      active: true,
    }));

    // The whole list every time — no delta protocol on this platform.
    return { lists: {
      [LEDGER_LIST_KINDS.accounts]: accounts,
      [LEDGER_LIST_KINDS.suppliers]: (contacts.contacts ?? []).map((contact) => ({
        id: contact.url,
        code: null,
        name: contactName(contact),
        active: contact.status !== 'Hidden',
      })),
      [LEDGER_LIST_KINDS.bankAccounts]: (bankAccounts.bank_accounts ?? []).map((account) => ({
        id: account.url,
        code: account.account_number ?? null,
        name: account.name,
        active: true,
      })),
      // ⚠ FreeAgent has no tax-rate list endpoint: VAT is a percentage on the
      // line, not a code to pick. An empty list is the honest answer rather
      // than an invented one.
      [LEDGER_LIST_KINDS.taxRates]: [],
    } };
  },

  async publish(context) {
    const account = accountFor(context);
    if (isFailure(account)) return account;

    let contactUrl: string;
    try {
      contactUrl = await resolveContact(context);
    } catch (error) {
      return fromApiError(error, 'the supplier could not be found or created');
    }

    // ⚠ Money leaves as a STRING, straight from integer pence. No division, no
    // float, no `toFixed` — `penceToDecimalString` builds the text digit by digit.
    const bill: Record<string, unknown> = {
      contact: contactUrl,
      reference: referenceOrDocNumber(context),
      dated_on: dateOrToday(context.request),
      // FreeAgent requires a due date. Same day as the bill is the honest
      // default for a receipt that has already been paid; a payment-terms
      // feature is a real thing with real rules and inventing one here would be
      // worse than not having it.
      due_on: dateOrToday(context.request),
      total_value: penceToDecimalString(context.request.totalPence),
      sales_tax_value: penceToDecimalString(context.request.taxPence),
      category: account.id,
      currency: context.request.currency,
    };

    // ✅ The attachment on the SAME call — one request, not two, which is why
    // this platform cannot leave a bill posted with its receipt half-attached.
    if (context.attachment.ok) {
      bill['attachment'] = {
        data: context.attachment.bytes.toString('base64'),
        file_name: context.attachment.filename,
        content_type: freeAgentContentType(context.attachment.mimeType),
        description: 'Source document from Neoting',
      };
    }

    let created: z.infer<typeof CreatedBillSchema>;
    try {
      created = await context.api.postJson(CreatedBillSchema, '/bills', { bill });
    } catch (error) {
      // ⚠ A bill REJECTED ONLY because of its attachment must still reach the
      // books. Retrying without the file is the difference between "the
      // bookkeeping is right and the receipt is missing" and "nothing
      // happened", and D43 prefers the first while saying so honestly.
      if (context.attachment.ok && isAttachmentRejection(error)) {
        delete bill['attachment'];
        try {
          created = await context.api.postJson(CreatedBillSchema, '/bills', { bill });
          return published(created.bill.url, false);
        } catch (retryError) {
          return fromApiError(retryError, 'the bill was refused');
        }
      }
      return fromApiError(error, 'the bill was refused');
    }

    const mismatch = reconcile(
      context.request,
      {
        totalPence: amountOrNull(created.bill.total_value, 'total'),
        taxPence: amountOrNull(created.bill.sales_tax_value, 'VAT'),
      },
      context.connection.vendor.label,
    );
    // ⚠ The bill is in the books either way; a recalculation is something a
    // human must see, not a reason to claim it never landed.
    //
    // ⚠ This used to BRANCH on the mismatch into two returns that were
    // identical — so the sentence was computed and dropped, exactly as the
    // other three adapters dropped it. It now rides the result.
    return published(created.bill.url, attached(created), mismatch);
  },
};

/**
 * Find the supplier, or create it.
 *
 * ⚠ Matched against the SYNCED list first, then against a live search, and only
 * then created. "Republishing historically creates duplicate vendors" (SoT
 * §17.1) is the failure this ladder exists to avoid, and a synced list that is
 * a day old is exactly when the live check earns its round trip.
 */
async function resolveContact(context: PublishContext): Promise<string> {
  const known = matchSupplier(context.suppliers, context.request.supplierName);
  if (known !== null) return known.id;

  const live = await context.api.get(ContactsSchema, '/contacts', { view: 'active', per_page: '100' });
  const found = matchSupplier(
    (live.contacts ?? []).map((contact) => ({ id: contact.url, code: null, name: contactName(contact) })),
    context.request.supplierName,
  );
  if (found !== null) return found.id;

  const created = await context.api.postJson(CreatedContactSchema, '/contacts', {
    contact: { organisation_name: context.request.supplierName },
  });
  return created.contact.url;
}

function contactName(contact: z.infer<typeof ContactSchema>): string {
  const organisation = contact.organisation_name?.trim();
  if (organisation !== undefined && organisation !== '') return organisation;
  return [contact.first_name, contact.last_name].filter((part) => part !== undefined && part !== '').join(' ');
}

/** ⚠ FreeAgent's own type for PDFs. Standard `application/pdf` uploads and then will not open. */
function freeAgentContentType(mimeType: string): string {
  return mimeType === 'application/pdf' ? 'application/x-pdf' : mimeType;
}

function attached(created: z.infer<typeof CreatedBillSchema>): boolean {
  return created.bill.attachment != null;
}

function amountOrNull(value: unknown, field: string): number | null {
  if (value === undefined || value === null) return null;
  try {
    return penceFromWire(value, field);
  } catch {
    // An unreadable read-back is not a failed publish — the bill exists. It
    // just cannot be reconciled, which is the same as not being told.
    return null;
  }
}

/**
 * Whether a 4xx is about the FILE rather than the bookkeeping.
 *
 * Deliberately narrow: only a refusal whose text names the attachment. Treating
 * any 4xx as an attachment problem would retry a genuinely-wrong bill without
 * its evidence and then report success.
 */
function isAttachmentRejection(error: unknown): boolean {
  return error instanceof LedgerApiError && error.status >= 400 && error.status < 500 && /attach|file|data/i.test(error.message);
}

function fromApiError(error: unknown, what: string) {
  if (error instanceof LedgerApiError) return failed(error.message, error.retryable);
  return failed(`${what} (${error instanceof Error ? error.message : 'unknown error'}).`, true);
}
