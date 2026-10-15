import { describe, expect, it } from 'vitest';

import { validateVrn } from './vat-number.js';

describe('validateVrn', () => {
  it('accepts a real original-series number, in any spacing', () => {
    expect(validateVrn('GB 980 7806 84')).toMatchObject({ valid: true, normalised: 'GB980780684' });
    expect(validateVrn('980780684')).toMatchObject({ valid: true, normalised: 'GB980780684' });
    expect(validateVrn('gb980.780.684')).toMatchObject({ valid: true });
  });

  it('accepts both checksum series (mod 97, and the 9755 +55 series)', () => {
    // 1234567 weighs to 112; +82 = 194 = 2×97; +27 (+55) = 194 too.
    expect(validateVrn('GB123456782')).toMatchObject({ valid: true });
    expect(validateVrn('GB123456727')).toMatchObject({ valid: true });
  });

  it('refuses a bad checksum, naming why', () => {
    expect(validateVrn('GB123456789')).toEqual({ valid: false, normalised: 'GB123456789', reason: 'INVALID_CHECKSUM' });
    expect(validateVrn('GB000000000')).toMatchObject({ valid: false, reason: 'INVALID_CHECKSUM' });
  });

  it('refuses what cannot be a VRN at all', () => {
    for (const raw of ['', 'GB12345678', 'GB1234567890', 'FR12345678901', 'ABCDEFGHI']) {
      expect(validateVrn(raw)).toMatchObject({ valid: false, reason: 'INVALID_FORMAT' });
    }
  });

  it('checks a branch-trader number on its first nine digits', () => {
    expect(validateVrn('GB980780684001')).toMatchObject({ valid: true, normalised: 'GB980780684' });
  });

  it('knows the government and health-authority ranges', () => {
    expect(validateVrn('GBGD001')).toMatchObject({ valid: true, shape: 'GOVERNMENT' });
    expect(validateVrn('GBHA599')).toMatchObject({ valid: true, shape: 'HEALTH' });
    expect(validateVrn('GBGD500')).toMatchObject({ valid: false, reason: 'INVALID_FORMAT' });
    expect(validateVrn('GBHA499')).toMatchObject({ valid: false, reason: 'INVALID_FORMAT' });
  });
});
