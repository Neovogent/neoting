import { HttpStatus, Logger } from '@nestjs/common';

import type {
  ActionProposal,
  BankRemoveStatementPayload,
  ChaseSendPayload,
  ErrorCode,
  ProposalKind,
  ProposalReview,
  PublishBatchPayload,
  UpdateCodingPayload,
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
  assertUpdateCodingAllowed,
  type ChartCategoriesReader,
  type CorrectionSecondOpinion,
  type ChaseComposeConfig,
  computeChaseSendPayload,
  computeCorrectionAdvisory,
  computePublishBatchPayload,
  computeRemoveStatementPayload,
  type DedupeDetection,
  type ExecutionInput,
  type ExecutionResult,
  type ExecutorRegistry,
  type ExportEntryPreviewer,
  type FollowUp,
  ProposalExecutionRefused,
  ProposalNotImplementedError,
  type PublishGateway,
  runDedupeFollowUp,
  runPublishFollowUp,
  transitionDocument,
} from '../validation-dedupe/index.js';
import { assertCanApprove, requiresReleaseAuthority, resolveActor } from './assert-can.js';
import { appendAuditEvent } from './audit-writer.js';
import { canonicalHash } from './canonical-hash.js';
import { proposalIdentity } from './proposal-identity.js';
import { knownProposalKind, parseStoredProposalPayload } from './proposal-body.js';
import { KIND_LABEL, renderSummary } from './render-summary.js';
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
 * How many pending proposals the duplicate check reads before giving up on
 * finding a twin (review item 26).
 *
 * The candidate set is already narrowed to one kind on one business in a
 * non-terminal state inside its TTL, which in a healthy practice is nought to
 * a handful. The cap exists for the UNhealthy one — the queue this feature was
 * reported from held eight over a single document, and a practice that has let
 * hundreds accumulate must not turn every subsequent create into an unbounded
 * scan. Missing a twin past the cap costs one duplicate card, which is what
 * the whole product did until today; blocking the create would be worse.
 */
const DUPLICATE_SCAN_LIMIT = 50;

/**
 * What a caller who staged the same act twice reads (`NT-PRP-007`).
 *
 * Per kind because the sentence has to name the thing they pressed — the rule
 * `assert-can.ts` established for refusal messages, applied on the create side.
 * Partial on purpose: a kind with no sentence gets the generic one, which is
 * true of every kind, rather than nothing.
 */
const DUPLICATE_DETAIL: Partial<Record<ProposalKind, string>> = {
  'publish.batch':
    'This release is already awaiting review — the same documents were staged for this client and nobody has decided it yet. Open Approvals and decide that one.',
  'document.update-coding':
    'A correction to the same field on this document is already awaiting review. Decide that one in Approvals rather than staging a second.',
  'chase.send':
    'A chase for exactly these items is already awaiting review. Decide that one in Approvals rather than staging a second.',
  'bank.remove-statement': 'Removing these statements is already awaiting review. Decide that one in Approvals.',
  'document.purge': 'Deleting these documents is already awaiting review. Decide that one in Approvals.',
  'business.offboard': 'Removing this client is already awaiting review. Decide that one in Approvals.',
  'business.reactivate': 'Restoring this client is already awaiting review. Decide that one in Approvals.',
};

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
    /**
     * The export's own entry preview — what the VT import file will CONTAIN,
     * per document, computed into the payload at proposal time so Read review
     * can render it (D42: a file, never a ledger; nothing is transmitted).
     *
     * Optional so a test can build the engine without it. When absent the
     * proposal simply carries no entry preview and the card falls back to the
     * three totals it always showed; the alternative — an engine that refused
     * to create a publish proposal because it could not describe the file — is
     * a worse failure than a quieter card.
     */
    private readonly exportEntryPreview?: ExportEntryPreviewer,
    /**
     * The client's chart of accounts, for the `document.update-coding`
     * creation gate (review item 47): a typed category must be a code ON the
     * chart — the same refuse-never-fuzzy rule AI rule drafts already obey —
     * validated server-side, whatever client staged the correction.
     *
     * Optional so a test can build the engine without it; absent, the chart
     * check is skipped (the `exportEntryPreview` reasoning — a correction
     * boundary that refused every category because a picklist was not wired
     * would be worse than the junk string it exists to stop).
     */
    private readonly chartCategories?: ChartCategoriesReader,
    /**
     * The MODEL second opinion on a manual correction (review items 22/47's
     * deferred half, 6 Sep 2026).
     *
     * Optional for the third time and for the third time the same reason: a
     * test builds the engine without it, `EXTRACTOR=demo` selects none, and its
     * absence leaves the deterministic advisory exactly as #256 shipped it.
     * Unlike the chart reader, this one is optional in a stronger sense — it is
     * allowed to fail at RUNTIME too. Every failure is `null` and `null` is
     * silence, because the ruling says the check must never block a correction.
     */
    private readonly correctionSecondOpinion?: CorrectionSecondOpinion,
    /**
     * The denial notice (review item 27) — the fifth structural seam this
     * module's factory composes, built in `approvals.module.ts` over
     * `notifications`' `NotificationsService`.
     *
     * ⚠ **A FUNCTION, not the service.** This module needs to send exactly one
     * message and must not acquire an opinion about email: a `NotificationsService`
     * here would put every other message it can send one import away from the
     * engine, which is the second-door shape issue #81 exists to prevent.
     *
     * Optional for the reason every seam here is optional — a test builds the
     * engine without it — and, like the second opinion, optional in the stronger
     * sense too: it is called AFTER the commit and a throw is swallowed into a
     * loud log. A denial whose email failed is a denial, recorded and visible.
     */
    private readonly denialNotice?: DenialNotice,
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
            this.exportEntryPreview,
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
      // And for `bank.remove-statement` (4 Sep 2026): the blast radius Read
      // review renders — per-statement transaction counts, file names, the
      // total — is computed by the SERVER over the provenance-stamped rows;
      // the caller's preview is discarded, and everything refusable (confirmed
      // matches, open chases, cross-workspace, unprovable provenance) refuses
      // NOW rather than at approve.
      if (request.kind === 'bank.remove-statement') {
        try {
          const asked = request.payload as unknown as BankRemoveStatementPayload;
          payload = (await computeRemoveStatementPayload(db, asked.statementIds)) as unknown as Record<string, unknown>;
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
      // The correction-integrity gate (5 Sep 2026, review item 47): a manual
      // category correction must name a code on the client's chart of
      // accounts — refused by exact membership, never fuzzy-matched, the same
      // rule AI rule drafts have always obeyed. A refusal here is a hard rule,
      // not an advisory; the advisory checks run at review (see review()).
      if (request.kind === 'document.update-coding') {
        try {
          await assertUpdateCodingAllowed(db, request.payload as unknown as UpdateCodingPayload, this.chartCategories);
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
      // ---- IDEMPOTENT STAGING (review item 26) ------------------------------
      //
      // Run LAST of the creation checks and immediately before the insert, so
      // a second identical click gets the same refusal the first one would
      // have got if it were malformed — the payload gates above are about
      // whether this act is possible at all, and this one is about whether it
      // is already open.
      //
      // ⚠ It is over the RECOMPUTED payload, not the caller's. The engine has
      // rewritten publish/chase/statement payloads by this point, and the
      // stored rows it compares against were rewritten the same way — so both
      // sides of the comparison come out of the same mill.
      await this.refuseDuplicatePending(db, request.kind, businessId, payload);

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
      // The correction-integrity advisory (items 22/46/47): for a coding
      // correction, run the deterministic checks against the document AS IT
      // STANDS when the review is first opened, and freeze the result into the
      // stored render — the render itself stays a pure function (the checks
      // arrive as an argument), review idempotency returns this stored copy,
      // and the approve call echoes its hash, so what was warned about is part
      // of what was approved. `RenderContext`'s doc says why the checks cannot
      // ride the payload instead. The read is under the caller's own scope.
      // Narrowed to a local: the model second opinion meters against the
      // practice the SESSION fixes, and a proposal with no practice gets the
      // deterministic checks alone.
      const meteredPracticeId = ctx.practiceId ?? null;
      const context =
        row.kind === 'document.update-coding'
          ? {
              correctionChecks: await computeCorrectionAdvisory(
                db,
                payload as unknown as UpdateCodingPayload,
                undefined,
                // ⚠ The MODEL half rides the SAME seam and the same section
                // (items 22/47). It is metered against the practice the session
                // already fixes, never one a caller could name — and a proposal
                // with no practice (there is no such shape for this kind, but
                // the type allows one) simply gets the deterministic checks.
                this.correctionSecondOpinion !== undefined && meteredPracticeId !== null
                  ? { read: this.correctionSecondOpinion, practiceId: meteredPracticeId }
                  : undefined,
              ),
            }
          : {};
      const renderedSummary = renderSummary(row.kind as ProposalKind, payload, context);
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
        // `assertCanApprove`, not `assertCan(…, 'publish.release', …)`: since
        // item 66 tier 1 holds SEVEN kinds, and the five that are not D44's two
        // answer to `proposal.approve` so a refused approver reads a sentence
        // about the act they pressed. One predicate, two names —
        // `assert-can.ts` picks between them.
        assertCanApprove(await resolveActor(db, ctx), {
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

  /**
   * Refuse a create whose act is already awaiting a decision (review item 26,
   * matrix gate ⚖8).
   *
   * > *For same document, multiple review request has come in the approval
   * > tab… make sure no duplicate approval request is sent*
   *
   * Eight identical release cards over one Ready document is what this stops.
   * Staging is now idempotent over WHAT IS BEING PROPOSED, not only over the
   * caller's `Idempotency-Key` — which never helped here, because each click
   * carried a fresh key, honestly.
   *
   * **The candidate set is small by construction**: same kind, same business,
   * still `CREATED` or `REVIEWED`, still inside its TTL. In practice that is
   * nought to a handful of rows, so the identity comparison happens in JS over
   * `proposalIdentity` rather than as a jsonb predicate — which is also what
   * lets it read payloads the engine rewrote at creation without a column to
   * store a request hash in.
   *
   * ⚠ **An expired pending row does NOT block.** It cannot be approved
   * (`NT-PRP-003` refuses it at review and at approve), so treating it as the
   * open decision would leave a caller pointed at a card nobody can act on —
   * a deadlock wearing a helpful sentence.
   *
   * ⚠ **A kind with no identity is never deduped**, and `rule.create` is the
   * deliberate one: two rules over one client are two rules. See
   * `proposal-identity.ts`.
   *
   * The refusal is 409 rather than a quiet 201 over the existing row because
   * the browser cannot see an HTTP status — `packages/contracts`' fetch mutator
   * returns the raw body — so a returned twin would have the dialog claiming to
   * have staged something it did not.
   */
  private async refuseDuplicatePending(
    db: ScopedClient,
    kind: ProposalKind,
    businessId: string | null,
    payload: Record<string, unknown>,
  ): Promise<void> {
    const identity = proposalIdentity(kind, payload);
    if (identity === null) return;

    const pending = await db.actionProposal.findMany({
      where: {
        kind,
        businessId,
        state: { in: ['CREATED', 'REVIEWED'] },
        expiresAt: { gt: new Date() },
      },
      select: { id: true, payload: true },
      // Newest first, so the id named in the log is the one a caller most
      // likely just made — and the scan stops at the first match anyway.
      orderBy: { createdAt: 'desc' },
      take: DUPLICATE_SCAN_LIMIT,
    });

    const twin = pending.find(
      (row) => isJsonObject(row.payload) && proposalIdentity(kind, row.payload as Record<string, unknown>) === identity,
    );
    if (twin === undefined) return;

    throw new AppException(
      'NT-PRP-007',
      HttpStatus.CONFLICT,
      'Already awaiting review',
      // Written for the person who pressed the button twice. It says the act is
      // not lost, and it says where to go — never the proposal id, which would
      // be a handle no screen in the product resolves.
      DUPLICATE_DETAIL[kind] ??
        'An identical request is already awaiting review. Decide that one in Approvals rather than staging a second.',
    );
  }

  /**
   * **[Deny]** — the REVIEWER's refusal (review item 27, matrix gate ⚖7).
   *
   * > *There is no option for denying an approval, if the super admin denies to
   * > approve it then it must ask for the reason, and the reason and declined
   * > message must be sent via email to the team member*
   *
   * Until this existed the card offered Approve and Cancel, and **Cancel is the
   * proposer taking their own work back** — a reviewer who disagreed had nothing
   * to press and no way to say why. The two are different decisions and the
   * state enum now says so: `DENIED`, never `CANCELLED`, and never `REJECTED`
   * (that word already means a DOCUMENT judged unusable, twice over).
   *
   * ## The four things it does, and the order they are done in
   *
   * 1. **Authority first**, before any other gate, for the approve path's
   *    reason verbatim: a caller who may not decide this learns nothing about
   *    its state. Deny authority IS approve authority — a refusal is a decision
   *    of the same weight — so `assertCanApprove` is the same call, and tier-1
   *    kinds answer `NT-PRM-001` to anybody but the firm's super admin.
   * 2. **The proposal is consumed**, `DENIED`, with the reason and the decider
   *    in `outcome`. Nothing is deleted; the record of what we decided NOT to do
   *    is the point.
   * 3. **A denied `publish.batch` sends its documents back** `READY →
   *    TO_REVIEW` wearing "Denied by {name}: {reason}". Only that kind touches a
   *    document: denying a coding correction simply means the correction was
   *    never applied, and there is nothing to send back.
   * 4. **The proposer is emailed the reason — AFTER the commit.**
   *
   * ## ⚠ The email is outside the transaction, and that is not a convenience
   *
   * An SMTP or SES round trip must never hold a tenant transaction open — the
   * rule `runPublishFollowUp` established for the ledger call, for the same
   * reason: it lasts as long as somebody else's network decides. So the denial
   * commits first and the notice is sent after, which means a send failure
   * cannot un-deny anything. It is a loud log, exactly like the post-commit
   * follow-ups: the decision is on the proposal, visible in the queue and on
   * the document, and a lost email is not a lost decision.
   *
   * ⚠ **A model-proposed action has no proposer to write to** and simply skips
   * the notice — `createdByModel` and `createdByUserId` are never both set.
   */
  async deny(
    ctx: ScopeContext,
    proposalId: string,
    body: { reason: string },
    idempotencyKey: string,
  ): Promise<ActionProposal> {
    const replay = await this.replayed<ActionProposal>(ctx, idempotencyKey, { proposalId, ...body });
    if (replay !== null) return replay;

    const traceId = currentTraceId() ?? 'no-trace';
    const { row, notice } = await scopedDb(this.prisma, ctx, async (db) => {
      const proposal = await db.actionProposal.findUnique({ where: { id: proposalId } });
      if (proposal === null) throw notFound();

      const kind = knownProposalKind(proposal.kind);

      // ---- AUTHORITY, first (the approve path's ordering, and its reason) ---
      if (kind !== null && requiresReleaseAuthority(kind)) {
        assertCanApprove(await resolveActor(db, ctx), {
          kind,
          proposalId: proposal.id,
          businessId: proposal.businessId,
        });
      }

      if (proposal.executedAt !== null || proposal.state === 'EXECUTED') {
        throw conflict(
          'NT-PRP-005',
          'Already executed',
          'An executed action is undone by a new proposal, never by denying the old one.',
        );
      }
      if (proposal.state === 'CANCELLED') {
        throw conflict('NT-PRP-006', 'Proposal cancelled', 'The proposer withdrew this before it was decided.');
      }
      // Idempotent replay: denying a denied proposal returns it unchanged rather
      // than overwriting one reviewer's reason with another's.
      if (proposal.state === 'DENIED') return { row: proposal, notice: null };

      // ⚠ An EXPIRED proposal is deliberately still deniable, which is why
      // `refuseTerminal` is not reused here. Review and approve refuse an
      // expired row because approving it would execute against facts that have
      // moved; denying executes nothing. A queue full of expired proposals
      // nobody may close is a queue nobody reads.

      const decider = await readPersonName(db, ctx.actorId);
      const denied = await db.actionProposal.update({
        where: { id: proposal.id },
        data: {
          state: 'DENIED',
          outcome: {
            denied: true,
            reason: body.reason,
            deniedByUserId: ctx.actorId,
            ...(decider === null ? {} : { deniedByName: decider }),
          },
        },
      });

      // ---- the documents go back (publish.batch only) -----------------------
      if (kind === 'publish.batch') {
        await sendDocumentsBack(db, proposal, body.reason, decider, traceId);
      }

      await appendAuditEvent(db, {
        businessId: proposal.businessId,
        event: 'action_proposal.denied',
        proposalId: proposal.id,
        payloadHash: proposal.payloadHash,
        renderedSummaryHash: proposal.renderedSummaryHash,
        traceId,
        outcome: { kind: proposal.kind, deniedByUserId: ctx.actorId },
      });

      // Everything the notice needs, read under the CALLER's scope while it is
      // still open — the mailer runs after the transaction and has none.
      const proposerEmail =
        proposal.createdByUserId === null ? null : await readPersonEmail(db, proposal.createdByUserId);
      const clientName =
        proposal.businessId === null
          ? null
          : ((await db.business.findUnique({ where: { id: proposal.businessId }, select: { name: true } }))?.name ??
            null);

      return {
        row: denied,
        notice:
          proposerEmail === null
            ? null
            : {
                to: proposerEmail,
                actionLabel: labelFor(proposal),
                clientName,
                deciderName: decider,
                reason: body.reason,
              },
      };
    });

    if (notice !== null) {
      try {
        await this.denialNotice?.(notice);
      } catch (error) {
        // The denial is committed and correct. A send failure is a loud log,
        // never a 500 for a decision that was taken — the post-commit
        // follow-ups' rule, one seam over.
        this.logger.warn(
          `denial notice failed [${traceId}]: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    const response = toActionProposal(row);
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

/**
 * What the engine hands the mailer when a proposal is denied (review item 27).
 *
 * Deliberately a plain shape and not `SendProposalDeniedInput`: this module
 * composes no email and holds no address type. It states the facts it read
 * under the caller's scope; `approvals.module.ts` maps them onto the
 * notifications seam, which is the composition root's job.
 */
export interface DenialNoticeInput {
  readonly to: string;
  readonly actionLabel: string;
  readonly clientName: string | null;
  readonly deciderName: string | null;
  readonly reason: string;
}

export type DenialNotice = (input: DenialNoticeInput) => Promise<unknown>;

/**
 * ⚠ `documents.failure_code` for a reviewer's denial, and it is deliberately
 * NOT an `NT-PUB-*` code.
 *
 * `api/documents.ts` reads `failureCode?.startsWith('NT-PUB')` to decide
 * whether a row is a FAILED PUBLISH — a thing the export lane offers to retry.
 * A denial is the opposite: the release was refused by a person and retrying it
 * unchanged is exactly what must not be offered. `NT-DOC-001` is the existing
 * "rejected by a reviewer" value, its runbook page says in as many words that
 * it never reaches the wire as a problem code, and this is precisely what it
 * was minted for.
 */
const DENIED_FAILURE_CODE = 'NT-DOC-001';

/**
 * A denied release sends its documents back to To Review wearing the reason.
 *
 * > *this document must be downgraded from ready tab to review tab with tag
 * > that it is rejected or denied by the super admin for this reason in a
 * > column*
 *
 * ⚠ **Only rows still in `READY` move, and one that has moved on is SKIPPED
 * rather than forced.** Between staging and the denial a document may have been
 * archived, corrected back to `TO_REVIEW` by somebody else, or published by a
 * second approved batch; `LEGAL_TRANSITIONS` refuses most of those and
 * `transitionDocument`'s compare-and-swap would throw on the rest. A denial
 * must not fail because one document in a batch of forty moved — the decision
 * is about the PROPOSAL, and the send-back is a courtesy to the composer.
 *
 * The reason rides `failureCode`/`failureMessage`, the column whose schema
 * comment reads *"why it was rejected or failed"* — and a denial is a
 * rejection, by a person rather than by the pipeline. Everything client-facing
 * then comes free: `api/documents.ts` maps `failureMessage` onto
 * `Document.statusNote`, and `Tables.tsx` already renders that as the amber
 * pill on every review-status row. Zero web bytes for the tag item 27 asked
 * for.
 */
async function sendDocumentsBack(
  db: ScopedClient,
  proposal: ActionProposalRow,
  reason: string,
  deciderName: string | null,
  traceId: string,
): Promise<void> {
  const payload = proposal.payload;
  if (!isJsonObject(payload)) return;
  const documentIds = (payload as Record<string, unknown>)['documentIds'];
  if (!Array.isArray(documentIds)) return;

  const ids = documentIds.filter((id): id is string => typeof id === 'string');
  if (ids.length === 0) return;

  const documents = await db.document.findMany({
    where: { id: { in: ids }, state: 'READY' },
    select: { id: true, state: true },
  });

  for (const document of documents) {
    await transitionDocument(db, document, {
      to: 'TO_REVIEW',
      failure: {
        code: DENIED_FAILURE_CODE,
        // The words the composer reads on the row. The reviewer's own reason is
        // reproduced verbatim — it is the whole of what they have to act on —
        // and the decider is named when we know them.
        message: deciderName === null ? `Denied at review: ${reason}` : `Denied by ${deciderName}: ${reason}`,
      },
      traceId,
      detail: { deniedByProposalId: proposal.id },
    });
  }
}

/**
 * What the denial notice calls the refused act.
 *
 * The proposal's own stored review title first — the server's words for THIS
 * proposal, computed and hashed at Read review, naming counts and figures a
 * bare label cannot. `KIND_LABEL` is the fallback for a proposal denied without
 * its review ever having been opened, which the server permits: refusing to let
 * somebody say no is not a rule worth having.
 */
function labelFor(proposal: ActionProposalRow): string {
  const summary = proposal.renderedSummary;
  if (isJsonObject(summary) && typeof (summary as Record<string, unknown>)['title'] === 'string') {
    return (summary as Record<string, unknown>)['title'] as string;
  }
  const kind = knownProposalKind(proposal.kind);
  return kind === null ? proposal.kind : KIND_LABEL[kind];
}

/**
 * A person's display name, or null when nothing is recorded.
 *
 * ⚠ `users` carries no RLS — it is one of the tables the policies read — so the
 * `id` filter IS the boundary here, exactly as it is in `resolveActor`. Both ids
 * this is called with come from the verified session or from the proposal row
 * RLS has already admitted.
 */
async function readPersonName(db: ScopedClient, userId: string): Promise<string | null> {
  const user = await db.user.findUnique({ where: { id: userId }, select: { firstName: true, lastName: true } });
  if (user === null) return null;
  const name = [user.firstName, user.lastName].filter((part) => part !== null && part !== '').join(' ').trim();
  return name === '' ? null : name;
}

/** The proposer's address. Null for a SYSTEM actor or a row with no email. */
async function readPersonEmail(db: ScopedClient, userId: string): Promise<string | null> {
  const user = await db.user.findUnique({ where: { id: userId }, select: { email: true, kind: true } });
  if (user === null || user.kind !== 'HUMAN') return null;
  return user.email === null || user.email === '' ? null : user.email;
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
