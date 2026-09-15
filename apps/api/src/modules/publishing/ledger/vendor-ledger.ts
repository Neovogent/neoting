import type { AttachmentOutcome } from './attachment.js';
import type { VendorApi } from './ledger-http.js';
import { LEDGER_REJECTED, type LedgerPublishResult, type PublishBillRequest } from '../ledger-adapter.js';
import { matchAccount, type ReferenceItem, type ReferenceLists } from './reference-sync.js';
import type { ResolvedConnection } from './token-store.js';

/**
 * What every one of the four vendor modules implements.
 *
 * It is deliberately NOT `LedgerAdapter`. That interface is the seam the rest of
 * the product publishes through and it takes one bill and nothing else;
 * `HttpLedgerAdapter` implements it once, and this is the smaller thing behind
 * it — the part that genuinely differs between Xero and FreeAgent, with the
 * tokens, the attachment, the reference lists and the duplicate guard already
 * resolved by the shared layer.
 */
export interface VendorLedger {
  /**
   * The vendor's own organisation identifier, read immediately after consent
   * and stored in `integrations.org_ref`.
   *
   * ⚠ Without it nothing can be routed. Xero hands back a tenant id from a
   * separate endpoint, Sage a business id, FreeAgent a company URL, and
   * QuickBooks puts a `realmId` on the callback query string — which is why
   * this takes the callback's parameters as well as an API handle.
   */
  resolveOrgRef(api: VendorApi, callbackParams: Readonly<Record<string, string>>): Promise<string | null>;

  /** Pull the client's own lists. Called at connect and by the sync schedule. */
  fetchLists(api: VendorApi, connection: ResolvedConnection, since: Date | null): Promise<ReferenceLists>;

  /** Post one bill with its receipt. A per-item failure is a RESULT, never a throw. */
  publish(context: PublishContext): Promise<LedgerPublishResult>;
}

/** Everything one bill needs, resolved before the vendor module is entered. */
export interface PublishContext {
  readonly api: VendorApi;
  readonly connection: ResolvedConnection;
  readonly request: PublishBillRequest;
  readonly attachment: AttachmentOutcome;
  readonly accounts: readonly ReferenceItem[];
  readonly suppliers: readonly ReferenceItem[];
  readonly taxRates: readonly ReferenceItem[];
  /** Only Sage's Start-plan fallback reads this, and it cannot post without one. */
  readonly bankAccounts: readonly ReferenceItem[];
  /**
   * The deterministic duplicate guard, derived from `publishes.idempotency_key`.
   *
   * ⚠ QuickBooks has **no idempotency support at all**, so its `DocNumber` is
   * the only thing standing between a retry and a second bill in a client's
   * books. Xero's own window is six minutes, which a slow retry can outlive.
   * So every adapter carries this, and each uses it in whichever field its
   * vendor will honour.
   */
  readonly docNumber: string;
}

/** The refusal an item gets when its category has no counterpart in the client's ledger. */
export function accountFor(context: PublishContext): ReferenceItem | LedgerPublishResult {
  const account = matchAccount(context.accounts, context.request.categoryCode);
  if (account !== null) return account;
  return failed(
    `"${context.request.categoryCode}" does not match any account in this client's ${context.connection.vendor.label} chart of accounts. Re-code the document to an account they actually have, or sync the connection again if it was added recently.`,
    false,
  );
}

/** Narrowing helper — `accountFor` returns one or the other and TypeScript needs telling which. */
export function isFailure(value: ReferenceItem | LedgerPublishResult): value is LedgerPublishResult {
  return 'ok' in value;
}

/**
 * A per-item failure.
 *
 * ⚠ **Both fields are mandatory and this is why there is a helper**: the
 * contract's words are *"a failure with no reason attached is a bug, not a
 * state"*, and the message is what an accountant reads on the Rejected surface.
 * `retryable` is a HINT recorded with the attempt, never permission — a retry
 * is always a new `publish.batch` proposal through Review → Approve.
 */
export function failed(message: string, retryable: boolean): LedgerPublishResult {
  return { ok: false, failure: { code: LEDGER_REJECTED, message, retryable } };
}

export function published(externalRef: string, attachmentSent: boolean): LedgerPublishResult {
  return { ok: true, externalRef, attachmentSent };
}

/**
 * ⚠ **Read-back reconciliation (build brief Stage 3).**
 *
 * Several platforms recompute tax server-side and hand back something different
 * from what was sent — a client whose VAT scheme rounds per line, a tax code
 * that means 5% rather than 20%. Comparing what came back against what was sent
 * is the difference between "the books have the right number" and "we posted
 * something and assumed".
 *
 * It does NOT fail the publish. The transaction exists in the client's books by
 * the time this runs, and refusing after the fact would leave a real bill
 * marked as never posted — the worst of both. The discrepancy goes on the
 * result's message path instead, where a human sees it and can correct it in
 * the ledger.
 */
export function reconcile(
  request: PublishBillRequest,
  returned: { readonly totalPence: number | null; readonly taxPence: number | null },
  vendorLabel: string,
): string | null {
  const parts: string[] = [];
  if (returned.totalPence !== null && returned.totalPence !== request.totalPence) {
    parts.push(`total ${pounds(request.totalPence)} was recorded as ${pounds(returned.totalPence)}`);
  }
  if (returned.taxPence !== null && returned.taxPence !== request.taxPence) {
    parts.push(`VAT ${pounds(request.taxPence)} was recorded as ${pounds(returned.taxPence)}`);
  }
  if (parts.length === 0) return null;
  return `${vendorLabel} recalculated this transaction: ${parts.join(' and ')}. The transaction is in the books — check it against the receipt.`;
}

/** Integer pence to a readable amount. Never a float: integer division and a remainder. */
function pounds(signedPence: number): string {
  const absolute = Math.abs(signedPence);
  return `${signedPence < 0 ? '-' : ''}£${Math.trunc(absolute / 100)}.${String(absolute % 100).padStart(2, '0')}`;
}

/**
 * The supplier's invoice reference, or a stable substitute.
 *
 * ⚠ Most of the four require a reference or a document number of some kind, and
 * several use it as their own duplicate check. When a receipt genuinely carries
 * none, `docNumber` is used — which is derived from the proposal and the
 * document, so a retry of the SAME approval reuses it and a genuinely new
 * attempt does not.
 */
export function referenceOrDocNumber(context: PublishContext): string {
  const reference = context.request.reference?.trim();
  return reference === undefined || reference === '' ? context.docNumber : reference;
}

/** `YYYY-MM-DD`, or today when the document carried no date. UTC in storage, always. */
export function dateOrToday(request: PublishBillRequest, now: Date = new Date()): string {
  return request.documentDate ?? now.toISOString().slice(0, 10);
}
