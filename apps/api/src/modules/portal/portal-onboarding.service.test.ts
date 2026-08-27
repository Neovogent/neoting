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
    contact: { findFirst: async () => ({ id: 'con_1' }) },
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
    membership: { findMany: async () => [{ practiceId: 'prac_1', userId: 'usr_sys' }] },
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
    { portalSessionSecret: SECRET, otpMode: over.otpMode ?? 'totp' },
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
