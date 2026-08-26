import { describe, expect, it } from 'vitest';
import { renderLegalMarkdown } from './markdown';

// The real documents, raw. `?raw` bypasses the build plugin (its id filter
// requires the id to END in `.md`), so what arrives here is the markdown as
// authored — warning banners, drafting comments and all — and the suite runs
// the same transform the build runs over exactly the bytes the build sees.
import termsRaw from '../../../../../docs/legal/terms-of-service.md?raw';
import privacyRaw from '../../../../../docs/legal/privacy-notice.md?raw';
import dpaRaw from '../../../../../docs/legal/data-processing-terms.md?raw';
import refundsRaw from '../../../../../docs/legal/refund-and-cancellation.md?raw';

/**
 * Two kinds of pin. The synthetic cases pin the transform's own rules — what
 * is escaped, what is stripped, what a placeholder becomes. The real-document
 * cases pin the CLAIMS the legal pack makes about publication: the
 * drafting-aid banner and the solicitor-facing comments must not reach a
 * customer, and the in-page tables of contents must actually land somewhere.
 * They deliberately do not pin prose — the documents are Shakib's to edit
 * (S6), and a wording change must not fail this suite.
 */

const REAL_DOCS = [
  ['terms-of-service', termsRaw],
  ['privacy-notice', privacyRaw],
  ['data-processing-terms', dpaRaw],
  ['refund-and-cancellation', refundsRaw],
] as const;

describe('the published body of every real document', () => {
  it.each(REAL_DOCS)('%s: strips the drafting-aid banner and every drafting comment', (_slug, raw) => {
    const { html } = renderLegalMarkdown(raw);

    // The banner's own vocabulary, in any casing. The raw files all carry at
    // least one of these; the published body may carry none.
    expect(html).not.toMatch(/NOT LEGAL ADVICE/i);
    expect(html).not.toMatch(/DRAFTING AID/i);
    expect(html).not.toMatch(/REMOVE THIS (BLOCK|BANNER)/i);
    // Comments are stripped, not escaped into visible text.
    expect(html).not.toContain('&lt;!--');
    expect(html).not.toContain('<!--');
  });

  it.each(REAL_DOCS)('%s: opens with its own h1 and exports it as the title', (_slug, raw) => {
    const { html, title } = renderLegalMarkdown(raw);
    expect(html.startsWith('<h1 ')).toBe(true);
    expect(title.length).toBeGreaterThan(0);
  });

  it.each(REAL_DOCS)('%s: highlights every remaining placeholder instead of hiding it', (_slug, raw) => {
    const { html, placeholderCount } = renderLegalMarkdown(raw);
    // The count counts the published body — while it is non-zero, the marks
    // must exist; when S6 resolves them all, both sides go to zero together.
    expect(placeholderCount).toBe((html.match(/\[PLACEHOLDER/g) ?? []).length);
    if (placeholderCount > 0) expect(html).toContain('<mark data-legal-placeholder>');
    else expect(html).not.toContain('data-legal-placeholder');
  });

  it.each(REAL_DOCS)('%s: every in-page anchor lands on a heading id', (_slug, raw) => {
    const { html } = renderLegalMarkdown(raw);
    const ids = new Set([...html.matchAll(/<h[1-6] id="([^"]+)"/g)].map((match) => match[1]));
    const anchors = [...html.matchAll(/href="#([^"]+)"/g)].map((match) => match[1]);
    for (const anchor of anchors) {
      expect(ids, `no heading answers #${anchor}`).toContain(anchor);
    }
  });
});

describe('the transform rules', () => {
  it('escapes markup in the source rather than executing it', () => {
    const { html } = renderLegalMarkdown('# T\n\nA <script>alert(1)</script> & a "quote".');
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('&amp;');
  });

  it('drops a leading banner however the front matter is arranged, and keeps a body quote', () => {
    const doc = ['> REMOVE ME', '> before publishing.', '', '---', '', '# Title', '', '> A quoted clause.', ''].join('\n');
    const { html } = renderLegalMarkdown(doc);
    expect(html).not.toContain('REMOVE ME');
    expect(html).toContain('<blockquote><p>A quoted clause.</p></blockquote>');
  });

  it('renders the subset the documents use', () => {
    const doc = [
      '# One',
      '',
      '## 2. The words we use',
      '',
      'Bold **words**, *leaning* words, `code`, and a [link](https://example.com/a).',
      '',
      '- first',
      '- second wraps',
      '  onto another line',
      '',
      '1. numbered',
      '2. also',
      '',
      '| Head | Also |',
      '|---|---|',
      '| a | b |',
      '',
      '---',
    ].join('\n');
    const { html, title } = renderLegalMarkdown(doc);
    expect(title).toBe('One');
    expect(html).toContain('<h2 id="2-the-words-we-use">');
    expect(html).toContain('<strong>words</strong>');
    expect(html).toContain('<em>leaning</em>');
    expect(html).toContain('<code>code</code>');
    expect(html).toContain('<a href="https://example.com/a">link</a>');
    expect(html).toContain('<li>second wraps onto another line</li>');
    expect(html).toContain('<ol><li>numbered</li><li>also</li></ol>');
    expect(html).toContain('<th>Head</th>');
    expect(html).toContain('<td>b</td>');
    expect(html).toContain('<hr />');
  });

  it('marks a placeholder — including the nested shape the drafts really use', () => {
    const nested = '[PLACEHOLDER: outer records **[PLACEHOLDER: inner]** — confirm]';
    const { html, placeholderCount } = renderLegalMarkdown(`# T\n\nSee ${nested} here.`);
    // One mark around the whole nested marker; both literal tokens counted,
    // so the count keeps parity with a grep of the source.
    expect(placeholderCount).toBe(2);
    expect(html.match(/<mark data-legal-placeholder>/g)).toHaveLength(1);
    expect(html).toContain('<strong>[PLACEHOLDER: inner]</strong>');
  });

  it('does not read a clause number as a list item', () => {
    const { html } = renderLegalMarkdown('# T\n\n9.4 Billing is monthly in advance.');
    expect(html).toContain('<p>9.4 Billing is monthly in advance.</p>');
    expect(html).not.toContain('<ol');
  });
});
