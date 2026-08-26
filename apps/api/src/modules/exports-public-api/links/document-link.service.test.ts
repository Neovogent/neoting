import { HttpStatus } from '@nestjs/common';
import { describe, expect, test } from 'vitest';

import type { PrismaClient } from '../../../common/db/prisma.js';
import type { ScopeContext } from '../../../common/db/scope-context.js';
import { AppException } from '../../../common/problem/problem.js';

import { DEFAULT_DOCUMENT_LINK_TTL_DAYS, DocumentLinkService, MAX_LINKS_PER_CALL } from './document-link.service.js';

const NOW = new Date('2026-08-26T09:00:00.000Z');
const CTX: ScopeContext = { actorId: 'usr_1', practiceId: 'prac_1', sessionScope: 'user', grantedItemIds: [] };
const DAY_MS = 86_400_000;

interface LinkRow {
  documentId: string;
  code: string;
  createdAt: Date;
}

interface DocRow {
  id: string;
  businessId: string | null;
  business: { practice: { documentLinkTtlDays: number | null } | null } | null;
}

function harness(options: { links?: LinkRow[]; documents?: DocRow[]; failFirstInserts?: number } = {}) {
  const created: { documentId: string; businessId: string; code: string; expiresAt: Date; createdByUserId: string }[] = [];
  const findManyArgs: unknown[] = [];
  let remainingFailures = options.failFirstInserts ?? 0;

  const tx = {
    $executeRaw: async () => 0,
    documentLink: {
      findMany: async (args: { where: unknown }) => {
        findManyArgs.push(args.where);
        return options.links ?? [];
      },
      create: async (args: { data: { documentId: string; businessId: string; code: string; expiresAt: Date; createdByUserId: string } }) => {
        if (remainingFailures > 0) {
          remainingFailures -= 1;
          throw Object.assign(new Error('Unique constraint failed'), { code: 'P2002' });
        }
        created.push(args.data);
        return args.data;
      },
    },
    document: {
      findMany: async () => options.documents ?? [],
    },
  };

  const prisma = { $transaction: async (fn: (t: unknown) => Promise<unknown>) => fn(tx) } as unknown as PrismaClient;

  return {
    created,
    findManyArgs,
    service: new DocumentLinkService(prisma, { origin: 'https://neoacc.neovogent.com', now: () => NOW }),
  };
}

function doc(id: string, ttlDays: number | null = null, businessId: string | null = 'biz_1'): DocRow {
  return { id, businessId, business: businessId === null ? null : { practice: { documentLinkTtlDays: ttlDays } } };
}

describe('⚠ byte-stability — the same document re-exported carries the SAME code', () => {
  test('a live link is reused, and nothing is minted', async () => {
    const { created, service } = harness({ links: [{ documentId: 'doc_1', code: 'A7K2M9PQ', createdAt: NOW }] });
    const links = await service.linksFor(CTX, ['doc_1']);

    expect(links.get('doc_1')).toEqual({ code: 'A7K2M9PQ', url: 'https://neoacc.neovogent.com/d/A7K2M9PQ' });
    // The accountant's saved VT conversion table depends on this: a second code
    // for the same document turns every future import back into manual work.
    expect(created).toEqual([]);
  });

  test('the live-link query excludes revoked and expired links', async () => {
    const { findManyArgs, service } = harness({ documents: [doc('doc_1')] });
    await service.linksFor(CTX, ['doc_1']);

    expect(findManyArgs[0]).toEqual({
      documentId: { in: ['doc_1'] },
      revokedAt: null,
      OR: [{ expiresAt: null }, { expiresAt: { gt: NOW } }],
    });
  });

  test('a document whose only link was revoked gets a NEW code, not the old one back', async () => {
    // The query above returns nothing for it, so it falls through to minting.
    const { created, service } = harness({ links: [], documents: [doc('doc_1')] });
    const links = await service.linksFor(CTX, ['doc_1']);

    expect(created).toHaveLength(1);
    expect(links.get('doc_1')?.code).toBe(created[0]?.code);
  });

  test('the newest live link wins when a document somehow has two', async () => {
    const { service } = harness({
      links: [
        { documentId: 'doc_1', code: 'NEWCADE1', createdAt: new Date('2026-08-26T00:00:00Z') },
        { documentId: 'doc_1', code: 'PREVCAD1', createdAt: new Date('2026-01-01T00:00:00Z') },
      ],
    });
    expect((await service.linksFor(CTX, ['doc_1']))?.get('doc_1')?.code).toBe('NEWCADE1');
  });

  test('a stored code that could never have been minted is a LOUD failure, not a broken link in a customer’s file', async () => {
    // `O` is not in the alphabet. A row like this is corrupt data, and building
    // a URL from it would put a link that resolves to nothing inside a ledger.
    const { service } = harness({ links: [{ documentId: 'doc_1', code: 'OLDCODE1', createdAt: NOW }] });
    await expect(service.linksFor(CTX, ['doc_1'])).rejects.toThrow(/not a capability code/);
  });
});

describe('minting', () => {
  test('the business anchor is read from the DOCUMENT row, never from the caller', async () => {
    const { created, service } = harness({ documents: [doc('doc_1')] });
    await service.linksFor(CTX, ['doc_1']);
    expect(created[0]).toMatchObject({ documentId: 'doc_1', businessId: 'biz_1', createdByUserId: 'usr_1' });
  });

  test('a document the caller cannot see is simply ABSENT — not an error, not a link', async () => {
    // RLS returns no row, so `document.findMany` yields nothing for it. The
    // emitter then raises A7's `source-link-missing` warning for that row,
    // which is the honest outcome.
    const { created, service } = harness({ documents: [] });
    const links = await service.linksFor(CTX, ['doc_invisible']);
    expect(links.size).toBe(0);
    expect(created).toEqual([]);
  });

  test('an UNROUTED document gets no link — it has no business to anchor one to', async () => {
    const { created, service } = harness({ documents: [doc('doc_1', null, null)] });
    expect((await service.linksFor(CTX, ['doc_1'])).size).toBe(0);
    expect(created).toEqual([]);
  });

  test('a code collision is retried with a fresh code, not surfaced', async () => {
    const { created, service } = harness({ documents: [doc('doc_1')], failFirstInserts: 2 });
    const links = await service.linksFor(CTX, ['doc_1']);
    expect(links.get('doc_1')?.code).toBeDefined();
    expect(created).toHaveLength(1);
  });

  test('an entropy source that keeps colliding throws rather than looping', async () => {
    const { service } = harness({ documents: [doc('doc_1')], failFirstInserts: 99 });
    await expect(service.linksFor(CTX, ['doc_1'])).rejects.toThrow(/entropy source is repeating itself/);
  });

  test('duplicate ids in one request produce one link', async () => {
    const { created, service } = harness({ documents: [doc('doc_1')] });
    await service.linksFor(CTX, ['doc_1', 'doc_1', 'doc_1']);
    expect(created).toHaveLength(1);
  });
});

describe('expiry — D43 makes it configurable per practice', () => {
  test('a practice that has not chosen one gets the platform default', async () => {
    const { created, service } = harness({ documents: [doc('doc_1', null)] });
    await service.linksFor(CTX, ['doc_1']);
    expect(created[0]?.expiresAt).toEqual(new Date(NOW.getTime() + DEFAULT_DOCUMENT_LINK_TTL_DAYS * DAY_MS));
  });

  test('a practice setting is honoured', async () => {
    const { created, service } = harness({ documents: [doc('doc_1', 30)] });
    await service.linksFor(CTX, ['doc_1']);
    expect(created[0]?.expiresAt).toEqual(new Date(NOW.getTime() + 30 * DAY_MS));
  });

  test('a non-positive setting falls back rather than minting a link that is already dead', async () => {
    for (const ttl of [0, -1]) {
      const { created, service } = harness({ documents: [doc('doc_1', ttl)] });
      await service.linksFor(CTX, ['doc_1']);
      expect(created[0]?.expiresAt).toEqual(new Date(NOW.getTime() + DEFAULT_DOCUMENT_LINK_TTL_DAYS * DAY_MS));
    }
  });

  test('every minted link HAS an expiry — a link with none outlives the engagement', async () => {
    const { created, service } = harness({ documents: [doc('doc_1'), doc('doc_2')] });
    await service.linksFor(CTX, ['doc_1', 'doc_2']);
    for (const row of created) expect(row.expiresAt.getTime()).toBeGreaterThan(NOW.getTime());
  });
});

describe('bounds', () => {
  test('an empty request touches the database not at all', async () => {
    const { findManyArgs, service } = harness();
    expect((await service.linksFor(CTX, [])).size).toBe(0);
    expect(findManyArgs).toEqual([]);
  });

  test(`more than ${MAX_LINKS_PER_CALL} documents is refused with the contract's own export code`, async () => {
    const { service } = harness();
    const ids = Array.from({ length: MAX_LINKS_PER_CALL + 1 }, (_, i) => `doc_${i}`);
    try {
      await service.linksFor(CTX, ids);
      throw new Error('expected a refusal');
    } catch (error) {
      expect(error).toBeInstanceOf(AppException);
      expect((error as AppException).code).toBe('NT-EXP-003');
      expect((error as AppException).getStatus()).toBe(HttpStatus.UNPROCESSABLE_ENTITY);
    }
  });

  test('a malformed origin fails at CONSTRUCTION, not after it is baked into a customer’s ledger file', () => {
    const prisma = {} as unknown as PrismaClient;
    expect(() => new DocumentLinkService(prisma, { origin: 'http://neoacc.neovogent.com' })).toThrow(/must be https/);
    expect(() => new DocumentLinkService(prisma, { origin: 'https://x.test/app' })).toThrow(/bare origin/);
  });
});

test('linkFor is the single-document convenience and returns null for an unreachable one', async () => {
  const { service } = harness({ documents: [] });
  expect(await service.linkFor(CTX, 'doc_missing')).toBeNull();
});
