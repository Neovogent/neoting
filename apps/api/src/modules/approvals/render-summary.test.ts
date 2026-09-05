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
    preview: { itemCount: 2, grossPence: 8_492_500, vatPence: 99, currency: 'GBP' },
  });
  // "Release … for export", never "Publish … to <vendor>". D42: this release
  // has no ledger connection, and *Published* is an internal state meaning
  // approved and released for export.
  expect(summary.title).toBe('Release 2 documents for export — gross £84925.00, VAT £0.99');
  // Negative pence and sub-pound values format by string arithmetic — no float
  // ever touches a monetary value, even in a formatter.
  const credit = renderSummary('publish.batch', {
    documentIds: ['doc_1'],
    preview: { itemCount: 1, grossPence: -150, vatPence: 5, currency: 'GBP' },
  });
  expect(credit.title).toBe('Release 1 document for export — gross -£1.50, VAT £0.05');
});

/**
 * ⚠ **The regression this pins was found on real data: a USD invoice rendered
 * `gross £54352.51` on the approval card.**
 *
 * This is the Review → Approve path, where the product's whole promise is that
 * what was shown is what was approved — so a wrong symbol here is not a display
 * bug, it is the guarantee failing. A batch with no single currency must render
 * its totals BARE and say why; substituting `£` would be the defect returning.
 */
test('a batch with no single currency renders no symbol at all, and the card says why', () => {
  const summary = renderSummary('publish.batch', {
    documentIds: ['doc_1', 'doc_2'],
    preview: { itemCount: 2, grossPence: 5_435_251, vatPence: 0, currency: null },
  });

  expect(summary.title).toBe('Release 2 documents for export — gross 54352.51, VAT 0.00 (mixed currencies)');
  // The reason is ON the card, not left to be inferred from a missing glyph.
  const preview = summary.sections.find((section) => section.heading === 'Server-computed preview');
  expect(preview?.entries.find((entry) => entry.label === 'Currency')?.value).toContain('not all in one currency');

  // No currency symbol survives anywhere in the rendered summary. Asserted over
  // the whole render rather than over the title, because the totals appear
  // twice and the second one is the easy one to forget.
  expect(JSON.stringify(summary)).not.toMatch(/[£$€]/);
});

test('a foreign but SINGLE currency keeps its own symbol — the fix is not "sterling or nothing"', () => {
  const summary = renderSummary('publish.batch', {
    documentIds: ['doc_1'],
    preview: { itemCount: 1, grossPence: 5_435_251, vatPence: 0, currency: 'USD' },
  });

  expect(summary.title).toBe('Release 1 document for export — gross $54352.51, VAT $0.00');
  expect(summary.title).not.toContain('£');
});

/**
 * The entry preview — the owner's ask, in his words: *"before publishing show
 * the accountant the actual accounting entry that will be put into the VT
 * software."*
 *
 * The fixture below is shaped exactly as the emitter produces it. What this test
 * pins is that the RENDER changes nothing on the way through: cells appear
 * verbatim, under the emitter's own column names, in file order. The proof that
 * the cells themselves match the file is one layer down, in
 * `vt-transaction-plus-emitter.test.ts`, which parses the emitted bytes back and
 * compares them — the two tests together are what make drift impossible.
 */
const VT_ENTRY_PREVIEW = {
  target: 'VT_TRANSACTION_PLUS',
  columns: [
    "Bank account name/supplier's name",
    'Paid to/invoice details',
    'Gross amount',
    'Input VAT',
    'Net amount',
    'Net amount for VAT purposes',
    'Analysis account name',
  ],
  documents: [
    {
      documentId: 'doc_1',
      fileName: '2025-05-12-purchase-invoices.csv',
      dataFormat: 'Payments list/purchase invoices list',
      rows: [
        [
          'Nexora Solutions LLC',
          'INV-2291 · Imported from Neo Accounting',
          '54352.51',
          '0.00',
          '54352.51',
          '54352.51',
          'SUBSCRIPTIONS',
        ],
      ],
      warnings: [
        {
          documentId: 'doc_1',
          code: 'analysis-account-unprefixed',
          message: 'The analysis account "SUBSCRIPTIONS" has no ledger prefix.',
        },
      ],
    },
  ],
};

test('publish.batch shows the bookkeeping entry the import file will contain, cell for cell', () => {
  const summary = renderSummary('publish.batch', {
    documentIds: ['doc_1'],
    preview: { itemCount: 1, grossPence: 5_435_251, vatPence: 0, currency: 'USD' },
    entryPreview: VT_ENTRY_PREVIEW,
  });

  const entry = summary.sections.find((section) => section.heading.startsWith('Entry 1'));
  // The counterparty heads the section — what an accountant recognises, and it
  // comes off the row rather than out of a second read of the document.
  expect(entry?.heading).toBe('Entry 1 — Nexora Solutions LLC');

  const byLabel = new Map(entry?.entries.map((item) => [item.label, item.value]));
  expect(byLabel.get('Document')).toBe('doc_1');
  expect(byLabel.get('Lands in')).toBe('2025-05-12-purchase-invoices.csv — data format "Payments list/purchase invoices list"');
  // Every cell, under the emitter's OWN column name and verbatim — including
  // the emitter's money rendering, which is what the file carries.
  expect(byLabel.get("Bank account name/supplier's name")).toBe('Nexora Solutions LLC');
  expect(byLabel.get('Paid to/invoice details')).toBe('INV-2291 · Imported from Neo Accounting');
  expect(byLabel.get('Gross amount')).toBe('54352.51');
  expect(byLabel.get('Input VAT')).toBe('0.00');
  expect(byLabel.get('Analysis account name')).toBe('SUBSCRIPTIONS');
  // The emitter's warning for THIS document is on the card. An unprefixed
  // analysis account is worth knowing before the release, not after the import.
  expect(byLabel.get('Check before you import — analysis-account-unprefixed')).toContain('no ledger prefix');

  // The header section states the file and the line count the accountant will
  // reconcile against their own software's preview.
  const header = summary.sections.find((section) => section.heading.startsWith('The accounting entry'));
  expect(header?.entries.find((item) => item.label === 'Import file')?.value).toContain('VT Transaction+');
  expect(header?.entries.find((item) => item.label === 'Lines the file will carry')?.value).toBe('1');
});

test('a split analysis renders one labelled line per nominal — nothing collapsed on the card', () => {
  const summary = renderSummary('publish.batch', {
    documentIds: ['doc_1'],
    preview: { itemCount: 1, grossPence: 24_000, vatPence: 0, currency: 'GBP' },
    entryPreview: {
      ...VT_ENTRY_PREVIEW,
      documents: [
        {
          ...VT_ENTRY_PREVIEW.documents[0],
          rows: [
            ['Acme', 'INV-1 · Imported from Neo Accounting', '240.00', '0.00', '150.00', '150.00', 'Cost of sales: Purchases'],
            ['Acme', 'INV-1 · Imported from Neo Accounting', '', '', '90.00', '90.00', 'Expenses: Software'],
          ],
          warnings: [],
        },
      ],
    },
  });

  const labels = summary.sections.find((section) => section.heading.startsWith('Entry 1'))?.entries.map((item) => item.label) ?? [];
  expect(labels).toContain('Line 1 · Net amount');
  expect(labels).toContain('Line 2 · Analysis account name');
  // The continuation row's empty Gross cell shows as empty, because that is
  // literally what the file carries — VT reads gross off the first line only.
  const values = new Map(summary.sections.find((s) => s.heading.startsWith('Entry 1'))?.entries.map((i) => [i.label, i.value]));
  expect(values.get('Line 2 · Gross amount')).toBe('');
});

test('a document that cannot become a row is NAMED on the card, FIRST, never dropped', () => {
  const summary = renderSummary('publish.batch', {
    documentIds: ['doc_1', 'doc_2'],
    preview: { itemCount: 2, grossPence: 100, vatPence: 0, currency: 'GBP' },
    entryPreview: {
      ...VT_ENTRY_PREVIEW,
      refusals: [{ documentId: 'doc_2', code: 'document-missing-category', message: 'This document has not been coded to a nominal.' }],
    },
  });

  // Item 29(b): the £9,000-VAT release was approved with its refusal renderable
  // only at the bottom of the card. The refusal is now the FIRST section, worded
  // as what it means for the release, and counted in the title — a reviewer
  // cannot reach the entry without passing it.
  expect(summary.title).toContain('⚠ 1 document will produce no export line');
  const checks = summary.sections[0];
  expect(checks?.heading).toBe('⚠ Checks — read before you release');
  expect(checks?.entries).toEqual([
    { label: 'Will not export — doc_2', value: 'This document has not been coded to a nominal.' },
  ]);
});

test('a document the pipeline judged non-financial is restated on the release review (D46, item 47)', () => {
  const summary = renderSummary('publish.batch', {
    documentIds: ['doc_1'],
    preview: { itemCount: 1, grossPence: 24_000, vatPence: 4_000, currency: 'GBP' },
    entryPreview: {
      ...VT_ENTRY_PREVIEW,
      documents: [
        {
          ...VT_ENTRY_PREVIEW.documents[0],
          warnings: [
            {
              documentId: 'doc_1',
              code: 'not-a-financial-document',
              message: 'The pipeline judged this not to be a financial document when it was read (Type OTHER).',
            },
          ],
        },
      ],
    },
  });

  const checks = summary.sections[0];
  expect(checks?.heading).toBe('⚠ Checks — read before you release');
  expect(checks?.entries[0]?.label).toBe('Not a financial document — doc_1');
  expect(checks?.entries[0]?.value).toContain('judged this not to be a financial document');
  // No refusal, so the title carries no will-not-export count.
  expect(summary.title).not.toContain('will produce no export line');
});

test('the correction advisory renders as its own section on an update-coding review, and gates nothing', () => {
  const summary = renderSummary(
    'document.update-coding',
    { documentId: 'doc_9', fields: { taxPence: 900_000 } },
    {
      correctionChecks: [
        {
          code: 'tax-exceeds-total',
          message: 'Tax £9,000.00 is larger than the total £994.00. A document whose tax exceeds its total will produce NO line in the export file — correct the tax or the total before approving.',
        },
      ],
    },
  );

  const checks = summary.sections.find((section) => section.heading === '⚠ Checks — read before you approve');
  expect(checks?.entries[0]).toEqual({
    label: 'Tax exceeds the total',
    value:
      'Tax £9,000.00 is larger than the total £994.00. A document whose tax exceeds its total will produce NO line in the export file — correct the tax or the total before approving.',
  });
  // Advisory, never a gate — the section says so in as many words (D44).
  expect(checks?.entries.at(-1)?.label).toBe('These checks gate nothing');

  // And with no checks, NO section — an always-present "no concerns" section
  // teaches reviewers to skip the one that matters.
  const clean = renderSummary('document.update-coding', { documentId: 'doc_9', fields: { supplierName: 'Bidfood' } });
  expect(clean.sections.some((section) => section.heading.startsWith('⚠ Checks'))).toBe(false);
});

test('a payload with no entry preview still reviews — the card falls back, it does not fail', () => {
  const summary = renderSummary('publish.batch', {
    documentIds: ['doc_1'],
    preview: { itemCount: 1, grossPence: 100, vatPence: 0, currency: 'GBP' },
  });

  expect(summary.sections.some((section) => section.heading.startsWith('Entry '))).toBe(false);
  expect(summary.sections.map((section) => section.heading)).toEqual(['Server-computed preview', 'Documents']);
});

/**
 * ⚠ **D42 copy rule, enforced the way `apps/web/src/views/ExportView.test.tsx`
 * enforces it — by reading the rendered output, not by trusting a reviewer.**
 *
 * This release has NO ledger connection and NO auto-publish. The review card may
 * say what the import file will contain; it may not say or imply that anything
 * is posted, synced, sent, or reaches accounting software on its own. The card
 * is server-rendered, so this is the surface where the rule has to hold — the
 * browser renders whatever these strings say.
 */
test('the publish review card never claims anything is transmitted (D42)', () => {
  const summary = renderSummary('publish.batch', {
    documentIds: ['doc_1'],
    preview: { itemCount: 1, grossPence: 5_435_251, vatPence: 0, currency: 'USD' },
    entryPreview: VT_ENTRY_PREVIEW,
  });

  const rendered = `${summary.title} ${summary.sections
    .map((section) => `${section.heading} ${section.entries.map((entry) => `${entry.label} ${entry.value}`).join(' ')}`)
    .join(' ')}`;

  for (const forbidden of [
    /\bsend(ing|s)? to\b/i,
    /\bsent to\b/i,
    /publish(ing|ed)? to\b/i,
    /\bsync(ed|ing|s)?\b/i,
    /\bpost(ed|ing)? to\b/i,
    /\bupload(ed|s)? to VT\b/i,
    /connect(ed|ion|s)? to\b/i,
    /\bXero\b/i,
    /\bQuickBooks\b/i,
    /\bSage\b/i,
  ]) {
    expect(rendered).not.toMatch(forbidden);
  }

  // And it says the true thing, positively.
  expect(rendered).toContain('Releases these documents for export');
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


test('the purge card states what is destroyed, what survives, and what it does NOT do', () => {
  // ⚠ The one card on this surface where "what will happen" is not recoverable
  // afterwards. Review → Approve promises that what was shown is what happens,
  // so a shortfall belongs on the card a human approves rather than in a source
  // file nobody opens — the `document.reprocess` precedent.
  const summary = renderSummary('document.purge', { documentIds: ['doc_1', 'doc_2'], reason: 'Duplicate scans' });
  const rendered = JSON.stringify(summary);

  expect(summary.title).toBe('Permanently delete 2 documents');
  expect(rendered).toContain('cannot be undone');
  // The audit trail outlives the documents, which is the only thing that makes
  // this act accountable at all.
  expect(rendered).toContain('Audit trail');
  // ⚠ THE SHORTFALL, on the card. An executor runs inside the engine's
  // transaction and may not make an external call, so the stored objects are
  // NOT deleted. Promising it and not doing it would be worse than naming it.
  expect(rendered).toContain('NOT deleted');
  // The refusal is shown as a PROMISE, not a result: the render is payload-pure
  // and may not read a database, so it cannot say whether THESE documents are
  // exported — only that the executor will check and refuse.
  expect(rendered).toContain('Refused');
  // The reason, verbatim.
  expect(rendered).toContain('Duplicate scans');
});

test('a purge card without a reason renders no empty reason section', () => {
  const summary = renderSummary('document.purge', { documentIds: ['doc_1'] });
  expect(summary.sections.some((section) => section.heading.includes('Reason'))).toBe(false);
  expect(summary.title).toBe('Permanently delete 1 document');
});
