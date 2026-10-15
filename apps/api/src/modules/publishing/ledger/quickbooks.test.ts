import { expect, test } from 'vitest';
import type { z } from 'zod';

import type { VendorApi } from './ledger-http.js';
import { quickBooksLedger } from './quickbooks.js';

/** The realm id names no company; CompanyInfo does. A failed read still connects. */
test('resolveOrgRef names the company from CompanyInfo, keyed on the realm', async () => {
  const paths: string[] = [];
  const api = {
    async get(schema: z.ZodType<unknown>, path: string) {
      paths.push(path);
      return schema.parse({ CompanyInfo: { CompanyName: 'Meridian Trading Ltd', LegalName: 'Meridian Trading Limited' } });
    },
  } as unknown as VendorApi;

  expect(await quickBooksLedger.resolveOrgRef(api, { realmId: ' 9341 ' })).toEqual({ ref: '9341', name: 'Meridian Trading Ltd' });
  expect(paths).toEqual(['/9341/companyinfo/9341']);
});

test('no realm is no connection; a failed CompanyInfo read keeps the realm', async () => {
  const failing = {
    async get() {
      throw new Error('503');
    },
  } as unknown as VendorApi;

  expect(await quickBooksLedger.resolveOrgRef(failing, {})).toBeNull();
  expect(await quickBooksLedger.resolveOrgRef(failing, { realmId: '9341' })).toEqual({ ref: '9341' });
});
