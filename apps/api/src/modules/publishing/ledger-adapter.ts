/**
 * The `LedgerAdapter` interface (METH Stage 10, SoT §4 Stage 10, §17.1).
 *
 * Publishing is the step where an approved, coded document finally moves the
 * client's books: one bill, with its source image attached, into Xero or
 * QuickBooks, and back comes the ledger's own reference — the proof it landed.
 * Xero SDK + OAuth is the committed real implementation; this interface is the
 * seam it drops in behind, exactly like `DocumentExtractor` / `DocumentStore` /
 * `IngestQueue`.
 *
 * // DEMO-MOCK: `DemoXeroAdapter` is the only implementation today. The Xero
 * // OAuth + SDK adapter (and a QuickBooks sibling) replaces it post-demo,
 * // behind THIS interface, selected by env — no call site changes.
 *
 * ⚠ TWO RULES THIS INTERFACE EXISTS TO ENFORCE.
 *
 * 1. **An external HTTP call must never hold a tenant transaction open.** The
 *    proposal executor runs inside the engine's open `scopedDb` transaction
 *    (`ScopedClient` has no `$transaction` — one effect, one transaction,
 *    structurally). A Xero round trip in there holds row locks for the length
 *    of someone else's network, and a batch is up to 500 items. So the adapter
 *    is called from the engine's POST-COMMIT follow-up, never from inside the
 *    effect: the executor writes `publishes` rows QUEUED (durable intent, the
 *    state the schema already has for exactly this) and the follow-up resolves
 *    each one to SUCCEEDED or FAILED in its own short transaction. The
 *    reasoning is written out in this module's CLAUDE.md.
 * 2. **A per-item failure is a RESULT, not a throw.** A batch of 40 where item
 *    12 is rejected must publish the other 39 and land item 12 on the
 *    Rejected/Failed surface with a reason — the contract's words: "a failure
 *    with no reason attached is a bug, not a state". A throw would lose the
 *    batch. Reserve throwing for the world being broken (no credentials
 *    configured, the adapter itself misconfigured); a vendor saying no, a
 *    timeout and a 429 are all {@link LedgerPublishFailure} with
 *    `retryable` set honestly.
 */

import type { IntegrationKind } from '@prisma/client';

/**
 * Row-level publishing failure codes (Governance §13.4 — the `NT-PUB-*`
 * family). These land in `publishes.failure_code`, which the contract types as
 * a free string; they are NOT `Problem.code` values. `NT-PUB-001` is the one
 * PUB code in the contract's `ErrorCode` enum, and it belongs to the
 * *refusal* path (publish-preview.ts) because that one is an HTTP answer.
 * Adding a code here is cheap; adding one to the enum is a contract change
 * (G7), and every new code needs a runbook entry to pass review.
 */
export const LEDGER_REJECTED = 'NT-PUB-002';

/** Widen this union as adapters learn to fail in new ways — a compile-guided edit. */
export type LedgerFailureCode = typeof LEDGER_REJECTED;

/** The ledger connection a bill is published through. Resolved before the call. */
export interface LedgerTarget {
  readonly integrationId: string;
  readonly kind: IntegrationKind;
  /** The vendor's own organisation identifier (`integrations.org_ref`). */
  readonly orgRef: string | null;
}

/**
 * The source document travelling with the bill (SoT Stage 10 — "the source
 * image always travels with the data"). A REFERENCE, never bytes: the adapter
 * fetches through the document store if it needs them, so nothing here holds a
 * multi-megabyte buffer in memory for the length of a 500-item batch.
 */
export interface LedgerAttachment {
  readonly s3Key: string;
  readonly filename: string;
  readonly mimeType: string;
}

/**
 * One bill. `supplierName`, `categoryCode` and `totalPence` are non-nullable
 * on purpose: the minimum check (Total + Supplier + Category — publish-preview.ts)
 * has already run and refused anything short of it with `NT-PUB-001`, so an
 * adapter never has to decide what to do with a half-coded document.
 *
 * Money is integer pence, both fields, always.
 */
export interface PublishBillRequest {
  readonly documentId: string;
  /**
   * 1-based attempt number for THIS document — the count of prior `publishes`
   * rows plus one. Retry is a new `publish.batch` proposal over the failed
   * item (the contract: "the old attempt is never replayed and never
   * deleted"), so the count is the honest attempt number, and it is what lets
   * the demo's scripted failure fail once and then succeed.
   */
  readonly attempt: number;
  readonly target: LedgerTarget;
  readonly supplierName: string;
  readonly categoryCode: string;
  /** ISO-4217, e.g. `GBP`. */
  readonly currency: string;
  readonly totalPence: number;
  readonly taxPence: number;
  /** `YYYY-MM-DD`, or null when the document carries no date. */
  readonly documentDate: string | null;
  /** The supplier's own invoice reference, when read. */
  readonly reference: string | null;
  /** Null when there is nothing to attach — which the result then reports honestly. */
  readonly attachment: LedgerAttachment | null;
}

export interface LedgerPublishSuccess {
  readonly ok: true;
  /** The ledger's own reference — the proof the books moved. */
  readonly externalRef: string;
  /**
   * The source document went with the bill. False on a ledger that refused the
   * attachment — never silently, per the contract's `Publish.attachmentSent`.
   */
  readonly attachmentSent: boolean;
}

/** Why one bill did not land. Both fields are mandatory — see rule 2 above. */
export interface LedgerFailure {
  readonly code: LedgerFailureCode;
  /** Plain English, for a human on the Rejected/Failed surface. */
  readonly message: string;
  /**
   * Whether a fresh attempt could reasonably succeed. It is a HINT recorded
   * with the attempt, not permission: a retry is always a new `publish.batch`
   * proposal through Review → Approve, never an automatic replay.
   */
  readonly retryable: boolean;
}

export interface LedgerPublishFailure {
  readonly ok: false;
  readonly failure: LedgerFailure;
}

export type LedgerPublishResult = LedgerPublishSuccess | LedgerPublishFailure;

export interface LedgerAdapter {
  /**
   * Publish exactly one bill. Idempotency lives with the CALLER — the
   * `publishes.idempotency_key` (proposal id + document id) is what makes a
   * replay a no-op, because that is the row a duplicate post would double.
   *
   * A real adapter parses the vendor's HTTP response with Zod before returning
   * (Zod at every boundary, adapter responses included). The demo adapter is
   * in-process, so its result is typed rather than parsed.
   */
  publishBill(request: PublishBillRequest): Promise<LedgerPublishResult>;
}
