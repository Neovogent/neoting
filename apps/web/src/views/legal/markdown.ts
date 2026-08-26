/**
 * The markdown → HTML transform for the legal pack (launch stage M4).
 *
 * `docs/legal/*.md` is the source of truth — the pages render it rather than
 * retyping it, so a correction is made once (the legal pack's own README makes
 * that an instruction, not a preference). This module is the whole renderer:
 * it runs at BUILD time, inside the `neoting-legal-docs` plugin in
 * `vite.config.ts`, so no parser ships to the client and — more importantly —
 * neither do the bytes it strips:
 *
 * - **HTML comments.** The drafting maps ("which statute each clause
 *   satisfies", "Art. 13 compliance map") are notes to the reviewing
 *   solicitor. A runtime renderer would merely not display them; they would
 *   still be readable in the served chunk. Stripping at build removes them
 *   from the artefact.
 * - **The leading drafting-aid banner.** Each document opens with a
 *   blockquote saying "NOT LEGAL ADVICE — REMOVE BEFORE PUBLICATION", and the
 *   pack's README says in as many words that the block must not be published.
 *   Every leading blockquote run (plus blank lines and rules) before the
 *   first real content is dropped, so the banner cannot reach a customer even
 *   if a future edit reshuffles the front matter.
 *
 * What it deliberately does NOT strip: `[PLACEHOLDER: …]` markers in the body.
 * Those are unresolved facts only Shakib can supply (S6), and silently hiding
 * one would publish a legal document with a hole where a commitment should
 * be. They render as a highlighted `<mark data-legal-placeholder>` instead,
 * are counted, and the count drives both a build warning and the draft banner
 * `LegalView` shows — loud, never quiet. M4's own instruction is that a page
 * with a placeholder still in it must not go live; the count is how that stays
 * checkable.
 *
 * It is a subset renderer, not a markdown engine: the four documents use ATX
 * headings, paragraphs, `---` rules, `-` and `1.` lists (with two-space
 * continuation lines), pipe tables, blockquotes, bold, italics, inline code
 * and `[text](url)` links — measured, not assumed. Anything it does not
 * recognise renders as an escaped paragraph rather than being dropped, and
 * every heading gets a GitHub-style id because the terms and the refund
 * policy both carry in-page `#slug` tables of contents.
 */

export interface RenderedLegalDoc {
  /** The document body as HTML — headings, lists, tables, marked placeholders. */
  html: string;
  /** The first h1's plain text, for the page `<title>`-of-sorts uses. */
  title: string;
  /** How many `[PLACEHOLDER…]` markers remain in the PUBLISHED body. */
  placeholderCount: number;
}

/** Escapes the four characters that would otherwise become markup. */
const escapeHtml = (text: string) =>
  text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');

/**
 * One nesting level of brackets, because the drafts really do nest one:
 * "[PLACEHOLDER: … records **[PLACEHOLDER: …]** — confirm]".
 */
const PLACEHOLDER = /\[PLACEHOLDER(?:[^\][]|\[[^\]]*\])*\]/g;

/**
 * Inline markdown on already-escaped text. Order matters: placeholders are
 * marked first (their content may itself contain emphasis, which then renders
 * inside the mark), code spans before emphasis so a starred word in a path is
 * not italicised, links before emphasis so bold link text still resolves.
 */
function renderInline(raw: string): string {
  return escapeHtml(raw)
    .replace(PLACEHOLDER, (marker) => `<mark data-legal-placeholder>${marker}</mark>`)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '<a href="$2">$1</a>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\*([^*]+)\*/g, '<em>$1</em>');
}

/** Inline markdown reduced to plain text — for the title export. */
const plainInline = (raw: string) =>
  raw
    .replace(/\[([^\]]+)\]\([^)\s]+\)/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .trim();

/**
 * GitHub's heading slugs, which is the dialect the documents' own tables of
 * contents link with (`#15-data-protection-who-is-responsible-for-what`):
 * lowercase, punctuation dropped, spaces to hyphens, `-1` on a repeat.
 */
function slugger() {
  const seen = new Map<string, number>();
  return (text: string) => {
    const base = text
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s_-]/gu, '')
      .trim()
      .replace(/\s+/g, '-');
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    return n === 0 ? base : `${base}-${n}`;
  };
}

const isHr = (line: string) => /^-{3,}\s*$/.test(line);
const isBlank = (line: string) => line.trim() === '';

/** A table separator row: `|---|:---:|`. */
const isTableSeparator = (line: string) =>
  /^\|?[\s:|-]+\|?$/.test(line) && line.includes('-') && line.includes('|');

const splitRow = (line: string) =>
  line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((cell) => cell.trim());

/**
 * Drops everything before the first real content that is only front matter:
 * blank lines, horizontal rules, and — the point — the drafting-aid
 * blockquote. Runs of each are dropped from the top until a line that is none
 * of the three, so a banner is removed wherever it sits in the preamble, and
 * a document that opens with its title straight away loses nothing.
 */
function stripFrontMatter(lines: string[]): string[] {
  let start = 0;
  while (start < lines.length) {
    const line = lines[start] ?? '';
    if (isBlank(line) || isHr(line) || line.startsWith('>')) start += 1;
    else break;
  }
  return lines.slice(start);
}

export function renderLegalMarkdown(source: string): RenderedLegalDoc {
  // HTML comments first — they may span lines and contain anything, including
  // text that looks like the blocks below.
  const withoutComments = source.replace(/<!--[\s\S]*?-->/g, '');
  const lines = stripFrontMatter(withoutComments.split('\n'));

  const slugOf = slugger();
  const out: string[] = [];
  let title = '';

  // The three accumulators. At most one is open at a time; `flush` closes
  // whichever it is, so every block boundary goes through one place.
  let paragraph: string[] = [];
  let list: { ordered: boolean; start: number; items: string[] } | null = null;
  let quote: string[] = [];

  const flush = () => {
    if (paragraph.length > 0) {
      out.push(`<p>${renderInline(paragraph.join(' '))}</p>`);
      paragraph = [];
    }
    if (list) {
      const items = list.items.map((item) => `<li>${renderInline(item)}</li>`).join('');
      const startAttr = list.ordered && list.start !== 1 ? ` start="${list.start}"` : '';
      out.push(list.ordered ? `<ol${startAttr}>${items}</ol>` : `<ul>${items}</ul>`);
      list = null;
    }
    if (quote.length > 0) {
      const inner = quote
        .join('\n')
        .split(/\n{2,}/)
        .filter((part) => part.trim() !== '')
        .map((part) => `<p>${renderInline(part.replace(/\n/g, ' ').trim())}</p>`)
        .join('');
      out.push(`<blockquote>${inner}</blockquote>`);
      quote = [];
    }
  };

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? '';

    if (isBlank(line)) {
      // Blank inside a blockquote is a paragraph break within it, not its end
      // — but only when the quote continues; a trailing blank closes it.
      if (quote.length > 0 && (lines[i + 1] ?? '').startsWith('>')) {
        quote.push('');
        continue;
      }
      flush();
      continue;
    }

    const heading = /^(#{1,6})\s+(.+?)\s*$/.exec(line);
    if (heading) {
      flush();
      const level = heading[1]?.length ?? 1;
      const text = heading[2] ?? '';
      if (level === 1 && title === '') title = plainInline(text);
      out.push(`<h${level} id="${slugOf(plainInline(text))}">${renderInline(text)}</h${level}>`);
      continue;
    }

    if (isHr(line)) {
      flush();
      out.push('<hr />');
      continue;
    }

    if (line.startsWith('>')) {
      if (paragraph.length > 0 || list) flush();
      quote.push(line.replace(/^>\s?/, ''));
      continue;
    }

    if (line.startsWith('|')) {
      flush();
      const rows: string[] = [];
      while (i < lines.length && (lines[i] ?? '').trimStart().startsWith('|')) {
        rows.push(lines[i] ?? '');
        i += 1;
      }
      i -= 1;
      const headerIsSeparated = rows.length > 1 && isTableSeparator(rows[1] ?? '');
      const head = headerIsSeparated
        ? `<thead><tr>${splitRow(rows[0] ?? '')
            .map((cell) => `<th>${renderInline(cell)}</th>`)
            .join('')}</tr></thead>`
        : '';
      const bodyRows = (headerIsSeparated ? rows.slice(2) : rows)
        .filter((row) => !isTableSeparator(row))
        .map((row) => `<tr>${splitRow(row).map((cell) => `<td>${renderInline(cell)}</td>`).join('')}</tr>`)
        .join('');
      out.push(`<table>${head}<tbody>${bodyRows}</tbody></table>`);
      continue;
    }

    const ulItem = /^-\s+(.+)$/.exec(line);
    const olItem = /^(\d+)\.\s+(.+)$/.exec(line);
    if (ulItem || olItem) {
      const ordered = !!olItem;
      if (paragraph.length > 0 || quote.length > 0 || (list && list.ordered !== ordered)) flush();
      list ??= { ordered, start: olItem ? Number(olItem[1]) : 1, items: [] };
      list.items.push((olItem ? olItem[2] : ulItem?.[1]) ?? '');
      continue;
    }

    // A wrapped continuation: the terms document really does wrap its list
    // items and its party paragraph with a two-space indent.
    const continuation = /^\s{2,}(\S.*)$/.exec(line);
    if (continuation) {
      const text = continuation[1] ?? '';
      if (list && list.items.length > 0) {
        list.items[list.items.length - 1] += ` ${text}`;
      } else {
        paragraph.push(text);
      }
      continue;
    }

    if (list || quote.length > 0) flush();
    paragraph.push(line.trim());
  }
  flush();

  const published = out.join('\n');
  const placeholderCount = (published.match(/\[PLACEHOLDER/g) ?? []).length;

  return { html: published, title, placeholderCount };
}
