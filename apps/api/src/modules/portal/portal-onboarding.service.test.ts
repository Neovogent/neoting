import { describe, expect, test } from 'vitest';

import { hashSetupToken } from '../clients-team-settings/index.js';
import type { NotificationsService } from '../notifications/index.js';

import { hashOtp, PORTAL_OTP_MAX_ATTEMPTS } from './otp-attempts.js';
import { ONBOARDING_OTP_TTL_MS, PortalOnboardingService } from './portal-onboarding.service.js';
import { verifyPortalSessionToken } from './portal-session-token.js';

/**
 * The invited client's way in.
 *
 * The rule that matters most here is the one that has no visible effect:
 * `requestSignInCode` answers the same way whatever happened. Every refusal
 * below asserts that **nothing was sent** rather than that something was
 * reported, because reporting is exactly what would leak.
 */

const SECRET = 'portal-session-secret-for-tests';
const TOKEN = 'setup-token-abc';
const EMAIL = 'owner@sparkle.test';
const NOW = Date.parse('2026-08-28T09:00:00Z');

interface Row {
  id: string;
  linkTokenHash: string;
  otpHash: string | null;
  otpExpiresAt: Date | null;
  attempts: number;
  lockedUntil: Date | null;
  verifiedAt: Date | null;
}

/**
 * A Prisma double that answers the three tables this service touches, and
 * enforces the one thing a stub must not paper over: `invite.findUnique`
 * answers only under the practice whose context is set, so the sweep is really
 * exercised rather than short-circuited.
 */
function harness(
  over: {
    invite?: Partial<{ email: string; businessId: string | null; expiresAt: Date; acceptedAt: Date | null }>;
    row?: Partial<Row>;
    otpMode?: 'demo' | 'totp';
    send?: () => Promise<unknown>;
    /** The practices the sweep can see. `[]` is a tenant with no machine actor. */
    practices?: readonly { practiceId: string; userId: string }[];
    /** What `contacts` holds for the address — the tokenless route's only input. */
    contacts?: readonly { id: string; businessId: string }[];
    /** The business's subscription status at session open. Null = never subscribed. */
    subscriptionStatus?: 'ACTIVE' | 'TRIALING' | 'CANCELED' | null;
  } = {},
) {
  const invite = {
    businessId: 'biz_1' as string | null,
    email: EMAIL,
    expiresAt: new Date(NOW + 86_400_000),
    acceptedAt: null as Date | null,
    ...over.invite,
  };

  const rows = new Map<string, Row>();
  if (over.row !== undefined) {
    rows.set(hashSetupToken(TOKEN), {
      id: 'otp_1',
      linkTokenHash: hashSetupToken(TOKEN),
      otpHash: null,
      otpExpiresAt: null,
      attempts: 0,
      lockedUntil: null,
      verifiedAt: null,
      ...over.row,
    });
  }

  const sent: { to: string; code: string }[] = [];

  const db = {
    invite: { findUnique: async ({ where }: { where: { tokenHash: string } }) => (where.tokenHash === hashSetupToken(TOKEN) ? invite : null) },
    contact: {
      findFirst: async () => ({ id: 'con_1' }),
      // The tokenless (returning-client) route resolves the workspace from the
      // address alone. `contacts` defaults to the one business the invite names.
      findMany: async ({ where }: { where: { email: { equals: string } } }) =>
        where.email.equals === EMAIL.toLowerCase() ? (over.contacts ?? [{ id: 'con_1', businessId: 'biz_1' }]) : [],
    },
    otpSession: {
      findUnique: async ({ where }: { where: { linkTokenHash: string } }) => rows.get(where.linkTokenHash) ?? null,
      upsert: async ({ where, update, create }: { where: { linkTokenHash: string }; update: Partial<Row>; create: Partial<Row> }) => {
        const existing = rows.get(where.linkTokenHash);
        const next = existing === undefined
          ? ({ id: 'otp_1', attempts: 0, lockedUntil: null, verifiedAt: null, ...create } as Row)
          : ({ ...existing, ...update } as Row);
        rows.set(where.linkTokenHash, next);
        return next;
      },
      update: async ({ where, data }: { where: { linkTokenHash?: string; id?: string }; data: Partial<Row> }) => {
        const key = where.linkTokenHash ?? hashSetupToken(TOKEN);
        const next = { ...(rows.get(key) as Row), ...data };
        rows.set(key, next);
        return next;
      },
    },
    membership: {
      findMany: async () => over.practices ?? [{ practiceId: 'prac_1', userId: 'usr_sys' }],
    },
    // The session-open path reads the business's subscription status inside
    // the same scoped transaction (5 Sep 2026) so the journey can skip the
    // subscribe step for an already-paying client. The double answers for the
    // invite's own business and nothing else.
    business: {
      findUnique: async ({ where }: { where: { id: string } }) =>
        where.id === 'biz_1' ? { subscriptionStatus: over.subscriptionStatus ?? null, name: 'Biz One Ltd' } : null,
    },
    // `scopedDb` sets the RLS context with a tagged template on the
    // TRANSACTION client before it runs the callback. The double has one
    // practice, so accepting the SET LOCAL and moving on is faithful.
    $executeRaw: async () => 0,
  };

  const prisma = {
    ...db,
    // The sweep reads `membership` off the ROOT client (it carries no RLS);
    // everything after it runs inside `scopedDb`'s transaction, which is the
    // same double.
    $transaction: async (fn: (c: unknown) => unknown) => fn(db),
  } as never;

  const notifications = {
    sendSignInCode: async (input: { to: string; code: { reveal(): string } }) => {
      if (over.send !== undefined) return over.send();
      sent.push({ to: input.to, code: input.code.reveal() });
      return { sent: true, kind: 'sign-in-code', providerMessageId: 'm1' };
    },
  } as unknown as NotificationsService;

  const service = new PortalOnboardingService(
    prisma,
    { portalSessionSecret: SECRET, otpMode: over.otpMode ?? 'totp', portalLinkSecret: 'test-portal-link-secret' },
    notifications,
  );

  return { service, sent, rows };
}

describe('requesting a code', () => {
  test('sends a six-digit code to the registered address and stores only its hash', async () => {
    const { service, sent, rows } = harness();
    await service.requestSignInCode({ setupToken: TOKEN, email: EMAIL }, NOW);

    expect(sent).toHaveLength(1);
    expect(sent[0]?.to).toBe(EMAIL);
    expect(sent[0]?.code).toMatch(/^[0-9]{6}$/);

    const row = rows.get(hashSetupToken(TOKEN));
    // The code itself is nowhere in the row.
    expect(row?.otpHash).toBe(hashOtp(sent[0]?.code ?? ''));
    expect(row?.otpHash).not.toBe(sent[0]?.code);
    expect(row?.otpExpiresAt?.getTime()).toBe(NOW + ONBOARDING_OTP_TTL_MS);
  });

  test('is case- and whitespace-insensitive about the address', async () => {
    const { service, sent } = harness();
    await service.requestSignInCode({ setupToken: TOKEN, email: '  OWNER@Sparkle.TEST ' }, NOW);
    expect(sent).toHaveLength(1);
  });
});

describe('⚠ every refusal is silent — the caller may not learn which', () => {
  const cases: [string, Parameters<typeof harness>[0], string][] = [
    ['a token that was never ours', {}, 'not-our-token'],
    ['an address that is not the registered one', {}, TOKEN],
    ['an expired invite', { invite: { expiresAt: new Date(NOW - 1) } }, TOKEN],
    ['an invite already accepted', { invite: { acceptedAt: new Date(NOW - 1) } }, TOKEN],
    ['an invite with no business', { invite: { businessId: null } }, TOKEN],
  ];

  for (const [name, over, token] of cases) {
    test(`${name} — resolves, and sends nothing`, async () => {
      const { service, sent } = harness(over);
      const email = name.includes('address') ? 'someone.else@elsewhere.test' : EMAIL;
      // Resolves. It does not throw, and it does not report.
      await expect(
        service.requestSignInCode({ setupToken: token, email }, NOW),
      ).resolves.toBeUndefined();
      expect(sent).toHaveLength(0);
    });
  }

  test('a send failure is swallowed for the caller — but the code was still minted', async () => {
    const { service, rows } = harness({
      send: () => {
        throw new Error('SES is down');
      },
    });
    await expect(service.requestSignInCode({ setupToken: TOKEN, email: EMAIL }, NOW)).resolves.toBeUndefined();
    expect(rows.get(hashSetupToken(TOKEN))?.otpHash).not.toBeNull();
  });
});

describe('exchanging the code for a session', () => {
  const live = (code: string) => ({ otpHash: hashOtp(code), otpExpiresAt: new Date(NOW + 60_000) });

  test('a correct code mints a portal bearer for that business', async () => {
    const { service } = harness({ row: live('123456') });
    const issued = await service.createOnboardingSession(
      { setupToken: TOKEN, email: EMAIL, otp: '123456' },
      NOW,
    );

    expect(issued).not.toBeNull();
    const verdict = verifyPortalSessionToken(issued?.token ?? '', SECRET, NOW);
    expect(verdict.ok).toBe(true);
    if (verdict.ok) {
      expect(verdict.claims.businessId).toBe('biz_1');
      expect(verdict.claims.practiceId).toBe('prac_1');
    }
  });

  test('the session carries subscriptionStatus when the business has one, and OMITS the key when it never subscribed', async () => {
    // The optional key is what lets the journey skip the £8.50 screen for an
    // already-paying client (5 Sep 2026). Never-subscribed is null in the
    // column and an ABSENT key on the wire (exactOptionalPropertyTypes) — the
    // controller spreads it conditionally, so the distinction starts here.
    const active = harness({ row: live('123456'), subscriptionStatus: 'ACTIVE' });
    const issuedActive = await active.service.createOnboardingSession({ setupToken: TOKEN, email: EMAIL, otp: '123456' }, NOW);
    expect(issuedActive?.subscriptionStatus).toBe('ACTIVE');

    const never = harness({ row: live('123456') });
    const issuedNever = await never.service.createOnboardingSession({ setupToken: TOKEN, email: EMAIL, otp: '123456' }, NOW);
    expect(issuedNever).not.toBeNull();
    expect(issuedNever !== null && 'subscriptionStatus' in issuedNever).toBe(false);
  });

  test('⚠ the code is single-use — the hash is cleared once it has opened a session', async () => {
    const { service, rows } = harness({ row: live('123456') });
    await service.createOnboardingSession({ setupToken: TOKEN, email: EMAIL, otp: '123456' }, NOW);
    // Without this the code stays live for its full ten minutes after use.
    expect(rows.get(hashSetupToken(TOKEN))?.otpHash).toBeNull();
  });

  test('a wrong code is refused and counted', async () => {
    const { service, rows } = harness({ row: live('123456') });
    expect(await service.createOnboardingSession({ setupToken: TOKEN, email: EMAIL, otp: '000001' }, NOW)).toBeNull();
    expect(rows.get(hashSetupToken(TOKEN))?.attempts).toBe(1);
  });

  test('an expired code is refused', async () => {
    const { service } = harness({ row: { otpHash: hashOtp('123456'), otpExpiresAt: new Date(NOW - 1) } });
    expect(await service.createOnboardingSession({ setupToken: TOKEN, email: EMAIL, otp: '123456' }, NOW)).toBeNull();
  });

  test('⚠ a locked link is refused BEFORE the code is compared, so it is not a timing oracle', async () => {
    const { service, rows } = harness({
      row: { ...live('123456'), attempts: PORTAL_OTP_MAX_ATTEMPTS, lockedUntil: new Date(NOW + 60_000) },
    });
    expect(await service.createOnboardingSession({ setupToken: TOKEN, email: EMAIL, otp: '123456' }, NOW)).toBeNull();
    // Not counted again: the lock cost one read, not a verification.
    expect(rows.get(hashSetupToken(TOKEN))?.attempts).toBe(PORTAL_OTP_MAX_ATTEMPTS);
  });

  test('no code was ever requested — refused, with nothing to count against', async () => {
    const { service } = harness();
    expect(await service.createOnboardingSession({ setupToken: TOKEN, email: EMAIL, otp: '123456' }, NOW)).toBeNull();
  });

  test('a wrong address is refused even with the right code', async () => {
    const { service } = harness({ row: live('123456') });
    expect(
      await service.createOnboardingSession(
        { setupToken: TOKEN, email: 'someone.else@elsewhere.test', otp: '123456' },
        NOW,
      ),
    ).toBeNull();
  });
});

/**
 * ⚠ **A practice with no SYSTEM actor is not a bad link, and conflating the
 * two cost a night.** The sweep searches UNDER each practice's machine actor,
 * so a practice that has none contributes no candidate — and the refusal that
 * comes back is byte-identical to the one an unknown token gets.
 *
 * That is correct for the CALLER (both are a silent `202`, and they must be),
 * and it was wrong for the LOG, which said nothing at all. Until 28 Aug 2026
 * only `prisma/seed.ts` created a SYSTEM user, so every real signed-up practice
 * was in this state and an invited client's code silently went nowhere.
 */
test('no practice has a machine actor — refused silently, and the caller still learns nothing', async () => {
  const { service, sent } = harness({ practices: [] });

  await expect(service.requestSignInCode({ setupToken: TOKEN, email: EMAIL }, NOW)).resolves.toBeUndefined();
  expect(sent).toHaveLength(0);
  // And the exchange is refused the same way, rather than throwing out of a
  // sweep that found nothing to iterate.
  expect(await service.createOnboardingSession({ setupToken: TOKEN, email: EMAIL, otp: '123456' }, NOW)).toBeNull();
});

test('a send the notifier REFUSES is not a send, and the code is still spent from the row', async () => {
  // `sendSignInCode` answers with a verdict rather than throwing, so a
  // rate-limited code never reached the `catch` and looked identical to a
  // delivered one. The caller still sees nothing — that part is the contract.
  const { service, sent, rows } = harness({
    send: async () => ({ sent: false, kind: 'sign-in-code', reason: 'rate-limited', retryAfterSeconds: 900 }),
  });

  await expect(service.requestSignInCode({ setupToken: TOKEN, email: EMAIL }, NOW)).resolves.toBeUndefined();
  expect(sent).toHaveLength(0);
  // The row still carries a fresh hash: refusing to SEND must not leave the
  // previous code live, or a retry would be compared against a stale one.
  expect(rows.get(hashSetupToken(TOKEN))?.otpHash).not.toBeNull();
});

/* ── Signing in again, with no setup link ─────────────────────────────────── */

/**
 * ⚠ The invite expires after SEVEN DAYS. While the setup token was required,
 * that made this a one-week door rather than a portal: a client who onboarded,
 * subscribed and came back a fortnight later was locked out of their own
 * workspace, with no route back that did not involve telephoning their
 * accountant.
 *
 * The address alone names the workspace now — which is only safe because it has
 * to name exactly one.
 */
describe('a returning client, with no setup token', () => {
  test('gets a code, resolved from the address alone', async () => {
    const { service, sent, rows } = harness();

    await service.requestSignInCode({ email: EMAIL }, NOW);

    expect(sent).toHaveLength(1);
    expect(sent[0]?.to).toBe(EMAIL);
    expect(sent[0]?.code).toMatch(/^[0-9]{6}$/);
    // Keyed on something OTHER than the setup token's hash — there is no link.
    expect(rows.has(hashSetupToken(TOKEN))).toBe(false);
    expect(rows.size).toBe(1);
    // Only the hash is stored, exactly as on the invite route.
    expect([...rows.values()][0]?.otpHash).not.toBe(sent[0]?.code);
  });

  test('the code opens a session carrying that business', async () => {
    const { service, sent } = harness();
    await service.requestSignInCode({ email: EMAIL }, NOW);

    const issued = await service.createOnboardingSession({ email: EMAIL, otp: sent[0]!.code }, NOW + 1000);

    expect(issued).not.toBeNull();
    expect(issued?.businessId).toBe('biz_1');
    const verdict = verifyPortalSessionToken(issued!.token, SECRET, NOW + 2000);
    expect(verdict.ok).toBe(true);
    if (verdict.ok) expect(verdict.claims.businessId).toBe('biz_1');
  });

  test('an address on TWO businesses sends NOTHING — it is never guessed at', async () => {
    // Picking one would open somebody's books on a coin toss, and the person it
    // opened them to would have no way of telling. The caller still sees 202.
    const { service, sent } = harness({
      contacts: [
        { id: 'con_1', businessId: 'biz_1' },
        { id: 'con_2', businessId: 'biz_2' },
      ],
    });

    await service.requestSignInCode({ email: EMAIL }, NOW);

    expect(sent).toHaveLength(0);
  });

  test('an address nobody is a contact at sends nothing', async () => {
    const { service, sent } = harness();
    await service.requestSignInCode({ email: 'stranger@elsewhere.test' }, NOW);
    expect(sent).toHaveLength(0);
  });

  test('a wrong code opens no session', async () => {
    const { service, sent } = harness();
    await service.requestSignInCode({ email: EMAIL }, NOW);
    const wrong = sent[0]!.code === '000000' ? '111111' : '000000';

    expect(await service.createOnboardingSession({ email: EMAIL, otp: wrong }, NOW + 1000)).toBeNull();
  });

  test('the invite route still keys on the token, so the two do not collide', async () => {
    const { service, rows } = harness();

    await service.requestSignInCode({ setupToken: TOKEN, email: EMAIL }, NOW);
    await service.requestSignInCode({ email: EMAIL }, NOW);

    // Two rows: a first sign-in and a return are different attempts and must not
    // overwrite each other's code.
    expect(rows.size).toBe(2);
    expect(rows.has(hashSetupToken(TOKEN))).toBe(true);
  });
});

describe('the setup preview — a token answers WITHOUT the address (5 Sep 2026)', () => {
  test('a live token names the registered email and the business, for the prefill', async () => {
    const { service } = harness();
    expect(await service.previewSetup(TOKEN, NOW)).toEqual({ email: EMAIL, businessName: 'Biz One Ltd' });
  });

  test('every refusal is one null — unknown, expired, accepted, business-less', async () => {
    const { service } = harness();
    expect(await service.previewSetup('not-our-token', NOW)).toBeNull();

    const expired = harness({ invite: { expiresAt: new Date(NOW - 1) } });
    expect(await expired.service.previewSetup(TOKEN, NOW)).toBeNull();

    const accepted = harness({ invite: { acceptedAt: new Date(NOW - 1) } });
    expect(await accepted.service.previewSetup(TOKEN, NOW)).toBeNull();

    const orphan = harness({ invite: { businessId: null } });
    expect(await orphan.service.previewSetup(TOKEN, NOW)).toBeNull();
  });

  test('a tenant with no machine actor is refused, not crashed', async () => {
    const { service } = harness({ practices: [] });
    expect(await service.previewSetup(TOKEN, NOW)).toBeNull();
  });
});
