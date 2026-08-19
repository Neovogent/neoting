import { expect, test } from 'vitest';

import { DEMO_FAILING_SUPPLIERS, DEMO_PER_ITEM_DELAY_MS, DemoXeroAdapter, demoExternalRef } from './demo-xero-adapter.js';
import { LEDGER_REJECTED, type PublishBillRequest } from './ledger-adapter.js';

/** No waiting in the unit suite: the delay is a demo affordance, not behaviour. */
const instant = new DemoXeroAdapter({ perItemDelayMs: 0 });

function bill(overrides: Partial<PublishBillRequest> = {}): PublishBillRequest {
  return {
    documentId: 'doc_001',
    attempt: 1,
    target: { integrationId: 'int_burger_xero', kind: 'XERO', orgRef: 'xero-demo-org-1' },
    supplierName: 'Bidfood',
    categoryCode: 'Cost of Sales — Food',
    currency: 'GBP',
    totalPence: 128_450,
    taxPence: 21_408,
    documentDate: '2026-08-15',
    reference: 'BID-1000',
    attachment: { s3Key: 'w/biz_burger/doc_001.pdf', filename: 'bidfood-doc_001.pdf', mimeType: 'application/pdf' },
    ...overrides,
  };
}

test('the external ref is XERO-INV-#### and deterministic per document', async () => {
  const first = await instant.publishBill(bill());
  const second = await instant.publishBill(bill());

  expect(first).toEqual(second);
  expect(first.ok && first.externalRef).toMatch(/^XERO-INV-\d{4}$/);
  expect(demoExternalRef('doc_001')).not.toBe(demoExternalRef('doc_007'));
});

test('the ref does NOT vary with the attempt — a republish must not mint a second reference', async () => {
  const failed = await instant.publishBill(bill({ documentId: 'doc_007', supplierName: 'British Gas' }));
  const retried = await instant.publishBill(bill({ documentId: 'doc_007', supplierName: 'British Gas', attempt: 2 }));

  expect(failed.ok).toBe(false);
  expect(retried.ok && retried.externalRef).toBe(demoExternalRef('doc_007'));
});

test('attachmentSent reports what actually travelled, never a claim', async () => {
  const withAttachment = await instant.publishBill(bill());
  const without = await instant.publishBill(bill({ attachment: null }));

  expect(withAttachment.ok && withAttachment.attachmentSent).toBe(true);
  expect(without.ok && without.attachmentSent).toBe(false);
});

test('the flagged supplier fails its FIRST attempt with a reasoned, retryable failure', async () => {
  // doc_007 in the seed on main: British Gas, £412.66 gross, READY, Utilities,
  // American Burger. The scripted Rejected/Failed → retry beat of the demo.
  const result = await instant.publishBill(bill({ documentId: 'doc_007', supplierName: 'British Gas', totalPence: 41_266, taxPence: 6_878 }));

  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.failure.code).toBe(LEDGER_REJECTED);
  expect(result.failure.retryable).toBe(true);
  // A failure with no reason attached is a bug, not a state (the contract).
  expect(result.failure.message).toContain('British Gas');
  expect(result.failure.message.length).toBeGreaterThan(20);
});

test('the retry succeeds — the flag is on the attempt, not on the document forever', async () => {
  const retry = await instant.publishBill(bill({ documentId: 'doc_007', supplierName: 'British Gas', attempt: 2 }));

  expect(retry.ok).toBe(true);
  expect(retry.ok && retry.attachmentSent).toBe(true);
});

test('the flag survives casing and punctuation drift, and does not spread to lookalikes', async () => {
  const shouty = await instant.publishBill(bill({ supplierName: '  BRITISH   GAS!  ' }));
  const lookalike = await instant.publishBill(bill({ supplierName: 'British Gas Business Energy' }));

  expect(shouty.ok).toBe(false);
  expect(lookalike.ok).toBe(true);
  expect(DEMO_FAILING_SUPPLIERS).toContain('british gas');
});

test('every other supplier lands first time', async () => {
  for (const supplierName of ['Bidfood', 'Thames Water', 'Henry Schein', 'Brakes']) {
    expect((await instant.publishBill(bill({ supplierName }))).ok).toBe(true);
  }
});

test('the per-item delay is configurable, injected, and defaults to the documented constant', async () => {
  const slept: number[] = [];
  const sleep = async (ms: number): Promise<void> => {
    slept.push(ms);
  };

  await new DemoXeroAdapter({ sleep }).publishBill(bill());
  await new DemoXeroAdapter({ perItemDelayMs: 5, sleep }).publishBill(bill());
  await new DemoXeroAdapter({ perItemDelayMs: 0, sleep }).publishBill(bill());

  // Default, override, and zero meaning "do not wait at all" — not "wait 0ms".
  expect(slept).toEqual([DEMO_PER_ITEM_DELAY_MS, 5]);
  // Small enough that a 500-item batch is not an hour, honest enough that a
  // three-item demo batch reads as work being done.
  expect(DEMO_PER_ITEM_DELAY_MS).toBeLessThanOrEqual(1_000);
});
