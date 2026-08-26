import { expect, test } from 'vitest';

import type { ExecutionResult, ExecutorRegistry } from '../validation-dedupe/index.js';
import { ProposalNotImplementedError } from '../validation-dedupe/index.js';
import type { PrismaClient } from '../../common/db/prisma.js';
import { ScopeContextSchema } from '../../common/db/scope-context.js';
import { InMemoryIdempotencyStore } from '../../common/idempotency/idempotency-store.js';
import { AppException } from '../../common/problem/problem.js';
import { ActionProposalsService } from './action-proposals.service.js';
import { canonicalHash } from './canonical-hash.js';

/**
 * The gate ladder, against a recording fake — the assertions are on what
 * reaches the database and on WHETHER THE EXECUTOR RAN, which is the thing
 * each refusal exists to prevent. The trigger-level enforcement (approve
 * bypassing this service entirely) is the integration test's half.
 */

const CTX = ScopeContextSchema.parse({ actorId: 'usr_1', practiceId: 'prac_1' });

interface ProposalRow {
  id: string;
  businessId: string | null;
  practiceId: string | null;
  kind: string;
  payload: Record<string, unknown>;
  payloadHash: string;
  renderedSummary: Record<string, unknown> | null;
  renderedSummaryHash: string | null;
  state: string;
  createdByUserId: string | null;
  createdByModel: string | null;
  createdAt: Date;
  reviewedAt: Date | null;
  approvedByUserId: string | null;
  approvedAt: Date | null;
  executedAt: Date | null;
  expiresAt: Date;
  policyProposalId: string | null;
  outcome: Record<string, unknown> | null;
  traceId: string | null;
}

const ARCHIVE_PAYLOAD = { documentIds: ['doc_1'], archived: true };
const PUBLISH_PAYLOAD = { documentIds: ['doc_1'], preview: { itemCount: 1, grossPence: 12_000, vatPence: 2_000 } };

/** The firm's super admin: the release role AND the ownership flag (A12, D44). */
const OWNER_MEMBERSHIP = { role: 'PRACTICE_ADMIN', isOwner: true };

function proposal(id: string, over: Partial<ProposalRow> = {}): ProposalRow {
  return {
    id,
    businessId: 'biz_1',
    practiceId: 'prac_1',
    kind: 'document.archive',
    payload: ARCHIVE_PAYLOAD,
    payloadHash: canonicalHash(ARCHIVE_PAYLOAD),
    renderedSummary: null,
    renderedSummaryHash: null,
    state: 'CREATED',
    createdByUserId: 'usr_1',
    createdByModel: null,
    createdAt: new Date('2026-08-18T09:00:00Z'),
    reviewedAt: null,
    approvedByUserId: null,
    approvedAt: null,
    executedAt: null,
    expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    policyProposalId: null,
    outcome: null,
    traceId: null,
    ...over,
  };
}

function harness(
  rows: ProposalRow[] = [],
  executorResult?: ExecutionResult | Error,
  /**
   * The acting membership the release gate reads (A12). `null` is a caller with
   * no practice-wide membership at all; the default is the firm's super admin,
   * so every pre-existing test keeps its old meaning.
   */
  membership: { role: string; isOwner: boolean } | null = OWNER_MEMBERSHIP,
) {
  const map = new Map(rows.map((r) => [r.id, r]));
  const audits: Record<string, unknown>[] = [];
  const executed: string[] = [];
  const listCalls: { where?: unknown; orderBy?: unknown; take?: number }[] = [];
  const membershipQueries: Record<string, unknown>[] = [];
  let idSeq = 0;

  const tx = {
    $executeRaw: async () => 0, // scopedDb's GUCs
    $queryRaw: async (strings: TemplateStringsArray, ...args: unknown[]) => {
      const sql = strings.join('?');
      if (sql.includes('FOR UPDATE')) return map.has(args[0] as string) ? [{ id: args[0] }] : [];
      return [{}]; // the audit writer's advisory lock
    },
    actionProposal: {
      findMany: async (args: { where?: unknown; orderBy?: unknown; take?: number }) => {
        listCalls.push(args);
        return [...map.values()];
      },
      findUnique: async ({ where }: { where: { id: string } }) => map.get(where.id) ?? null,
      create: async ({ data }: { data: Record<string, unknown> }) => {
        const row = proposal(`prop_${++idSeq}`, data as Partial<ProposalRow>);
        map.set(row.id, row);
        return row;
      },
      update: async ({ where, data }: { where: { id: string }; data: Partial<ProposalRow> }) => {
        const row = map.get(where.id);
        if (row === undefined) throw new Error('update on missing row');
        Object.assign(row, data);
        return row;
      },
    },
    business: {
      findUnique: async ({ where }: { where: { id: string } }) => (where.id === 'biz_1' ? { id: where.id } : null),
    },
    membership: {
      findFirst: async ({ where }: { where: Record<string, unknown> }) => {
        membershipQueries.push(where);
        return membership;
      },
    },
    auditEvent: {
      findFirst: async () => null,
      create: async ({ data }: { data: Record<string, unknown> }) => {
        audits.push(data);
        return data;
      },
    },
  };
  const prisma = { $transaction: async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx) } as unknown as PrismaClient;

  const registry = {
    'document.archive': {
      kind: 'document.archive',
      execute: async () => {
        executed.push('document.archive');
        if (executorResult instanceof Error) throw executorResult;
        return executorResult ?? { changed: [{ entity: 'document', id: 'doc_1' }], alreadyApplied: false, followUps: [] };
      },
    },
    'chase.send': {
      kind: 'chase.send',
      execute: async () => {
        executed.push('chase.send');
        throw new ProposalNotImplementedError('chase.send');
      },
    },
    // A recording executor for the OTHER gated kind (A12), so a refusal can be
    // told apart from an effect that ran and was rolled back.
    'publish.batch': {
      kind: 'publish.batch',
      execute: async () => {
        executed.push('publish.batch');
        return { changed: [{ entity: 'document', id: 'doc_1' }], alreadyApplied: false, followUps: [] };
      },
    },
  } as unknown as ExecutorRegistry;

  const service = new ActionProposalsService(
    prisma,
    registry,
    { detect: async () => ({ findings: [], candidatesTruncated: false }) },
    // No publish proposals here, so the ledger is never reached; a stub keeps
    // the gate-ladder assertions independent of METH S10's wiring.
    {
      ledger: { publishBill: async () => ({ ok: true, externalRef: 'STUB', attachmentSent: false }) },
      previewPublishBatch: () => ({ ok: true, preview: { itemCount: 0, grossPence: 0, vatPence: 0 } }),
    },
    new InMemoryIdempotencyStore(),
  );
  return { service, map, audits, executed, listCalls, membershipQueries };
}

const code = async (p: Promise<unknown>): Promise<string> => {
  try {
    await p;
    return 'no-throw';
  } catch (e) {
    return e instanceof AppException ? e.code : `unexpected:${String(e)}`;
  }
};

// ---- create -----------------------------------------------------------------

test('create stores the canonical payload hash, the creator, and executes nothing', async () => {
  const { service, map, executed } = harness();
  const created = await service.create(CTX, { kind: 'document.archive', businessId: 'biz_1', payload: ARCHIVE_PAYLOAD }, 'key-1');
  expect(created.state).toBe('CREATED');
  expect(created.payloadHash).toBe(canonicalHash(ARCHIVE_PAYLOAD));
  expect(created.createdByUserId).toBe('usr_1');
  expect(created.reviewedAt).toBeNull();
  expect(executed).toEqual([]);
  expect(map.size).toBe(1);
});

test('create refuses an unreachable business (422, never confirming existence) and an anchorless proposal', async () => {
  const { service } = harness();
  expect(await code(service.create(CTX, { kind: 'document.archive', businessId: 'biz_other', payload: ARCHIVE_PAYLOAD }, 'k'))).toBe('NT-PRP-006');
  const businessScoped = ScopeContextSchema.parse({ actorId: 'usr_2', businessId: 'biz_1' });
  expect(await code(service.create(businessScoped, { kind: 'document.archive', businessId: null, payload: ARCHIVE_PAYLOAD }, 'k2'))).toBe('NT-PRP-006');
});

test('a replayed Idempotency-Key returns the original response; a reused one with a different payload is NT-IDM-001', async () => {
  const { service, map } = harness();
  const first = await service.create(CTX, { kind: 'document.archive', businessId: 'biz_1', payload: ARCHIVE_PAYLOAD }, 'key-1');
  const replay = await service.create(CTX, { kind: 'document.archive', businessId: 'biz_1', payload: ARCHIVE_PAYLOAD }, 'key-1');
  expect(replay).toEqual(first);
  expect(map.size).toBe(1); // no second proposal
  expect(await code(service.create(CTX, { kind: 'document.archive', businessId: 'biz_1', payload: { documentIds: ['doc_2'], archived: true } }, 'key-1'))).toBe('NT-IDM-001');
});

// ---- review -----------------------------------------------------------------

test('review records what was rendered; a second review returns the SAME hash and keeps the first reviewedAt', async () => {
  const { service } = harness([proposal('prop_a')]);
  const first = await service.review(CTX, 'prop_a', 'k1');
  expect(first.renderedSummaryHash).toMatch(/^[a-f0-9]{64}$/);
  expect(first.proposal.state).toBe('REVIEWED');
  const second = await service.review(CTX, 'prop_a', 'k2');
  expect(second.renderedSummaryHash).toBe(first.renderedSummaryHash);
  expect(second.reviewedAt).toBe(first.reviewedAt);
});

test('review refuses executed, cancelled and expired proposals; get/review of an invisible proposal is 404', async () => {
  const { service } = harness([
    proposal('prop_done', { executedAt: new Date(), state: 'EXECUTED' }),
    proposal('prop_gone', { state: 'CANCELLED' }),
    proposal('prop_old', { expiresAt: new Date(Date.now() - 1000) }),
  ]);
  expect(await code(service.review(CTX, 'prop_done', 'k'))).toBe('NT-PRP-005');
  expect(await code(service.review(CTX, 'prop_gone', 'k'))).toBe('NT-PRP-006');
  expect(await code(service.review(CTX, 'prop_old', 'k'))).toBe('NT-PRP-003');
  expect(await code(service.review(CTX, 'prop_missing', 'k'))).toBe('NT-VAL-001');
  expect(await code(service.get(CTX, 'prop_missing'))).toBe('NT-VAL-001');
});

// ---- approve: the gate ladder ------------------------------------------------

test('approve WITHOUT review is refused NT-PRP-002 and the executor never runs', async () => {
  const { service, executed } = harness([proposal('prop_a')]);
  expect(await code(service.approve(CTX, 'prop_a', { renderedSummaryHash: 'f'.repeat(64) }, 'k'))).toBe('NT-PRP-002');
  expect(executed).toEqual([]);
});

test('approve with a stale rendered hash is refused NT-PRP-004 and the executor never runs', async () => {
  const { service, executed } = harness([proposal('prop_a')]);
  await service.review(CTX, 'prop_a', 'k1');
  expect(await code(service.approve(CTX, 'prop_a', { renderedSummaryHash: 'f'.repeat(64) }, 'k2'))).toBe('NT-PRP-004');
  expect(executed).toEqual([]);
});

test('the full path: review → approve executes exactly once, consumes the proposal, and appends the audit event', async () => {
  const { service, executed, audits, map } = harness([proposal('prop_a')]);
  const review = await service.review(CTX, 'prop_a', 'k1');
  const approved = await service.approve(CTX, 'prop_a', { renderedSummaryHash: review.renderedSummaryHash, comment: 'looks right' }, 'k2');

  expect(executed).toEqual(['document.archive']);
  expect(approved.state).toBe('EXECUTED');
  expect(approved.approvedByUserId).toBe('usr_1');
  expect(approved.executedAt).not.toBeNull();
  expect(approved.outcome).toMatchObject({ alreadyApplied: false, comment: 'looks right' });

  expect(audits).toHaveLength(1);
  expect(audits[0]).toMatchObject({
    businessId: 'biz_1',
    event: 'action_proposal.executed',
    proposalId: 'prop_a',
    payloadHash: map.get('prop_a')?.payloadHash,
    renderedSummaryHash: review.renderedSummaryHash,
  });

  // Second approve: the proposal is consumed. Same key → original outcome,
  // no second execution; different key → NT-PRP-005.
  const replay = await service.approve(CTX, 'prop_a', { renderedSummaryHash: review.renderedSummaryHash, comment: 'looks right' }, 'k2');
  expect(replay).toEqual(approved);
  expect(await code(service.approve(CTX, 'prop_a', { renderedSummaryHash: review.renderedSummaryHash }, 'k3'))).toBe('NT-PRP-005');
  expect(executed).toEqual(['document.archive']);
  expect(audits).toHaveLength(1);
});

test('an unimplemented kind refuses at approval (NT-PRP-006) — after review, before any write', async () => {
  const chasePayload = { messages: [{ recipientE164: '+447700900001', body: 'x', transactionIds: ['t1'] }] };
  const { service, audits } = harness([
    proposal('prop_c', { kind: 'chase.send', payload: chasePayload, payloadHash: canonicalHash(chasePayload) }),
  ]);
  const review = await service.review(CTX, 'prop_c', 'k1');
  expect(await code(service.approve(CTX, 'prop_c', { renderedSummaryHash: review.renderedSummaryHash }, 'k2'))).toBe('NT-PRP-006');
  expect(audits).toHaveLength(0);
});

test('a stored payload that no longer parses refuses NT-PRP-006 rather than reaching the executor', async () => {
  const { service, executed } = harness([
    proposal('prop_bad', { payload: { documentIds: [], archived: 'yes' } as never, payloadHash: 'deadbeef' }),
  ]);
  expect(await code(service.review(CTX, 'prop_bad', 'k'))).toBe('NT-PRP-006');
  expect(executed).toEqual([]);
});

// ---- approve: the RELEASE GATE (A12, D44, Governance §11.2) ------------------

function publishProposal(id: string, over: Partial<ProposalRow> = {}): ProposalRow {
  return proposal(id, { kind: 'publish.batch', payload: PUBLISH_PAYLOAD, payloadHash: canonicalHash(PUBLISH_PAYLOAD), ...over });
}

test('a member who is not the super admin cannot release: NT-PRM-001, and THE EXECUTOR NEVER RUNS', async () => {
  // A PRACTICE_ADMIN who is not the owner — the widest role short of the firm's
  // super admin, so this is the narrowing D44 asks for, not a role typo.
  const { service, executed, audits, map } = harness([publishProposal('prop_p')], undefined, {
    role: 'PRACTICE_ADMIN',
    isOwner: false,
  });
  const review = await service.review(CTX, 'prop_p', 'k1');
  expect(await code(service.approve(CTX, 'prop_p', { renderedSummaryHash: review.renderedSummaryHash }, 'k2'))).toBe('NT-PRM-001');

  // No effect at all: the executor was never entered, no audit row was written,
  // and the proposal is NOT consumed — the super admin can still approve it.
  expect(executed).toEqual([]);
  expect(audits).toEqual([]);
  const row = map.get('prop_p');
  expect(row?.state).toBe('REVIEWED');
  expect(row?.executedAt).toBeNull();
  expect(row?.approvedByUserId).toBeNull();
});

test('the same refusal for chase.send — the other irreversible outward act', async () => {
  const chasePayload = { messages: [{ recipientE164: '+447700900001', body: 'Please send the receipt', transactionIds: ['t1'] }] };
  const { service, executed } = harness(
    [proposal('prop_c', { kind: 'chase.send', payload: chasePayload, payloadHash: canonicalHash(chasePayload) })],
    undefined,
    { role: 'PRACTICE_STANDARD', isOwner: false },
  );
  const review = await service.review(CTX, 'prop_c', 'k1');
  expect(await code(service.approve(CTX, 'prop_c', { renderedSummaryHash: review.renderedSummaryHash }, 'k2'))).toBe('NT-PRM-001');
  expect(executed).toEqual([]);
});

test('the super admin releases: same proposal, same review, executes and audits', async () => {
  const { service, executed, audits } = harness([publishProposal('prop_p')]);
  const review = await service.review(CTX, 'prop_p', 'k1');
  const approved = await service.approve(CTX, 'prop_p', { renderedSummaryHash: review.renderedSummaryHash }, 'k2');
  expect(approved.state).toBe('EXECUTED');
  expect(executed).toEqual(['publish.batch']);
  expect(audits).toHaveLength(1);
});

test('authority is decided BEFORE every other gate — a refused releaser learns nothing about the proposal', async () => {
  // Unreviewed, expired and hash-mismatched all answer NT-PRM-001 rather than
  // NT-PRP-002 / -003 / -004: those are answers to a question this caller was
  // not allowed to ask, and the approve endpoint must not become an oracle.
  const { service, executed } = harness(
    [publishProposal('prop_new'), publishProposal('prop_old', { expiresAt: new Date(Date.now() - 1000) })],
    undefined,
    null,
  );
  expect(await code(service.approve(CTX, 'prop_new', { renderedSummaryHash: 'f'.repeat(64) }, 'k1'))).toBe('NT-PRM-001');
  expect(await code(service.approve(CTX, 'prop_old', { renderedSummaryHash: 'f'.repeat(64) }, 'k2'))).toBe('NT-PRM-001');
  expect(executed).toEqual([]);
});

test('a proposal the caller cannot SEE is still 404, never 403 — visibility is not authority', async () => {
  // RLS returns nothing for an invisible row, so the lookup fails before the
  // gate is reached and the answer never confirms the proposal exists.
  const { service } = harness([], undefined, null);
  expect(await code(service.approve(CTX, 'prop_invisible', { renderedSummaryHash: 'f'.repeat(64) }, 'k'))).toBe('NT-VAL-001');
});

test('composing and editing is ungated, and costs no membership read at all', async () => {
  const { service, executed, membershipQueries } = harness([proposal('prop_a')], undefined, null);
  const review = await service.review(CTX, 'prop_a', 'k1');
  const approved = await service.approve(CTX, 'prop_a', { renderedSummaryHash: review.renderedSummaryHash }, 'k2');
  expect(approved.state).toBe('EXECUTED');
  expect(executed).toEqual(['document.archive']);
  // D44's first half: every member composes and edits. The gate is lazy, so the
  // ordinary path pays nothing for it.
  expect(membershipQueries).toEqual([]);
});

test('a release gate refusal rolls back cleanly: the super admin can approve the very same proposal afterwards', async () => {
  const { service, executed } = harness([publishProposal('prop_p')], undefined, { role: 'PRACTICE_STANDARD', isOwner: false });
  const review = await service.review(CTX, 'prop_p', 'k1');
  expect(await code(service.approve(CTX, 'prop_p', { renderedSummaryHash: review.renderedSummaryHash }, 'k2'))).toBe('NT-PRM-001');

  // Same fake, same rows — now with the owner acting.
  const owner = harness([publishProposal('prop_p')]);
  const ownerReview = await owner.service.review(CTX, 'prop_p', 'k3');
  await owner.service.approve(CTX, 'prop_p', { renderedSummaryHash: ownerReview.renderedSummaryHash }, 'k4');
  expect(owner.executed).toEqual(['publish.batch']);
  expect(executed).toEqual([]);
});

test('the replay fingerprint is scoped to the actor — another person cannot replay a key past the gate', async () => {
  const { service, executed } = harness([publishProposal('prop_p')]);
  const review = await service.review(CTX, 'prop_p', 'k1');
  await service.approve(CTX, 'prop_p', { renderedSummaryHash: review.renderedSummaryHash }, 'shared-key');
  expect(executed).toEqual(['publish.batch']);

  // The SAME key and the SAME body, a different person: NT-IDM-001, not the
  // stored response. The idempotency store runs before RLS and before the gate,
  // so without the actor in the fingerprint this replays somebody else's answer.
  const other = ScopeContextSchema.parse({ actorId: 'usr_2', practiceId: 'prac_1' });
  expect(await code(service.approve(other, 'prop_p', { renderedSummaryHash: review.renderedSummaryHash }, 'shared-key'))).toBe('NT-IDM-001');
  // The original caller still replays their own.
  const replay = await service.approve(CTX, 'prop_p', { renderedSummaryHash: review.renderedSummaryHash }, 'shared-key');
  expect(replay.state).toBe('EXECUTED');
  expect(executed).toEqual(['publish.batch']);
});

// ---- cancel -----------------------------------------------------------------

test('cancel is refused on an executed proposal, idempotent on a cancelled one, and records the reason', async () => {
  const { service } = harness([proposal('prop_a'), proposal('prop_done', { executedAt: new Date(), state: 'EXECUTED' })]);
  const cancelled = await service.cancel(CTX, 'prop_a', { reason: 'changed my mind' }, 'k1');
  expect(cancelled.state).toBe('CANCELLED');
  expect(cancelled.outcome).toMatchObject({ cancelled: true, reason: 'changed my mind' });
  const again = await service.cancel(CTX, 'prop_a', { reason: 'changed my mind' }, 'k2');
  expect(again.state).toBe('CANCELLED');
  expect(await code(service.cancel(CTX, 'prop_done', {}, 'k3'))).toBe('NT-PRP-005');
});

// ---- list (METH S12, issue #140) ---------------------------------------------

test('list returns the contract envelope, newest first, asking for limit + 1', async () => {
  const { service, listCalls } = harness([proposal('prop_a')]);
  const page = await service.list(CTX, { limit: 2 } as never);

  expect(page.data).toHaveLength(1);
  expect(page.pageInfo).toEqual({ hasMore: false, nextCursor: null });
  const [call] = listCalls;
  expect(call?.take).toBe(3); // the probe row, not a second COUNT
  expect(call?.orderBy).toEqual([{ createdAt: 'desc' }, { id: 'desc' }]);
});

test('list filters are ANDed in; a businessId is a filter, not a second tenancy guard', async () => {
  const { service, listCalls } = harness();
  await service.list(CTX, {
    limit: 50,
    businessId: 'biz_9',
    state: ['CREATED', 'REVIEWED'],
    kind: ['chase.send'],
  } as never);
  expect(listCalls[0]?.where).toEqual({
    businessId: 'biz_9',
    state: { in: ['CREATED', 'REVIEWED'] },
    kind: { in: ['chase.send'] },
  });
});

test('list with no filter sends an empty where — RLS is the only tenancy mechanism, and no state is excluded', async () => {
  const { service, listCalls } = harness();
  await service.list(CTX, { limit: 50 } as never);
  expect(listCalls[0]?.where).toEqual({});
});

test('list projects onto the contract shape and never renders — reading the queue is not reviewing', async () => {
  const { service } = harness([proposal('prop_a')]);
  const page = await service.list(CTX, { limit: 50 } as never);
  const [row] = page.data;
  expect(row?.id).toBe('prop_a');
  expect(row?.state).toBe('CREATED');
  expect(row?.createdAt).toBe('2026-08-18T09:00:00.000Z');
  expect(row?.reviewedAt).toBeNull(); // untouched — only POST .../review writes it
  expect(row?.renderedSummaryHash).toBeNull();
});
