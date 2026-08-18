import { expect, test } from 'vitest';

import type { ScopeContext } from '../../../common/db/scope-context.js';
import { ScopeContextSchema } from '../../../common/db/scope-context.js';
import type { ScopedClient } from '../../../common/db/scoped-db.js';
import { ProposalExecutionRefused } from './proposal-executor.js';
import { updateCodingExecutor } from './update-coding.js';

const CTX: ScopeContext = ScopeContextSchema.parse({ actorId: 'usr_1', practiceId: 'prac_1' });

interface DocRow {
  id: string;
  state: string;
  docType: string | null;
  supplierName: string | null;
  customerName: string | null;
  documentDate: Date | null;
  dueDate: Date | null;
  currency: string | null;
  totalPence: number | null;
  taxPence: number | null;
  reference: string | null;
  categoryCode: string | null;
  description: string | null;
  projectRef: string | null;
}

function doc(id: string, over: Partial<DocRow> = {}): DocRow {
  return {
    id,
    state: 'TO_REVIEW',
    docType: 'RECEIPT',
    supplierName: null,
    customerName: null,
    documentDate: null,
    dueDate: null,
    currency: 'GBP',
    totalPence: null,
    taxPence: null,
    reference: null,
    categoryCode: null,
    description: null,
    projectRef: null,
    ...over,
  };
}

interface ExtractionRow {
  id: string;
  documentId: string;
  fields: Record<string, unknown>;
  isAccepted: boolean;
  extractorKind?: string;
  keyedByUserId?: string | null;
}

function harness(rows: DocRow[], extractions: ExtractionRow[] = []) {
  const map = new Map(rows.map((r) => [r.id, r]));
  const updates: { where: Record<string, unknown>; data: Record<string, unknown> }[] = [];
  const events: Record<string, unknown>[] = [];
  const created: ExtractionRow[] = [];
  const db = {
    document: {
      findUnique: async ({ where }: { where: { id: string } }) => map.get(where.id) ?? null,
      update: async (args: { where: { id: string }; data: Record<string, unknown> }) => {
        updates.push(args);
        Object.assign(map.get(args.where.id) ?? {}, args.data);
        return map.get(args.where.id);
      },
      updateMany: async (args: { where: { id: string; state: string }; data: Record<string, unknown> }) => {
        const row = map.get(args.where.id);
        if (row === undefined || row.state !== args.where.state) return { count: 0 };
        updates.push(args);
        Object.assign(row, args.data);
        return { count: 1 };
      },
    },
    extraction: {
      findFirst: async ({ where }: { where: { documentId: string; isAccepted: boolean } }) =>
        extractions.find((e) => e.documentId === where.documentId && e.isAccepted === where.isAccepted) ?? null,
      update: async ({ where, data }: { where: { id: string }; data: Partial<ExtractionRow> }) => {
        const row = extractions.find((e) => e.id === where.id);
        if (row !== undefined) Object.assign(row, data);
        return row;
      },
      create: async ({ data }: { data: ExtractionRow }) => {
        created.push(data);
        return data;
      },
    },
    documentEvent: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        events.push(data);
        return {};
      },
    },
  } as unknown as ScopedClient;
  return { db, map, updates, events, created };
}

const input = (payload: unknown) => ({ proposalId: 'prop_1', payload: payload as never, ctx: CTX, traceId: 'trace-122' });

test('field edits land on the header projection AND the extraction surface as HUMAN_CONFIRMED', async () => {
  const prior = { id: 'ext_1', documentId: 'doc_1', isAccepted: true, fields: { supplierName: { value: 'CURRYS PLC', provenance: 'AI_SUGGESTED', confidence: 0.62 } } };
  const { db, map, events, created } = harness([doc('doc_1', { supplierName: 'CURRYS PLC', totalPence: 129_900 })], [prior]);

  const result = await updateCodingExecutor.execute(db, input({
    documentId: 'doc_1',
    fields: { supplierName: 'Currys', categoryCode: 'OFFICE_EQUIPMENT', documentDate: '2026-08-09' },
  }));

  expect(result.alreadyApplied).toBe(false);
  const row = map.get('doc_1');
  expect(row?.supplierName).toBe('Currys');
  expect(row?.categoryCode).toBe('OFFICE_EQUIPMENT');
  // UTC midnight — UTC in storage, Europe/London only at render.
  expect(row?.documentDate?.toISOString()).toBe('2026-08-09T00:00:00.000Z');

  // The prior accepted extraction lost its acceptance, never its content; the
  // new row carries the corrections as HUMAN_CONFIRMED with the proposal cited.
  expect(prior.isAccepted).toBe(false);
  expect(created).toHaveLength(1);
  expect(created[0]).toMatchObject({ documentId: 'doc_1', isAccepted: true, extractorKind: 'human', keyedByUserId: 'usr_1' });
  const fields = created[0]?.fields as Record<string, Record<string, unknown>>;
  expect(fields['supplierName']).toEqual({ value: 'Currys', provenance: 'HUMAN_CONFIRMED', confidence: null, source: 'proposal:prop_1', wasCorrected: true });
  // The date lands as the contract's YYYY-MM-DD, not a Date object.
  expect(fields['documentDate']?.['value']).toBe('2026-08-09');

  expect(events.some((e) => e['stage'] === 'coding' && e['outcome'] === 'updated')).toBe(true);
});

test('supplying the last missing mandatory field moves TO_REVIEW → READY through the machine', async () => {
  const { db, map, events } = harness([doc('doc_1', { supplierName: 'Currys', totalPence: 129_900, categoryCode: null })]);
  await updateCodingExecutor.execute(db, input({ documentId: 'doc_1', fields: { categoryCode: 'OFFICE_EQUIPMENT' } }));
  expect(map.get('doc_1')?.state).toBe('READY');
  expect(events.some((e) => e['stage'] === 'state' && e['outcome'] === 'READY')).toBe(true);
});

test('a correction that still leaves a mandatory field missing stays TO_REVIEW', async () => {
  const { db, map } = harness([doc('doc_1', { supplierName: null, totalPence: null })]);
  await updateCodingExecutor.execute(db, input({ documentId: 'doc_1', fields: { supplierName: 'Currys' } }));
  expect(map.get('doc_1')?.state).toBe('TO_REVIEW');
});

test('idempotent replay: values already in place mean no writes, no event, no extraction row', async () => {
  const { db, updates, events, created } = harness([doc('doc_1', { supplierName: 'Currys', totalPence: 129_900 })]);
  const result = await updateCodingExecutor.execute(db, input({ documentId: 'doc_1', fields: { supplierName: 'Currys', totalPence: 129_900 } }));
  expect(result.alreadyApplied).toBe(true);
  expect(updates).toEqual([]);
  expect(events).toEqual([]);
  expect(created).toEqual([]);
});

test('refuses: missing document, PUBLISHED and ARCHIVED locks', async () => {
  const { db } = harness([doc('doc_pub', { state: 'PUBLISHED' }), doc('doc_arch', { state: 'ARCHIVED' })]);
  await expect(updateCodingExecutor.execute(db, input({ documentId: 'doc_x', fields: { supplierName: 'A' } }))).rejects.toThrow(ProposalExecutionRefused);
  await expect(updateCodingExecutor.execute(db, input({ documentId: 'doc_pub', fields: { supplierName: 'A' } }))).rejects.toThrow('locked');
  await expect(updateCodingExecutor.execute(db, input({ documentId: 'doc_arch', fields: { supplierName: 'A' } }))).rejects.toThrow('locked');
});

test('createRuleFromCorrection is recorded on the event as a deferred seam, never silently dropped', async () => {
  const { db, events } = harness([doc('doc_1')]);
  await updateCodingExecutor.execute(db, input({ documentId: 'doc_1', fields: { categoryCode: 'ADS' }, createRuleFromCorrection: true }));
  const coding = events.find((e) => e['stage'] === 'coding');
  expect((coding?.['detail'] as Record<string, unknown>)['createRuleDeferred']).toBe(true);
});
