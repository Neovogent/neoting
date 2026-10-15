import { describe, expect, it } from 'vitest';

import { assertPublicHttpsUrl, isPrivateAddress, safeLookup, UnsafeUrlError } from './ssrf-guard.js';

describe('isPrivateAddress', () => {
  it.each([
    '127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254', '100.64.0.1',
    '0.0.0.0', '::1', '::', 'fc00::1', 'fd12:3456::1', 'fe80::1', '::ffff:127.0.0.1', '::ffff:10.0.0.1', 'not-an-ip',
  ])('refuses %s', (address) => {
    expect(isPrivateAddress(address)).toBe(true);
  });

  it.each(['8.8.8.8', '1.1.1.1', '172.32.0.1', '2606:4700:4700::1111', '::ffff:8.8.8.8'])('allows %s', (address) => {
    expect(isPrivateAddress(address)).toBe(false);
  });
});

describe('assertPublicHttpsUrl', () => {
  it('refuses http, credentials, private literals and the metadata address', async () => {
    await expect(assertPublicHttpsUrl('http://8.8.8.8/hook')).rejects.toBeInstanceOf(UnsafeUrlError);
    await expect(assertPublicHttpsUrl('https://user:pw@8.8.8.8/hook')).rejects.toBeInstanceOf(UnsafeUrlError);
    await expect(assertPublicHttpsUrl('https://127.0.0.1/hook')).rejects.toBeInstanceOf(UnsafeUrlError);
    await expect(assertPublicHttpsUrl('https://169.254.169.254/latest/meta-data')).rejects.toBeInstanceOf(UnsafeUrlError);
    await expect(assertPublicHttpsUrl('https://[::1]/hook')).rejects.toBeInstanceOf(UnsafeUrlError);
    await expect(assertPublicHttpsUrl('https://localhost/hook')).rejects.toBeInstanceOf(UnsafeUrlError);
    await expect(assertPublicHttpsUrl('not a url')).rejects.toBeInstanceOf(UnsafeUrlError);
  });

  it('allows a public literal, and narrows to an allow-list when given one', async () => {
    await expect(assertPublicHttpsUrl('https://8.8.8.8/hook')).resolves.toBeInstanceOf(URL);
    await expect(assertPublicHttpsUrl('https://8.8.8.8/hook', ['hooks.slack.com'])).rejects.toThrow(/hooks\.slack\.com/);
    await expect(assertPublicHttpsUrl('https://hooks.slack.com.evil.test/x', ['hooks.slack.com'])).rejects.toThrow(/hooks\.slack\.com/);
  });
});

describe('safeLookup', () => {
  it('refuses a name that resolves inward, at connect time', async () => {
    const error = await new Promise<NodeJS.ErrnoException | null>((resolve) => {
      safeLookup('localhost', {}, (err) => resolve(err));
    });
    expect(error?.code).toBe('ESSRF');
  });
});
