import { describe, expect, test } from 'vitest';

import { isoDaysAgo } from '../../api/analytics';
import { screenPath } from './ChatActionCards';

describe('chat screen links', () => {
  test('client screens need a client and map onto the sub-tab address', () => {
    expect(screenPath('client-bank', 'biz_1')).toBe('/clients/biz_1/bank');
    expect(screenPath('client-supplier-statements', 'biz_1')).toBe('/clients/biz_1/supplier-statements');
    expect(screenPath('client-statements', 'biz_1')).toBe('/clients/biz_1/bank/statements');
    expect(screenPath('client-bank', undefined)).toBeNull();
  });

  test('practice tabs are left to setActiveTab; clients is its own list', () => {
    expect(screenPath('analytics', 'biz_1')).toBeNull();
    expect(screenPath('clients', undefined)).toBe('/clients');
  });
});

describe('analytics period', () => {
  test('isoDaysAgo counts back in UTC days', () => {
    const now = new Date('2026-03-01T23:30:00.000Z');
    expect(isoDaysAgo(0, now)).toBe('2026-03-01');
    expect(isoDaysAgo(29, now)).toBe('2026-01-31');
  });
});
