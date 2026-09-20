import { expect, test } from 'vitest';
import type { z } from 'zod';

import type { PublishBillRequest } from '../ledger-adapter.js';
import type { VendorApi } from './ledger-http.js';
import type { ReferenceItem } from './reference-sync.js';
import type { ResolvedConnection } from './token-store.js';
import type { PublishContext } from './vendor-ledger.js';
import { VENDORS } from './vendors.js';
import { xeroLedger } from './xero.js';

/**
 * What Xero is actually SENT — the body, not the client.
 *
 * ⚠ Every assertion here was bought by posting a real bill and then reading
 * Xero's own screen. The unit suite was completely green on the day the bill it
 * produced was a DRAFT nobody had approved and a £899.99 invoice that another
 * vendor had recorded at £1,079.99, because nothing anywhere asserted the shape
 * of the request. `ledger-lane.integration.test.ts` drives a real socket, but it
 * speaks FreeAgent's shapes and needs a database; this needs neither and pins
 * the three fields that were each wrong once.
 */

/** A recording stand-in. Only the three verbs the adapter uses. */
function fakeApi(posted: unknown[]): VendorApi {
  return {
    async get() {
      throw new Error('publish() must not GET');
    },
    async postJson(schema: z.ZodType<unknown>, path: string, body: unknown) {
      posted.push({ path, body });
      return schema.parse({
        Invoices: [{ InvoiceID: 'inv_1', InvoiceNumber: 'NT-TEST', Total: 899.99, TotalTax: 150 }],
      });
    },
    async postBytes(schema: z.ZodType<unknown>) {
      return schema.parse({ Attachments: [{ AttachmentID: 'att_1' }] });
    },
  } as unknown as VendorApi;
}

const ACCOUNT: ReferenceItem = { id: 'acc_1', code: '429', name: 'General Expenses', active: true };

function context(posted: unknown[], over: Partial<PublishBillRequest> = {}): PublishContext {
  const connection: ResolvedConnection = {
    integrationId: 'int_1',
    vendor: VENDORS.xero,
    orgRef: 'tenant_1',
    accessToken: 'tok',
  };
  const request: PublishBillRequest = {
    documentId: 'doc_1',
    attempt: 1,
    target: { integrationId: 'int_1', kind: 'XERO', orgRef: 'tenant_1' },
    supplierName: 'Currys Business',
    categoryCode: '429',
    currency: 'GBP',
    // The gross a human read off the receipt, and the VAT already inside it.
    totalPence: 89_999,
    taxPence: 15_000,
    documentDate: '2026-08-08',
    reference: null,
    attachment: null,
    ...over,
  };
  return {
    api: fakeApi(posted),
    connection,
    request,
    attachment: { ok: false, reason: 'no file in this test' },
    accounts: [ACCOUNT],
    suppliers: [],
    taxRates: [],
    bankAccounts: [],
    docNumber: 'NT-TEST',
  };
}

function bodyOf(posted: unknown[]): Record<string, unknown> {
  const first = posted[0] as { body: { Invoices: Record<string, unknown>[] } };
  return first.body.Invoices[0] ?? {};
}

/**
 * ⚠ **The bill has to be IN the books, not beside them.**
 *
 * Xero's own screen showed `NT-2FH97ZFSZ021D` as a **Draft** with an unpressed
 * Approve button — absent from the P&L, absent from the VAT return, absent from
 * Bills to pay — while the publish dialog had told the accountant *"Approving
 * creates these entries in this client's Xero books"* and the document sat
 * PUBLISHED. Every figure was right and the sentence was false. Owner's call,
 * 20 Sep 2026: post live, like QuickBooks and FreeAgent already do.
 */
test('the bill is posted AUTHORISED, so approving in Neoting moves the books', async () => {
  const posted: unknown[] = [];
  const result = await xeroLedger.publish(context(posted));

  expect(result.ok).toBe(true);
  expect(bodyOf(posted)['Status']).toBe('AUTHORISED');
});

/**
 * ⚠ The 20% overstatement, from the other side. `totalPence` is the GROSS;
 * declaring the line exclusive makes Xero add VAT on top of a figure that
 * already contains it, which is what QuickBooks did to the very same document
 * (£899.99 booked as £1,079.99) before #313.
 */
test('money goes up GROSS and tax-inclusive, never net', async () => {
  const posted: unknown[] = [];
  await xeroLedger.publish(context(posted));

  const body = bodyOf(posted);
  expect(body['LineAmountTypes']).toBe('Inclusive');
  const line = (body['LineItems'] as Record<string, unknown>[])[0] ?? {};
  // 899.99, not 749.99 — the gross, with the VAT stated separately.
  expect(line['UnitAmount']).toBe(899.99);
  expect(line['TaxAmount']).toBe(150);
  expect(line['AccountCode']).toBe('429');
});

/**
 * The duplicate guard that outlives Xero's six-minute idempotency window: a
 * retry of the same approval carries the same `InvoiceNumber`, and Xero refuses
 * a second ACCPAY holding one it already has.
 */
test('the doc number rides as InvoiceNumber, and a missing reference falls back to it', async () => {
  const posted: unknown[] = [];
  await xeroLedger.publish(context(posted));

  const body = bodyOf(posted);
  expect(body['InvoiceNumber']).toBe('NT-TEST');
  expect(body['Reference']).toBe('NT-TEST');
  expect(body['Type']).toBe('ACCPAY');
});

/**
 * ⚠ **A GUID cannot answer the question the connection screen asks.** That card
 * warns *"unless you mean to write to this client's real books"* and then
 * printed `e5e7917d-6621-4666-8264-d81ccb7758ea` underneath it. The name was in
 * the same response all along, parsed and thrown away one line later.
 */
test('resolveOrgRef carries the organisation NAME, not just the tenant id', async () => {
  const api = {
    async get(schema: z.ZodType<unknown>) {
      return schema.parse([{ tenantId: 'tenant_1', tenantName: 'Neoting Sandbox Ltd', tenantType: 'ORGANISATION' }]);
    },
  } as unknown as VendorApi;

  expect(await xeroLedger.resolveOrgRef(api, {})).toEqual({ ref: 'tenant_1', name: 'Neoting Sandbox Ltd' });
});

test('a tenant with no name still connects — the ref alone is enough to route on', async () => {
  const api = {
    async get(schema: z.ZodType<unknown>) {
      return schema.parse([{ tenantId: 'tenant_1' }]);
    },
  } as unknown as VendorApi;

  expect(await xeroLedger.resolveOrgRef(api, {})).toEqual({ ref: 'tenant_1' });
});

/** A category the client's chart does not hold is a per-item REFUSAL, never a throw. */
test('an unmatched category refuses with a reason and posts nothing', async () => {
  const posted: unknown[] = [];
  const result = await xeroLedger.publish(context(posted, { categoryCode: 'not-a-code' }));

  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.failure.message).toContain('not-a-code');
  expect(posted).toHaveLength(0);
});
