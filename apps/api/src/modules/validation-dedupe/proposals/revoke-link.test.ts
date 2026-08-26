import { describe, expect, test } from 'vitest';

import type { ScopeContext } from '../../../common/db/scope-context.js';
import type { ScopedClient } from '../../../common/db/scoped-db.js';

import { ProposalExecutionRefused } from './proposal-executor.js';
import { revokeLinkExecutor } from './revoke-link.js';

const CTX: ScopeContext = { actorId: 'usr_1', practiceId: 'prac_1', sessionScope: 'user', grantedItemIds: [] };

interface LinkRow {
  id: string;
  documentId: string;
  code: string;
  revokedAt: Date | null;
}

function harness(links: LinkRow[]) {
  const updates: { where: unknown; data: unknown }[] = [];
  const events: { documentId: string; stage: string; outcome: string; detail: Record<string, unknown> }[] = [];

  const db = {
    documentLink: {
      findMany: async (args: { where: { id: { in: string[] } } }) =>
        links.filter((link) => args.where.id.in.includes(link.id)),
      updateMany: async (args: { where: unknown; data: unknown }) => {
        updates.push(args);
        return { count: 0 };
      },
    },
    documentEvent: {
      createMany: async (args: { data: typeof events }) => {
        events.push(...args.data);
        return { count: args.data.length };
      },
    },
  } as unknown as ScopedClient;

  return { db, updates, events };
}

function run(db: ScopedClient, payload: { documentLinkIds: string[]; reason?: string | null }) {
  return revokeLinkExecutor.execute(db, {
    proposalId: 'prp_1',
    payload: payload as never,
    ctx: CTX,
    traceId: 'trace-1',
  });
}

describe('revocation is the effect of an approved proposal, and nothing else', () => {
  test('it is registered under the contract’s own kind', () => {
    expect(revokeLinkExecutor.kind).toBe('document.revoke-link');
  });

  test('the pending links are revoked, guarded on still being unrevoked', async () => {
    const { db, updates } = harness([
      { id: 'dl_1', documentId: 'doc_1', code: 'A7K2M9PQ', revokedAt: null },
      { id: 'dl_2', documentId: 'doc_2', code: 'B8N3P0QR', revokedAt: null },
    ]);
    const result = await run(db, { documentLinkIds: ['dl_1', 'dl_2'] });

    expect(updates).toHaveLength(1);
    expect(updates[0]?.where).toMatchObject({ id: { in: ['dl_1', 'dl_2'] }, revokedAt: null });
    expect(result.alreadyApplied).toBe(false);
    expect(result.detail).toMatchObject({ linksRequested: 2, linksRevoked: 2, linksAlreadyRevoked: 0 });
  });

  test('⚠ NOTHING is minted — a revoked document has no live link until the next export', async () => {
    // `create` is deliberately absent from the fake: if this executor ever
    // minted a replacement, the test would throw rather than pass.
    const { db } = harness([{ id: 'dl_1', documentId: 'doc_1', code: 'A7K2M9PQ', revokedAt: null }]);
    await expect(run(db, { documentLinkIds: ['dl_1'] })).resolves.toBeDefined();
  });

  test('the document’s own log records the revocation, with the dead code on it', async () => {
    const { db, events } = harness([{ id: 'dl_1', documentId: 'doc_1', code: 'A7K2M9PQ', revokedAt: null }]);
    await run(db, { documentLinkIds: ['dl_1'], reason: 'Client left the practice' });

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ documentId: 'doc_1', stage: 'source-link', outcome: 'revoked', traceId: 'trace-1' });
    // The code is no longer a credential — it resolves to 410 from now on —
    // and it is the only thing tying this event to the row in the ledger.
    expect(events[0]?.detail).toMatchObject({ linkId: 'dl_1', code: 'A7K2M9PQ', proposalId: 'prp_1', reason: 'Client left the practice' });
  });

  test('a null reason is omitted rather than stored as null', async () => {
    const { db, events } = harness([{ id: 'dl_1', documentId: 'doc_1', code: 'A7K2M9PQ', revokedAt: null }]);
    await run(db, { documentLinkIds: ['dl_1'], reason: null });
    expect(events[0]?.detail).not.toHaveProperty('reason');
  });

  test('the outcome names the DOCUMENTS that stopped being reachable, de-duplicated', async () => {
    const { db } = harness([
      { id: 'dl_1', documentId: 'doc_1', code: 'A7K2M9PQ', revokedAt: null },
      { id: 'dl_2', documentId: 'doc_1', code: 'B8N3P0QR', revokedAt: null },
    ]);
    const result = await run(db, { documentLinkIds: ['dl_1', 'dl_2'] });
    expect(result.changed).toEqual([{ entity: 'document', id: 'doc_1' }]);
    expect(result.detail).toMatchObject({ documentsAffected: 1, linksRevoked: 2 });
  });

  test('no follow-up work — revocation is complete when the transaction commits', async () => {
    const { db } = harness([{ id: 'dl_1', documentId: 'doc_1', code: 'A7K2M9PQ', revokedAt: null }]);
    expect((await run(db, { documentLinkIds: ['dl_1'] })).followUps).toEqual([]);
  });
});

describe('⚠ the refusals', () => {
  test('a link id the approver cannot see refuses the WHOLE batch', async () => {
    const { db, updates } = harness([{ id: 'dl_1', documentId: 'doc_1', code: 'A7K2M9PQ', revokedAt: null }]);
    // RLS returns no row for `dl_other`, which is exactly what a non-existent
    // id looks like too. The message does not distinguish them — the house
    // 404-never-403 rule, applied to effects.
    await expect(run(db, { documentLinkIds: ['dl_1', 'dl_other'] })).rejects.toBeInstanceOf(ProposalExecutionRefused);
    // Nothing partial: a batch that revoked what it could and reported success
    // would leave the reviewer believing eleven links died when ten did.
    expect(updates).toEqual([]);
  });

  test('an empty result set refuses rather than reporting an empty success', async () => {
    const { db } = harness([]);
    await expect(run(db, { documentLinkIds: ['dl_1'] })).rejects.toThrow(/not reachable/);
  });
});

describe('idempotency — approve is exactly-once, but a retry must be harmless', () => {
  test('a replay changes nothing, writes no second event, and reports alreadyApplied', async () => {
    const revokedAt = new Date('2026-08-01T00:00:00Z');
    const { db, updates, events } = harness([{ id: 'dl_1', documentId: 'doc_1', code: 'A7K2M9PQ', revokedAt }]);
    const result = await run(db, { documentLinkIds: ['dl_1'] });

    expect(result.alreadyApplied).toBe(true);
    // The original timestamp survives: when a link died is the answer to "when
    // did my January export stop working".
    expect(updates).toEqual([]);
    expect(events).toEqual([]);
    expect(result.detail).toMatchObject({ linksRevoked: 0, linksAlreadyRevoked: 1 });
  });

  test('a mixed batch revokes only what is still live, and is not alreadyApplied', async () => {
    const { db, events } = harness([
      { id: 'dl_1', documentId: 'doc_1', code: 'A7K2M9PQ', revokedAt: new Date('2026-08-01T00:00:00Z') },
      { id: 'dl_2', documentId: 'doc_2', code: 'B8N3P0QR', revokedAt: null },
    ]);
    const result = await run(db, { documentLinkIds: ['dl_1', 'dl_2'] });

    expect(result.alreadyApplied).toBe(false);
    expect(events.map((event) => event.documentId)).toEqual(['doc_2']);
    expect(result.detail).toMatchObject({ linksRevoked: 1, linksAlreadyRevoked: 1 });
  });

  test('duplicate ids in one payload are collapsed before anything is counted', async () => {
    const { db } = harness([{ id: 'dl_1', documentId: 'doc_1', code: 'A7K2M9PQ', revokedAt: null }]);
    const result = await run(db, { documentLinkIds: ['dl_1', 'dl_1', 'dl_1'] });
    expect(result.detail).toMatchObject({ linksRequested: 1, linksRevoked: 1 });
  });
});
