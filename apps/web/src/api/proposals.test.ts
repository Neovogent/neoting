import { afterEach, expect, test, vi } from 'vitest';

import { ProposalKind } from '@neoting/contracts/model';
import { approveReviewed, cancelPending, createProposal, KIND_LABEL, openReview } from './proposals';

/**
 * The proposal-queue boundary (METH Stage 12), recorder-fetch style like the
 * portal's: offline by construction, and the assertions are on what this
 * module SENT — the echoed hash above all — and on the fail-closed parse of
 * the one response a human signs against.
 */

interface Recorded {
  url: string;
  init: RequestInit;
}

function stubFetch(replies: { body: unknown; status?: number }[]): Recorded[] {
  const calls: Recorded[] = [];
  let index = 0;
  vi.stubGlobal('fetch', (url: string | URL, init: RequestInit = {}) => {
    calls.push({ url: String(url), init });
    const reply = replies[index++] ?? { body: {} };
    return Promise.resolve(
      new Response(JSON.stringify(reply.body), {
        status: reply.status ?? 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
  });
  return calls;
}

afterEach(() => vi.unstubAllGlobals());

const header = (init: RequestInit, name: string): string | null => new Headers(init.headers).get(name);

const HASH = 'a'.repeat(64);

/** A contract-valid proposal body — the generated schemas are `.strict()`. */
const PROPOSAL = {
  id: 'prop_1',
  businessId: 'biz_burger',
  kind: 'chase.send',
  state: 'CREATED',
  payload: { messages: [] },
  payloadHash: HASH,
  renderedSummaryHash: null,
  createdByUserId: 'usr_1',
  createdByModel: null,
  createdAt: '2026-08-19T09:00:00.000Z',
  reviewedAt: null,
  approvedByUserId: null,
  approvedAt: null,
  executedAt: null,
  expiresAt: '2026-08-20T09:00:00.000Z',
  policyProposalId: null,
  outcome: null,
  traceId: null,
};

const REVIEW = {
  proposal: { ...PROPOSAL, state: 'REVIEWED', renderedSummaryHash: HASH, reviewedAt: '2026-08-19T09:05:00.000Z' },
  renderedSummary: {
    title: 'Send 1 chase SMS message',
    sections: [
      {
        heading: 'Message 1 — to +447700900001',
        entries: [{ label: 'SMS, exactly as it will send', value: 'American Burger Accounts: …' }],
      },
    ],
    warnings: [],
  },
  renderedSummaryHash: HASH,
  reviewedAt: '2026-08-19T09:05:00.000Z',
};

/* ── the kind labels ──────────────────────────────────────────────────────── */

test('every contract kind has a label, and no label names a kind the contract lost', () => {
  const kinds = Object.values(ProposalKind).sort();
  expect(Object.keys(KIND_LABEL).sort()).toEqual(kinds);
});

/* ── [Read review] ────────────────────────────────────────────────────────── */

test('opening the review POSTs the recorded write and returns the sections and the hash to echo', async () => {
  const calls = stubFetch([{ body: REVIEW }]);

  const card = await openReview('prop_1');

  expect(calls[0]!.url).toMatch(/\/v1\/action-proposals\/prop_1\/review$/);
  expect(calls[0]!.init.method).toBe('POST');
  // Review WRITES reviewedAt, so it carries the mutation header like any write.
  expect(header(calls[0]!.init, 'Idempotency-Key')).toBeTruthy();
  expect(card.title).toBe('Send 1 chase SMS message');
  expect(card.sections[0]!.entries[0]!.value).toBe('American Burger Accounts: …');
  expect(card.renderedSummaryHash).toBe(HASH);
});

test('a section this screen cannot render fails the WHOLE review — no Approve out of a half-read card', async () => {
  stubFetch([
    {
      body: {
        ...REVIEW,
        renderedSummary: { ...REVIEW.renderedSummary, sections: [{ heading: 'x', entries: [{ label: 'y' }] }] },
      },
    },
  ]);
  await expect(openReview('prop_1')).rejects.toThrow(/cannot render/);
});

/* ── [Approve] / [Cancel] ─────────────────────────────────────────────────── */

test('approve echoes the hash the review returned, verbatim, to the approval door', async () => {
  const calls = stubFetch([{ body: { ...PROPOSAL, state: 'EXECUTED' } }]);

  await approveReviewed('prop_1', HASH);

  expect(calls[0]!.url).toMatch(/\/v1\/action-proposals\/prop_1\/approval$/);
  expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ renderedSummaryHash: HASH });
});

test('cancel posts the cancellation with the reason when one was given, an empty body when not', async () => {
  const calls = stubFetch([{ body: { ...PROPOSAL, state: 'CANCELLED' } }, { body: { ...PROPOSAL, state: 'CANCELLED' } }]);

  await cancelPending('prop_1', 'changed my mind');
  await cancelPending('prop_1');

  expect(calls[0]!.url).toMatch(/\/v1\/action-proposals\/prop_1\/cancellation$/);
  expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ reason: 'changed my mind' });
  expect(JSON.parse(String(calls[1]!.init.body))).toEqual({});
});

/* ── create ───────────────────────────────────────────────────────────────── */

test('create returns the proposal the server minted, parsed by the contract schema', async () => {
  const calls = stubFetch([{ body: PROPOSAL, status: 201 }]);

  const created = await createProposal({
    kind: 'publish.batch',
    businessId: 'biz_burger',
    payload: { documentIds: ['doc_7'], integrationId: null, preview: { itemCount: 1, grossPence: 0, vatPence: 0 } },
  });

  expect(calls[0]!.url).toMatch(/\/v1\/action-proposals$/);
  expect(created.id).toBe('prop_1');
  expect(created.state).toBe('CREATED');
});

test('a create response that drifts from the contract is refused with the field named', async () => {
  stubFetch([{ body: { ...PROPOSAL, payloadHash: 'sha256:not-hex' }, status: 201 }]);
  await expect(
    createProposal({ kind: 'document.route', businessId: null, payload: { documentId: 'doc_1', inbox: 'COSTS' } }),
  ).rejects.toThrow(/payloadHash/);
});
