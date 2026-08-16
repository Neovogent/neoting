/**
 * `formatjs/no-literal-string-in-jsx`, minus the glyphs that are not language.
 *
 * ── Why this file exists ────────────────────────────────────────────────────
 *
 * The rule this wraps is the one Governance §12.6 asks for: it fails the build
 * on any string typed straight into JSX, which is the only check that stops the
 * catalogue rotting one hurried component at a time. Turned on as shipped, it
 * reported 80 places in this app. Seventy-four of them are punctuation:
 *
 *     · — → + − ✓ • ⌘↵ ---- ? $ {' '}
 *
 * the middots between a date and an amount, the em-dash standing in for an
 * empty cell, the arrow in "old → new", the tick on a selected chip, the dots
 * masking an account number. Extracting those would put `documents.row.middot`
 * = "·" in the catalogue, hand a translator a bullet to translate, and teach
 * everyone reading the diff that the catalogue is where symbols live. It would
 * also bury the other six — the strings the rule was turned on to find. Those
 * are now fixed: "Cancel" on the confirm dialog and three numeric placeholders
 * are in the catalogue, a hardcoded `0` renders the count it was standing in
 * for, and the Xero brand glyph carries a disable comment that says why.
 *
 * The obvious fix is a rule option. **There isn't one.** `no-literal-string-in-jsx`
 * takes exactly one config — `props.include` / `props.exclude` — and both are
 * matchers over *tag and attribute names*, not over the matched text. Verified
 * against the installed 5.4.2 and against the current 6.4.20 published today:
 * neither version has any way to say "this glyph is not a sentence". Upgrading
 * would not help, and would be a dependency decision this repo routes past a
 * human anyway (CLAUDE.md).
 *
 * So the exemption is written here, where it can be read, in eleven lines that
 * name their own limits, rather than left as eighty `eslint-disable` comments
 * nobody will ever audit again.
 *
 * ── What it lets through, exactly ───────────────────────────────────────────
 *
 * A report is dropped only when **every** static chunk of the flagged node
 * contains no letter and no digit in any script — `\p{L}` and `\p{N}` over the
 * whole of Unicode, not an allowlist of the symbols that happen to appear in
 * this codebase today. Anything with a word in it, anything with a numeral in
 * it, and anything with one letter in it still fails:
 *
 *     <span>Cancel</span>              ✗ reported
 *     <span>3 left</span>              ✗ reported
 *     <span>X</span>                   ✗ reported  (the Xero glyph carries an
 *                                                   explicit disable comment)
 *     <input placeholder="0000" />     ✗ reported  (a numeral is localisable)
 *     <span> · </span>                 ✓ dropped
 *     {on ? '✓ ' : ''}                 ✓ dropped
 *     {`${a} · ${b}`}                  ✓ dropped   (both quasis are separators)
 *
 * The default is to report: a node shape this file does not recognise falls
 * through to the upstream report rather than being quietly swallowed. That
 * direction matters more than the predicate — a filter that fails open turns
 * the whole rule into decoration, which is worse than not having it.
 *
 * The one thing it cannot catch is a real string made only of symbols. There
 * is no such string in a bookkeeping product's UI, and if one ever appears it
 * is a `FormattedMessage` away from being right.
 */
import formatjs from 'eslint-plugin-formatjs';

const upstream = formatjs.rules['no-literal-string-in-jsx'];

/** Letters and numbers in any script. Everything else is a glyph. */
const HAS_LANGUAGE = /[\p{L}\p{N}]/u;

/**
 * The static text a flagged node contributes, or `null` when the shape is not
 * one this file claims to understand — which means "report it".
 *
 * The upstream rule reports four kinds of node, and each carries its text in a
 * different place. A `JSXAttribute` is reported whole (`placeholder="Search"`),
 * so reading its source text would find the attribute name and see letters in
 * every case; the value is what was flagged, so the value is what is judged.
 */
function staticChunks(node) {
  switch (node?.type) {
    case 'JSXText':
      return [node.value];
    case 'Literal':
      return typeof node.value === 'string' ? [node.value] : null;
    case 'TemplateLiteral':
      return node.quasis.map((q) => q.value.cooked ?? q.value.raw);
    case 'JSXAttribute':
      return node.value ? staticChunks(node.value) : null;
    default:
      return null;
  }
}

const isDecorative = (node) => {
  const chunks = staticChunks(node);
  return chunks !== null && chunks.every((c) => !HAS_LANGUAGE.test(c));
};

export const rule = {
  ...upstream,
  meta: {
    ...upstream.meta,
    docs: {
      ...upstream.meta.docs,
      description:
        'Disallow untranslated literal strings in JSX. Separators and symbols — ' +
        'anything with no letter and no digit in it — are not translatable text ' +
        'and are not reported.',
    },
  },
  create(context) {
    const filtered = (descriptor) => {
      if (isDecorative(descriptor.node)) return;
      context.report(descriptor);
    };

    // Prototype shadowing rather than a Proxy, and not by choice: ESLint 10
    // hands rules a *frozen* context (`FileContext#extend` is
    // `Object.freeze(Object.assign(Object.create(this), extension))`), and a
    // proxy that returns anything but the real value of a frozen own property
    // is an invariant violation — `get` on it throws a TypeError mid-lint.
    // Inheriting from the context and defining one own `report` shadows it
    // legally, and every other property still resolves up the chain to the
    // real thing.
    const guarded = Object.create(context, {
      report: { value: filtered, enumerable: true },
    });

    // That trick depends on the context being plain data properties, which is
    // true of every property `FileContext` defines today. If a future ESLint
    // moves them behind getters bound to internal state, this check notices and
    // hands the rule the untouched context — so the failure mode is 70-odd
    // noisy complaints about middots, not a filter that silently stops
    // filtering and takes the whole gate with it.
    const intact =
      guarded.report === filtered &&
      guarded.options === context.options &&
      guarded.sourceCode === context.sourceCode;

    return upstream.create(intact ? guarded : context);
  },
};

export default { rules: { 'no-literal-string-in-jsx': rule } };
