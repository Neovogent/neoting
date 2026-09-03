/**
 * Entry point. Writes the ground-truth map FIRST, then renders the PDFs and
 * emits the image specifications.
 *
 *   pnpm tsx scripts/demo/invoice-test-set/build.ts
 */
import { join } from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';

import {
  BUSINESS,
  CATALOGUE,
  DOCS,
  OUT,
  buildDocs,
  lineItems,
  minusDays,
  money,
  printPdf,
  splitVat,
} from './generate.js';
import type { StatementRow, TestDoc } from './plan.js';

/** Controls carry no statement row, so their amount and date are stated here. */
const CONTROL: Record<string, { grossPence: number; date: string }> = {
  E1: { grossPence: 74_219, date: '10/06/2026' },
  E2: { grossPence: 40_775, date: '01/08/2025' },
  E3: { grossPence: 28_840, date: '15/09/2026' },
};

interface Built {
  readonly doc: TestDoc;
  readonly fileName: string;
  readonly docDate: string;
  readonly grossPence: number;
  readonly netPence: number;
  readonly vatPence: number;
}

function build(doc: TestDoc): Built {
  const control = CONTROL[doc.id];
  const first = doc.rows[0];
  const grossPence =
    control?.grossPence ?? doc.rows.reduce((sum, r) => sum + Math.abs(r.pence), 0);
  const docDate = control?.date ?? (first === undefined ? '01/01/2026' : minusDays(first.date, doc.termsDays));
  const { net, vat } = splitVat(grossPence, doc.vatRate);
  const ext = doc.format === 'pdf' ? 'pdf' : 'png';
  const slug = doc.supplier.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  return {
    doc,
    fileName: `${doc.id}_${slug}_${doc.shape === 'invoice' ? 'invoice' : doc.shape}.${ext}`,
    docDate,
    grossPence,
    netPence: net,
    vatPence: vat,
  };
}

/* ── HTML ─────────────────────────────────────────────────────────────────── */

const CSS = `
  @page { size: A4; margin: 14mm 14mm 12mm 14mm; }
  * { box-sizing: border-box; }
  body { font-family: "Helvetica Neue", Helvetica, Arial, sans-serif; font-size: 10.5pt; color: #111; margin: 0; }
  .top { display: flex; justify-content: space-between; align-items: flex-start; border-bottom: 2px solid #111; padding-bottom: 10px; }
  .sup { font-size: 17pt; font-weight: 700; letter-spacing: -0.2px; }
  .muted { color: #555; font-size: 9pt; line-height: 1.45; }
  .title { font-size: 20pt; font-weight: 700; text-align: right; letter-spacing: 1px; }
  .meta { margin-top: 4px; text-align: right; font-size: 9.5pt; line-height: 1.6; }
  .parties { display: flex; gap: 28px; margin: 18px 0 14px; }
  .parties > div { flex: 1; }
  .lbl { font-size: 7.5pt; text-transform: uppercase; letter-spacing: 1.1px; color: #777; margin-bottom: 4px; }
  table { width: 100%; border-collapse: collapse; margin-top: 6px; }
  th { text-align: left; font-size: 8pt; text-transform: uppercase; letter-spacing: 0.8px; color: #555;
       border-bottom: 1.5px solid #111; padding: 7px 6px; }
  td { padding: 6px; border-bottom: 0.5px solid #ddd; font-size: 9.5pt; }
  td.n, th.n { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
  tfoot td { border: none; padding: 3px 6px; font-size: 10pt; }
  tfoot tr.grand td { border-top: 1.5px solid #111; font-weight: 700; font-size: 11.5pt; padding-top: 8px; }
  .foot { margin-top: 26px; border-top: 0.5px solid #ccc; padding-top: 8px; font-size: 8pt; color: #666; line-height: 1.5; }
  .pill { display:inline-block; border:1px solid #111; padding:3px 9px; font-size:8.5pt; letter-spacing:0.5px; }
`;

const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function head(b: Built, title: string): string {
  const d = b.doc;
  return `<div class="top">
    <div><div class="sup">${esc(d.supplier)}</div>
      <div class="muted">${d.supplierAddress.map(esc).join('<br>')}
      ${d.vatNumber ? `<br>VAT Reg. No. ${esc(d.vatNumber)}` : ''}</div></div>
    <div><div class="title">${title}</div>
      <div class="meta"><b>${esc(d.reference)}</b><br>Date: ${b.docDate}</div></div>
  </div>
  <div class="parties">
    <div><div class="lbl">Invoice to</div>
      <div><b>${esc(BUSINESS.name)}</b><br><span class="muted">${BUSINESS.address.map(esc).join('<br>')}
      <br>VAT ${esc(BUSINESS.vatNumber)}</span></div></div>
    <div style="text-align:right"><div class="lbl">Account</div>
      <div class="muted">AMB-4471<br>Terms: ${d.termsDays === 0 ? 'On statement' : `${d.termsDays} days net`}</div></div>
  </div>`;
}

function totals(b: Built): string {
  const zero = b.doc.vatRate === 0;
  return `<tfoot>
    <tr><td colspan="2"></td><td class="n">${zero ? 'Total (zero-rated)' : 'Subtotal'}</td><td class="n">£${money(b.netPence)}</td></tr>
    ${zero ? '' : `<tr><td colspan="2"></td><td class="n">VAT @ 20%</td><td class="n">£${money(b.vatPence)}</td></tr>`}
    <tr class="grand"><td colspan="2"></td><td class="n">Total due</td><td class="n">£${money(b.grossPence)}</td></tr>
  </tfoot>`;
}

function invoiceHtml(b: Built): string {
  const cat = CATALOGUE[b.doc.supplier] ?? ['Goods'];
  const seed = b.grossPence % 997;
  const items = lineItems(b.netPence, cat, seed);
  const rows = items
    .map(
      (it, i) =>
        `<tr><td>${i + 1}</td><td>${esc(it.desc)}</td><td class="n">1</td><td class="n">£${money(it.pence)}</td></tr>`,
    )
    .join('');
  return `<!doctype html><meta charset="utf-8"><style>${CSS}</style><body>
    ${head(b, 'INVOICE')}
    <table><thead><tr><th style="width:28px">#</th><th>Description</th><th class="n" style="width:50px">Qty</th><th class="n" style="width:110px">Amount</th></tr></thead>
    <tbody>${rows}</tbody>${totals(b)}</table>
    <div class="foot">Payment by BACS to ${esc(b.doc.supplier)}. Please quote ${esc(b.doc.reference)} with your remittance.<br>
    ${b.doc.vatRate === 0 ? 'Zero-rated food supplies — VAT Act 1994, Schedule 8, Group 1.' : 'This is a VAT invoice. Please retain for your records.'}</div>
  </body>`;
}

function statementHtml(b: Built, kind: 'supplier' | 'settlement'): string {
  const isSettlement = kind === 'settlement';
  const rows = b.doc.rows
    .map((r, i) => {
      const ref = isSettlement
        ? `WP${r.date.slice(0, 2)}${r.date.slice(3, 5)}-${String(1000 + i)}`
        : `${b.doc.reference.split('-')[0]}-${String(60_000 + i * 137)}`;
      return `<tr><td>${r.date}</td><td>${esc(ref)}</td><td>${isSettlement ? 'Card settlement — net of charges' : 'Goods delivered'}</td><td class="n">£${money(r.pence)}</td></tr>`;
    })
    .join('');
  const total = b.doc.rows.reduce((s, r) => s + Math.abs(r.pence), 0);
  const period = `${b.doc.rows[0]?.date ?? ''} to ${b.doc.rows[b.doc.rows.length - 1]?.date ?? ''}`;
  return `<!doctype html><meta charset="utf-8"><style>${CSS}</style><body>
    ${head(b, isSettlement ? 'SETTLEMENT' : 'STATEMENT')}
    <div class="pill">${isSettlement ? 'MERCHANT SETTLEMENT SCHEDULE' : 'STATEMENT OF ACCOUNT'} &nbsp;·&nbsp; ${period} &nbsp;·&nbsp; ${b.doc.rows.length} items</div>
    <table><thead><tr><th style="width:90px">Date</th><th style="width:130px">${isSettlement ? 'Settlement ref' : 'Invoice no.'}</th><th>Detail</th><th class="n" style="width:110px">${isSettlement ? 'Paid to you' : 'Amount'}</th></tr></thead>
    <tbody>${rows}</tbody>
    <tfoot><tr class="grand"><td colspan="2"></td><td class="n">${isSettlement ? 'Total settled' : 'Total due'}</td><td class="n">£${money(total)}</td></tr></tfoot></table>
    <div class="foot">${
      isSettlement
        ? 'Each line was paid to your nominated account as a separate BACS credit. Amounts are net of scheme and processing charges, which are collected separately by direct debit.'
        : 'Each invoice above was settled separately. This statement is for reconciliation and is not itself a request for a single payment.'
    }</div>
  </body>`;
}

/* ── The map ──────────────────────────────────────────────────────────────── */

function groundTruth(built: Built[]): string {
  const line = (r: StatementRow): string =>
    `${r.line} | ${r.date} | ${r.description} | ${r.pence < 0 ? '−' : '+'}£${money(r.pence)}`;

  const section = (title: string, ids: string[], blurb: string): string => {
    const rows = built.filter((b) => ids.includes(b.doc.id));
    return `\n## ${title}\n\n${blurb}\n\n${rows
      .map((b) => {
        const d = b.doc;
        const expect =
          d.expectNoMatch !== null
            ? `**EXPECTED RESULT: NO MATCH** (${d.expectNoMatch.why})\n\n> ${d.expectNoMatch.detail}`
            : `**EXPECTED RESULT: ${d.rows.length} match${d.rows.length === 1 ? '' : 'es'}**\n\n` +
              '| Statement line | Date | Narrative | Amount |\n|---|---|---|---|\n' +
              d.rows.map((r) => `| ${r.line} | ${r.date} | \`${r.description}\` | ${r.pence < 0 ? '−' : '+'}£${money(r.pence)} |`).join('\n');
        return `### ${d.id} — ${d.supplier}\n\n` +
          `- **File:** \`documents/${d.format}/${b.fileName}\`\n` +
          `- **Format:** ${d.format.toUpperCase()} · ${d.shape}\n` +
          `- **Document date:** ${b.docDate}${d.termsDays > 0 ? ` (${d.termsDays} days before payment)` : ''}\n` +
          `- **Reference:** ${d.reference}\n` +
          `- **Net / VAT / Gross:** £${money(b.netPence)} / £${money(b.vatPence)} / **£${money(b.grossPence)}**\n` +
          (d.ambiguousAmount ? `- ⚠️ **Ambiguous amount** — this exact amount appears more than once in the statement.\n` : '') +
          `- **Notes:** ${d.notes}\n\n${expect}\n`;
      })
      .join('\n')}`;
  };

  const totalMatches = built.reduce((s, b) => s + (b.doc.expectNoMatch === null ? b.doc.rows.length : 0), 0);

  return `# Ground truth — invoice ↔ bank statement matching test

Generated ${new Date().toISOString().slice(0, 10)} against \`scripts/demo/bank-statement/out/statement.csv\`
(American Burger Ltd · NatWest 60-84-77 31456221 · 01/08/2025 → 31/08/2026 · 1,491 transactions).

**Read this after your test, not before it.** Every expected answer below was
derived by *building the document from* the statement line, so it is a fact about
how the file was made rather than an opinion about what it says.

## Scorecard

| | |
|---|---|
| Documents | ${built.length} (${built.filter((b) => b.doc.format === 'pdf').length} PDF, ${built.filter((b) => b.doc.format === 'image').length} image) |
| Documents that SHOULD match | ${built.filter((b) => b.doc.expectNoMatch === null).length} |
| Documents that should find NOTHING | ${built.filter((b) => b.doc.expectNoMatch !== null).length} |
| Total correct document→transaction pairs | **${totalMatches}** |
| Ambiguous-amount cases (date is the only discriminator) | ${built.filter((b) => b.doc.ambiguousAmount).length} |

**How to score.** For each document: did it find *exactly* the listed lines?
- A missed line is a **false negative** — a payment left without evidence.
- An extra line is a **false positive**, and it is the worse error: it files a
  receipt against a payment it does not evidence, and the books look reconciled
  when they are not. The four E-documents exist to measure this, and a matcher
  that scores 100% on A–D while matching any of E has failed.
${section('A · One transaction · PDF', ['A1', 'A2', 'A3', 'A4', 'A5'], 'The baseline. One purchase, one payment, a clean machine-generated PDF. A matcher that cannot do these cannot do anything.')}
${section('B · One transaction · Image (gpt-image-2)', ['B1', 'B2', 'B3', 'B4'], 'The same task, but the document is a picture. This measures the OCR rung as much as the matcher. ⚠️ See `IMAGE-FIDELITY.md` — what an image model draws is not guaranteed to be what it was asked to draw, and the verified reading of each image is recorded there.')}
${section('C · More than 10 transactions · PDF', ['C1', 'C2', 'C3'], 'One document, many payments. The document must fan out to every line — matching once on the grand total is a failure, and so is matching only the first page. C1 is deliberately the income side: those are CREDITS.')}
${section('D · More than 10 transactions · Image (gpt-image-2)', ['D1', 'D2'], 'The hardest realistic case: a many-row table that has to be read from a picture before it can be matched.')}
${section('E · Negative controls — nothing here should match', ['E1', 'E2', 'E3', 'E4'], 'Precision, not recall. Each looks entirely legitimate and none evidences a payment in the statement. E2 is the sharpest: right supplier, right period, 18 pence out.')}

---

## Every expected pair, flat

For grepping or scripted scoring.

| Doc | Statement line | Date | Narrative | Amount |
|---|---|---|---|---|
${built
  .filter((b) => b.doc.expectNoMatch === null)
  .flatMap((b) => b.doc.rows.map((r) => `| ${b.doc.id} | ${line(r)} |`))
  .join('\n')
  .replace(/\| (\d+) \| ([^|]+) \| ([^|]+) \| ([^|]+) \|/g, '| $1 | $2 | `$3` | $4 |')}
`;
}

/* ── Run ──────────────────────────────────────────────────────────────────── */

const docs = buildDocs();
const built = docs.map(build);

mkdirSync(join(DOCS, 'pdf'), { recursive: true });
mkdirSync(join(DOCS, 'images'), { recursive: true });
mkdirSync(join(OUT, '.work'), { recursive: true });

// 1 · the map, BEFORE anything is drawn.
writeFileSync(join(OUT, 'GROUND-TRUTH.md'), groundTruth(built), 'utf8');
writeFileSync(
  join(OUT, 'ground-truth.json'),
  `${JSON.stringify(
    built.map((b) => ({
      id: b.doc.id,
      file: `documents/${b.doc.format === 'pdf' ? 'pdf' : 'images'}/${b.fileName}`,
      format: b.doc.format,
      shape: b.doc.shape,
      supplier: b.doc.supplier,
      reference: b.doc.reference,
      documentDate: b.docDate,
      netPence: b.netPence,
      vatPence: b.vatPence,
      grossPence: b.grossPence,
      ambiguousAmount: b.doc.ambiguousAmount,
      expectNoMatch: b.doc.expectNoMatch,
      expectedMatches: b.doc.expectNoMatch === null ? b.doc.rows : [],
      notes: b.doc.notes,
    })),
    null,
    2,
  )}\n`,
  'utf8',
);
console.log(`map written · ${built.length} documents`);

// 2 · the PDFs.
let n = 0;
for (const b of built.filter((x) => x.doc.format === 'pdf')) {
  const html =
    b.doc.shape === 'settlement-statement'
      ? statementHtml(b, 'settlement')
      : b.doc.shape === 'supplier-statement'
        ? statementHtml(b, 'supplier')
        : invoiceHtml(b);
  const htmlPath = join(OUT, '.work', `${b.doc.id}.html`);
  writeFileSync(htmlPath, html, 'utf8');
  printPdf(htmlPath, join(DOCS, 'pdf', b.fileName));
  n += 1;
  console.log(`  pdf ${b.doc.id.padEnd(3)} ${b.fileName}`);
}
console.log(`\n${n} PDFs rendered into ${DOCS}/pdf`);

// 3 · the image specifications, for images.ts.
writeFileSync(
  join(OUT, '.work', 'image-specs.json'),
  `${JSON.stringify(
    built
      .filter((b) => b.doc.format === 'image')
      .map((b) => ({
        id: b.doc.id,
        fileName: b.fileName,
        shape: b.doc.shape,
        supplier: b.doc.supplier,
        supplierAddress: b.doc.supplierAddress,
        vatNumber: b.doc.vatNumber,
        reference: b.doc.reference,
        docDate: b.docDate,
        netPence: b.netPence,
        vatPence: b.vatPence,
        grossPence: b.grossPence,
        vatRate: b.doc.vatRate,
        rows: b.doc.rows,
        items: lineItems(b.netPence, CATALOGUE[b.doc.supplier] ?? ['Goods'], b.grossPence % 997),
      })),
    null,
    2,
  )}\n`,
  'utf8',
);
console.log(`image specs written for ${built.filter((b) => b.doc.format === 'image').length} documents`);
