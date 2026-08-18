import type {
  ArchivePayload,
  ErrorCode,
  BankConfirmMatchPayload,
  ChaseSendPayload,
  MoveBusinessPayload,
  ProposalKind,
  PublishBatchPayload,
  RejectPayload,
  ReprocessPayload,
  RoutePayload,
  RuleCreatePayload,
  SplitPayload,
  UpdateCodingPayload,
} from '@neoting/contracts/model';

import type { ScopeContext } from '../../../common/db/scope-context.js';
import type { ScopedClient } from '../../../common/db/scoped-db.js';

/**
 * The `ProposalExecutor` seam — issue #81, signature ACKed on the issue before
 * a line of it was written.
 *
 * The engine (Review → Approve, Governance §10 — Shakib's S1) and the effects
 * it executes are two different jobs. Executors live HERE, in the domain
 * module that owns the data. The engine owns authorisation, the review gate,
 * the shown-hash comparison, the audit write and the `outcome` record; an
 * executor performs exactly one effect and decides nothing about whether it
 * may happen. Nothing in this directory is reachable from a controller — a
 * test asserts that.
 */

/** Payload per kind, straight off the generated model. No hand-written DTOs. */
export interface ProposalPayloadMap {
  'document.route': RoutePayload;
  'document.update-coding': UpdateCodingPayload;
  'document.move-business': MoveBusinessPayload;
  'document.reprocess': ReprocessPayload;
  'document.reject': RejectPayload;
  'document.split': SplitPayload;
  'document.archive': ArchivePayload;
  'chase.send': ChaseSendPayload;
  'publish.batch': PublishBatchPayload;
  'bank.confirm-match': BankConfirmMatchPayload;
  'rule.create': RuleCreatePayload;
}

export interface ExecutionInput<P> {
  readonly proposalId: string;
  /**
   * Already parsed by the engine — it re-parses the stored row through
   * `createDocumentUploadBody`'s sibling union at execution time, because the
   * row sat in a table between propose and approve. The executor does not
   * re-validate.
   */
  readonly payload: P;
  /** The approver's context. The executor never builds one. */
  readonly ctx: ScopeContext;
  readonly traceId: string;
}

/**
 * Work that must NOT run in the effect transaction. A discriminated union from
 * day one — the engine's post-commit enqueue switch should be total the same
 * way the registry is (the addition ACKed on #81).
 */
export type FollowUp =
  | {
      readonly kind: 'dedupe';
      readonly documentId: string;
      readonly businessId: string;
      readonly practiceId: string;
    }
  | {
      /**
       * The LEDGER call for an approved publish batch (METH Stage 10).
       *
       * **An external HTTP call must never hold a tenant transaction open.**
       * The effect transaction wrote one `publishes` row per item in `QUEUED`
       * — durable intent, committed atomically with the approval, the same
       * outbox principle `dedupe` uses — and this follow-up drives the vendor
       * per item AFTER commit, resolving each row to SUCCEEDED or FAILED in
       * its own short transaction. A batch is up to 500 items and a real Xero
       * round trip is someone else's network; inside the effect that is
       * minutes of held row locks (publishing/CLAUDE.md carries the full
       * reasoning). Only the proposal is carried: the QUEUED rows are the
       * work list, so a crash leaves them visible and re-drivable rather than
       * lost.
       */
      readonly kind: 'publish';
      readonly proposalId: string;
      readonly businessId: string;
    };

/** Serialised by the engine into `action_proposals.outcome` (Json?). */
export interface ExecutionResult {
  /** Every row the effect touched — archive is batched, route is not. */
  readonly changed: readonly { readonly entity: 'document'; readonly id: string }[];
  /** True when the effect was already applied: a retry, not a second effect. */
  readonly alreadyApplied: boolean;
  /** The engine enqueues these AFTER commit; see dedupe-follow-up.ts for why. */
  readonly followUps: readonly FollowUp[];
  /** Small, safe, storable. Never untrusted content. */
  readonly detail?: Readonly<Record<string, string | number | boolean>>;
}

export interface ProposalExecutor<K extends ProposalKind, P> {
  readonly kind: K;
  /**
   * `db` is the ENGINE's open transaction. One effect, one transaction,
   * structurally: `ScopedClient` omits `$transaction`, so an executor cannot
   * open a second one, and a partially-applied approved action cannot exist.
   */
  execute(db: ScopedClient, input: ExecutionInput<P>): Promise<ExecutionResult>;
}

/** Total by construction — a missing kind is a compile error, not a runtime 500. */
export type ExecutorRegistry = {
  [K in ProposalKind]: ProposalExecutor<K, ProposalPayloadMap[K]>;
};

/**
 * An effect the executor REFUSES — the payload names a row the approver cannot
 * see, a document in a shape the effect does not apply to, or a semantic
 * impossibility. The engine records it as a failed execution; the message
 * never distinguishes "does not exist" from "not yours" (404-never-403, the
 * house rule, applied to effects).
 */
export class ProposalExecutionRefused extends Error {
  constructor(
    readonly kind: ProposalKind,
    message: string,
    /**
     * The contract `ErrorCode` this refusal should reach the wire as. Omitted →
     * the engine's generic `NT-PRP-006`, which is right for "this proposal is
     * not executable" refusals.
     *
     * It exists because some refusals are NAMED BY THE CONTRACT and a client is
     * meant to branch on them: `PublishBatchPayload` says an item short of the
     * minimum "refuses with `NT-PUB-001`", and `NT-PUB-001` is in the `ErrorCode`
     * enum for exactly that reason. Folding it into the detail prose leaves the
     * machine-readable `Problem.code` saying `NT-PRP-006`, so the one client
     * branch the contract promises cannot be written.
     */
    readonly code?: ErrorCode,
  ) {
    super(`${kind}: ${message}`);
    this.name = 'ProposalExecutionRefused';
  }
}

/** The honest holes (#81, grown by #120): registered, typed, and loudly unbuilt. */
export class ProposalNotImplementedError extends Error {
  constructor(readonly kind: ProposalKind) {
    super(`${kind}: executor not implemented — registered as an honest hole by issue #81; build it in its own issue before any engine executes this kind`);
    this.name = 'ProposalNotImplementedError';
  }
}
