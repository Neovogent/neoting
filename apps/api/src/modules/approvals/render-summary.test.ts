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

test('chase.send renders every message byte-for-byte and its recipient — nothing summarised away', () => {
  const body = 'American Burger Accounts: we’re missing the receipt for Currys £1,299 on 9 Aug. Upload securely: https://x';
  const summary = renderSummary('chase.send', {
    messages: [{ recipientE164: '+447700900001', body, transactionIds: ['txn_1', 'txn_2'] }],
  });
  expect(summary.title).toBe('Send 1 chase message');
  // A pre-compose-seam payload carries no recipientEmail: the number heads it.
  expect(summary.sections[0]?.heading).toContain('+447700900001');
  expect(summary.sections[0]?.entries[0]?.value).toBe(body);
  expect(summary.sections[0]?.entries[1]?.value).toBe('txn_1, txn_2');
});

test('chase.send with a resolved recipientEmail heads the section with the ADDRESS the email transport sends to', () => {
  const body = 'American Burger Accounts: we’re missing the receipt for Currys £1,299 on 9 Aug. Upload securely: https://x';
  const summary = renderSummary('chase.send', {
    messages: [
      { recipientE164: '+447700900001', recipientEmail: 'sam@client.test', body, transactionIds: ['txn_1'] },
    ],
  });
  expect(summary.sections[0]?.heading).toContain('sam@client.test');
  expect(summary.sections[0]?.entries[0]?.value).toBe(body);
  // The registered mobile stays on the card — the reviewer sees both.
  expect(summary.sections[0]?.entries[1]?.value).toBe('+447700900001');
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

test('rule.create renders the rule in full — fields, tier, scope — not a JSON blob (METH S13)', () => {
  const summary = renderSummary('rule.create', {
    tier: 'SUPPLIER_CUSTOMER',
    scopeKey: 'Bidfood',
    conditions: null,
    sets: { categoryCode: 'COST_OF_SALES_FOOD', vatTreatment: 'standard' },
  });
  expect(summary.title).toBe('Create rule: Bidfood → categoryCode COST_OF_SALES_FOOD, vatTreatment standard');
  const rule = summary.sections.find((s) => s.heading === 'Rule that will be created');
  expect(rule?.entries).toEqual([
    { label: 'Tier', value: 'SUPPLIER_CUSTOMER' },
    { label: 'Matches', value: 'Bidfood' },
    { label: 'Conditions', value: 'Always' },
  ]);
  const sets = summary.sections.find((s) => s.heading === 'Fields this rule sets');
  expect(sets?.entries.map((e) => e.label)).toEqual(['categoryCode', 'vatTreatment']);

  // A scopeless tier says so, and richer conditions are named rather than hidden.
  const accountDefault = renderSummary('rule.create', {
    tier: 'ACCOUNT_DEFAULT',
    scopeKey: null,
    conditions: { totalPenceGreaterThan: 200000 },
    sets: { vatTreatment: 'exempt' },
  });
  expect(accountDefault.sections[0]?.entries).toContainEqual({ label: 'Matches', value: 'Every document in scope' });
  expect(accountDefault.sections[0]?.entries).toContainEqual({ label: 'Conditions', value: 'totalPenceGreaterThan: 200000' });
});

test('unshaped kinds fall back to naming every payload member, and warnings default empty', () => {
  const summary = renderSummary('bank.confirm-match', { transactionId: 'txn_1', documentId: 'doc_1', matchKind: 'EXACT' });
  expect(summary.title).toBe('bank.confirm-match');
  expect(summary.sections[0]?.entries.map((e) => e.label)).toEqual(['transactionId', 'documentId', 'matchKind']);
  expect(summary.warnings).toEqual([]);
});

test('reject shows the reason verbatim — a reviewer agrees to the words, not to a summary of them', () => {
  const summary = renderSummary('document.reject', {
    documentIds: ['doc_1', 'doc_2'],
    reason: 'Personal receipt — not a business cost',
  });
  expect(summary.title).toBe('Reject 2 documents');
  expect(summary.sections[0]?.entries).toEqual([{ label: 'Reason', value: 'Personal receipt — not a business cost' }]);
  expect(summary.sections[1]?.entries).toEqual([
    { label: 'Document 1', value: 'doc_1' },
    { label: 'Document 2', value: 'doc_2' },
  ]);
});

test('business.offboard says books are retained, and shows the reason verbatim only when one was given', () => {
  const summary = renderSummary('business.offboard', {
    businessId: 'biz_1',
    reason: 'Client moved to another practice',
  });
  expect(summary.title).toBe('Offboard client workspace biz_1 — books retained');
  const entries = summary.sections[0]?.entries ?? [];
  expect(entries).toContainEqual({ label: 'Business', value: 'biz_1' });
  expect(entries).toContainEqual({
    label: 'Deletes books, documents or the audit trail',
    value: 'No — retained for the six-year requirement',
  });
  expect(entries).toContainEqual({
    label: 'Reason, exactly as it will be recorded',
    value: 'Client moved to another practice',
  });
  // No reason means no reason entry — recorded, never invented.
  expect(
    renderSummary('business.offboard', { businessId: 'biz_1' }).sections[0]?.entries.map((e) => e.label),
  ).not.toContain('Reason, exactly as it will be recorded');
});

test('reprocess states what it does NOT do — the card is where the limit belongs, not a source file', () => {
  const summary = renderSummary('document.reprocess', { documentIds: ['doc_1'] });
  expect(summary.title).toBe('Retry 1 document');
  const entries = summary.sections[0]?.entries ?? [];
  expect(entries).toContainEqual({ label: 'Reads the document again', value: 'No — extraction is not re-run' });
  expect(entries).toContainEqual({ label: 'Clears the failure reason', value: 'Yes' });
  // `fromStage` is shown only when it was asked for — recorded, never invented.
  expect(entries.map((e) => e.label)).not.toContain('Requested from stage');
  expect(
    renderSummary('document.reprocess', { documentIds: ['doc_1'], fromStage: 'extract' }).sections[0]?.entries,
  ).toContainEqual({ label: 'Requested from stage', value: 'extract' });
});
