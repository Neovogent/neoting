import type { ChasePolicySettings } from '@neoting/contracts/model';
import { expect, test } from 'vitest';

import { ScopeContextSchema } from '../../../common/db/scope-context.js';
import type { ScopedClient } from '../../../common/db/scoped-db.js';
import { activatePolicyExecutor } from './activate-policy.js';
import { ProposalExecutionRefused } from './proposal-executor.js';

/** `policy.activate` carrying `chasePolicy` (rush/chase-scheduler), against a recording fake. */

const CTX = ScopeContextSchema.parse({ actorId: 'usr_1', practiceId: 'prac_1' });
const SETTINGS: ChasePolicySettings = {
  firstReminderDays: 3,
  secondReminderDays: 7,
  escalateAfterDays: 14,
  maxReminders: 2,
  quietHoursStart: 20,
  quietHoursEnd: 8,
};

function harness(practiceId: string | null) {
  const rows = new Map<string, Record<string, unknown>>();
  const db = {
    actionProposal: { findUnique: async () => ({ practiceId }) },
    chasePolicy: {
      findUnique: async ({ where }: { where: { practiceId: string } }) => rows.get(where.practiceId) ?? null,
      upsert: async (args: { where: { practiceId: string }; create: Record<string, unknown>; update: Record<string, unknown> }) => {
        const row = { ...(rows.get(args.where.practiceId) ?? args.create), ...args.update };
        rows.set(args.where.practiceId, row);
        return row;
      },
    },
  } as unknown as ScopedClient;
  return { db, rows };
}

const run = (db: ScopedClient, proposalId: string, chasePolicy: ChasePolicySettings, active = true) =>
  activatePolicyExecutor.execute(db, { proposalId, payload: { active, chasePolicy }, ctx: CTX, traceId: 't' });

test("approving writes the practice's schedule, stamped with the proposal; a replay is a no-op", async () => {
  const { db, rows } = harness('prac_1');
  const first = await run(db, 'prop_1', SETTINGS);
  expect(first.alreadyApplied).toBe(false);
  expect(rows.get('prac_1')).toMatchObject({ enabled: true, firstReminderDays: 3, actionProposalId: 'prop_1' });

  expect((await run(db, 'prop_1', SETTINGS)).alreadyApplied).toBe(true);

  await run(db, 'prop_2', SETTINGS, false);
  expect(rows.get('prac_1')).toMatchObject({ enabled: false, actionProposalId: 'prop_2' });
});

test('refuses a second reminder that is not after the first, and a proposal with no practice', async () => {
  await expect(run(harness('prac_1').db, 'p', { ...SETTINGS, secondReminderDays: 3 })).rejects.toBeInstanceOf(
    ProposalExecutionRefused,
  );
  await expect(run(harness(null).db, 'p', SETTINGS)).rejects.toThrow(/belongs to a practice/);
});
