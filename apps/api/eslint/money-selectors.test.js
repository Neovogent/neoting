/**
 * The gate on the money gate (R5; CI family `money-type`, §14.3).
 *
 * The money rule is four esquery selectors inside `no-restricted-syntax`, and
 * a selector has the worst possible failure mode: a typo does not error, it
 * matches nothing, forever, silently. So both halves are asserted the same way
 * the other custom gates are — float-touches-pence still fails, the sanctioned
 * shapes still pass.
 *
 * The block is duplicated across apps/api and apps/web (there is no shared
 * lint package to put it in, and inventing one for four selectors would be a
 * dependency decision), so this file also pins the two copies to each other:
 * if someone tightens one and not the other, this fails before review has to
 * notice.
 */
import { describe, expect, it } from 'vitest';
import { Linter } from 'eslint';
import tsParser from '@typescript-eslint/parser';
import apiConfig from '../eslint.config.js';
import webConfig from '../../web/eslint.config.js';

const moneyEntries = (config) => {
  const block = config.find((c) => c.rules && c.rules['no-restricted-syntax']);
  expect(block, 'a config lost its no-restricted-syntax block').toBeDefined();
  const [severity, ...entries] = block.rules['no-restricted-syntax'];
  expect(severity).toBe('error');
  return entries;
};

const entries = moneyEntries(apiConfig);

describe('the two copies of the money block', () => {
  it('are identical, selector for selector', () => {
    expect(moneyEntries(webConfig)).toEqual(entries);
  });
});

const linter = new Linter();

const lint = (code) =>
  linter.verify(
    code,
    [
      {
        files: ['**/*.ts'],
        languageOptions: {
          parser: tsParser,
          parserOptions: { ecmaVersion: 2023, sourceType: 'module' },
        },
        rules: { 'no-restricted-syntax': ['error', ...entries] },
      },
    ],
    { filename: 'probe.ts' },
  );

const messagesFor = (code) => {
  const found = lint(code);
  // A parse error would read as "no violations" and pass every negative case.
  const fatal = found.filter((f) => f.fatal);
  expect(fatal, JSON.stringify(fatal)).toHaveLength(0);
  return found;
};

describe('money selectors — a float touching pence fails', () => {
  it.each([
    ['a float literal born into a money field', 'const doc = { totalPence: 12.34 };'],
    ['a signed float — still a float', 'const doc = { amountPence: -0.5 };'],
    ['a float assigned into a money member', 'row.taxPence = 2.5;'],
    ['a float declared into a money name', 'let balancePence = 1.5;'],
    ['VAT as a float multiplier (the shape Math.round would launder)', 'const vat = totalPence * 0.2;'],
    ['the same multiplier written the other way round', 'const vat = 0.2 * doc.totalPence;'],
    ['a computed money member in float arithmetic', "const half = doc['amountPence'] / 2.5;"],
    ['a quoted money key', "const doc = { 'totalPence': 0.01 };"],
  ])('reports %s', (_what, code) => {
    expect(messagesFor(code).length).toBeGreaterThan(0);
  });
});

describe('money selectors — everything the codebase actually does passes', () => {
  it.each([
    ['integer pence', 'const doc = { totalPence: 1234 };'],
    // The web display boundary: `fromPence` takes a *parameter* named pence —
    // lowercase, not a money-typed field name — and returns pounds. That the
    // crossing is visible in the name is the design, not a gap.
    ['the pence-to-pounds display boundary', 'const pounds = pence / 100;'],
    ['the pounds-to-pence parse boundary', 'const doc = { totalPence: Math.round(pounds * 100) };'],
    ['integer scaling rounded once at the end', 'const vat = Math.round(totalPence * 20 / 100);'],
    ['a ratio of two pence values', 'const ratio = aPence / bPence;'],
    ['a float nowhere near money', 'const opacity = 0.35;'],
    ['a float in a non-money field', 'const doc = { confidence: 12.34 };'],
    ['time arithmetic', 'const ms = seconds * 1000;'],
    ['a pence field fed from a variable', 'const doc = { totalPence: computed };'],
  ])('ignores %s', (_what, code) => {
    expect(messagesFor(code)).toHaveLength(0);
  });
});
