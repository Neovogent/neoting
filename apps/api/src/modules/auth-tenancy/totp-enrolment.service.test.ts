import { expect, test } from 'vitest';

import type { PrismaClient } from '../../common/db/prisma.js';
import type { AppException } from '../../common/problem/problem.js';
import type { Env } from '../../config/env.js';
import { TotpEnrolmentService } from './totp-enrolment.service.js';
import { unwrapTotpMaterial } from './totp-secret.js';
import { totpEngine } from './totp.js';

const SECRET = 'test-session-secret';
const env = { SESSION_SECRET: SECRET, OTP_MODE: 'totp', NODE_ENV: 'test' } as Env;
const NOW = 1_756_000_000_000;

interface UserRow {
  id: string;
  email: string | null;
  kind: string;
  totpSecretRef: string | null;
  totpEnabledAt: Date | null;
}

function prismaWith(user: UserRow | null): { client: PrismaClient; row: UserRow | null } {
  const state = user;
  const client = {
    user: {
      findUnique: async () => state,
      update: async ({ data }: { data: Partial<UserRow> }) => {
        if (state === null) throw new Error('no such user');
        Object.assign(state, data);
        return state;
      },
    },
  } as unknown as PrismaClient;
  return { client, row: state };
}

function human(overrides: Partial<UserRow> = {}): UserRow {
  return { id: 'usr_priya', email: 'priya@ledgerline.test', kind: 'HUMAN', totpSecretRef: null, totpEnabledAt: null, ...overrides };
}

async function grab(fn: () => Promise<unknown>): Promise<AppException> {
  try {
    await fn();
  } catch (error) {
    return error as AppException;
  }
  throw new Error('expected a throw');
}

test('begin stores a wrapped enrolment and leaves it UNCONFIRMED', async () => {
  const { client, row } = prismaWith(human());
  const offer = await new TotpEnrolmentService(client, env).begin('usr_priya');

  expect(offer.uri.startsWith('otpauth://totp/')).toBe(true);
  expect(offer.recoveryCodes.length).toBeGreaterThan(0);
  expect(row?.totpSecretRef).not.toBeNull();
  // ⚠ Unconfirmed until a code proves the QR reached an app. Enrolling in one
  // step locks an accountant who mis-scans out of their own workspace.
  expect(row?.totpEnabledAt).toBeNull();
  // The seed and the codes are in the offer once, and in the column never.
  expect(row?.totpSecretRef).not.toContain(offer.secret);
});

test('REFUSAL: a SYSTEM actor and a user with no login address cannot enrol', async () => {
  for (const user of [human({ kind: 'SYSTEM' }), human({ email: null }), null]) {
    const { client } = prismaWith(user);
    const error = await grab(() => new TotpEnrolmentService(client, env).begin('usr_priya'));
    expect(error.code).toBe('NT-AUTH-003');
  }
});

test('confirm requires a code from THAT candidate, and only then switches the factor on', async () => {
  const { client, row } = prismaWith(human());
  const service = new TotpEnrolmentService(client, env);
  const offer = await service.begin('usr_priya');

  const wrong = await grab(() => service.confirm('usr_priya', '000000', NOW));
  expect(wrong.code).toBe('NT-AUTH-003');
  expect(row?.totpEnabledAt).toBeNull();

  const code = await totpEngine.generate({ secret: offer.secret, epoch: Math.floor(NOW / 1000) });
  await service.confirm('usr_priya', code, NOW);
  expect(row?.totpEnabledAt).toEqual(new Date(NOW));
});

test('REFUSAL: a RECOVERY code cannot confirm an enrolment — it proves nothing about the app', async () => {
  const { client, row } = prismaWith(human());
  const service = new TotpEnrolmentService(client, env);
  const offer = await service.begin('usr_priya');

  // It would verify perfectly well as a second factor, which is exactly why the
  // verdict is narrowed rather than trusted: confirming on a recovery code
  // leaves the user with a factor their authenticator never received.
  const error = await grab(() => service.confirm('usr_priya', offer.recoveryCodes[0]!, NOW));
  expect(error.code).toBe('NT-AUTH-003');
  expect(row?.totpEnabledAt).toBeNull();
});

test('re-enrolling replaces the previous secret rather than holding two live at once', async () => {
  const { client, row } = prismaWith(human());
  const service = new TotpEnrolmentService(client, env);
  const first = await service.begin('usr_priya');
  const firstRef = row?.totpSecretRef;
  await service.confirm('usr_priya', await totpEngine.generate({ secret: first.secret, epoch: Math.floor(NOW / 1000) }), NOW);

  const second = await service.begin('usr_priya');
  expect(row?.totpSecretRef).not.toBe(firstRef);
  // And the confirmation is withdrawn until the new one is proved.
  expect(row?.totpEnabledAt).toBeNull();
  expect(unwrapTotpMaterial(row?.totpSecretRef ?? null, SECRET)?.secret).toBe(second.secret);
});

test('recoveryCodesLeft reports what is actually in the envelope', async () => {
  const { client } = prismaWith(human());
  const service = new TotpEnrolmentService(client, env);
  const offer = await service.begin('usr_priya');
  expect(await service.recoveryCodesLeft('usr_priya')).toBe(offer.recoveryCodes.length);
});
