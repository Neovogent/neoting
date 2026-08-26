import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, test } from 'vitest';

import { UNVERSIONED_ROUTES } from '../../../config/routing.js';
import { CanonicalSourceLinkSchema } from '../canonical/canonical-row.js';

import { mintCapabilityCode } from './capability-code.js';
import {
  CAPABILITY_LINK_ORIGIN,
  CapabilityUrlError,
  assertCapabilityOrigin,
  capabilityLinkUrl,
  toCanonicalSourceLink,
} from './capability-url.js';

describe('the origin is validated, not trusted', () => {
  test('a bare https origin passes and is normalised', () => {
    expect(assertCapabilityOrigin('https://neoacc.neovogent.com')).toBe('https://neoacc.neovogent.com');
    // A trailing slash must not produce `//d/CODE`, and it must mint the same
    // bytes as the un-slashed form — byte-stability across exports.
    expect(assertCapabilityOrigin('https://neoacc.neovogent.com/')).toBe('https://neoacc.neovogent.com');
  });

  test('plaintext is refused everywhere except localhost', () => {
    expect(() => assertCapabilityOrigin('http://neoacc.neovogent.com')).toThrow(CapabilityUrlError);
    expect(assertCapabilityOrigin('http://localhost:3000')).toBe('http://localhost:3000');
  });

  test('an origin carrying a path, query or fragment is refused', () => {
    // Each of these silently changes where EVERY exported link points, in a
    // file we cannot recall.
    expect(() => assertCapabilityOrigin('https://neoacc.neovogent.com/app')).toThrow(/bare origin/);
    expect(() => assertCapabilityOrigin('https://neoacc.neovogent.com/?x=1')).toThrow(/bare origin/);
    expect(() => assertCapabilityOrigin('https://neoacc.neovogent.com/#f')).toThrow(/bare origin/);
  });

  test('a non-URL is refused', () => {
    expect(() => assertCapabilityOrigin('neoacc.neovogent.com')).toThrow(/is not a URL/);
    expect(() => assertCapabilityOrigin('')).toThrow(/is not a URL/);
  });

  test('the default is the origin the contract declares for this path item', () => {
    const spec = readFileSync(
      fileURLToPath(new URL('../../../../../../packages/contracts/openapi.yaml', import.meta.url)),
      'utf8',
    );
    expect(spec).toContain(CAPABILITY_LINK_ORIGIN);
  });
});

describe('the URL itself', () => {
  test('is origin + /d/ + code', () => {
    expect(capabilityLinkUrl('https://neoacc.neovogent.com', 'A7K2M9PQ')).toBe(
      'https://neoacc.neovogent.com/d/A7K2M9PQ',
    );
  });

  test('refuses a code that could never have been minted', () => {
    expect(() => capabilityLinkUrl(CAPABILITY_LINK_ORIGIN, '12345678')).toThrow(CapabilityUrlError);
    expect(() => capabilityLinkUrl(CAPABILITY_LINK_ORIGIN, '../secrets')).toThrow(CapabilityUrlError);
  });

  test('the pair it builds satisfies A7’s canonical schema, every time', () => {
    for (let i = 0; i < 100; i += 1) {
      const link = toCanonicalSourceLink(CAPABILITY_LINK_ORIGIN, mintCapabilityCode());
      expect(CanonicalSourceLinkSchema.safeParse(link).success).toBe(true);
      expect(link.url.endsWith(`/d/${link.code}`)).toBe(true);
    }
  });

  test('⚠ the full URL does NOT fit a 25- or 30-character reference field, and that is why rung 1 carries the bare code', () => {
    const url = capabilityLinkUrl(CAPABILITY_LINK_ORIGIN, 'A7K2M9PQ');
    // Recorded as a measurement rather than a hope. `https://` + the host + `/d/`
    // is 31 characters before the code, so the URL belongs only in a field with
    // no practical limit (VT's `Transaction notes`). The CODE is what goes in
    // `Entry details`, and eight characters fits anything.
    expect(url.length).toBeGreaterThan(30);
    expect('A7K2M9PQ'.length).toBeLessThanOrEqual(20);
  });
});

test('the route is excluded from the /v1 prefix, and the controller serves the path that is excluded', () => {
  // The same coupling `routing.test.ts` keeps for Meta's webhook, applied to
  // the URL an accountant types out of their ledger. Rename the @Controller
  // path without the exclusion and Nest mounts this at `/v1/d/:code` — where
  // every link already inside a customer's VT file 404s.
  const controller = readFileSync(fileURLToPath(new URL('./capability-link.controller.ts', import.meta.url)), 'utf8');
  const declared = /@Controller\('([^']+)'\)/.exec(controller)?.[1];
  const param = /@Get\('([^']+)'\)/.exec(controller)?.[1];

  expect(declared).toBe('d');
  expect(param).toBe(':code');
  expect(UNVERSIONED_ROUTES.map((route) => route.path)).toContain(`${declared}/${param}`);
});
