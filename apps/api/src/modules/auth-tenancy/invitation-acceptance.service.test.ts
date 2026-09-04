import { describe, expect, test } from 'vitest';

import { hashSetupToken } from '../clients-team-settings/index.js';
import type { PrismaClient } from '../../common/db/prisma.js';
import type { AppException } from '../../common/problem/problem.js';
import { InvitationAcceptanceService, MEMBER_JOINED_EVENT } from './invitation-acceptance.service.js';
import { verifyPasswordHash } from './password.js';
import { InMemorySignInThrottle } from './sign-in-throttle.js';

/**
 * Accepting a colleague's invitation.
 *
 * The rules under test are mostly rules about what does NOT happen: a refusal
 * that is indistinguishable from every other refusal, a race that produces one
 * account rather than two, and an acceptance that issues no session. So most
 * assertions here are about an ABSENCE, which is the only way to test a rule
 * whose whole point is that nothing visible follows from it.
 */

const TOKEN = 'invitation-token-abc';
const EMAIL = 'sam@ledgerline.test';
const NOW = Date.parse('2026-09-02T09:00:00.000Z');
const PASSWORD = 'a-long-enough-passphrase';

interface InviteRow {
  id: string;
  practiceId: string | null;
  businessId: string | null;
  email: string | null;
  role: string;
  businessIds: string[];
  hideFinancialFields: boolean;
  expiresAt: Date;
  acceptedAt: Date | null;
  invitedByUserId: string | null;
}

function harness(
  over: {
    invite?: Partial<InviteRow> | null;
    /** The practices the sweep can see. `[]` is a tenant with no machine actor. */
    practices?: readonly { practiceId: string; userId: string }[];
    /** Clients the practice context can see at acceptance time. */
    businesses?: readonly { id: string }[];
    existingUser?: boolean;
    /** Thrown by `user.create`, to drive the concurrent-signup race. */
    createThrows?: unknown;
  } = {},
) {
  const invite: InviteRow | null =
    over.invite === null
      ? null
      : {
          id: 'inv_1',
          practiceId: 'prac_1',
          businessId: null,
          email: EMAIL,
          role: 'PRACTICE_STANDARD',
          businessIds: [],
          hideFinancialFields: false,
          expiresAt: new Date(NOW + 86_400_000),
          acceptedAt: null,
          invitedByUserId: 'usr_admin',
          ...over.invite,
        };

  const writes: { model: string; data: unknown }[] = [];
  const raw: string[] = [];
  let stamped: Date | null = null;

  const db = {
    invite: {
      findUnique: async ({ where }: { where: { tokenHash: string } }) =>
        where.tokenHash === hashSetupToken(TOKEN) ? invite : null,
      updateMany: async ({ data }: { data: { acceptedAt: Date } }) => {
        if (invite === null || invite.acceptedAt !== null) return { count: 0 };
        stamped = data.acceptedAt;
        return { count: 1 };
      },
    },
    practice: { findUnique: async () => ({ name: 'Ledgerline' }) },
    business: {
      findMany: async ({ where }: { where?: { id?: { in?: string[] } } } = {}) => {
        const all = over.businesses ?? [{ id: 'biz_a' }, { id: 'biz_b' }];
        const wanted = where?.id?.in;
        return wanted === undefined ? all : all.filter((b) => wanted.includes(b.id));
      },
    },
    user: {
      findUnique: async ({ where }: { where: { id?: string; email?: string } }) => {
        if (where.email !== undefined) return over.existingUser === true ? { id: 'usr_existing' } : null;
        return { firstName: 'Priya', lastName: 'Shah' };
      },
      create: async ({ data }: { data: Record<string, unknown> }) => {
        if (over.createThrows !== undefined) throw over.createThrows;
        writes.push({ model: 'user', data });
        return { id: 'usr_new' };
      },
    },
    membership: {
      createMany: async ({ data }: { data: unknown }) => {
        writes.push({ model: 'membership', data });
        return { count: Array.isArray(data) ? data.length : 1 };
      },
      // The sweep reads this off the ROOT client; it is on the double once.
      findMany: async () => over.practices ?? [{ practiceId: 'prac_1', userId: 'usr_sys' }],
    },
    auditEvent: {
      findFirst: async () => null,
      create: async ({ data }: { data: unknown }) => {
        writes.push({ model: 'auditEvent', data });
        return data;
      },
    },
    // `scopedDb` sets the RLS context with a tagged template on the TRANSACTION
    // client; the advisory lock in the audit append uses the same call.
    $executeRaw: async () => 0,
    // The row lock. The double answers with the same invite the sweep found,
    // which is what a real `FOR UPDATE` on this practice's context returns.
    $queryRaw: async (...args: unknown[]) => {
      raw.push(String((args[0] as { raw?: string[] } | undefined)?.raw?.join('?') ?? ''));
      return invite === null ? [] : [{ accepted_at: invite.acceptedAt, expires_at: invite.expiresAt }];
    },
  };

  const prisma = { ...db, $transaction: async (fn: (c: unknown) => unknown) => fn(db) } as unknown as PrismaClient;
  const service = new InvitationAcceptanceService(prisma, new InMemorySignInThrottle());

  return {
    service,
    writes,
    raw,
    stampedAt: () => stamped,
    of: (model: string) => writes.filter((w) => w.model === model).map((w) => w.data),
  };
}

const refusal = async (run: () => Promise<unknown>): Promise<AppException> => {
  try {
    await run();
  } catch (error) {
    return error as AppException;
  }
  throw new Error('expected a refusal');
};

const accept = () => ({ token: TOKEN, password: PASSWORD, firstName: 'Sam', lastName: 'Patel' });

// ---- preview -----------------------------------------------------------------

describe('preview', () => {
  test('names the practice, the address, the role and who sent it — all of it already in the email', async () => {
    const h = harness();
    expect(await h.service.preview(TOKEN, NOW)).toEqual({
      practiceName: 'Ledgerline',
      email: EMAIL,
      role: 'PRACTICE_STANDARD',
      expiresAt: new Date(NOW + 86_400_000).toISOString(),
      invitedByName: 'Priya Shah',
    });
  });

  test('an inviter who has since gone leaves the line out rather than inventing a name', async () => {
    const h = harness({ invite: { invitedByUserId: null } });
    expect((await h.service.preview(TOKEN, NOW)).invitedByName).toBeNull();
  });

  test('⚠ every refusal but expiry is the SAME NT-AUTH-004, byte for byte', async () => {
    const cases: Record<string, Parameters<typeof harness>[0]> = {
      'unknown token': { invite: null },
      'already accepted': { invite: { acceptedAt: new Date(NOW - 1000) } },
      'a CLIENT invite, not a colleague one': { invite: { businessId: 'biz_a' } },
      'an invite with no practice': { invite: { practiceId: null } },
      'no practice has a machine actor': { practices: [] },
    };

    const answers = new Set<string>();
    for (const [, options] of Object.entries(cases)) {
      const h = harness(options);
      const refused = await refusal(() => h.service.preview(TOKEN, NOW));
      expect(refused.code).toBe('NT-AUTH-004');
      expect(refused.getStatus()).toBe(401);
      answers.add(`${refused.code}|${refused.publicDetail ?? ''}`);
    }
    // One answer for five different facts: a guesser learns nothing from which
    // one they hit.
    expect(answers.size).toBe(1);
  });

  test('expiry is the ONE distinguishable refusal, because "ask for another" is the only action left', async () => {
    const h = harness({ invite: { expiresAt: new Date(NOW - 1) } });
    const refused = await refusal(() => h.service.preview(TOKEN, NOW));
    expect(refused.code).toBe('NT-AUTH-005');
    expect(refused.publicDetail).toContain('expired');
  });

  test('the preview writes nothing — the invitation is still outstanding afterwards', async () => {
    const h = harness();
    await h.service.preview(TOKEN, NOW);
    expect(h.writes).toEqual([]);
    expect(h.stampedAt()).toBeNull();
  });
});

// ---- acceptance --------------------------------------------------------------

describe('acceptance', () => {
  test('creates the user ALREADY VERIFIED, hashes the password, and issues NO session', async () => {
    const h = harness();
    const result = await h.service.accept(accept(), NOW);

    // The body carries the address and nothing else. No token, no cookie, no id.
    expect(result).toEqual({ email: EMAIL });

    const user = h.of('user')[0] as Record<string, unknown>;
    expect(user).toMatchObject({ kind: 'HUMAN', email: EMAIL, emailVerified: true, firstName: 'Sam', lastName: 'Patel' });
    // The password is stored as a hash and the plaintext appears nowhere.
    expect(verifyPasswordHash(PASSWORD, String(user['passwordHash']))).toBe(true);
    // `audit_events.seq` is a BigInt, which JSON.stringify refuses — the
    // replacer is about the serialiser, not about the assertion.
    expect(JSON.stringify(h.writes, (_k, v) => (typeof v === 'bigint' ? v.toString() : v))).not.toContain(PASSWORD);
  });

  test('an unscoped colleague gets ONE practice-wide membership, never an owner flag', async () => {
    const h = harness();
    await h.service.accept(accept(), NOW);
    expect(h.of('membership')[0]).toEqual([
      { userId: 'usr_new', practiceId: 'prac_1', role: 'PRACTICE_STANDARD', isOwner: false, hideFinancialFields: false },
    ]);
  });

  test('⚠ a scoped colleague gets ONE membership PER CLIENT with a NULL practiceId — that null is the whole mechanism', async () => {
    const h = harness({ invite: { businessIds: ['biz_a', 'biz_b'], hideFinancialFields: true } });
    await h.service.accept(accept(), NOW);
    // A practice_id on these rows would satisfy `app_can_access_business`'s
    // practice branch for EVERY client of the firm — the exact access the scope
    // exists to withhold.
    expect(h.of('membership')[0]).toEqual([
      { userId: 'usr_new', practiceId: null, businessId: 'biz_a', role: 'PRACTICE_STANDARD', isOwner: false, hideFinancialFields: true },
      { userId: 'usr_new', practiceId: null, businessId: 'biz_b', role: 'PRACTICE_STANDARD', isOwner: false, hideFinancialFields: true },
    ]);
  });

  test('a client offboarded since the invitation is dropped; if they ALL are, the acceptance is refused', async () => {
    const partly = harness({ invite: { businessIds: ['biz_a', 'biz_gone'] }, businesses: [{ id: 'biz_a' }] });
    await partly.service.accept(accept(), NOW);
    expect(partly.of('membership')[0]).toHaveLength(1);

    // Granting practice-wide instead would widen a decision nobody took, and
    // granting nothing would create an account that 401s on every request.
    const none = harness({ invite: { businessIds: ['biz_gone'] }, businesses: [] });
    expect((await refusal(() => none.service.accept(accept(), NOW))).code).toBe('NT-AUTH-004');
  });

  test('the invitation is consumed under a row lock, and an audit row records the join', async () => {
    const h = harness();
    await h.service.accept(accept(), NOW);
    expect(h.raw.join(' ')).toContain('FOR UPDATE');
    expect(h.stampedAt()?.toISOString()).toBe(new Date(NOW).toISOString());

    const audit = h.of('auditEvent')[0] as Record<string, unknown>;
    expect(audit).toMatchObject({ event: MEMBER_JOINED_EVENT, businessId: null, proposalId: null });
    // The address is hashed into `payload_hash`, never written into a column an
    // erasure request could not reach.
    expect(JSON.stringify(audit['outcome'])).not.toContain(EMAIL);
  });

  test('an already-accepted invitation cannot be spent twice, and nothing is written the second time', async () => {
    const h = harness({ invite: { acceptedAt: new Date(NOW - 1000) } });
    expect((await refusal(() => h.service.accept(accept(), NOW))).code).toBe('NT-AUTH-004');
    expect(h.writes).toEqual([]);
  });

  test('an address that already has an account is the SAME NT-AUTH-004 — no enumeration oracle', async () => {
    const h = harness({ existingUser: true });
    const refused = await refusal(() => h.service.accept(accept(), NOW));
    expect(refused.code).toBe('NT-AUTH-004');
    expect(refused.publicDetail).toContain('not valid');
    expect(h.of('membership')).toEqual([]);
  });

  test('the DUPLICATE-EMAIL RACE: a P2002 between the check and the insert is the same refusal', async () => {
    // A concurrent signup won the race the `findUnique` above cannot close.
    const h = harness({ createThrows: { code: 'P2002', meta: { target: ['email'] } } });
    const refused = await refusal(() => h.service.accept(accept(), NOW));
    expect(refused.code).toBe('NT-AUTH-004');
    expect(h.of('membership')).toEqual([]);
  });

  test('a P2002 on ANY OTHER index is a real bug and is NOT swallowed as "that address is taken"', async () => {
    const h = harness({ createThrows: { code: 'P2002', meta: { target: ['id'] } } });
    const thrown = await refusal(() => h.service.accept(accept(), NOW));
    // It surfaces as itself, not as an invitation refusal.
    expect((thrown as unknown as { code: string }).code).toBe('P2002');
  });

  test('an expired invitation refuses NT-AUTH-005 and writes nothing', async () => {
    const h = harness({ invite: { expiresAt: new Date(NOW - 1) } });
    expect((await refusal(() => h.service.accept(accept(), NOW))).code).toBe('NT-AUTH-005');
    expect(h.writes).toEqual([]);
  });
});
