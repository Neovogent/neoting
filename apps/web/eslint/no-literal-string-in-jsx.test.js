/**
 * The gate on the gate.
 *
 * `neoting/no-literal-string-in-jsx` is the only thing standing between the
 * catalogue and the next person in a hurry, and it is a rule with a filter
 * bolted onto it. A filter that quietly starts matching everything turns a
 * blocking rule into a green tick that checks nothing — the exact failure this
 * repo has already had once, when `i18n:check` was an `&&` on an exit code that
 * was always 0. So the filter's two halves are both asserted here: real copy
 * still fails, punctuation still passes.
 *
 * The cases are lifted from the app rather than invented. Every "decorative"
 * one appears verbatim in a view today.
 */
import { describe, expect, it } from 'vitest';
import { Linter } from 'eslint';
import tsParser from '@typescript-eslint/parser';
import neoting from './no-literal-string-in-jsx.js';

const linter = new Linter();

const lint = (body) =>
  linter.verify(
    `export function Probe({ a, b }: { a: string; b: string }) {\n  return (\n    <div>\n${body}\n    </div>\n  );\n}\n`,
    [
      {
        files: ['**/*.tsx'],
        languageOptions: {
          parser: tsParser,
          parserOptions: { ecmaVersion: 2023, sourceType: 'module', ecmaFeatures: { jsx: true } },
        },
        plugins: { neoting },
        rules: { 'neoting/no-literal-string-in-jsx': 'error' },
      },
    ],
    { filename: 'probe.tsx' },
  );

const messagesFor = (body) => {
  const found = lint(body);
  // A parse error would otherwise read as "no violations" and pass every
  // negative case in this file.
  const fatal = found.filter((f) => f.fatal);
  expect(fatal, JSON.stringify(fatal)).toHaveLength(0);
  return found;
};

describe('neoting/no-literal-string-in-jsx — copy still fails', () => {
  it.each([
    ['a sentence in element text', '<span>Save changes</span>'],
    ['a string literal in an expression', "<span>{'Approve'}</span>"],
    ['both arms of a ternary', "<span>{a ? 'Yes' : 'No'}</span>"],
    ['a template literal with words in it', '<span>{`${a} and ${b}`}</span>'],
    ['a placeholder attribute', '<input placeholder="Search clients" />'],
    ['an image alt', '<img src="x.png" alt="A receipt" />'],
    ['an aria-label', '<button aria-label="Close the dialog">{a}</button>'],
    // A numeral is not punctuation: the digits and the decimal separator both
    // change with the locale, so "0.00" and "0000" belong in the catalogue and
    // the rule is right to ask for them.
    ['a bare numeral', '<span>0</span>'],
    ['a number-format placeholder', '<input placeholder="0.00" />'],
    // The narrowest thing the filter must still catch. If single letters ever
    // start passing, the Xero glyph's disable comment in ClientsView becomes
    // dead and `reportUnusedDisableDirectives` says so.
    ['a single letter', '<span>X</span>'],
  ])('reports %s', (_what, body) => {
    expect(messagesFor(body).length).toBeGreaterThan(0);
  });

  it('reports the real half of a mixed ternary rather than the whole node', () => {
    const found = messagesFor("<span>{a ? 'Retry' : '—'}</span>");
    expect(found).toHaveLength(1);
  });
});

describe('neoting/no-literal-string-in-jsx — separators do not', () => {
  it.each([
    ['a middot between two fields', '<span>{a} · {b}</span>'],
    ['an em-dash standing in for an empty cell', "<span>{a ?? '—'}</span>"],
    ['an arrow between an old and a new value', '<span>{a} → {b}</span>'],
    ['a tick on a selected chip', "<span>{a ? '✓ ' : ''}</span>"],
    ['the keyboard hint', '<span>⌘↵</span>'],
    ['masked account digits', "<span>••{b ?? '----'}</span>"],
    ['an initial fallback', "<span>{a || '?'}</span>"],
    ['a separator-only template literal', '<span>{`${a} · ${b}`}</span>'],
    ['the JSX spacing idiom', "<span>{a}{' '}{b}</span>"],
    ['a currency symbol', '<span>£{a}</span>'],
    ['a percent sign', '<span>{a}%</span>'],
  ])('ignores %s', (_what, body) => {
    expect(messagesFor(body)).toHaveLength(0);
  });
});
