import { expect, test } from 'vitest';

import type { Task } from '../api/tasks';
import { toBoardRow } from './TeamView';

const TASK: Task = {
  id: 'tsk_1',
  businessId: 'biz_1',
  businessName: 'Zeplow Inc.',
  title: 'Reconcile the bank',
  description: null,
  assigneeUserId: 'usr_kate',
  assigneeName: 'Kate Okafor',
  dueDate: '2026-09-30',
  status: 'open',
  cadence: 'monthly',
  dependsOnTaskId: null,
  aiPrefilledAt: null,
  createdAt: '2026-09-07T09:00:00.000Z',
  updatedAt: '2026-09-07T09:00:00.000Z',
};

test('a live task maps onto the board row the table already renders', () => {
  expect(toBoardRow(TASK)).toMatchObject({
    id: 'tsk_1',
    clientId: 'biz_1',
    clientName: 'Zeplow Inc.',
    assignee: 'Kate Okafor',
    assigneeUserId: 'usr_kate',
    due: '2026-09-30',
    cadence: 'monthly',
  });
});

test('⚠ a live task NEVER carries the AI-prefilled badge while nothing stamps the column', () => {
  // Review item 54, applying item 25's standing rule. The badge used to be
  // decided by matching the task's TITLE against three string prefixes — a
  // coincidence against a real task, and a claim to have read something nobody
  // read. It comes back when an engine writes `aiPrefilledAt`, and this test
  // is what says so: it goes green on its own the day that happens.
  expect(toBoardRow(TASK).aiPrefilled).toBe(false);
  expect(toBoardRow({ ...TASK, aiPrefilledAt: '2026-09-07T10:00:00.000Z' }).aiPrefilled).toBe(true);
});

test('unassigned and undated are empty strings, not the raw id or a fake dash', () => {
  const bare = toBoardRow({ ...TASK, assigneeUserId: null, assigneeName: null, dueDate: null });
  expect(bare.assignee).toBe('');
  expect(bare.assigneeUserId).toBeUndefined();
  expect(bare.due).toBe('');
});
