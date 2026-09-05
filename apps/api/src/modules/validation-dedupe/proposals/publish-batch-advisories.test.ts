import { expect, test } from 'vitest';

import type { PublishBatchPayload } from '@neoting/contracts/model';
import type { ScopedClient } from '../../../common/db/scoped-db.js';
import type { ExportEntryPreview } from '../../exports-public-api/index.js';
import { computePublishBatchPayload, type ExportEntryPreviewer, type PublishGateway } from './publish-batch.js';

/**
 * The release-review advisories (items 29(b) + 47's D46 half), pinned at the
 * unit through `computePublishBatchPayload` — the same function the engine
 * calls at creation, and whose output the executor's recompute must match
 * fingerprint-for-fingerprint (which is why `applyEntryAdvisories` is not
 * exported: both call sites live in publish-batch.ts and cannot diverge).
 */

interface FakeDoc {
  id: string;
  state: string;
  businessId: string;
  supplierName: string;
  categoryCode: string;
  totalPence: number;
  taxPence: number;
  currency: string;
  inbox: string;
  docType: string;
  customerName: string | null;
  documentDate: Date;
  reference: string | null;
}

const fakeDoc = (id: string, over: Partial<FakeDoc> = {}): FakeDoc => ({
  id,
  state: 'READY',
  businessId: 'biz_1',
  supplierName: 'Aldgate Meats Ltd',
  categoryCode: 'COS_FOOD',
  totalPence: 99_400,
  taxPence: 0,
  currency: 'GBP',
  inbox: 'COSTS',
  docType: 'INVOICE',
  customerName: null,
  documentDate: new Date('2025-07-30T00:00:00.000Z'),
  reference: null,
  ...over,
});

function fakeDb(documents: FakeDoc[], machineExtractions: { documentId: string; fields: unknown }[]): ScopedClient {
  return {
    document: { findMany: async () => documents },
    extraction: { findMany: async () => machineExtractions },
  } as unknown as ScopedClient;
}

const publishing: PublishGateway = {
  ledger: {
    publishBill: async () => {
      throw new Error('the ledger must never be reached');
    },
  } as unknown as PublishGateway['ledger'],
  previewPublishBatch: (items) => ({
    ok: true,
    preview: { itemCount: items.length, grossPence: 99_400, vatPence: 0, currency: 'GBP' },
  }),
};

const basePayload = (ids: string[]): PublishBatchPayload => ({
  documentIds: ids,
  preview: { itemCount: ids.length, grossPence: 0, vatPence: 0 },
});

test('a tax-exceeds-total refusal gains the plain sentence naming both figures (item 29(b))', async () => {
  const doc = fakeDoc('doc_tax', { taxPence: 900_000 });
  const previewer: ExportEntryPreviewer = async () =>
    ({
      target: 'VT_TRANSACTION_PLUS',
      columns: ['Account'],
      documents: [],
      refusals: [
        {
          documentId: 'doc_tax',
          code: 'document-not-representable',
          message: "This document's figures do not add up, so it was left out rather than exported wrong.",
        },
      ],
    }) as unknown as ExportEntryPreview;

  const payload = await computePublishBatchPayload(fakeDb([doc], []), publishing, basePayload(['doc_tax']), previewer);
  const refusal = payload.entryPreview?.refusals?.[0];
  expect(refusal?.message).toContain('figures do not add up');
  expect(refusal?.message).toContain('Tax £9000.00 is larger than the total £994.00');
  expect(refusal?.message).toContain('propose the release again');
});

test("a document the pipeline judged OTHER carries the D46 warning on its entry — keyed on the MACHINE's verdict, not the corrected column", async () => {
  // The selfie walked to Ready: current docType is RECEIPT (a human asserted
  // it), but the machine extraction read OTHER — that verdict follows it.
  const doc = fakeDoc('doc_selfie', { docType: 'RECEIPT', totalPence: 7_654_300 });
  const previewer: ExportEntryPreviewer = async () =>
    ({
      target: 'VT_TRANSACTION_PLUS',
      columns: ['Account'],
      documents: [{ documentId: 'doc_selfie', fileName: '', dataFormat: '', rows: [['gf']], warnings: [] }],
    }) as unknown as ExportEntryPreview;

  const payload = await computePublishBatchPayload(
    fakeDb([doc], [{ documentId: 'doc_selfie', fields: { docType: { value: 'OTHER', provenance: 'AI_SUGGESTED' } } }]),
    publishing,
    basePayload(['doc_selfie']),
    previewer,
  );
  const warnings = payload.entryPreview?.documents[0]?.warnings ?? [];
  expect(warnings.map((warning) => warning.code)).toContain('not-a-financial-document');
  expect(warnings.find((warning) => warning.code === 'not-a-financial-document')?.message).toContain(
    'judged this not to be a financial document',
  );
});

test('a clean batch gains no advisory — no warning, no augmented refusal', async () => {
  const doc = fakeDoc('doc_clean');
  const previewer: ExportEntryPreviewer = async () =>
    ({
      target: 'VT_TRANSACTION_PLUS',
      columns: ['Account'],
      documents: [{ documentId: 'doc_clean', fileName: '', dataFormat: '', rows: [['Aldgate Meats Ltd']], warnings: [] }],
    }) as unknown as ExportEntryPreview;

  const payload = await computePublishBatchPayload(
    fakeDb([doc], [{ documentId: 'doc_clean', fields: { docType: { value: 'INVOICE', provenance: 'AI_SUGGESTED' } } }]),
    publishing,
    basePayload(['doc_clean']),
    previewer,
  );
  expect(payload.entryPreview?.documents[0]?.warnings).toEqual([]);
  expect(payload.entryPreview?.refusals).toBeUndefined();
});
