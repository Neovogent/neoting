import { HttpStatus, Logger } from '@nestjs/common';

import type { ActionProposal, ErrorCode, ProposalKind, ProposalReview } from '@neoting/contracts/model';
import type { ActionProposal as ActionProposalRow, Prisma } from '@prisma/client';

import type { PrismaClient } from '../../common/db/prisma.js';
import type { ScopeContext } from '../../common/db/scope-context.js';
import { scopedDb, type ScopedClient } from '../../common/db/scoped-db.js';
import { fingerprint, type IdempotencyStore } from '../../common/idempotency/idempotency-store.js';
import { AppException } from '../../common/problem/problem.js';
import { currentTraceId } from '../../common/trace/trace-context.js';
import {
  type DedupeDetection,
  type ExecutionInput,
  type ExecutionResult,
  type ExecutorRegistry,
  type FollowUp,
  ProposalExecutionRefused,
  ProposalNotImplementedError,
  runDedupeFollowUp,
} from '../validation-dedupe/index.js';
import { appendAuditEvent } from './audit-writer.js';
import { canonicalHash } from './canonical-hash.js';
import { knownProposalKind, parseStoredProposalPayload } from './proposal-body.js';
import { renderSummary } from './render-summary.js';
import { toActionProposal } from './to-action-proposal.js';

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
    private readonly idempotency: IdempotencyStore,
  ) {}

  async create(ctx: ScopeContext, request: CreateProposalRequest, idempotencyKey: string): Promise<ActionProposal> {
    const replay = await this.replayed<ActionProposal>(idempotencyKey, request);
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
      return db.actionProposal.create({
        data: {
          businessId,
          practiceId,
          kind: request.kind,
          payload: request.payload as Prisma.InputJsonObject,
          // SHA-256 over the canonical payload (Governance §10.4). The guard
          // trigger refuses any later change to it.
          payloadHash: canonicalHash(request.payload),
          state: 'CREATED',
          createdByUserId: ctx.actorId,
          expiresAt: new Date(Date.now() + PROPOSAL_TTL_MS),
          traceId,
        },
      });
    });

    const response = toActionProposal(row);
    await this.remember(idempotencyKey, request, response);
    return response;
  }

  async get(ctx: ScopeContext, proposalId: string): Promise<ActionProposal> {
    const row = await scopedDb(this.prisma, ctx, (db) => db.actionProposal.findUnique({ where: { id: proposalId } }));
    if (row === null) throw notFound();
    return toActionProposal(row);
  }

  /**
   * [Read review] — renders exactly what will change and records both
   * `reviewedAt` and the hash of what was rendered. Idempotent by nature:
   * a second call returns the STORED summary and hash, and `reviewedAt`
   * keeps its first value (the contract's words).
   */
  async review(ctx: ScopeContext, proposalId: string, idempotencyKey: string): Promise<ProposalReview> {
    const replay = await this.replayed<ProposalReview>(idempotencyKey, { proposalId });
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

    await this.remember(idempotencyKey, { proposalId }, response);
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
    const replay = await this.replayed<ActionProposal>(idempotencyKey, { proposalId, ...body });
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
    await this.remember(idempotencyKey, { proposalId, ...body }, response);
    return response;
  }

  async cancel(
    ctx: ScopeContext,
    proposalId: string,
    body: { reason?: string | undefined },
    idempotencyKey: string,
  ): Promise<ActionProposal> {
    const replay = await this.replayed<ActionProposal>(idempotencyKey, { proposalId, ...body });
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

    await this.remember(idempotencyKey, { proposalId, ...body }, response);
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
        throw conflict('NT-PRP-006', 'Proposal is not executable', error.message);
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
        // The switch is total the way the registry is: `FollowUp` has one
        // member today, and a second one failing to compile here is the point.
        switch (followUp.kind) {
          case 'dedupe':
            await runDedupeFollowUp(this.prisma, ctx, followUp, this.dedupeDetection, traceId);
        }
      } catch (error) {
        // The approval is committed and correct; the deferral marker is
        // durable and sweepable. Loud log, no 500 for a done action.
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

  private async replayed<T>(idempotencyKey: string, request: unknown): Promise<T | null> {
    const record = await this.idempotency.get(idempotencyKey);
    if (record === null) return null;
    if (record.requestHash !== fingerprint(request)) {
      throw new AppException('NT-IDM-001', HttpStatus.CONFLICT, 'This Idempotency-Key was already used with a different payload');
    }
    return record.response as T;
  }

  private async remember(idempotencyKey: string, request: unknown, response: unknown): Promise<void> {
    await this.idempotency.put(idempotencyKey, { requestHash: fingerprint(request), response });
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

function notFound(): AppException {
  // NT-NOT-001 does not exist (see modules/documents/CLAUDE.md) — NT-VAL-001
  // is the house fallback for an otherwise-uncoded 4xx. The detail never
  // echoes the id and never distinguishes "does not exist" from "not yours".
  return new AppException('NT-VAL-001', HttpStatus.NOT_FOUND, 'Not found', 'No proposal with that id.');
}

function conflict(code: ErrorCode, title: string, detail: string): AppException {
  return new AppException(code, HttpStatus.CONFLICT, title, detail);
}
