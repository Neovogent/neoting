import { expect, test } from 'vitest';

import {
  type PortalChaseTarget,
  type PortalDocumentRow,
  portalUploadStatus,
} from './portal-upload-status.service.js';

/**
 * The pure half of the portal's post-upload read: document row + chased line →
 * what the client sees. The scoped reads around it are proven against a real
 * database in `portal-upload-feedback.integration.test.ts`; everything here is
 * offline.
 */

const GOOGLE_CHASE: PortalChaseTarget = {
  chaseId: 'chase_1',
  chaseState: 'SENT',
  transactionId: 'txn_1',
  transaction: {
    amountPence: -60_000,
    bookedAt: new Date('2026-08-05T09:12:00.000Z'),
    merchantName: 'Google',
    descriptionRaw: 'GOOGLE ADS 8829 IE',
  },
};

function row(overrides: Partial<PortalDocumentRow> = {}): PortalDocumentRow {
  return {
    id: 'doc_1',
    state: 'READY',
    supplierName: 'Google',
    totalPence: 60_000,
    documentDate: new Date('2026-08-05T00:00:00.000Z'),
    confidence: 0.94,
    ...overrides,
  };
}

test('a document still in the pipeline is processing — no verdict, no header', () => {
  for (const state of ['RECEIVED', 'PROCESSING'] as const) {
    const status = portalUploadStatus(row({ state }), GOOGLE_CHASE);
    expect(status.stage).toBe('processing');
    expect(status.extracted).toBeNull();
    expect(status.message).toBe("We're reading your document — this usually takes a few seconds.");
    // The item it will be judged against is known from the first second.
    expect(status.transactionId).toBe('txn_1');
  }
});

test('a document that could not be read says so — it is not a mismatch', () => {
  for (const state of ['FAILED', 'REJECTED'] as const) {
    const status = portalUploadStatus(row({ state }), GOOGLE_CHASE);
    expect(status.stage).toBe('failed');
    expect(status.reasons).toEqual([]);
    expect(status.message).toBe("We couldn't read that file. Please try again with a clearer photo or a PDF.");
  }
});

test('an extracted document that answers the chase reports the match and its header', () => {
  const status = portalUploadStatus(row(), GOOGLE_CHASE);

  expect(status.stage).toBe('match');
  expect(status.message).toBe("Received, thank you — that's the £600 Google transaction from 5 Aug.");
  expect(status.extracted).toEqual({
    supplierName: 'Google',
    totalPence: 60_000,
    documentDate: new Date('2026-08-05T00:00:00.000Z'),
    confidence: 0.94,
  });
  expect(status.chaseState).toBe('SENT');
});

test('the wrong document names the difference and stays on the chased item', () => {
  const status = portalUploadStatus(row({ totalPence: 42_000 }), GOOGLE_CHASE);

  expect(status.stage).toBe('mismatch');
  expect(status.reasons).toEqual(['amount']);
  expect(status.message).toBe('This looks like a £420 invoice, but we need the £600 Google transaction from 5 Aug.');
  expect(status.transactionId).toBe('txn_1');
});

test('TO_REVIEW is judged like READY — a failed validator is not a wrong document', () => {
  expect(portalUploadStatus(row({ state: 'TO_REVIEW' }), GOOGLE_CHASE).stage).toBe('match');
});

test('a chase with no single line is received, not judged', () => {
  const grouped: PortalChaseTarget = { ...GOOGLE_CHASE, transactionId: null, transaction: null };

  const status = portalUploadStatus(row(), grouped);
  expect(status.stage).toBe('received');
  expect(status.message).toBe("Received, thank you — we'll take it from here.");
  expect(status.extracted).not.toBeNull();
  expect(status.transactionId).toBeNull();
});

test('no chase at all is still an honest answer, not a crash', () => {
  const status = portalUploadStatus(row(), null);
  expect(status.stage).toBe('received');
  expect(status.chaseState).toBeNull();
});

test('the document state travels verbatim — the portal never re-derives the pipeline', () => {
  expect(portalUploadStatus(row({ state: 'PUBLISHED' }), GOOGLE_CHASE).state).toBe('PUBLISHED');
});
