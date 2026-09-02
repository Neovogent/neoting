import { createHash } from 'node:crypto';

import { expect, test } from 'vitest';

import type { PrismaClient } from '../../common/db/prisma.js';
import type { AppException } from '../../common/problem/problem.js';
import { signPortalLink } from '../chase/index.js';
import { hashOtp, PORTAL_OTP_LOCKOUT_MS, PORTAL_OTP_MAX_ATTEMPTS } from './otp-attempts.js';
import type { PortalSessionFacts } from './portal-session-context.js';
import { PORTAL_SESSION_TTL_MS, verifyPortalSessionToken } from './portal-session-token.js';
import { PortalSessionService } from './portal-session.service.js';

const LINK_SECRET = 'test-portal-link-secret';
const SESSION_SECRET = 'test-portal-session-secret';
const NOW = 1_755_500_000_000;

const config = { portalLinkSecret: LINK_SECRET, portalSessionSecret: SESSION_SECRET, otpMode: 'demo' } as const;

interface ChaseFixture {
  readonly practiceId: string;
  readonly businessId: string;
  readonly recipientContactId: string | null;
  readonly recipientUserId: string | null;
}

interface OtpRow {
  id: string;
  linkTokenHash: string;
  businessId: string;
  chaseId: string | null;
  requestedFromContactId: string | null;
  userId: string | null;
  scope: string;
  grantedItemIds: string[];
  verifiedAt: Date | null;
  expiresAt: Date;
  /** A2 — the four columns the schema always had and nothing read until now. */
  attempts: number;
  lockedUntil: Date | null;
  otpHash: string | null;
  otpExpiresAt: Date | null;
}

interface Fixture {
  /** practiceId → its SYSTEM actor, in `memberships` order. */
  readonly systemActors: readonly { practiceId: string | null; userId: string }[];
  /** chaseId → the chase, and the practice whose context can see it. */
  readonly chases: Readonly<Record<string, ChaseFixture>>;
  /** The ids that name a real `users` row. */
  readonly users: readonly string[];
  readonly otpSessions: OtpRow[];
}

/**
 * A Prisma stand-in that SIMULATES the practice scoping, because that is the
 * behaviour under test: `scopedDb` writes `app.practice_id` as the second bound
 * value of its `set_config` statement, and the fake chase read honours it. A
 * chase is therefore invisible to every practice but its own, exactly as
 * `chases_tenant` makes it.
 */
function fakePrisma(fixture: Fixture): PrismaClient {
  let practiceInScope: string | null = null;
  let nextId = 1;

  const tx = {
    $executeRaw: async (_strings: TemplateStringsArray, ...values: unknown[]): Promise<number> => {
      practiceInScope = values[1] === '' ? null : String(values[1]);
      return 0;
    },
    chase: {
      findUnique: async ({ where }: { where: { id: string } }) => {
        const chase = fixture.chases[where.id];
        if (chase === undefined || chase.practiceId !== practiceInScope) return null;
        return {
          id: where.id,
          businessId: chase.businessId,
          recipientContactId: chase.recipientContactId,
          recipient: chase.recipientContactId === null ? null : { userId: chase.recipientUserId },
        };
      },
    },
    user: {
      findUnique: async ({ where }: { where: { id: string } }) =>
        fixture.users.includes(where.id) ? { id: where.id } : null,
    },
    otpSession: {
      findUnique: async ({ where }: { where: { id?: string; linkTokenHash?: string } }) =>
        fixture.otpSessions.find((row) => (where.id === undefined ? row.linkTokenHash === where.linkTokenHash : row.id === where.id)) ?? null,
      upsert: async ({ where, create, update }: { where: { linkTokenHash: string }; create: Partial<OtpRow>; update: Partial<OtpRow> }) => {
        const existing = fixture.otpSessions.find((row) => row.linkTokenHash === where.linkTokenHash);
        if (existing !== undefined) return Object.assign(existing, update);
        const row = { id: `otp_${nextId++}`, grantedItemIds: [], attempts: 0, lockedUntil: null, otpHash: null, otpExpiresAt: null, ...create } as OtpRow;
        fixture.otpSessions.push(row);
        return row;
      },
      update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        const row = fixture.otpSessions.find((candidate) => candidate.id === where.id);
        if (row === undefined) throw new Error('no such otp session');
        const push = (data['grantedItemIds'] as { push?: string[] } | undefined)?.push;
        if (push !== undefined) row.grantedItemIds = [...row.grantedItemIds, ...push];
        return row;
      },
    },
  };

  return {
    membership: { findMany: async () => fixture.systemActors },
    $transaction: async (fn: (client: typeof tx) => Promise<unknown>) => fn(tx),
  } as unknown as PrismaClient;
}

function fixture(over: Partial<Fixture> = {}): Fixture {
  return {
    systemActors: [{ practiceId: 'prac_other', userId: 'usr_system_other' }, { practiceId: 'prac_1', userId: 'usr_system_1' }],
    chases: {
      chase_1: { practiceId: 'prac_1', businessId: 'biz_burger', recipientContactId: 'contact_1', recipientUserId: null },
    },
    users: [],
    otpSessions: [],
    ...over,
  };
}

function link(chaseId = 'chase_1', expSeconds = 3600): string {
  return signPortalLink({ chaseId, expSeconds }, LINK_SECRET, NOW);
}

async function grab(fn: () => Promise<unknown>): Promise<AppException> {
  try {
    await fn();
  } catch (error) {
    return error as AppException;
  }
  throw new Error('expected a throw');
}

test('link + OTP mint a bearer carrying the session, its business and its practice', async () => {
  const db = fixture();
  const session = await new PortalSessionService(fakePrisma(db), config).createSession({ linkToken: link(), otp: '000000' }, NOW);

  expect(session.expiresAt.getTime()).toBe(NOW + PORTAL_SESSION_TTL_MS);
  expect(verifyPortalSessionToken(session.token, SESSION_SECRET, NOW)).toEqual({
    ok: true,
    claims: { otpSessionId: 'otp_1', businessId: 'biz_burger', practiceId: 'prac_1', expiresAtMs: NOW + PORTAL_SESSION_TTL_MS },
  });
});

test('the otp_sessions row records the grant: DELEGATED_UPLOAD, the chase, requested-from, an EMPTY grant and the hashed link', async () => {
  const db = fixture();
  const token = link();
  await new PortalSessionService(fakePrisma(db), config).createSession({ linkToken: token, otp: '000000' }, NOW);

  const row = db.otpSessions[0];
  expect(row).toMatchObject({
    businessId: 'biz_burger',
    chaseId: 'chase_1',
    requestedFromContactId: 'contact_1',
    scope: 'DELEGATED_UPLOAD',
    grantedItemIds: [],
    userId: null,
    verifiedAt: new Date(NOW),
    expiresAt: new Date(NOW + PORTAL_SESSION_TTL_MS),
  });
  // The link token itself is never stored — only a hash of it, and `contactId`
  // stays null because a forwarded link does not say who is holding it.
  expect(row?.linkTokenHash).toBe(createHash('sha256').update(token).digest('hex'));
  expect(row).not.toHaveProperty('contactId');
  expect(JSON.stringify(row)).not.toContain(token);
});

test('EVERY verification failure is the same 401 NT-OTP-001 — no oracle between link, expiry, OTP and a missing chase', async () => {
  const service = new PortalSessionService(fakePrisma(fixture()), config);
  const attempts = [
    { linkToken: link(), otp: '111111' }, // wrong OTP
    { linkToken: 'not-a-token', otp: '000000' }, // malformed link
    { linkToken: signPortalLink({ chaseId: 'chase_1' }, 'another-secret', NOW), otp: '000000' }, // forged link
    { linkToken: link('chase_1', 60), otp: '000000' }, // expired link (verified 10 min later, below)
    { linkToken: link('chase_gone'), otp: '000000' }, // signed by us, names nothing
  ];

  for (const attempt of attempts) {
    const error = await grab(() => service.createSession(attempt, NOW + 10 * 60 * 1000));
    expect(error.code).toBe('NT-OTP-001');
    expect(error.getStatus()).toBe(401);
    expect(error.publicDetail).toBe('The link or verification code did not verify. Request a fresh link if this one has expired.');
  }
});

test('a chase in ANOTHER practice is found by the sweep — the practice is not knowable before the session exists', async () => {
  // Two practices, the chase in the second. The first candidate context sees
  // nothing (as RLS would show it nothing), so the sweep continues.
  const db = fixture({
    chases: { chase_1: { practiceId: 'prac_1', businessId: 'biz_burger', recipientContactId: null, recipientUserId: null } },
  });
  const session = await new PortalSessionService(fakePrisma(db), config).createSession({ linkToken: link(), otp: '000000' }, NOW);
  const verdict = verifyPortalSessionToken(session.token, SESSION_SECRET, NOW);
  expect(verdict.ok && verdict.claims.practiceId).toBe('prac_1');
});

test('a chase no practice SYSTEM actor can reach is the same 401 — never a 500, never a leak', async () => {
  const db = fixture({ systemActors: [] });
  const error = await grab(() => new PortalSessionService(fakePrisma(db), config).createSession({ linkToken: link(), otp: '000000' }, NOW));
  expect(error.code).toBe('NT-OTP-001');
});

test('the delegated actor is the contact user only when that user actually exists', async () => {
  const withUser = fixture({
    chases: { chase_1: { practiceId: 'prac_1', businessId: 'biz_burger', recipientContactId: 'contact_1', recipientUserId: 'usr_client' } },
    users: ['usr_client'],
  });
  await new PortalSessionService(fakePrisma(withUser), config).createSession({ linkToken: link(), otp: '000000' }, NOW);
  expect(withUser.otpSessions[0]?.userId).toBe('usr_client');

  // `Contact.userId` carries no foreign key, so an id naming no `users` row
  // must NOT be adopted — `documents.submitter_user_id` would reject it hours
  // later, on the client's phone.
  const dangling = fixture({
    chases: { chase_1: { practiceId: 'prac_1', businessId: 'biz_burger', recipientContactId: 'contact_1', recipientUserId: 'usr_deleted' } },
    users: [],
  });
  await new PortalSessionService(fakePrisma(dangling), config).createSession({ linkToken: link(), otp: '000000' }, NOW);
  expect(dangling.otpSessions[0]?.userId).toBeNull();
});

test('re-verifying the same link updates the SAME row (link_token_hash is unique) and keeps what it already granted', async () => {
  const db = fixture();
  const service = new PortalSessionService(fakePrisma(db), config);
  const token = link();

  const first = await service.createSession({ linkToken: token, otp: '000000' }, NOW);
  db.otpSessions[0]!.grantedItemIds = ['doc_already_uploaded'];

  const later = NOW + 30 * 60 * 1000;
  const second = await service.createSession({ linkToken: token, otp: '000000' }, later);

  expect(db.otpSessions).toHaveLength(1);
  expect(db.otpSessions[0]?.grantedItemIds).toEqual(['doc_already_uploaded']);
  expect(db.otpSessions[0]?.expiresAt).toEqual(new Date(later + PORTAL_SESSION_TTL_MS));
  expect(second.token).not.toBe(first.token); // a fresh bearer, a fresh hour
});

test('grantItems pushes only the ids the session does not already hold', async () => {
  const db = fixture({
    otpSessions: [
      {
        id: 'otp_1',
        linkTokenHash: 'hash',
        businessId: 'biz_burger',
        chaseId: 'chase_1',
        requestedFromContactId: null,
        userId: null,
        scope: 'DELEGATED_UPLOAD',
        grantedItemIds: ['doc_a'],
        verifiedAt: new Date(NOW),
        expiresAt: new Date(NOW + PORTAL_SESSION_TTL_MS),
        attempts: 0,
        lockedUntil: null,
        otpHash: null,
        otpExpiresAt: null,
      },
    ],
  });
  const service = new PortalSessionService(fakePrisma(db), config);
  const facts: PortalSessionFacts = {
    otpSessionId: 'otp_1',
    businessId: 'biz_burger',
    practiceId: 'prac_1',
    systemUserId: 'usr_system_1',
    actorId: 'usr_system_1',
    contactId: null,
    chaseId: 'chase_1',
    grantedItemIds: ['doc_a'],
    expiresAt: new Date(NOW + PORTAL_SESSION_TTL_MS),
  };

  expect(await service.grantItems(facts, ['doc_a'])).toEqual(['doc_a']);
  expect(db.otpSessions[0]?.grantedItemIds).toEqual(['doc_a']);

  expect(await service.grantItems(facts, ['doc_a', 'doc_b'])).toEqual(['doc_a', 'doc_b']);
  expect(db.otpSessions[0]?.grantedItemIds).toEqual(['doc_a', 'doc_b']);
});

test('an empty PORTAL_LINK_SECRET fails closed and loud, never as a quiet accept', async () => {
  const service = new PortalSessionService(fakePrisma(fixture()), { ...config, portalLinkSecret: '' });
  await expect(service.createSession({ linkToken: link(), otp: '000000' }, NOW)).rejects.toThrow(/PORTAL_LINK_SECRET/);
});

// ─────────────────────────────────────────────────────────────────────────────
// A2 — attempt counting and lockout on otp_sessions.attempts / locked_until
// ─────────────────────────────────────────────────────────────────────────────

test('A2: a wrong code is COUNTED, on a row that is deliberately not a session', async () => {
  const db = fixture();
  const token = link();
  const service = new PortalSessionService(fakePrisma(db), config);

  await grab(() => service.createSession({ linkToken: token, otp: '111111' }, NOW));

  const row = db.otpSessions[0];
  expect(row?.attempts).toBe(1);
  expect(row?.lockedUntil).toBeNull();
  // ⚠ Before A2 an `otp_sessions` row appeared only on SUCCESS, so a failure
  // had nowhere to be recorded and both columns were unreachable. The row this
  // creates is a counter, not a credential: `PortalSessionContextResolver`
  // refuses it on `verifiedAt === null` AND on `expiresAt <= now`, two
  // independent checks.
  expect(row?.verifiedAt).toBeNull();
  expect(row?.expiresAt).toEqual(new Date(NOW));
  expect(row?.linkTokenHash).toBe(createHash('sha256').update(token).digest('hex'));
  // One link, one row, however many wrong codes — `link_token_hash` is unique,
  // so an unauthenticated caller cannot grow the table.
  await grab(() => service.createSession({ linkToken: token, otp: '222222' }, NOW));
  expect(db.otpSessions).toHaveLength(1);
  expect(db.otpSessions[0]?.attempts).toBe(2);
});

test('A2 REFUSAL: five wrong codes lock the link, and the RIGHT code then gets the SAME 401', async () => {
  const db = fixture();
  const token = link();
  const service = new PortalSessionService(fakePrisma(db), config);

  for (let attempt = 0; attempt < PORTAL_OTP_MAX_ATTEMPTS; attempt += 1) {
    const error = await grab(() => service.createSession({ linkToken: token, otp: '111111' }, NOW));
    expect(error.code).toBe('NT-OTP-001');
  }
  expect(db.otpSessions[0]?.lockedUntil).toEqual(new Date(NOW + PORTAL_OTP_LOCKOUT_MS));

  // ⚠ THE SAME 401, WORD FOR WORD. `openapi.yaml` requires every verification
  // failure here to be indistinguishable — a distinct "this link is locked"
  // would confirm that the link names a real chase, which is exactly what the
  // uniform code exists to refuse. (Contrast the sign-in lane, whose 429 is
  // keyed on a string the CALLER typed and so reveals nothing.)
  const locked = await grab(() => service.createSession({ linkToken: token, otp: '000000' }, NOW));
  expect(locked.code).toBe('NT-OTP-001');
  expect(locked.getStatus()).toBe(401);
  expect(locked.publicDetail).toBe('The link or verification code did not verify. Request a fresh link if this one has expired.');

  // A locked link stops COUNTING too — the refusal is before the compare, so a
  // flood cannot inflate the number or extend the lock for ever.
  expect(db.otpSessions[0]?.attempts).toBe(PORTAL_OTP_MAX_ATTEMPTS);
});

test('A2: the lock lifts with the window, and a success clears the counter', async () => {
  const db = fixture();
  const token = link();
  const service = new PortalSessionService(fakePrisma(db), config);

  for (let attempt = 0; attempt < PORTAL_OTP_MAX_ATTEMPTS; attempt += 1) {
    await grab(() => service.createSession({ linkToken: token, otp: '111111' }, NOW));
  }
  const after = NOW + PORTAL_OTP_LOCKOUT_MS + 1;
  await expect(service.createSession({ linkToken: token, otp: '000000' }, after)).resolves.toBeDefined();

  // Carrying five attempts into the next visit would lock this client out on
  // their first slip, for a mistake they already corrected.
  expect(db.otpSessions[0]?.attempts).toBe(0);
  expect(db.otpSessions[0]?.lockedUntil).toBeNull();
  expect(db.otpSessions[0]?.verifiedAt).toEqual(new Date(after));
});

test('A2: one link locking does not touch another link on the same chase', async () => {
  const db = fixture();
  const service = new PortalSessionService(fakePrisma(db), config);
  const locked = link();
  const fresh = signPortalLink({ chaseId: 'chase_1', expSeconds: 7200 }, LINK_SECRET, NOW + 1);

  for (let attempt = 0; attempt < PORTAL_OTP_MAX_ATTEMPTS; attempt += 1) {
    await grab(() => service.createSession({ linkToken: locked, otp: '111111' }, NOW));
  }
  await expect(service.createSession({ linkToken: fresh, otp: '000000' }, NOW)).resolves.toBeDefined();
});

// ─────────────────────────────────────────────────────────────────────────────
// A2 — OTP_MODE=totp: the code comes from otp_sessions.otp_hash, not from source
// ─────────────────────────────────────────────────────────────────────────────

const realOtp = { ...config, otpMode: 'totp' } as const;

/** A link whose session row already carries a minted code, as a sender would leave it. */
function withMintedCode(otp: string, expiresAt: Date): { db: Fixture; token: string } {
  const token = link();
  const db = fixture({
    otpSessions: [
      {
        id: 'otp_minted',
        linkTokenHash: createHash('sha256').update(token).digest('hex'),
        businessId: 'biz_burger',
        chaseId: 'chase_1',
        requestedFromContactId: 'contact_1',
        userId: null,
        scope: 'DELEGATED_UPLOAD',
        grantedItemIds: [],
        verifiedAt: null,
        expiresAt,
        attempts: 0,
        lockedUntil: null,
        otpHash: hashOtp(otp),
        otpExpiresAt: expiresAt,
      },
    ],
  });
  return { db, token };
}

test('A2: under totp the portal verifies the MINTED code, and the published 000000 stops working', async () => {
  const { db, token } = withMintedCode('483920', new Date(NOW + 10 * 60 * 1000));
  const service = new PortalSessionService(fakePrisma(db), realOtp);

  const fixed = await grab(() => service.createSession({ linkToken: token, otp: '000000' }, NOW));
  expect(fixed.code).toBe('NT-OTP-001');

  await expect(service.createSession({ linkToken: token, otp: '483920' }, NOW)).resolves.toBeDefined();
  expect(db.otpSessions[0]?.verifiedAt).toEqual(new Date(NOW));
});

test('A2 REFUSAL: under totp, a session with NO minted code cannot be opened at all', async () => {
  // The honest intermediate state: nothing in A2's owned paths mints a code —
  // the chase sender is A13's and `POST /portal/sign-in-codes` is contracted and
  // unimplemented. Failing closed is the point, not a bug.
  const db = fixture();
  const service = new PortalSessionService(fakePrisma(db), realOtp);
  for (const otp of ['000000', '483920']) {
    const error = await grab(() => service.createSession({ linkToken: link(), otp }, NOW));
    expect(error.code).toBe('NT-OTP-001');
  }
});

test('A2 REFUSAL: an EXPIRED minted code is refused even though it is the right six digits', async () => {
  const { db, token } = withMintedCode('483920', new Date(NOW - 1));
  const service = new PortalSessionService(fakePrisma(db), realOtp);
  const error = await grab(() => service.createSession({ linkToken: token, otp: '483920' }, NOW));
  expect(error.code).toBe('NT-OTP-001');
  // …and it still counted as an attempt, so guessing around an expiry is not free.
  expect(db.otpSessions[0]?.attempts).toBe(1);
});
