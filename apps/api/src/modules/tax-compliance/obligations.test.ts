import { describe, expect, it } from 'vitest';

import { computeObligations, type ObligationInputs, readLegalStructure, statusFor } from './obligations.js';

const NONE: ObligationInputs = {
  legalStructure: null,
  vatRegistered: false,
  vatFrequency: null,
  vatPeriodStart: null,
  hasEmployees: null,
  yearEndMonth: null,
  yearEndDay: null,
  incorporatedOn: null,
  accountsNextDue: null,
  confirmationStatementNextDue: null,
};
const TODAY = '2026-10-15';
const dueOf = (inputs: Partial<ObligationInputs>, kind: string) =>
  computeObligations({ ...NONE, ...inputs }, TODAY)
    .filter((o) => o.kind === kind)
    .map((o) => o.dueDate);

describe('computeObligations', () => {
  it('knows nothing about a client with no profile', () => {
    expect(computeObligations(NONE, TODAY)).toEqual([]);
  });

  it('VAT: one month and seven days after each quarter ends', () => {
    const dues = dueOf({ vatRegistered: true, vatFrequency: 'QUARTERLY', vatPeriodStart: '2026-01-01' }, 'VAT_RETURN');
    expect(dues).toContain('2026-08-07'); // Apr–Jun
    expect(dues).toContain('2026-11-07'); // Jul–Sep
    expect(dues).toContain('2027-02-07'); // Oct–Dec
    expect(dues).toContain('2027-05-07'); // Jan–Mar, 31 Mar → 7 May
    expect(dues).not.toContain('2026-05-07'); // before the look-back window
  });

  it('VAT: a February quarter end is due 7 April, and an unregistered client owes none', () => {
    expect(dueOf({ vatRegistered: true, vatFrequency: 'QUARTERLY', vatPeriodStart: '2026-12-01' }, 'VAT_RETURN')).toContain('2027-04-07');
    expect(dueOf({ vatRegistered: false, vatFrequency: 'QUARTERLY', vatPeriodStart: '2026-01-01' }, 'VAT_RETURN')).toEqual([]);
  });

  it('PAYE: the 22nd of every month, only with employees', () => {
    const dues = dueOf({ hasEmployees: true }, 'PAYE');
    expect(dues).toContain('2026-10-22');
    expect(dues).toContain('2026-11-22');
    expect(dues.every((d) => d.endsWith('-22'))).toBe(true);
    expect(dueOf({ hasEmployees: false }, 'PAYE')).toEqual([]);
  });

  it('Self Assessment: 31 Jan and 31 Jul for a sole trader, plus 5 Oct registration', () => {
    const sa = { legalStructure: 'SOLE_TRADER' as const, incorporatedOn: '2026-06-01' };
    expect(dueOf(sa, 'SA_PAYMENT')).toEqual(expect.arrayContaining(['2027-01-31', '2027-07-31', '2026-07-31']));
    expect(dueOf(sa, 'SA_REGISTRATION')).toEqual(['2027-10-05']);
    expect(dueOf({ legalStructure: 'LIMITED_COMPANY' }, 'SA_PAYMENT')).toEqual([]);
  });

  it('Corporation Tax: pay nine months and a day after year end, file at twelve months', () => {
    const ltd = { legalStructure: 'LIMITED_COMPANY' as const, yearEndMonth: 3, yearEndDay: 31 };
    expect(dueOf(ltd, 'CT_PAYMENT')).toContain('2027-01-01');
    expect(dueOf(ltd, 'CT600')).toContain('2027-03-31');
    expect(dueOf({ ...ltd, yearEndMonth: 6, yearEndDay: 30 }, 'CT_PAYMENT')).toContain('2027-04-01');
  });

  it('Companies House: accounts month-end to month-end; confirmation from incorporation', () => {
    const ltd = { legalStructure: 'LIMITED_COMPANY' as const, yearEndMonth: 6, yearEndDay: 30, incorporatedOn: '2020-11-03' };
    expect(dueOf(ltd, 'CH_ACCOUNTS')).toContain('2027-03-31');
    expect(dueOf(ltd, 'CH_CONFIRMATION')).toContain('2026-11-17');
  });

  it("Companies House's own dates win when we have them", () => {
    const ltd = { legalStructure: 'LIMITED_COMPANY' as const, yearEndMonth: 3, yearEndDay: 31, accountsNextDue: '2026-12-31', confirmationStatementNextDue: '2027-02-10' };
    expect(dueOf(ltd, 'CH_ACCOUNTS')).toEqual(['2026-12-31']); // the next is past the 400-day horizon
    expect(dueOf(ltd, 'CH_CONFIRMATION')).toEqual(['2027-02-10']);
  });

  it('keys are stable, so a re-run updates rather than duplicates', () => {
    const inputs = { ...NONE, legalStructure: 'LIMITED_COMPANY' as const, yearEndMonth: 3, yearEndDay: 31, hasEmployees: true };
    const keys = computeObligations(inputs, TODAY).map((o) => o.computeKey);
    expect(new Set(keys).size).toBe(keys.length);
    expect(computeObligations(inputs, TODAY).map((o) => o.computeKey)).toEqual(keys);
  });
});

describe('statusFor', () => {
  it('DONE beats everything; past is OVERDUE; within seven days is DUE', () => {
    expect(statusFor('2026-01-01', true, TODAY)).toBe('DONE');
    expect(statusFor('2026-10-14', false, TODAY)).toBe('OVERDUE');
    expect(statusFor('2026-10-15', false, TODAY)).toBe('DUE');
    expect(statusFor('2026-10-21', false, TODAY)).toBe('DUE');
    expect(statusFor('2026-10-22', false, TODAY)).toBe('UPCOMING');
  });
});

describe('readLegalStructure', () => {
  it('reads the free text the column has always held', () => {
    expect(readLegalStructure('Limited company')).toBe('LIMITED_COMPANY');
    expect(readLegalStructure('LTD')).toBe('LIMITED_COMPANY');
    expect(readLegalStructure('sole trader')).toBe('SOLE_TRADER');
    expect(readLegalStructure('Limited Liability Partnership')).toBe('LLP');
    expect(readLegalStructure('Partnership')).toBe('PARTNERSHIP');
    expect(readLegalStructure(null)).toBeNull();
  });
});
