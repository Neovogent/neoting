import { HttpStatus, Logger } from '@nestjs/common';

import type {
  ActionProposal,
  ChaseSendPayload,
  ErrorCode,
  ProposalKind,
  ProposalReview,
  PublishBatchPayload,
} from '@neoting/contracts/model';
import type { listActionProposalsQueryParams } from '@neoting/contracts/zod';
import type { ActionProposal as ActionProposalRow, Prisma } from '@prisma/client';
import type { z } from 'zod';

import type { PrismaClient } from '../../common/db/prisma.js';
import type { ScopeContext } from '../../common/db/scope-context.js';
import { scopedDb, type ScopedClient } from '../../common/db/scoped-db.js';
import { fingerprint, type IdempotencyStore } from '../../common/idempotency/idempotency-store.js';
import {
  dateField,
  type Page,
  type PageRequest,
  pageQuery,
  type SortField,
  toPage,
} from '../../common/pagination/cursor.js';
import { AppException } from '../../common/problem/problem.js';
import { currentTraceId } from '../../common/trace/trace-context.js';
import {
  type ChaseComposeConfig,
  computeChaseSendPayload,
  computePublishBatchPayload,
  type DedupeDetection,
  type ExecutionInput,
  type ExecutionResult,
  type ExecutorRegistry,
  type FollowUp,
  ProposalExecutionRefused,
  ProposalNotImplementedError,
  type PublishGateway,
  runDedupeFollowUp,
  runPublishFollowUp,
} from '../validation-dedupe/index.js';
import { assertCan, requiresReleaseAuthority, resolveActor } from './assert-can.js';
import { appendAuditEvent } from './audit-writer.js';
import { canonicalHash } from './canonical-hash.js';
import { knownProposalKind, parseStoredProposalPayload } from './proposal-body.js';
import { renderSummary } from './render-summary.js';
import { toActionProposal } from './to-action-proposal.js';

type ListProposalsQuery = z.infer<typeof listActionProposalsQueryParams>;

/** Already boundary-parsed by the controller against the kind's own generated member schema. */
export interface CreateProposalRequest {
  readonly kind: ProposalKind;
  readonly businessId: string | null;
  readonly payload: Record<string, unknown>;
}

/**
 * How long a proposal stays approvable. The contract requires a TTL check
 * (`NT-PRP-003`) without fixing the number; 24 hours keeps a morning's
 * pending queue approvable all day while guaranteeing nothing stale from
 * last week executes against facts that have long moved. The expiry SWEEP
 * (rows flipping to `EXPIRED`) is explicitly out of METH S3's scope — the
 * gate refuses at approval time, which is where the guarantee lives.
 */
const PROPOSAL_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * The Review → Approve engine (METH S3, issue #122) — Governance §10, the
 * constitutional path every state change takes. The contract existed first
 * (`/action-proposals`, five operations); this implements it.
 *
 * Division of labour, per the #81 seam: THIS class owns the review gate, the
 * shown-hash comparison, exactly-once execution, the audit write and the
 * `outcome` record. An executor performs one effect inside the transaction
 * this class opens, and decides nothing about whether it may happen.
 *
 * Enforcement is layered, deliberately: every refusal below is ALSO enforced
 * by the `action_proposals_guard()` trigger in the database, so a code path
 * written next year that skips this service still cannot approve an
 * unreviewed proposal or execute one twice. The service exists to turn those
 * refusals into contracted problem+json instead of raw Postgres errors — and
 * the integration test proves the trigger holds when the service is bypassed.
 *
 * Concurrency: approval takes `SELECT … FOR UPDATE` on the proposal row
 * before deciding anything, so two racing approvals serialise — the loser
 * re-reads an executed row and refuses with `NT-PRP-005` BEFORE its executor
 * runs, not after (an effect applied twice and rolled back once is still a
 * bug the executors should never have to survive).
 */
export class ActionProposalsService {
  private readonly logger = new Logger(ActionProposalsService.name);

  constructor(
    private readonly prisma: PrismaClient,
    private readonly registry: ExecutorRegistry,
    private readonly dedupeDetection: DedupeDetection,
    /**
     * Publishing's seam. The SAME object the registry was built with, so the
     * executor's re-validation and the follow-up's ledger are one composition:
     * an engine that queued a batch through one adapter and published it
     * through another would be two systems wearing one name.
     */
    private readonly publishing: PublishGateway,
    private readonly idempotency: IdempotencyStore,
    /**
     * `chase.send` composition config (portal-link secret + web origin). The
     * engine recomposes each message body at creation the way it recomputes
     * the publish preview — the reviewed link is a link that verifies.
     */
    private readonly chaseCompose: ChaseComposeConfig,
  ) {}

  async create(ctx: ScopeContext, request: CreateProposalRequest, idempotencyKey: string): Promise<ActionProposal> {
    const replay = await this.replayed<ActionProposal>(ctx, idempotencyKey, request);
    if (replay !== null) return replay;

    const businessId = request.businessId;
    // The tenancy anchor (issue #104): a business-scoped proposal also carries
    // the caller's practice when one exists (both-set is the normal case, as
    // for documents); a practice-level proposal carries the practice alone.
    const practiceId = ctx.practiceId ?? null;
    if (businessId === null && practiceId === null) {
      throw new AppException(
        'NT-PRP-006',
        HttpStatus.UNPROCESSABLE_ENTITY,
        'Proposal has no tenancy anchor',
        'A proposal needs a business, or a practice-scoped caller.',
      );
    }

    const traceId = currentTraceId() ?? null;
    const row = await scopedDb(this.prisma, ctx, async (db) => {
      if (businessId !== null) {
        // Resolve through RLS BEFORE writing (the web-upload guard, applied
        // here): an unreachable business and an absent one are the same
        // refusal, and neither confirms existence.
        const business = await db.business.findUnique({ where: { id: businessId }, select: { id: true } });
        if (business === null) {
          throw new AppException(
            'NT-PRP-006',
            HttpStatus.UNPROCESSABLE_ENTITY,
            'Proposal is not executable',
            'A referenced record is not reachable.',
          );
        }
      }
      // METH S10, the contract's promise on `PublishBatchPayload.preview`:
      // the figures Read-review renders are computed by the SERVER at proposal
      // time, over the same scoped read the executor re-runs at approve —
      // whatever preview the caller sent is discarded. An item short of the
      // publish minimum refuses creation with `NT-PUB-001` rather than
      // waiting for approval to fail.
      let payload = request.payload;
      if (request.kind === 'publish.batch') {
        try {
          // The controller boundary-parsed the body against the kind's own
          // generated member schema, so the shape is already proven.
          payload = (await computePublishBatchPayload(
            db,
            this.publishing,
            request.payload as unknown as PublishBatchPayload,
          )) as unknown as Record<string, unknown>;
        } catch (error) {
          if (error instanceof ProposalExecutionRefused) {
            throw new AppException(
              error.code ?? 'NT-PRP-006',
              HttpStatus.UNPROCESSABLE_ENTITY,
              'Proposal is not executable',
              error.message,
            );
          }
          throw error;
        }
      }
      // The same promise for `chase.send`: the body Read-review shows is
      // composed by the SERVER over the chased transactions, with a SIGNED
      // portal link the executor's chase will answer to — whatever body the
      // caller sent is discarded (the S13 compose-seam gap, closed).
      if (request.kind === 'chase.send') {
        try {
          payload = (await computeChaseSendPayload(
            db,
            request.payload as unknown as ChaseSendPayload,
            this.chaseCompose,
            // A statement request derives its business from the PROPOSAL's own
            // anchor — it has no transactions to derive one from (Phase 5).
            businessId,
          )) as unknown as Record<string, unknown>;
        } catch (error) {
          if (error instanceof ProposalExecutionRefused) {
            throw new AppException(
              error.code ?? 'NT-PRP-006',
              HttpStatus.UNPROCESSABLE_ENTITY,
              'Proposal is not executable',
              error.message,
            );
          }
          throw error;
        }
      }
      return db.actionProposal.create({
        data: {
          businessId,
          practiceId,
          kind: request.kind,
          payload: payload as Prisma.InputJsonObject,
          // SHA-256 over the canonical payload (Governance §10.4). The guard
          // trigger refuses any later change to it.
          payloadHash: canonicalHash(payload),
          state: 'CREATED',
          createdByUserId: ctx.actorId,
          expiresAt: new Date(Date.now() + PROPOSAL_TTL_MS),
          traceId,
        },
      });
    });

    const response = toActionProposal(row);
    await this.remember(ctx, idempotencyKey, request, response);
    return response;
  }

  async get(ctx: ScopeContext, proposalId: string): Promise<ActionProposal> {
    const row = await scopedDb(this.prisma, ctx, (db) => db.actionProposal.findUnique({ where: { id: proposalId } }));
    if (row === null) throw notFound();
    return toActionProposal(row);
  }

  /**
   * `GET /action-proposals` — the approval queue and its history, newest first,
   * keyset-paginated (METH S12, issue #140 — the contract delta the module's
   * TODO deferred to Stage 12). A read like `getActionProposal`: listing is not
   * reviewing, and nothing here writes. `businessId`/`state`/`kind` are user
   * FILTERS on the RLS-scoped set, never a tenancy guard — a foreign
   * `businessId` yields an empty page (the chases-surface rule).
   */
  async list(ctx: ScopeContext, query: ListProposalsQuery): Promise<Page<ActionProposal>> {
    const request: PageRequest<ActionProposalRow> = {
      sort: PROPOSAL_SORT,
      order: 'desc',
      limit: query.limit,
      cursor: query.cursor,
      // The fingerprint covers what identifies the LIST (its filters), never
      // the caller's position in it — the documents page-2 regression shape.
      query: { businessId: query.businessId, state: query.state, kind: query.kind },
    };
    const seek = pageQuery(request);
    const filters = buildProposalFilters(query);

    const rows = await scopedDb(this.prisma, ctx, async (db) =>
      db.actionProposal.findMany({
        where: seek.where === undefined ? filters : { AND: [filters, seek.where] },
        orderBy: seek.orderBy as Prisma.ActionProposalOrderByWithRelationInput[],
        take: seek.take,
      }),
    );

    const page = toPage(rows, request);
    return { data: page.data.map(toActionProposal), pageInfo: page.pageInfo };
  }

  /**
   * [Read review] — renders exactly what will change and records both
   * `reviewedAt` and the hash of what was rendered. Idempotent by nature:
   * a second call returns the STORED summary and hash, and `reviewedAt`
   * keeps its first value (the contract's words).
   */
  async review(ctx: ScopeContext, proposalId: string, idempotencyKey: string): Promise<ProposalReview> {
    const replay = await this.replayed<ProposalReview>(ctx, idempotencyKey, { proposalId });
    if (replay !== null) return replay;

    const response = await scopedDb(this.prisma, ctx, async (db) => {
      const row = await db.actionProposal.findUnique({ where: { id: proposalId } });
      if (row === null) throw notFound();
      this.refuseTerminal(row);

      if (row.reviewedAt !== null) return toProposalReview(row);

      // Parse the stored payload back through the contract union before
      // rendering — the row sat in a table between propose and review, and a
      // renderer must never run over bytes nothing revalidated.
      const payload = parseStoredPayload(row);
      const renderedSummary = renderSummary(row.kind as ProposalKind, payload);
      const renderedSummaryHash = canonicalHash(renderedSummary);

      const updated = await db.actionProposal.update({
        where: { id: row.id },
        data: {
          reviewedAt: new Date(),
          renderedSummary: renderedSummary as unknown as Prisma.InputJsonObject,
          renderedSummaryHash,
          state: 'REVIEWED',
        },
      });
      return toProposalReview(updated);
    });

    await this.remember(ctx, idempotencyKey, { proposalId }, response);
    return response;
  }

  /**
   * [Approve] — the only operation in the contract that executes anything.
   * Gate ladder, executor effect, proposal consumption and audit append all
   * commit in ONE transaction; the dedupe follow-up runs after commit.
   */
  async approve(
    ctx: ScopeContext,
    proposalId: string,
    body: { renderedSummaryHash: string; comment?: string | undefined },
    idempotencyKey: string,
  ): Promise<ActionProposal> {
    const replay = await this.replayed<ActionProposal>(ctx, idempotencyKey, { proposalId, ...body });
    if (replay !== null) return replay;

    const traceId = currentTraceId() ?? 'no-trace';
    const { row, followUps } = await scopedDb(this.prisma, ctx, async (db) => {
      // Serialise racing approvals on the row itself, BEFORE deciding
      // anything: the loser blocks here, then re-reads the winner's committed
      // executed_at and refuses without its executor ever running. RLS
      // applies to this SELECT like any other, so an invisible proposal is
      // an empty result — 404, never 403.
      const locked = await db.$queryRaw<{ id: string }[]>`
        SELECT id FROM action_proposals WHERE id = ${proposalId} FOR UPDATE`;
      if (locked.length === 0) throw notFound();

      const proposal = await db.actionProposal.findUnique({ where: { id: proposalId } });
      if (proposal === null) throw notFound();

      // ---- THE RELEASE GATE (A12, D44, Governance §11.2) --------------------
      //
      // FIRST gate after visibility, and BEFORE the executor — the hook point
      // `publish-batch.ts`'s header names. The engine owns authorisation; an
      // executor decides nothing about whether an effect may happen, so a
      // second check beside this one would be two mechanisms free to disagree.
      //
      // Ordered here, not lower down, because authorisation precedes every
      // other question about the action: an actor who may not release learns
      // nothing about whether this proposal was reviewed, whether it expired,
      // or whether their echoed hash was stale. And it is ordered AFTER the
      // RLS lookup above, so a proposal the caller cannot see is still a 404 —
      // visibility and authority are different refusals and `assert-can.ts`
      // carries the reasoning for giving them different answers.
      //
      // The membership read is LAZY: only a release kind pays for it, so the
      // ordinary compose-and-edit approvals every accountant does all day take
      // no extra query.
      // `knownProposalKind` rather than a cast: a column value outside the enum
      // is refused `NT-PRP-001` a few lines below by `parseStoredPayload`, and
      // nothing it could name is a release, so it never reaches an effect.
      const kind = knownProposalKind(proposal.kind);
      if (kind !== null && requiresReleaseAuthority(kind)) {
        assertCan(await resolveActor(db, ctx), 'publish.release', {
          kind,
          proposalId: proposal.id,
          businessId: proposal.businessId,
        });
      }

      this.refuseTerminal(proposal);
      if (proposal.reviewedAt === null || proposal.renderedSummaryHash === null) {
        // Also enforced by action_proposals_guard() in the database — the
        // integration test proves the trigger holds without this service.
        throw conflict('NT-PRP-002', 'Review not opened', 'This proposal cannot be approved until its review has been opened.');
      }
      if (proposal.expiresAt.getTime() < Date.now()) {
        throw conflict('NT-PRP-003', 'Proposal expired', 'This proposal has expired; propose the action again.');
      }
      if (body.renderedSummaryHash !== proposal.renderedSummaryHash) {
        throw conflict('NT-PRP-004', 'Rendered summary no longer matches', 'What was reviewed is not what would execute. Re-open the review.');
      }

      const payload = parseStoredPayload(proposal);
      const result = await this.execute(db, ctx, proposal, payload, traceId);

      const now = new Date();
      const updated = await db.actionProposal.update({
        where: { id: proposal.id },
        data: {
          state: 'EXECUTED',
          approvedByUserId: ctx.actorId,
          approvedAt: now,
          // Execution consumes the proposal exactly once; from here the guard
          // trigger makes the row immutable.
          executedAt: now,
          outcome: {
            changed: result.changed,
            alreadyApplied: result.alreadyApplied,
            ...(result.detail === undefined ? {} : { detail: result.detail }),
            ...(body.comment === undefined ? {} : { comment: body.comment }),
          } as unknown as Prisma.InputJsonObject,
        },
      });

      await appendAuditEvent(db, {
        businessId: proposal.businessId,
        event: 'action_proposal.executed',
        proposalId: proposal.id,
        payloadHash: proposal.payloadHash,
        renderedSummaryHash: proposal.renderedSummaryHash,
        traceId,
        outcome: {
          kind: proposal.kind,
          approvedByUserId: ctx.actorId,
          alreadyApplied: result.alreadyApplied,
          changed: result.changed.length,
        },
      });

      return { row: updated, followUps: result.followUps };
    });

    // AFTER commit, never inside it (dedupe-follow-up.ts on why): the effect
    // transaction wrote the durable deferral marker, so a crash here loses
    // nothing — the deferred event stays visible to the sweep.
    await this.runFollowUps(ctx, followUps, traceId);

    const response = toActionProposal(row);
    await this.remember(ctx, idempotencyKey, { proposalId, ...body }, response);
    return response;
  }

  async cancel(
    ctx: ScopeContext,
    proposalId: string,
    body: { reason?: string | undefined },
    idempotencyKey: string,
  ): Promise<ActionProposal> {
    const replay = await this.replayed<ActionProposal>(ctx, idempotencyKey, { proposalId, ...body });
    if (replay !== null) return replay;

    const response = await scopedDb(this.prisma, ctx, async (db) => {
      const row = await db.actionProposal.findUnique({ where: { id: proposalId } });
      if (row === null) throw notFound();
      if (row.executedAt !== null) {
        throw conflict('NT-PRP-005', 'Already executed', 'An executed action is undone by a new proposal, never by cancelling the old one.');
      }
      if (row.state === 'CANCELLED') return toActionProposal(row); // idempotent replay

      const updated = await db.actionProposal.update({
        where: { id: row.id },
        data: {
          state: 'CANCELLED',
          // Nothing is deleted — "what did we decide not to do" is part of
          // the record (the contract's words); the reason rides in outcome.
          outcome: { cancelled: true, ...(body.reason === undefined ? {} : { reason: body.reason }) },
        },
      });
      return toActionProposal(updated);
    });

    await this.remember(ctx, idempotencyKey, { proposalId, ...body }, response);
    return response;
  }

  /** Dispatch to the registry executor, mapping its refusals onto the contract. */
  private async execute(
    db: ScopedClient,
    ctx: ScopeContext,
    proposal: ActionProposalRow,
    payload: unknown,
    traceId: string,
  ): Promise<ExecutionResult> {
    // The registry is total over the enum and the boundary refused unknown
    // kinds with NT-PRP-001, so a miss here means the column was edited
    // outside this module. Second line of defence, kept loud.
    const kind = knownProposalKind(proposal.kind);
    if (kind === null) {
      throw new AppException('NT-PRP-001', HttpStatus.BAD_REQUEST, 'Unknown action kind');
    }
    const executor = this.registry[kind] as unknown as UntypedExecutor;
    try {
      return await executor.execute(db, { proposalId: proposal.id, payload, ctx, traceId });
    } catch (error) {
      // Both refusals roll the whole transaction back — approval, execution
      // and audit are one atom, and a refused effect leaves no partial state.
      if (error instanceof ProposalExecutionRefused) {
        // A refusal the CONTRACT names carries its own code (e.g. publish's
        // `NT-PUB-001` for an item short of the minimum, which `ErrorCode` lists
        // precisely so a client can branch on it). Everything else is the
        // generic "this proposal is not executable".
        throw conflict(error.code ?? 'NT-PRP-006', 'Proposal is not executable', error.message);
      }
      if (error instanceof ProposalNotImplementedError) {
        throw conflict('NT-PRP-006', 'Action kind not yet executable', `No executor exists for ${proposal.kind} yet.`);
      }
      throw error;
    }
  }

  private async runFollowUps(ctx: ScopeContext, followUps: readonly FollowUp[], traceId: string): Promise<void> {
    for (const followUp of followUps) {
      try {
        // The switch is total the way the registry is — a new `FollowUp`
        // member that fails to compile here is the point. Two members since
        // METH S10, and the second is the one that matters most: `publish`
        // makes the LEDGER call, which must never happen inside the effect
        // transaction (publishing/CLAUDE.md carries the reasoning).
        switch (followUp.kind) {
          case 'dedupe':
            await runDedupeFollowUp(this.prisma, ctx, followUp, this.dedupeDetection, traceId);
            break;
          case 'publish':
            await runPublishFollowUp(this.prisma, ctx, followUp, this.publishing.ledger, traceId);
            break;
        }
      } catch (error) {
        // The approval is committed and correct; the deferral marker is
        // durable and sweepable — for publish that is the QUEUED `publishes`
        // rows, which are visible and re-drivable and never a lie. Loud log,
        // no 500 for a done action.
        this.logger.warn(
          `post-commit ${followUp.kind} follow-up failed [${traceId}]: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }

  /** Review and approval share one terminal-state ladder; the codes differ per gate above it. */
  private refuseTerminal(row: ActionProposalRow): void {
    if (row.executedAt !== null || row.state === 'EXECUTED') {
      throw conflict('NT-PRP-005', 'Already executed', 'Execution consumes a proposal exactly once.');
    }
    if (row.state === 'CANCELLED') {
      throw conflict('NT-PRP-006', 'Proposal cancelled', 'A cancelled proposal cannot be reviewed or approved; propose the action again.');
    }
    if (row.state === 'EXPIRED' || row.expiresAt.getTime() < Date.now()) {
      throw conflict('NT-PRP-003', 'Proposal expired', 'This proposal has expired; propose the action again.');
    }
  }

  private async replayed<T>(ctx: ScopeContext, idempotencyKey: string, request: unknown): Promise<T | null> {
    const record = await this.idempotency.get(idempotencyKey);
    if (record === null) return null;
    if (record.requestHash !== this.fingerprintFor(ctx, request)) {
      throw new AppException('NT-IDM-001', HttpStatus.CONFLICT, 'This Idempotency-Key was already used with a different payload');
    }
    return record.response as T;
  }

  private async remember(ctx: ScopeContext, idempotencyKey: string, request: unknown, response: unknown): Promise<void> {
    await this.idempotency.put(idempotencyKey, { requestHash: this.fingerprintFor(ctx, request), response });
  }

  /**
   * The replay fingerprint is scoped to the ACTOR, not just the request (A12).
   *
   * The store is a process-wide map keyed by a CALLER-CHOSEN string, and a
   * replay returns its stored response **before** any scoped query runs — so
   * without the actor in the fingerprint, presenting somebody else's
   * `Idempotency-Key` with a matching body replays their response, past RLS and
   * past the release gate above. Nothing executes twice (the proposal row is
   * consumed and the database guard is what makes that true), so this is a
   * disclosure hole rather than an effect one — but on the approve path the
   * thing disclosed is the outcome of an approval the caller was refused.
   *
   * Two callers colliding on a key now get `NT-IDM-001`, which is what the
   * contract already says about a key used for a different request. It is a
   * different request: a different person made it.
   *
   * ⚠ This narrows the hole, it does not close the class. The store itself is
   * `common/idempotency/`'s in-memory one, shared with web-upload and
   * clients-team-settings, and it is neither durable nor tenant-scoped. The
   * durable-store follow-up in this module's TODO is the same change.
   */
  private fingerprintFor(ctx: ScopeContext, request: unknown): string {
    return fingerprint({ actorId: ctx.actorId, request });
  }
}

/** The registry entry as the engine calls it — payload already re-validated, typing restored per-kind by the registry's own mapped type. */
interface UntypedExecutor {
  execute(db: ScopedClient, input: ExecutionInput<unknown>): Promise<ExecutionResult>;
}

/**
 * The stored payload, re-parsed through the SAME generated member schema that
 * admitted it — the row sat in a table between propose and execute, and the
 * executor does not re-validate (the #81 contract: parse here, not there).
 */
function parseStoredPayload(row: ActionProposalRow): Record<string, unknown> {
  const kind = knownProposalKind(row.kind);
  if (kind === null) {
    throw new AppException('NT-PRP-001', HttpStatus.BAD_REQUEST, 'Unknown action kind');
  }
  const payload = parseStoredProposalPayload(kind, row.payload);
  if (payload === null) {
    throw conflict('NT-PRP-006', 'Proposal is not executable', 'The stored payload no longer parses against the contract.');
  }
  return payload;
}

function toProposalReview(row: ActionProposalRow): ProposalReview {
  // Both set together in review(); a row with one and not the other cannot be
  // written by this module. Loud if some other writer manages it.
  if (row.reviewedAt === null || row.renderedSummaryHash === null || !isJsonObject(row.renderedSummary)) {
    throw new Error(`proposal ${row.id} has an inconsistent review record`);
  }
  return {
    proposal: toActionProposal(row),
    renderedSummary: row.renderedSummary as unknown as ProposalReview['renderedSummary'],
    renderedSummaryHash: row.renderedSummaryHash,
    reviewedAt: row.reviewedAt.toISOString(),
  };
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Proposals sort newest-first on `createdAt` (required, `@default(now())`, so
 * NOT nullable — a `nulls` clause on a required column 500s the list). The
 * unique id is the tie-break the cursor helper appends.
 */
const PROPOSAL_SORT: SortField<ActionProposalRow> = dateField<ActionProposalRow>(
  'createdAt',
  (r) => r.createdAt,
  false,
);

/**
 * The user-facing filters, applied ON TOP of what RLS already narrowed to.
 * Nothing here is a security boundary — a `businessId` the caller cannot reach
 * matches rows that were already invisible, so the page is simply empty.
 * `state` and `kind` are the contract's repeatable widen filters; there is no
 * default exclusion — decided history is part of the record.
 */
function buildProposalFilters(query: ListProposalsQuery): Prisma.ActionProposalWhereInput {
  return {
    ...(query.businessId !== undefined ? { businessId: query.businessId } : {}),
    ...(query.state !== undefined && query.state.length > 0 ? { state: { in: query.state } } : {}),
    ...(query.kind !== undefined && query.kind.length > 0 ? { kind: { in: query.kind } } : {}),
  };
}

function notFound(): AppException {
  // NT-NOT-001 does not exist (see modules/documents/CLAUDE.md) — NT-VAL-001
  // is the house fallback for an otherwise-uncoded 4xx. The detail never
  // echoes the id and never distinguishes "does not exist" from "not yours".
  return new AppException('NT-VAL-001', HttpStatus.NOT_FOUND, 'Not found', 'No proposal with that id.');
}

function conflict(code: ErrorCode, title: string, detail: string): AppException {
  return new AppException(code, HttpStatus.CONFLICT, title, detail);
}
