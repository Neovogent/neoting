import { expect, test } from 'vitest';

import { computeChaseSendPayload } from './compose-chase-send.js';
import { ProposalExecutionRefused } from './proposal-executor.js';
import type { ScopedClient } from '../../../common/db/scoped-db.js';
import type { ChaseSendPayload } from '@neoting/contracts/model';

/**
 * The compose seam's chaseability guard (5 Sep 2026).
 *
 * The caller's transaction list is a courtesy, never the decision — the web
 * sends only `isUnexplained` lines, but "the server decides, not this screen".
 * Until this guard the seam composed a chase over ANY reachable line: a
 * CONFIRMED one (its receipt is on file), a SUGGESTED one (already in front of
 * a human) or a suppressed one (a settlement credit, a bank charge — no
 * paperwork exists to ask for). Found live: a chase composer offering a
 * matched-and-published £994 line and 631 settlement credits, pre-ticked.
 */

interface TxnRow {
  id: string;
  businessId: string;
  amountPence: number;
  bookedAt: Date;
  descriptionRaw: string;
  merchantName: string | null;
  matchState: string;
  chaseSuppressed: boolean;
}

const txn = (id: string, over: Partial<TxnRow> = {}): TxnRow => ({
  id,
  businessId: 'biz_1',
  amountPence: -12_500,
  bookedAt: new Date('2026-08-09T00:00:00.000Z'),
  descriptionRaw: 'CURRYS 1234',
  merchantName: 'Currys',
  matchState: 'UNMATCHED',
  chaseSuppressed: false,
  ...over,
});

function fakeDb(txns: TxnRow[]): ScopedClient {
  return {
    bankTransaction: {
      findMany: async ({ where }: { where: { id: { in: string[] } } }) =>
        where.id.in.map((id) => txns.find((t) => t.id === id)).filter((t): t is TxnRow => t !== undefined),
    },
    business: {
      findUnique: async () => ({ name: 'American Burger Ltd' }),
    },
    contact: {
      findFirst: async () => ({ id: 'contact_1', email: 'owner@example.test', mobileE164: '+447700900001' }),
    },
  } as unknown as ScopedClient;
}

const CONFIG = { portalLinkSecret: 'test-secret-test-secret-test-secret!', appOrigin: 'https://app.test' };

const payloadFor = (ids: string[]): ChaseSendPayload =>
  ({ messages: [{ body: 'discarded', transactionIds: ids }] }) as ChaseSendPayload;

test('an UNMATCHED, unsuppressed line composes', async () => {
  const db = fakeDb([txn('txn_1')]);
  const out = await computeChaseSendPayload(db, payloadFor(['txn_1']), CONFIG);
  expect(out.messages[0]?.body).toContain('Currys');
});

test('accountantMessage replaces the middle sentence; the engine keeps greeting + signed link (item 31)', async () => {
  const db = fakeDb([txn('txn_1')]);
  const payload = {
    messages: [
      {
        body: 'discarded',
        transactionIds: ['txn_1'],
        accountantMessage: '  Could you send the August receipts over?  ',
      },
    ],
  } as ChaseSendPayload;
  const out = await computeChaseSendPayload(db, payload, CONFIG);
  const message = out.messages[0];
  expect(message?.body).toMatch(
    /^American Burger Ltd Accounts: Could you send the August receipts over\? Upload securely: https:\/\/app\.test\/p\//,
  );
  // Stored trimmed, so the payload, the review note and the sent bytes agree.
  expect(message?.accountantMessage).toBe('Could you send the August receipts over?');
  // The engine's own composition is fully displaced — no template sentence.
  expect(message?.body).not.toContain("we're missing");
});

test('a whitespace-only accountantMessage is "not edited" — the template stands', async () => {
  const db = fakeDb([txn('txn_1')]);
  const payload = {
    messages: [{ body: 'discarded', transactionIds: ['txn_1'], accountantMessage: '   ' }],
  } as ChaseSendPayload;
  const out = await computeChaseSendPayload(db, payload, CONFIG);
  expect(out.messages[0]?.body).toContain("we're missing");
  expect(out.messages[0]?.accountantMessage).toBeNull();
});

test('a composed body over the contract cap refuses at CREATE, naming the fix', async () => {
  const db = fakeDb([txn('txn_1')]);
  const payload = {
    messages: [{ body: 'discarded', transactionIds: ['txn_1'], accountantMessage: 'x'.repeat(240) }],
  } as ChaseSendPayload;
  // 240 chars of wording + greeting + a ~180-char signed link exceeds 500 —
  // the refusal must land here, not days later as NT-PRP-006 at review.
  await expect(
    computeChaseSendPayload(db, payload, { ...CONFIG, appOrigin: `https://${'a'.repeat(120)}.test` }),
  ).rejects.toThrow(/too long/);
});

test.each([
  ['a CONFIRMED line — its receipt is on file', { matchState: 'CONFIRMED' }],
  ['a SUGGESTED line — already in front of a human', { matchState: 'SUGGESTED' }],
  ['a suppressed line — no paperwork exists to ask for', { chaseSuppressed: true }],
])('refuses %s', async (_name, over) => {
  const db = fakeDb([txn('txn_1'), txn('txn_2', over as Partial<TxnRow>)]);
  await expect(computeChaseSendPayload(db, payloadFor(['txn_1', 'txn_2']), CONFIG)).rejects.toThrow(
    ProposalExecutionRefused,
  );
  // The whole message refuses — the reviewer must never read a body quietly
  // missing lines the caller named.
  await expect(computeChaseSendPayload(db, payloadFor(['txn_1', 'txn_2']), CONFIG)).rejects.toThrow(
    /cannot be chased/,
  );
});
