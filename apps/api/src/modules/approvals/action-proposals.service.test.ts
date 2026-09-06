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
const PUBLISH_PAYLOAD = { documentIds: ['doc_1'], preview: { itemCount: 1, grossPence: 12_000, vatPence: 2_000, currency: null } };

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
  /**
   * The denial notice (item 27). Absent means the engine was built without a
   * mailer — the ordinary test shape, and the same "absence is silence" rule
   * every other optional seam here follows.
   */
  denialNotice?: (input: unknown) => Promise<unknown>,
) {
  const map = new Map(rows.map((r) => [r.id, r]));
  const audits: Record<string, unknown>[] = [];
  const executed: string[] = [];
  /** Every `document.updateMany` the deny path drove — the send-back's record. */
  const documentUpdates: { where?: unknown; data?: unknown }[] = [];
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
    // The correction-integrity gate and advisory read the document and its
    // accepted extraction (validate-update-coding.ts). One fixture document,
    // shaped as the item-22 invoice: £994.00 gross, zero-rated, INVOICE.
    document: {
      findUnique: async ({ where }: { where: { id: string } }) =>
        where.id === 'doc_1'
          ? {
              id: 'doc_1',
              businessId: 'biz_1',
              docType: 'INVOICE',
              totalPence: 99_400,
              taxPence: 0,
              documentDate: new Date('2025-07-30T00:00:00.000Z'),
              currency: 'GBP',
            }
          : null,
    },
    extraction: {
      findFirst: async () => ({ fields: { supplierName: { value: 'Aldgate Meats Ltd', provenance: 'AI_SUGGESTED' } } }),
    },
    // The deny path's reads and writes (item 27). `documents.findMany` answers
    // the batch's rows still in READY; `updateMany` is `transitionDocument`'s
    // compare-and-swap, recorded rather than applied.
    documentEvent: { create: async ({ data }: { data: unknown }) => data },
    user: {
      findUnique: async ({ where }: { where: { id: string } }) =>
        where.id === 'usr_1'
          ? { id: 'usr_1', firstName: 'Priya', lastName: 'Shah', email: 'priya@practice.example', kind: 'HUMAN' }
          : null,
    },
  };
  (tx.document as Record<string, unknown>)['findMany'] = async () => [{ id: 'doc_1', state: 'READY' }];
  (tx.document as Record<string, unknown>)['updateMany'] = async (args: { where?: unknown; data?: unknown }) => {
    documentUpdates.push(args);
    return { count: 1 };
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

// chase.send composition config for tests — a real secret so signed links verify.
const TEST_CHASE_COMPOSE = { portalLinkSecret: 'test-portal-link-secret', appOrigin: 'https://app.test' };

  const service = new ActionProposalsService(
    prisma,
    registry,
    { detect: async () => ({ findings: [], candidatesTruncated: false }) },
    // No publish proposals here, so the ledger is never reached; a stub keeps
    // the gate-ladder assertions independent of METH S10's wiring.
    {
      ledger: { publishBill: async () => ({ ok: true, externalRef: 'STUB', attachmentSent: false }) },
      previewPublishBatch: () => ({ ok: true, preview: { itemCount: 0, grossPence: 0, vatPence: 0, currency: null } }),
    },
    new InMemoryIdempotencyStore(),
    TEST_CHASE_COMPOSE,
    // No entry previewer in this harness (the publish stub above covers it).
    undefined,
    // The chart reader the correction-integrity gate validates against.
    async () => [{ code: 'COS_FOOD' }, { code: 'SOFTWARE_AND_SUBSCRIPTIONS' }],
    // No model second opinion — absence is silence (item 22's rule).
    undefined,
    // The denial notice (item 27), when the case under test supplies one.
    denialNotice,
  );
  return { service, map, audits, executed, listCalls, membershipQueries, documentUpdates };
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

test('staging the same act twice is NT-PRP-007 — the reported eight-cards bug (item 26)', async () => {
  // ⚠ Note the Idempotency-Key DIFFERS on the second call. That is the point:
  // each of Mubashir's eight clicks carried a fresh key and was, honestly, a
  // separate REQUEST. What they were not was a separate ACT, and only this
  // check can see that.
  const { service, map } = harness();
  await service.create(CTX, { kind: 'document.archive', businessId: 'biz_1', payload: ARCHIVE_PAYLOAD }, 'key-1');
  expect(await code(service.create(CTX, { kind: 'document.archive', businessId: 'biz_1', payload: ARCHIVE_PAYLOAD }, 'key-2'))).toBe(
    'NT-PRP-007',
  );
  expect(map.size).toBe(1); // nothing was minted
});

test('a DIFFERENT act still stages while one is pending', async () => {
  const { service, map } = harness();
  await service.create(CTX, { kind: 'document.archive', businessId: 'biz_1', payload: ARCHIVE_PAYLOAD }, 'key-1');
  // Other documents — a different batch, and it must not be refused.
  await service.create(
    CTX,
    { kind: 'document.archive', businessId: 'biz_1', payload: { documentIds: ['doc_2'], archived: true } },
    'key-2',
  );
  // The OPPOSITE act on the same documents — unarchive. A documents-only key
  // would have refused this one, telling the caller their unarchive was
  // "already awaiting review" when what is pending is the archive.
  await service.create(
    CTX,
    { kind: 'document.archive', businessId: 'biz_1', payload: { documentIds: ['doc_1'], archived: false } },
    'key-3',
  );
  expect(map.size).toBe(3);
});

test('the duplicate scan is narrowed to pending, unexpired rows of the same kind and business', async () => {
  // The fake `findMany` ignores `where`, so the narrowing itself is asserted on
  // the query — which is also the half that matters: an EXPIRED pending row
  // must not block, because nobody can approve it (NT-PRP-003) and pointing a
  // caller at it would be a deadlock wearing a helpful sentence.
  const { service, listCalls } = harness();
  await service.create(CTX, { kind: 'document.archive', businessId: 'biz_1', payload: ARCHIVE_PAYLOAD }, 'key-1');
  const scan = listCalls.at(-1)?.where as Record<string, unknown> | undefined;
  expect(scan).toMatchObject({ kind: 'document.archive', businessId: 'biz_1', state: { in: ['CREATED', 'REVIEWED'] } });
  expect(scan?.['expiresAt']).toHaveProperty('gt');
});

test('a kind with no identity is never deduped — rule.create stages twice', async () => {
  // Two rules over one client are two rules. `proposal-identity.ts` returns
  // null for this kind deliberately, and the service must treat that as "no
  // duplicate" rather than as "no key, so refuse".
  const { service, map } = harness();
  const rule = { name: 'Google Ads → Advertising', scope: { businessId: 'biz_1' }, conditions: [], sets: {} };
  await service.create(CTX, { kind: 'rule.create', businessId: 'biz_1', payload: rule }, 'key-1');
  await service.create(CTX, { kind: 'rule.create', businessId: 'biz_1', payload: rule }, 'key-2');
  expect(map.size).toBe(2);
});

// ---- deny (review item 27) --------------------------------------------------

test('deny records DENIED with the reason and the decider, and executes nothing', async () => {
  const { service, map, executed } = harness([proposal('prop_d1', { state: 'REVIEWED', reviewedAt: new Date() })]);
  const denied = await service.deny(CTX, 'prop_d1', { reason: 'The VAT is wrong — it is zero-rated.' }, 'k');

  expect(denied.state).toBe('DENIED');
  expect(map.get('prop_d1')?.outcome).toMatchObject({
    denied: true,
    reason: 'The VAT is wrong — it is zero-rated.',
    deniedByUserId: 'usr_1',
  });
  // ⚠ The whole point: a refusal runs nothing.
  expect(executed).toEqual([]);
  expect(map.get('prop_d1')?.executedAt).toBeNull();
});

test('deny is NOT cancel — a cancelled proposal cannot be denied and vice versa', async () => {
  // The two are different decisions by different people and the states have to
  // stay apart, or History cannot tell "the proposer withdrew it" from "the
  // principal refused it" — which is the entire product of this feature.
  const { service } = harness([proposal('prop_c', { state: 'CANCELLED' })]);
  expect(await code(service.deny(CTX, 'prop_c', { reason: 'too late' }, 'k'))).toBe('NT-PRP-006');

  const { service: s2, map } = harness([proposal('prop_d2', { state: 'REVIEWED', reviewedAt: new Date() })]);
  await s2.deny(CTX, 'prop_d2', { reason: 'no' }, 'k2');
  expect(map.get('prop_d2')?.state).toBe('DENIED');
  expect(map.get('prop_d2')?.state).not.toBe('CANCELLED');
});

test('an executed proposal cannot be denied — it is undone by a new proposal', async () => {
  const { service } = harness([proposal('prop_x', { state: 'EXECUTED', executedAt: new Date() })]);
  expect(await code(service.deny(CTX, 'prop_x', { reason: 'changed my mind' }, 'k'))).toBe('NT-PRP-005');
});

test('denying a denied proposal is idempotent — the first reviewer’s reason is not overwritten', async () => {
  const { service, map } = harness([proposal('prop_d3', { state: 'REVIEWED', reviewedAt: new Date() })]);
  await service.deny(CTX, 'prop_d3', { reason: 'first reason' }, 'k1');
  await service.deny(CTX, 'prop_d3', { reason: 'second reason' }, 'k2');
  expect(map.get('prop_d3')?.outcome).toMatchObject({ reason: 'first reason' });
});

test('an EXPIRED proposal is still deniable — refusing to let somebody say no is not a rule', async () => {
  // Review and approve refuse an expired row because approving it would execute
  // against facts that have moved. Denying executes nothing, and a queue full of
  // expired proposals nobody may close is a queue nobody reads.
  const { service, map } = harness([
    proposal('prop_old', { state: 'REVIEWED', reviewedAt: new Date(), expiresAt: new Date(Date.now() - 1_000) }),
  ]);
  await service.deny(CTX, 'prop_old', { reason: 'stale' }, 'k');
  expect(map.get('prop_old')?.state).toBe('DENIED');
});

test('deny authority IS approve authority — a non-owner is refused a tier-1 kind and nothing changes', async () => {
  const { service, map } = harness(
    [proposal('prop_rel', { kind: 'publish.batch', payload: PUBLISH_PAYLOAD, state: 'REVIEWED', reviewedAt: new Date() })],
    undefined,
    { role: 'PRACTICE_ADMIN', isOwner: false },
  );
  expect(await code(service.deny(CTX, 'prop_rel', { reason: 'no' }, 'k'))).toBe('NT-PRM-001');
  // A refusal is a decision of the same weight as an approval, so it leaves the
  // proposal exactly where it was.
  expect(map.get('prop_rel')?.state).toBe('REVIEWED');
});

test('a denied publish.batch sends its READY documents back to TO_REVIEW wearing the reason', async () => {
  const { service, documentUpdates } = harness([
    proposal('prop_pub', { kind: 'publish.batch', payload: PUBLISH_PAYLOAD, state: 'REVIEWED', reviewedAt: new Date() }),
  ]);
  await service.deny(CTX, 'prop_pub', { reason: 'The tax figure is wrong.' }, 'k');

  const sentBack = documentUpdates.at(-1);
  expect(sentBack?.data).toMatchObject({ state: 'TO_REVIEW' });
  // The reviewer's words, verbatim, on the column the client tables already
  // render as the amber pill — zero web bytes for the tag item 27 asked for.
  expect(String((sentBack?.data as Record<string, unknown>)['failureMessage'])).toContain('The tax figure is wrong.');
  // ⚠ NOT an NT-PUB code: `api/documents.ts` reads that prefix as "a failed
  // publish worth retrying", and a denial is the opposite.
  expect(String((sentBack?.data as Record<string, unknown>)['failureCode'])).not.toContain('NT-PUB');
  // Guarded on the expected `from` state — a document that moved is skipped,
  // never forced.
  expect(sentBack?.where).toMatchObject({ state: 'READY' });
});

test('denying a NON-publish kind touches no document', async () => {
  // A denied coding correction simply means the correction was never applied.
  const { service, documentUpdates } = harness([proposal('prop_arc', { state: 'REVIEWED', reviewedAt: new Date() })]);
  await service.deny(CTX, 'prop_arc', { reason: 'not now' }, 'k');
  expect(documentUpdates).toEqual([]);
});

test('the proposer is emailed the reason AFTER the commit, and a send failure never un-denies it', async () => {
  const notices: unknown[] = [];
  const { service, map } = harness(
    [proposal('prop_mail', { state: 'REVIEWED', reviewedAt: new Date() })],
    undefined,
    OWNER_MEMBERSHIP,
    () => {
      notices.push('called');
      throw new Error('SES is down');
    },
  );
  const denied = await service.deny(CTX, 'prop_mail', { reason: 'wrong client' }, 'k');

  expect(notices).toHaveLength(1);
  // ⚠ The throw is swallowed: the denial is committed, and a lost email is not
  // a lost decision. Same rule as the post-commit follow-ups.
  expect(denied.state).toBe('DENIED');
  expect(map.get('prop_mail')?.state).toBe('DENIED');
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

// ---- the correction-integrity gate + advisory (items 22/46/47) ---------------

test('create refuses an update-coding whose category is not a code on the chart, naming the string', async () => {
  const { service, map, executed } = harness();
  const refused = service.create(
    CTX,
    { kind: 'document.update-coding', businessId: 'biz_1', payload: { documentId: 'doc_1', fields: { categoryCode: 'jhngbhf' } } },
    'k-junk',
  );
  await expect(refused).rejects.toMatchObject({ code: 'NT-PRP-006' });
  await refused.catch((e: unknown) => {
    expect(e).toBeInstanceOf(AppException);
    expect((e as AppException).message).toContain('Proposal is not executable');
  });
  expect(map.size).toBe(0); // nothing was stored
  expect(executed).toEqual([]);
});

test('create accepts an update-coding naming an exact chart code, and one that touches no category', async () => {
  const { service } = harness();
  const coded = await service.create(
    CTX,
    { kind: 'document.update-coding', businessId: 'biz_1', payload: { documentId: 'doc_1', fields: { categoryCode: 'COS_FOOD' } } },
    'k-good',
  );
  expect(coded.state).toBe('CREATED');
  const uncoded = await service.create(
    CTX,
    { kind: 'document.update-coding', businessId: 'biz_1', payload: { documentId: 'doc_1', fields: { supplierName: 'Aldgate Meats Ltd' } } },
    'k-name',
  );
  expect(uncoded.state).toBe('CREATED');
});

test('review freezes the correction advisory into the stored render — the £9,000-tax shape (item 22)', async () => {
  const { service } = harness([
    proposal('prop_tax', {
      kind: 'document.update-coding',
      payload: { documentId: 'doc_1', fields: { taxPence: 900_000 } },
    }),
  ]);
  const review = await service.review(CTX, 'prop_tax', 'k-rev');
  const sections = (review.renderedSummary as unknown as { sections: { heading: string; entries: { label: string; value: string }[] }[] }).sections;
  const checks = sections.find((section) => section.heading === '⚠ Checks — read before you approve');
  expect(checks).toBeDefined();
  expect(checks?.entries[0]?.label).toBe('Tax exceeds the total');
  expect(checks?.entries[0]?.value).toContain('£9000.00');
  expect(checks?.entries[0]?.value).toContain('£994.00');
  // Idempotent review returns the SAME frozen render — the advisory is part of
  // what the approve hash covers.
  const second = await service.review(CTX, 'prop_tax', 'k-rev-2');
  expect(second.renderedSummaryHash).toBe(review.renderedSummaryHash);
});

test('a clean correction reviews with NO checks section', async () => {
  const { service } = harness([
    proposal('prop_clean', {
      kind: 'document.update-coding',
      payload: { documentId: 'doc_1', fields: { supplierName: 'Aldgate Meats Ltd' } },
    }),
  ]);
  const review = await service.review(CTX, 'prop_clean', 'k-rev-3');
  const sections = (review.renderedSummary as unknown as { sections: { heading: string }[] }).sections;
  expect(sections.some((section) => section.heading.startsWith('⚠ Checks'))).toBe(false);
});
