import { describe, expect, test } from 'vitest';

import type { PrismaClient } from '../../../common/db/prisma.js';
import type { ScopedClient } from '../../../common/db/scoped-db.js';
import { AppException } from '../../../common/problem/problem.js';
import { CHART_OF_ACCOUNTS_LIST_KIND, ChartOfAccountsService } from './chart-of-accounts.service.js';

/**
 * The storage half: seed once, never overwrite, and stay readable by the module
 * that already queries this table.
 */

const CLEANING_AGENCY = {
  businessActivity: 'Commercial cleaning for offices and schools',
  typicalSuppliers: ['Nisbets'],
  typicalCosts: ['Cleaning materials'],
};

interface Recorded {
  readonly integrationId: string;
  readonly listKind: string;
  readonly payload: unknown;
}

interface Fake {
  readonly db: ScopedClient;
  readonly created: Recorded[];
}

function fake(options: {
  business?: { id: string; contextQuestionnaire: unknown } | null;
  integration?: { id: string } | null;
  stored?: { payload: unknown } | null;
  createThrows?: unknown;
}): Fake {
  const created: Recorded[] = [];
  let stored = options.stored ?? null;

  const db = {
    business: {
      findUnique: async () =>
        options.business === undefined ? { id: 'biz_1', contextQuestionnaire: null } : options.business,
    },
    integration: { findFirst: async () => (options.integration === undefined ? { id: 'int_1' } : options.integration) },
    referenceSync: {
      findUnique: async () => stored,
      create: async (args: { data: Recorded }) => {
        if (options.createThrows !== undefined) throw options.createThrows;
        created.push(args.data);
        stored = { payload: args.data.payload };
        return args.data;
      },
    },
  } as unknown as ScopedClient;

  return { db, created };
}

function service(): ChartOfAccountsService {
  return new ChartOfAccountsService(undefined as unknown as PrismaClient);
}

describe('seeding', () => {
  test('writes the chart under the list_kind chat-framework already queries', async () => {
    const { db, created } = fake({ business: { id: 'biz_1', contextQuestionnaire: CLEANING_AGENCY } });
    const chart = await service().resolve(db, 'biz_1');

    expect(chart.source).toBe('SEEDED');
    expect(created).toHaveLength(1);
    expect(created[0]?.listKind).toBe(CHART_OF_ACCOUNTS_LIST_KIND);
    expect(CHART_OF_ACCOUNTS_LIST_KIND).toBe('chart_of_accounts');
  });

  /**
   * ⚠ `chat-framework/grounding.ts` parses this payload with
   * `{ categories: { code, name }[] }`. If the written shape drifted, the
   * accountant would silently keep getting *"this client has no synced chart of
   * accounts yet"* and no rule could ever be drafted.
   */
  test('the payload is readable by the shape chat-framework parses', async () => {
    const { db, created } = fake({ business: { id: 'biz_1', contextQuestionnaire: CLEANING_AGENCY } });
    await service().resolve(db, 'biz_1');

    const payload = created[0]?.payload as { categories: { code: string; name: string }[] };
    expect(Array.isArray(payload.categories)).toBe(true);
    expect(payload.categories.length).toBeGreaterThan(20);
    for (const category of payload.categories) {
      expect(typeof category.code).toBe('string');
      // Ledger-prefixed — the same string A7 puts in `Analysis account`.
      expect(category.name).toMatch(/^[^:]+: [^:]+$/);
    }
    expect(payload.categories.map((c) => c.name)).toContain('Cost of sales: Materials and consumables');
  });

  test('a second read returns the stored chart and writes nothing', async () => {
    const { db, created } = fake({ business: { id: 'biz_1', contextQuestionnaire: CLEANING_AGENCY } });
    const first = await service().resolve(db, 'biz_1');
    const second = await service().resolve(db, 'biz_1');

    expect(first.source).toBe('SEEDED');
    expect(second.source).toBe('STORED');
    expect(created).toHaveLength(1);
    expect(second.accounts.map((a) => a.code)).toEqual(first.accounts.map((a) => a.code));
    expect(second.caveat).toBe(first.caveat);
  });

  /**
   * §24.4.1: the chart is *owned and edited by the accountant thereafter*. A
   * re-seed that clobbered their edits would be this module overriding a human,
   * which A6's brief calls absolute.
   */
  test('never overwrites a chart that is already there, even a different one', async () => {
    const theirs = {
      categories: [{ code: 'THEIR_CODE', name: 'Expenses: Their account' }],
      neoting: {
        version: 1,
        profileId: 'GENERAL_BUSINESS',
        basis: 'PROFILE_MATCHED',
        accounts: [
          {
            code: 'THEIR_CODE',
            ledger: 'Expenses',
            name: 'Their account',
            vatTreatment: 'STANDARD',
            taxConsequence: 'ALLOWABLE',
            keywords: [],
          },
        ],
        unmatchedCosts: [],
        knownSuppliers: [],
        caveat: 'Edited by the practice.',
      },
    };
    const { db, created } = fake({ business: { id: 'biz_1', contextQuestionnaire: CLEANING_AGENCY }, stored: { payload: theirs } });
    const chart = await service().resolve(db, 'biz_1');

    expect(created).toHaveLength(0);
    expect(chart.source).toBe('STORED');
    expect(chart.accounts.map((a) => a.code)).toEqual(['THEIR_CODE']);
  });

  test('a stored chart this release cannot read is served derived, and still not overwritten', async () => {
    const { db, created } = fake({
      business: { id: 'biz_1', contextQuestionnaire: CLEANING_AGENCY },
      stored: { payload: { somethingElse: true } },
    });
    const chart = await service().resolve(db, 'biz_1');

    expect(created).toHaveLength(0);
    expect(chart.source).toBe('UNSTORED');
    expect(chart.profileId).toBe('SERVICES_WITH_STAFF');
  });

  /**
   * A11's intake creates exactly one VT integration per client, so this is the
   * pre-A11 client and the seeded demo data. The chart still works — it is just
   * not visible to anything reading `reference_syncs` directly.
   */
  test('a client with no integration gets a working chart that is honestly marked unstored', async () => {
    const { db, created } = fake({ business: { id: 'biz_1', contextQuestionnaire: CLEANING_AGENCY }, integration: null });
    const chart = await service().resolve(db, 'biz_1');

    expect(created).toHaveLength(0);
    expect(chart.source).toBe('UNSTORED');
    expect(chart.accounts.length).toBeGreaterThan(20);
  });

  test('a concurrent seed loses the race and reads the winner’s row rather than failing', async () => {
    const winner = {
      categories: [{ code: 'COS_PURCHASES', name: 'Cost of sales: Purchases' }],
      neoting: {
        version: 1,
        profileId: 'GENERAL_BUSINESS',
        basis: 'NO_PROFILE',
        accounts: [],
        unmatchedCosts: [],
        knownSuppliers: [],
        caveat: 'Seeded by the other request.',
      },
    };
    let reads = 0;
    const db = {
      business: { findUnique: async () => ({ id: 'biz_1', contextQuestionnaire: CLEANING_AGENCY }) },
      integration: { findFirst: async () => ({ id: 'int_1' }) },
      referenceSync: {
        // Absent on the first look, present by the time the create fails.
        findUnique: async () => (reads++ === 0 ? null : { payload: winner }),
        create: async () => {
          throw { code: 'P2002' };
        },
      },
    } as unknown as ScopedClient;

    const chart = await service().resolve(db, 'biz_1');
    expect(chart.source).toBe('STORED');
    expect(chart.caveat).toBe('Seeded by the other request.');
  });

  test('any other database error is not swallowed', async () => {
    const { db } = fake({
      business: { id: 'biz_1', contextQuestionnaire: CLEANING_AGENCY },
      createThrows: new Error('connection reset'),
    });
    await expect(service().resolve(db, 'biz_1')).rejects.toThrow('connection reset');
  });
});

describe('tenancy', () => {
  /**
   * **404, never 403.** RLS makes another practice's client invisible, so
   * `findUnique` returns null and there is no ownership check that could
   * confirm it exists. The detail never echoes the id back.
   */
  test('a client the caller cannot see is a 404 that confirms nothing', async () => {
    const { db } = fake({ business: null });

    const error = await service()
      .resolve(db, 'biz_someone_elses')
      .then(() => null)
      .catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(AppException);
    const problem = error as AppException;
    expect(problem.getStatus()).toBe(404);
    expect(problem.code).toBe('NT-VAL-001');
    // The detail never echoes the id back — a 404 that names what it is hiding
    // is a 403 wearing a different number.
    expect(problem.publicDetail).not.toContain('biz_someone_elses');
  });
});
