import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';

import { PrismaWhatsAppPracticeResolver } from './whatsapp-practice-resolver.js';

/**
 * `Practice.whatsappPhoneNumberId` → practice, against real Postgres RLS
 * (Phase 2, 1 Sep 2026). What only a real database can answer:
 *
 *  - the sweep reads each practice's OWN row under its own SYSTEM context and
 *    the right practice answers;
 *  - a number nobody claims resolves to nothing;
 *  - a practice with no SYSTEM actor simply cannot answer (the sweep has no
 *    context to ask under) rather than erroring the lookup for everyone else.
 *
 * Namespace `p2wa_`, torn down by explicit id list.
 */
const DATABASE_URL = process.env['DATABASE_URL'];
const OWNER_URL = process.env['DIRECT_URL'];
const enabled = DATABASE_URL !== undefined && OWNER_URL !== undefined;

const P1 = 'p2wa_prac_mapped';
const P2 = 'p2wa_prac_other';
const P3 = 'p2wa_prac_no_actor';
const U1 = 'p2wa_sys_1';
const U2 = 'p2wa_sys_2';
const M1 = 'p2wa_mem_1';
const M2 = 'p2wa_mem_2';
const NUMBER = 'p2wa-phone-number-id-001';
const ORPHAN_NUMBER = 'p2wa-phone-number-id-orphan';

let owner: PrismaClient;
let app: PrismaClient;

async function cleanup(): Promise<void> {
  await owner.membership.deleteMany({ where: { id: { in: [M1, M2] } } });
  await owner.user.deleteMany({ where: { id: { in: [U1, U2] } } });
  await owner.practice.deleteMany({ where: { id: { in: [P1, P2, P3] } } });
}

beforeAll(async () => {
  if (!enabled) return;
  owner = new PrismaClient({ datasources: { db: { url: OWNER_URL } } });
  app = new PrismaClient({ datasources: { db: { url: DATABASE_URL } } });
  await owner.$queryRaw`SELECT 1`;

  await cleanup();
  await owner.practice.create({ data: { id: P1, name: 'Mapped', whatsappPhoneNumberId: NUMBER } });
  await owner.practice.create({ data: { id: P2, name: 'Other' } });
  // P3 claims a number but has NO SYSTEM actor — unanswerable, and that must
  // cost nothing but its own silence.
  await owner.practice.create({ data: { id: P3, name: 'NoActor', whatsappPhoneNumberId: ORPHAN_NUMBER } });
  await owner.user.create({ data: { id: U1, kind: 'SYSTEM' } });
  await owner.user.create({ data: { id: U2, kind: 'SYSTEM' } });
  await owner.membership.create({ data: { id: M1, userId: U1, practiceId: P1, role: 'PRACTICE_STANDARD' } });
  await owner.membership.create({ data: { id: M2, userId: U2, practiceId: P2, role: 'PRACTICE_STANDARD' } });
});

afterAll(async () => {
  if (owner !== undefined) await cleanup();
  await owner?.$disconnect();
  await app?.$disconnect();
});

describe.skipIf(!enabled)('PrismaWhatsAppPracticeResolver against real RLS', () => {
  test('the practice that claims the receiving number answers; others do not', async () => {
    const resolver = new PrismaWhatsAppPracticeResolver(app);
    expect(await resolver.byPhoneNumberId(NUMBER)).toBe(P1);
  });

  test('a number nobody claims resolves to nothing', async () => {
    const resolver = new PrismaWhatsAppPracticeResolver(app);
    expect(await resolver.byPhoneNumberId('p2wa-number-nobody-set')).toBeNull();
  });

  test('a claiming practice with no SYSTEM actor is silent, not an error', async () => {
    const resolver = new PrismaWhatsAppPracticeResolver(app);
    expect(await resolver.byPhoneNumberId(ORPHAN_NUMBER)).toBeNull();
  });
});
