import { HttpStatus } from '@nestjs/common';

import type { BusinessSubscription, SubscriptionStatus } from '@neoting/contracts/model';

import { AppException } from '../../common/problem/problem.js';

/**
 * Entitlement (D48) — what a business that is not paying may still do.
 *
 * ⚠ **THIS LIVES IN THE SERVICE LAYER AND MUST STAY THERE.** Not in
 * `scopedDb`, not in an RLS policy. Entitlement inside RLS would break D32's
 * export-at-cancellation promise invisibly: a lapsed tenant would not see a
 * billing message, they would see an EMPTY WORKSPACE, and their own financial
 * records would appear to have been deleted. The contract says it on the
 * webhook operation and `docs/runbooks/error-codes.md` says it again under
 * `NT-BIL-001`, because it is the one decision here that cannot be undone by
 * reading the code.
 *
 * The line, in one sentence: **reading and exporting survive a lapse; new
 * uploads do not.** Everything a business has already put in stays reachable,
 * reviewable, approvable and exportable — that is what makes cancelling safe
 * and what the refund policy promises. What stops is adding more.
 */

/**
 * The two statuses that admit new documents.
 *
 * `docs/runbooks/error-codes.md` fixes this list: "not `ACTIVE` or
 * `TRIALING`". `PAST_DUE` is deliberately NOT here even though Stripe is still
 * retrying the card — the grace it looks like belongs to Stripe's dunning,
 * which has already emailed the client, and a business quietly accumulating
 * documents on a card that has failed is a bill nobody agreed to.
 *
 * `null` — never been through checkout — is not entitled either. In ID the
 * client subscribes at the end of their own onboarding (SoT §24.5 step 4), so
 * a business with no subscription row has not finished signing up.
 */
const ENTITLED: ReadonlySet<SubscriptionStatus> = new Set<SubscriptionStatus>(['ACTIVE', 'TRIALING']);

/** What the `businesses` subscription columns look like to this module. */
export interface SubscriptionFacts {
  readonly subscriptionStatus: SubscriptionStatus | null;
  readonly plan?: string | null;
  readonly subscriptionCurrentPeriodEnd?: Date | null;
  /** D51 — the £2/month Document Vault add-on, written only by the Stripe webhook. */
  readonly vaultAddon?: boolean | null;
}

/** Pure, and the whole rule. Exported so a test pins all nine cases rather than the two that are convenient. */
export function mayIngest(status: SubscriptionStatus | null | undefined): boolean {
  return status != null && ENTITLED.has(status);
}

/**
 * Throw `NT-BIL-001` unless this business may take new documents.
 *
 * **402 Payment Required**, per the runbook. It is the one status that says
 * what is actually wrong: a 403 reads as "you are not allowed", which sends an
 * accountant to their permissions, and a 404 reads as "this client is gone",
 * which is the exact wrong thing to tell someone about their own books.
 *
 * The message names no amount and no card state. Stripe knows both, has
 * already emailed the client about them, and hosts the page that fixes them —
 * a second, staler copy on our side is a second thing to be wrong.
 */
/**
 * Whether this business may use the Document Vault (D51).
 *
 * **Two conditions, and both are load-bearing.** The add-on flag says they
 * bought it; the subscription status says they are still paying for anything at
 * all. An add-on riding a `CANCELED` subscription is not a paid feature, and
 * reading only the flag would leave the vault open to every client who ever
 * bought it once — the add-on line disappears from a cancelled subscription,
 * but nothing re-reads it after the final event, so the flag can outlive the
 * money by exactly as long as nobody looks.
 *
 * ⚠ **This gates the FEATURE, never the documents.** A client who drops the
 * add-on loses the vault surface, the ZIP and the Drive copy; every document
 * they have stays exactly where it was and stays visible in their portal list,
 * which is what it was before they ever bought the add-on. The line D32 draws —
 * reading and exporting survive a lapse — is not crossed by switching off a
 * feature they stopped paying for, and WOULD be crossed by hiding their file.
 */
export function mayUseVault(facts: SubscriptionFacts): boolean {
  return mayIngest(facts.subscriptionStatus) && facts.vaultAddon === true;
}

/**
 * Throw `NT-BIL-003` unless this business has the Document Vault add-on.
 *
 * **402, like `NT-BIL-001`**, and for the same reason: a 403 reads as "you are
 * not allowed" and sends a client to their permissions, when the true answer is
 * that this is a paid extra they have not bought. The message says what it
 * costs, because unlike a failed card there is nothing in Stripe already
 * telling them — this is an upsell, not a dunning notice.
 */
export function assertMayUseVault(facts: SubscriptionFacts): void {
  if (mayUseVault(facts)) return;
  throw new AppException(
    'NT-BIL-003',
    HttpStatus.PAYMENT_REQUIRED,
    'Document Vault not active',
    'The Document Vault is a £2/month add-on and is not active for this business. Documents already sent stay visible and downloadable without it.',
  );
}

export function assertMayIngest(facts: SubscriptionFacts): void {
  if (mayIngest(facts.subscriptionStatus)) return;
  throw new AppException(
    'NT-BIL-001',
    HttpStatus.PAYMENT_REQUIRED,
    'No active subscription',
    'This client business has no active subscription, so new documents cannot be accepted. Existing documents stay readable and exportable.',
  );
}

/**
 * The four columns as the contract's `BusinessSubscription` — the projection
 * `BusinessSummary.subscription` and `Business.subscription` render, so a
 * lapsed client shows in the switcher instead of being discovered at the next
 * upload (`docs/runbooks/error-codes.md`, NT-BIL-002 prevention).
 *
 * Null when the business has never been through checkout: the contract says
 * "Null until the client has been through checkout", and an invented
 * `INCOMPLETE` would render a billing problem for someone who has simply not
 * started.
 *
 * There is no PRICE in it, on purpose. The amount, the VAT and the gross total
 * are shown by Stripe's own checkout and on Stripe's own invoice, which is
 * where they are correct.
 */
export function toBusinessSubscription(facts: SubscriptionFacts): BusinessSubscription | null {
  if (facts.subscriptionStatus == null) return null;
  return {
    status: facts.subscriptionStatus,
    plan: facts.plan ?? null,
    currentPeriodEnd: facts.subscriptionCurrentPeriodEnd?.toISOString() ?? null,
  };
}
