import { expect, test } from 'vitest';

import { getPortalContextResponse } from '@neoting/contracts/zod';

import type { PrismaClient } from '../../common/db/prisma.js';
import type { AppException } from '../../common/problem/problem.js';
import { PortalContextService } from './portal-context.service.js';
import type { PortalSessionFacts } from './portal-session-context.js';

const NOW = 1_755_500_000_000;
const EXPIRES = new Date(NOW + 60 * 60 * 1000);

interface TxnRow {
  readonly id: string;
  readonly businessId: string;
  readonly bookedAt: Date;
  readonly amountPence: number;
  readonly descriptionRaw: string;
  readonly merchantName: string | null;
  readonly matchState: string;
}

interface ChaseRowFixture {
  readonly practiceId: string;
  readonly businessId: string;
  readonly itemRefs: unknown;
  readonly transactionId: string | null;
  readonly state: string;
}

interface Fixture {
  readonly chases: Readonly<Record<string, ChaseRowFixture>>;
  readonly businesses: Readonly<Record<string, { practiceId: string; name: string; subscriptionStatus?: string | null }>>;
  readonly transactions: readonly TxnRow[];
  /** Documents this business has sent — only their count and newest date matter. */
  readonly documents?: readonly { businessId: string; createdAt: Date }[];
}

interface Recorded {
  chaseWhere: unknown;
  txnWhere: unknown;
  businessWhere: unknown;
}

/**
 * A Prisma stand-in that SIMULATES practice scoping — `scopedDb` writes
 * `app.practice_id` as the second bound value of its `set_config` statement and
 * every read here honours it, so a chase, business or transaction belonging to
 * another practice is invisible exactly as `chases_tenant` /
 * `businesses_tenant` / `bank_transactions_tenant` make it. A stub that always
 * answered would prove nothing about the one thing this service must get right.
 */
function fakePrisma(fixture: Fixture, recorded: Recorded): PrismaClient {
  let practiceInScope: string | null = null;

  const tx = {
    $executeRaw: async (_strings: TemplateStringsArray, ...values: unknown[]): Promise<number> => {
      practiceInScope = values[1] === '' ? null : String(values[1]);
      return 0;
    },
    chase: {
      findMany: async ({ where }: { where: { businessId: string; state: { in: string[] } } }) =>
        Object.values(fixture.chases)
          .filter(
            (c) =>
              c.businessId === where.businessId &&
              where.state.in.includes(c.state) &&
              c.practiceId === practiceInScope,
          )
          .map((c) => ({ itemRefs: c.itemRefs, transactionId: c.transactionId })),
      findUnique: async ({ where }: { where: { id: string } }) => {
        recorded.chaseWhere = where;
        const chase = fixture.chases[where.id];
        if (chase === undefined || chase.practiceId !== practiceInScope) return null;
        return { businessId: chase.businessId, itemRefs: chase.itemRefs, state: chase.state, transactionId: chase.transactionId };
      },
    },
    business: {
      findUnique: async ({ where }: { where: { id: string } }) => {
        recorded.businessWhere = where;
        const business = fixture.businesses[where.id];
        if (business === undefined || business.practiceId !== practiceInScope) return null;
        return { name: business.name, subscriptionStatus: business.subscriptionStatus ?? null };
      },
    },
    document: {
      count: async ({ where }: { where: { businessId: string } }) =>
        (fixture.documents ?? []).filter((d) => d.businessId === where.businessId).length,
      findFirst: async ({ where }: { where: { businessId: string } }) => {
        const rows = (fixture.documents ?? [])
          .filter((d) => d.businessId === where.businessId)
          .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
        return rows[0] ?? null;
      },
    },
    bankTransaction: {
      findMany: async ({ where }: { where: { id: { in: string[] }; businessId: string } }) => {
        recorded.txnWhere = where;
        return fixture.transactions.filter(
          (txn) =>
            where.id.in.includes(txn.id) &&
            txn.businessId === where.businessId &&
            fixture.businesses[txn.businessId]?.practiceId === practiceInScope,
        );
      },
    },
  };

  return { $transaction: async (fn: (client: typeof tx) => Promise<unknown>) => fn(tx) } as unknown as PrismaClient;
}

function txn(over: Partial<TxnRow> = {}): TxnRow {
  return {
    id: 'txn_currys',
    businessId: 'biz_burger',
    bookedAt: new Date('2026-08-09T12:00:00.000Z'),
    amountPence: -129_900,
    descriptionRaw: 'CURRYS 1234 LONDON',
    merchantName: 'Currys',
    matchState: 'UNMATCHED',
    ...over,
  };
}

function fixture(over: Partial<Fixture> = {}): Fixture {
  return {
    chases: {
      chase_1: { practiceId: 'prac_1', businessId: 'biz_burger', itemRefs: ['txn_currys', 'txn_google'], transactionId: 'txn_currys', state: 'SENT' },
    },
    businesses: { biz_burger: { practiceId: 'prac_1', name: 'American Burger' } },
    transactions: [txn(), txn({ id: 'txn_google', amountPence: -60_000, merchantName: 'Google', descriptionRaw: 'GOOGLE ADS' })],
    ...over,
  };
}

function facts(over: Partial<PortalSessionFacts> = {}): PortalSessionFacts {
  return {
    otpSessionId: 'otp_1',
    businessId: 'biz_burger',
    practiceId: 'prac_1',
    systemUserId: 'usr_system_1',
    actorId: 'usr_system_1',
    chaseId: 'chase_1',
    grantedItemIds: [],
    expiresAt: EXPIRES,
    ...over,
  };
}

function service(db: Fixture, recorded: Recorded = { chaseWhere: null, txnWhere: null, businessWhere: null }): PortalContextService {
  return new PortalContextService(fakePrisma(db, recorded));
}

async function grab(fn: () => Promise<unknown>): Promise<AppException> {
  try {
    await fn();
  } catch (error) {
    return error as AppException;
  }
  throw new Error('expected a throw');
}

test('a live session sees ITS chase: the business name, its items in the chase\'s own order, and the session expiry', async () => {
  const context = await service(fixture()).getContext(facts());

  expect(context).toEqual({
    businessName: 'American Burger',
    // Null on a CHASE session: its holder may upload against granted documents
    // and nothing else, so they are handed no id they could put in a body.
    businessId: null,
    statementRequests: [],
    summary: null,
    items: [
      {
        transactionId: 'txn_currys',
        merchantName: 'Currys',
        descriptionRaw: 'CURRYS 1234 LONDON',
        amountPence: -129_900,
        bookedAt: '2026-08-09T12:00:00.000Z',
        received: false,
      },
      {
        transactionId: 'txn_google',
        merchantName: 'Google',
        descriptionRaw: 'GOOGLE ADS',
        amountPence: -60_000,
        bookedAt: '2026-08-09T12:00:00.000Z',
        received: false,
      },
    ],
    expiresAt: EXPIRES.toISOString(),
  });
  // The response the contract publishes, checked against the contract's own
  // generated schema rather than against this test's idea of it — including
  // `items: minItems 1` and `amountPence: integer`.
  expect(getPortalContextResponse.safeParse(context).success).toBe(true);
});

test('money is the signed integer pence the feed recorded — no arithmetic, no coercion, no float', async () => {
  const context = await service(fixture()).getContext(facts());
  for (const item of context.items) {
    expect(Number.isInteger(item.amountPence)).toBe(true);
  }
  expect(context.items.map((item) => item.amountPence)).toEqual([-129_900, -60_000]);
});

test('the read is CONSTRAINED to the session\'s own chase and business — the system context can see the whole practice', async () => {
  const recorded: Recorded = { chaseWhere: null, txnWhere: null, businessWhere: null };
  await service(fixture(), recorded).getContext(facts());

  // Nothing on this path comes from the caller: the chase id and the business id
  // are values the server wrote onto the `otp_sessions` row. That row IS the
  // chase boundary — `chases` and `bank_transactions` have no delegated RLS
  // branch, so SQL is not narrowing this to one chase; these clauses are.
  expect(recorded.chaseWhere).toEqual({ id: 'chase_1' });
  expect(recorded.businessWhere).toEqual({ id: 'biz_burger' });
  expect(recorded.txnWhere).toEqual({ id: { in: ['txn_currys', 'txn_google'] }, businessId: 'biz_burger' });
});

test('`received` is the chase module\'s predicate, not a second one: a closed-received chase or a matched transaction', async () => {
  const closed = fixture({
    chases: { chase_1: { practiceId: 'prac_1', businessId: 'biz_burger', itemRefs: ['txn_currys'], transactionId: 'txn_currys', state: 'CLOSED_RECEIVED' } },
    transactions: [txn()],
  });
  expect((await service(closed).getContext(facts())).items[0]?.received).toBe(true);

  const matched = fixture({
    chases: { chase_1: { practiceId: 'prac_1', businessId: 'biz_burger', itemRefs: ['txn_currys'], transactionId: 'txn_currys', state: 'SENT' } },
    transactions: [txn({ matchState: 'MATCHED' })],
  });
  expect((await service(matched).getContext(facts())).items[0]?.received).toBe(true);
});

test('a GROUPED chase credits only the line the close matched — the other item stays outstanding', async () => {
  // The bug this pins: Stage 8's auto-close closes the WHOLE chase on the first
  // matching document, so deriving `received` from the chase state alone marked
  // every item received off one upload. A client who sent the Currys receipt was
  // told the Google one had arrived too — the list read "nothing is outstanding"
  // and disabled the row, so the second receipt was never collected.
  const db = fixture({
    chases: {
      chase_1: {
        practiceId: 'prac_1',
        businessId: 'biz_burger',
        itemRefs: ['txn_currys', 'txn_google'],
        transactionId: 'txn_currys', // the line auto-close actually matched
        state: 'CLOSED_RECEIVED',
      },
    },
    transactions: [
      txn({ id: 'txn_currys' }),
      txn({ id: 'txn_google', matchState: 'UNMATCHED' }),
    ],
  });

  const items = (await service(db).getContext(facts())).items;
  expect(items.find((i) => i.transactionId === 'txn_currys')?.received).toBe(true);
  expect(items.find((i) => i.transactionId === 'txn_google')?.received).toBe(false);
});

test('a grouped chase still credits an item its OWN matchState settled, whichever channel brought it', async () => {
  // The per-item fallback survives the narrowing above: a line matched by email
  // or WhatsApp reads received even though the chase-level close names another.
  const db = fixture({
    chases: {
      chase_1: {
        practiceId: 'prac_1',
        businessId: 'biz_burger',
        itemRefs: ['txn_currys', 'txn_google'],
        transactionId: 'txn_currys',
        state: 'CLOSED_RECEIVED',
      },
    },
    transactions: [txn({ id: 'txn_currys' }), txn({ id: 'txn_google', matchState: 'MATCHED' })],
  });

  expect((await service(db).getContext(facts())).items.every((i) => i.received)).toBe(true);
});

test('a chase whose itemRefs JSON is unusable falls back to the single-transaction column, never to an empty list', async () => {
  const db = fixture({
    chases: { chase_1: { practiceId: 'prac_1', businessId: 'biz_burger', itemRefs: { not: 'an array' }, transactionId: 'txn_currys', state: 'SENT' } },
    transactions: [txn()],
  });
  expect((await service(db).getContext(facts())).items.map((item) => item.transactionId)).toEqual(['txn_currys']);
});

test('an invisible chase, or a chase in another business, is 401 NT-OTP-002 — never a leak, never a 500', async () => {
  const db = fixture({
    chases: {
      chase_1: { practiceId: 'prac_1', businessId: 'biz_burger', itemRefs: ['txn_currys'], transactionId: null, state: 'SENT' },
      chase_elsewhere: { practiceId: 'prac_other', businessId: 'biz_theirs', itemRefs: ['txn_theirs'], transactionId: null, state: 'SENT' },
    },
  });

  // ⚠ `chaseId: null` is NOT in this list any more. It used to be a 401, and
  // that was the bug: a client signed into their OWN workspace has no chase by
  // definition, so the only session an invited client can hold was refused and
  // they had no portal to land on. It now serves their workspace instead — see
  // the onboarding test below.
  for (const over of [
    { chaseId: 'chase_gone' }, // deleted under a live session
    { chaseId: 'chase_elsewhere' }, // another practice's chase: invisible under this context, as RLS makes it
    { businessId: 'biz_someone_else' }, // the row and the chase disagree about the tenant
  ]) {
    const error = await grab(() => service(db).getContext(facts(over)));
    expect(error.code).toBe('NT-OTP-002');
    expect(error.getStatus()).toBe(401);
    expect(error.publicDetail).toBe('missing or invalid portal session');
  }
});

test('a chase with no reachable item is a 500, NOT a 200 with an empty list — `items` is minItems 1 in the contract', async () => {
  const db = fixture({
    chases: { chase_1: { practiceId: 'prac_1', businessId: 'biz_burger', itemRefs: [], transactionId: null, state: 'SENT' } },
    transactions: [],
  });
  const error = await grab(() => service(db).getContext(facts()));
  expect(error.code).toBe('NT-SRV-001');
  expect(error.getStatus()).toBe(500);
  // Written for the person holding the phone, and it names no id.
  expect(error.publicDetail).toBe('We could not load what we are missing from you. Ask your accountant to send the link again.');
});

test('a business row that cannot be read is the same 500 — `businessName` is required and is never invented', async () => {
  const db = fixture({ businesses: {} });
  expect((await grab(() => service(db).getContext(facts()))).code).toBe('NT-SRV-001');
});


/* ── The client's own portal (D47, §24.5) ─────────────────────────────────── */

test('a session with no chase gets its OWN workspace, not a 401', async () => {
  // The bug this closes: an invited client who has just paid and signed in holds
  // exactly this session, and it was refused — so the one credential they can
  // have had no portal to land on.
  const db = fixture({
    businesses: { biz_burger: { practiceId: 'prac_1', name: 'American Burger', subscriptionStatus: 'ACTIVE' } },
    documents: [
      { businessId: 'biz_burger', createdAt: new Date('2026-08-01T09:00:00.000Z') },
      { businessId: 'biz_burger', createdAt: new Date('2026-08-09T09:00:00.000Z') },
      { businessId: 'biz_other', createdAt: new Date('2026-08-20T09:00:00.000Z') },
    ],
  });

  const context = await service(db).getContext(facts({ chaseId: null }));

  expect(context.businessName).toBe('American Burger');
  expect(context.businessId).toBe('biz_burger');
  // Phase 5: the own-portal ITEMISES the workspace's open asks — the fixture's
  // default open chase covers two transactions, and both are named here so
  // "waiting for N documents" stops being a number the client telephones about.
  expect(context.items.map((i) => i.transactionId).sort()).toEqual(['txn_currys', 'txn_google']);
  expect(context.items.every((i) => i.received === false)).toBe(true);
  // Another business's documents are not counted.
  expect(context.summary?.documentsSent).toBe(2);
  expect(context.summary?.lastDocumentAt).toBe('2026-08-09T09:00:00.000Z');
  expect(context.summary?.subscriptionActive).toBe(true);
  // The response still has to satisfy the contract it is declared by.
  expect(getPortalContextResponse.safeParse(context).success).toBe(true);
});

test('awaitingYou counts ITEMS across open chases, not chases', async () => {
  // A grouped chase asks for several receipts in one message (SoT §8.2), so the
  // number that means anything to a client is how many things they owe.
  const db = fixture({
    chases: {
      sent: { practiceId: 'prac_1', businessId: 'biz_burger', itemRefs: ['a', 'b'], transactionId: null, state: 'SENT' },
      escalated: { practiceId: 'prac_1', businessId: 'biz_burger', itemRefs: ['c'], transactionId: null, state: 'ESCALATED' },
      // Settled, and a chase composed but NOT sent has not reached this client —
      // counting it would say they are late for a request nobody made (D44).
      closed: { practiceId: 'prac_1', businessId: 'biz_burger', itemRefs: ['d'], transactionId: null, state: 'CLOSED_RECEIVED' },
      unsent: { practiceId: 'prac_1', businessId: 'biz_burger', itemRefs: ['e'], transactionId: null, state: 'PROPOSED' },
    },
  });

  const context = await service(db).getContext(facts({ chaseId: null }));
  expect(context.summary?.awaitingYou).toBe(3);
});

test('a lapsed subscription is reported, not hidden', async () => {
  // D48 refuses the upload anyway; the portal says so BEFORE the client
  // photographs a receipt rather than after.
  const db = fixture({
    businesses: { biz_burger: { practiceId: 'prac_1', name: 'American Burger', subscriptionStatus: 'PAST_DUE' } },
  });
  const context = await service(db).getContext(facts({ chaseId: null }));
  expect(context.summary?.subscriptionActive).toBe(false);
});
