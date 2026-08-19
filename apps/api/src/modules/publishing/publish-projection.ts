import type { Publish as PublishRow } from '@prisma/client';

import type { Publish } from '@neoting/contracts/model';

/**
 * Prisma `publishes` row → the contract `Publish` shape (`GET /v1/publishes`,
 * METH Stage 10).
 *
 * Pure: no clock, no database, no config. It is the one place a publish row
 * becomes a wire object, so what the Rejected/Failed surface renders and what
 * the publish history renders cannot disagree about what a `Publish` is.
 *
 * Three rules, each of which is a bug the moment it is broken.
 */

/**
 * **1. Nothing is invented and nothing is inferred.** Every field below is a
 * column read straight across. `state` is not re-derived from whether
 * `externalRef` is set, `attachmentSent` is not defaulted from `state`, and
 * there is no computed `retryable` — retry is a NEW `publish.batch` proposal
 * over the failed item (the contract: "the old attempt is never replayed and
 * never deleted"), so a read surface that advertised retryability would be
 * describing a capability that lives on the proposal spine, not here.
 *
 * **2. Two columns deliberately never leave the server.** `idempotencyKey` is
 * the anti-double-post key (`prisma/schema.prisma`: "Republishing must never
 * create a duplicate vendor or double-post a bill") and it is GLOBALLY unique,
 * so it is derived from ids a caller must not be able to reverse-engineer a
 * republish from; `publishedByUserId` is not in the contract's `Publish` at
 * all. Neither is in the schema this projects onto, and adding either would be
 * a contract change (G7), not a convenience. A test pins the exact key set,
 * because the failure mode of a spread (`...row`) is silent over-exposure that
 * typechecks.
 *
 * **3. A FAILED row's reason travels with it, verbatim.** The contract is
 * explicit — "A FAILED row always carries `failureCode` and `failureMessage`
 * ... a failure with no reason attached is a bug, not a state". So the pair is
 * passed through untouched: never trimmed, never collapsed to null, and — the
 * less obvious half — never SUBSTITUTED. If a writer ever commits a FAILED row
 * with no reason, this serves the null, so the bug shows up on the
 * Rejected/Failed surface where a human sees it. Papering it over with an
 * invented code would hide exactly the defect the contract names, and would put
 * a code on the wire that no writer emitted and no client has a branch for.
 * `failureCode` here is a free string in the contract (a row-level ledger code
 * such as `NT-PUB-002`), NOT a `Problem.code` — promoting one into the
 * `ErrorCode` enum would be a G7 change.
 *
 * Dates are ISO-8601 UTC (`Date.toISOString()`), per the repo invariant "UTC in
 * storage, Europe/London in rendering": the rendering half belongs to the web
 * app and must never be pre-applied here, because a localised string on the
 * wire cannot be converted back without knowing which zone it was made in.
 * Nullable dates are projected as an explicit `null` rather than omitted — the
 * key being present and null says "this attempt has not completed", which is
 * the true statement about a QUEUED row.
 */
export function toPublish(row: PublishRow): Publish {
  return {
    id: row.id,
    businessId: row.businessId,
    documentId: row.documentId,
    // Null is a real value here, not an absence: the contract types
    // `integrationId` as `string | null` and null means "the business's single
    // active integration" (`PublishBatchPayload`). Explicit, so a client never
    // has to distinguish a missing key from a null one.
    integrationId: row.integrationId,
    mode: row.mode,
    state: row.state,
    // Set on success only — "the proof the books moved" (`openapi.yaml`). Null
    // on a QUEUED or FAILED row, and that is the honest answer, not a gap.
    externalRef: row.externalRef,
    attachmentSent: row.attachmentSent,
    actionProposalId: row.actionProposalId,
    failureCode: row.failureCode,
    failureMessage: row.failureMessage,
    createdAt: row.createdAt.toISOString(),
    completedAt: row.completedAt === null ? null : row.completedAt.toISOString(),
  };
}
