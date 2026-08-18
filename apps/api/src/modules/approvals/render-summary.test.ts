import { expect, test } from 'vitest';

import { canonicalHash, canonicalStringify } from './canonical-hash.js';
import { renderSummary } from './render-summary.js';

test('canonical form is key-order independent — the property NT-PRP-004 depends on', () => {
  const a = { supplier: 'Currys', totalPence: 129_900, nested: { b: 2, a: 1 } };
  const b = { nested: { a: 1, b: 2 }, totalPence: 129_900, supplier: 'Currys' };
  expect(canonicalStringify(a)).toBe(canonicalStringify(b));
  expect(canonicalHash(a)).toBe(canonicalHash(b));
  expect(canonicalHash(a)).toMatch(/^[a-f0-9]{64}$/);
  // undefined members drop; null survives — they are different claims.
  expect(canonicalStringify({ a: undefined, b: null })).toBe('{"b":null}');
  // Arrays keep their order — [1,2] and [2,1] are different payloads.
  expect(canonicalStringify({ x: [1, 2] })).not.toBe(canonicalStringify({ x: [2, 1] }));
});

test('rendering is deterministic: same payload, same summary, same hash', () => {
  const payload = { documentIds: ['doc_1', 'doc_2'], archived: true };
  expect(canonicalHash(renderSummary('document.archive', payload))).toBe(canonicalHash(renderSummary('document.archive', payload)));
});

test('archive and restore render as different actions over the same documents', () => {
  const archive = renderSummary('document.archive', { documentIds: ['doc_1', 'doc_2'], archived: true });
  const restore = renderSummary('document.archive', { documentIds: ['doc_1', 'doc_2'], archived: false });
  expect(archive.title).toBe('Archive 2 documents');
  expect(restore.title).toBe('Restore 2 documents from the archive');
  expect(archive.sections[0]?.entries.map((e) => e.value)).toEqual(['doc_1', 'doc_2']);
});

test('chase.send renders every SMS byte-for-byte and its recipient — nothing summarised away', () => {
  const body = 'American Burger Accounts: we’re missing the receipt for Currys £1,299 on 9 Aug. Upload securely: https://x';
  const summary = renderSummary('chase.send', {
    messages: [{ recipientE164: '+447700900001', body, transactionIds: ['txn_1', 'txn_2'] }],
  });
  expect(summary.title).toBe('Send 1 chase SMS message');
  expect(summary.sections[0]?.heading).toContain('+447700900001');
  expect(summary.sections[0]?.entries[0]?.value).toBe(body);
  expect(summary.sections[0]?.entries[1]?.value).toBe('txn_1, txn_2');
});

test('publish.batch renders the server-computed preview with integer-only money formatting', () => {
  const summary = renderSummary('publish.batch', {
    documentIds: ['doc_1', 'doc_2'],
    preview: { itemCount: 2, grossPence: 8_492_500, vatPence: 99 },
  });
  expect(summary.title).toBe('Publish 2 documents — gross £84925.00, VAT £0.99');
  // Negative pence and sub-pound values format by string arithmetic — no float
  // ever touches a monetary value, even in a formatter.
  const credit = renderSummary('publish.batch', { documentIds: ['doc_1'], preview: { itemCount: 1, grossPence: -150, vatPence: 5 } });
  expect(credit.title).toBe('Publish 1 document — gross -£1.50, VAT £0.05');
});

test('update-coding names every field being set', () => {
  const summary = renderSummary('document.update-coding', {
    documentId: 'doc_1',
    fields: { categoryCode: 'COS_FOOD', totalPence: 129_900 },
  });
  expect(summary.title).toBe('Update coding — categoryCode, totalPence');
  expect(summary.sections[0]?.entries.map((e) => e.label)).toEqual(['Document', 'categoryCode', 'totalPence']);
});

test('unshaped kinds fall back to naming every payload member, and warnings default empty', () => {
  const summary = renderSummary('bank.confirm-match', { transactionId: 'txn_1', documentId: 'doc_1', matchKind: 'EXACT' });
  expect(summary.title).toBe('bank.confirm-match');
  expect(summary.sections[0]?.entries.map((e) => e.label)).toEqual(['transactionId', 'documentId', 'matchKind']);
  expect(summary.warnings).toEqual([]);
});
