import type { RuleCreatePayload } from '@neoting/contracts/model';
import type { Prisma } from '@prisma/client';

import type { ScopedClient } from '../../../common/db/scoped-db.js';
import {
  type ExecutionInput,
  type ExecutionResult,
  ProposalExecutionRefused,
  type ProposalExecutor,
} from './proposal-executor.js';

/**
 * `rule.create` — a coding rule comes into force (METH Stage 13, SoT §4
 * Stage 3).
 *
 * The utterance ("Whenever Bidfood invoices arrive for American Burger, code
 * them Cost of Sales Food…") was parsed OUTSIDE this executor — by the chat's
 * canned table today, by a model later — and what arrives here is the
 * contract's `RuleCreatePayload`, already reviewed by a human. The contract's
 * words: a rule never activates from an unapproved utterance, however
 * plain-English the request was. That is why the row is written with
 * `actionProposalId` — no rule exists without the proposal that activated it
 * (the schema comment on the column says the same).
 *
 * One effect: one `rules` row, active from birth, because approval IS the
 * activation (the chase.send stance — the executor runs on the far side of
 * Approve, so a rule born inactive would need a second approved action to
 * switch on, and no `rule.activate` kind exists in this pass).
 *
 * What honours it: the extraction pipeline's single-tier supplier match
 * (`extraction-pipeline.ts` — `tier: SUPPLIER_CUSTOMER`, exact `scopeKey`
 * equal to the extracted supplier name). Richer `conditions` are stored
 * verbatim for the four-tier engine to consume; nothing evaluates them yet.
 * // DEMO-MOCK: the four-tier priority engine replaces the single-tier match.
 */
export const ruleCreateExecutor: ProposalExecutor<'rule.create', RuleCreatePayload> = {
  kind: 'rule.create',

  async execute(db: ScopedClient, input: ExecutionInput<RuleCreatePayload>): Promise<ExecutionResult> {
    const { payload, proposalId, ctx } = input;

    // Idempotent replay: the engine may retry after a crash between the effect
    // and the record. A rule already stamped with this proposal id is this
    // exact activation, already done — never a second row.
    const existing = await db.rule.findFirst({
      where: { actionProposalId: proposalId },
      select: { id: true },
    });
    if (existing !== null) {
      return {
        changed: [{ entity: 'rule', id: existing.id }],
        alreadyApplied: true,
        followUps: [],
      };
    }

    // The payload carries no business — the PROPOSAL is the anchor (the
    // engine resolved it through RLS at creation). `rules.business_id` is
    // required: a practice-level rule has no home in the schema, so a
    // proposal without a business refuses rather than inventing scope.
    const proposal = await db.actionProposal.findUnique({
      where: { id: proposalId },
      select: { businessId: true },
    });
    const businessId = proposal?.businessId ?? null;
    if (businessId === null) {
      throw new ProposalExecutionRefused('rule.create', 'a rule needs a client workspace — this proposal has none');
    }

    // Resolve the business through RLS before writing (the route/chase.send
    // guard applied to effects): an unreachable workspace and an absent one
    // are the same refusal, and neither confirms existence.
    const business = await db.business.findUnique({ where: { id: businessId }, select: { id: true } });
    if (business === null) {
      throw new ProposalExecutionRefused('rule.create', 'the client workspace is not reachable');
    }

    const rule = await db.rule.create({
      data: {
        businessId,
        tier: payload.tier,
        scopeKey: payload.scopeKey ?? null,
        ...(payload.conditions == null ? {} : { conditions: payload.conditions as Prisma.InputJsonObject }),
        sets: payload.sets as Prisma.InputJsonObject,
        isActive: true,
        createdVia: 'chat',
        createdByUserId: ctx.actorId,
        actionProposalId: proposalId,
      },
      select: { id: true },
    });

    return {
      changed: [{ entity: 'rule', id: rule.id }],
      alreadyApplied: false,
      followUps: [],
      detail: {
        ruleId: rule.id,
        tier: payload.tier,
        ...(payload.scopeKey == null ? {} : { scopeKey: payload.scopeKey }),
      },
    };
  },
};
