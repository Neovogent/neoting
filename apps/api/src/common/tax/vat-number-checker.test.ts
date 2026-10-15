import { describe, expect, it, vi } from 'vitest';

import { HmrcVatClient, VatNumberChecker } from './vat-number-checker.js';

describe('VatNumberChecker', () => {
  it('without HMRC keys answers checksum-only and says so', async () => {
    const verdict = await new VatNumberChecker(null).check('GB980780684');
    expect(verdict).toMatchObject({ status: 'CHECKSUM_ONLY', source: 'CHECKSUM', vatNumber: 'GB980780684' });
    expect(verdict.note).toMatch(/not configured/);
  });

  it('never asks HMRC about a number that fails the checksum', async () => {
    const hmrc = { lookup: vi.fn() };
    const verdict = await new VatNumberChecker(hmrc).check('GB123456789');
    expect(verdict.status).toBe('INVALID_CHECKSUM');
    expect(hmrc.lookup).not.toHaveBeenCalled();
  });

  it('caches HMRC answers and degrades to checksum-only when HMRC throws', async () => {
    const hmrc = { lookup: vi.fn().mockResolvedValueOnce({ registered: true, name: 'Acme Ltd', address: '1 High St' }) };
    const checker = new VatNumberChecker(hmrc);
    expect(await checker.check('980780684')).toMatchObject({ status: 'VALID', source: 'HMRC', registeredName: 'Acme Ltd' });
    expect(await checker.check('GB 980 7806 84')).toMatchObject({ status: 'VALID' });
    expect(hmrc.lookup).toHaveBeenCalledTimes(1);

    const failing = new VatNumberChecker({ lookup: vi.fn().mockRejectedValue(new Error('down')) });
    expect(await failing.check('GB980780684')).toMatchObject({ status: 'CHECKSUM_ONLY', note: expect.stringMatching(/could not be reached/) });
  });
});

describe('HmrcVatClient', () => {
  it('fetches a client-credentials token, then parses the v2 lookup', async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.endsWith('/oauth/token')) return new Response(JSON.stringify({ access_token: 't', expires_in: 14400 }));
      if (url.endsWith('/lookup/980780684')) {
        return new Response(JSON.stringify({ target: { name: 'Acme Ltd', vatNumber: '980780684', address: { line1: '1 High St', postcode: 'AB1 2CD' } } }));
      }
      return new Response('{}', { status: 404 });
    });
    const client = new HmrcVatClient({ clientId: 'id', clientSecret: 's', baseUrl: 'https://hmrc.test' }, fetchImpl as unknown as typeof fetch);
    expect(await client.lookup('980780684')).toEqual({ registered: true, name: 'Acme Ltd', address: '1 High St, AB1 2CD' });
    expect(await client.lookup('123456782')).toEqual({ registered: false });
    expect(fetchImpl.mock.calls.filter(([url]) => String(url).endsWith('/oauth/token'))).toHaveLength(1);
  });
});
