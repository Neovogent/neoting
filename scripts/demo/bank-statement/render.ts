// Step 3 — ONE ledger, two artifacts.
//
// The PDF and the CSV are rendered from the same `Ledger`, in the same order,
// with the same descriptions and the same accumulated balances. If they could
// diverge the fixture would be worthless: the point of it is that the file an
// accountant reads and the file the parser reads are the same statement.
//
// ## Why the PDF is paginated HERE and not by the browser
//
// Chrome's `--print-to-pdf` gives no way to set a header/footer template from
// the command line, and CSS `counter(page)` in a `@page` margin box is not
// supported — so "Page 3 of 34", the per-page carried-forward line and the
// repeated column headers all have to be laid out before the HTML is written.
// Fixed-height rows make that exact: `sheets.length` is the page count, and
// `verify.ts` asserts the printed PDF agrees.

import { isoToLong, isoToUk, penceToAmount, type Ledger, type LedgerRow } from './ledger.js';

/** Transaction rows per page. Each table also carries a b/f and a c/f line. */
const FIRST_PAGE_ROWS = 28;
const PAGE_ROWS = 44;

export interface Page {
  readonly index: number;
  readonly rows: LedgerRow[];
  readonly broughtForwardPence: number;
  readonly carriedForwardPence: number;
}

export function paginate(ledger: Ledger): Page[] {
  const pages: Page[] = [];
  let cursor = 0;
  let broughtForward = ledger.openingBalancePence;

  while (cursor < ledger.rows.length) {
    const size = pages.length === 0 ? FIRST_PAGE_ROWS : PAGE_ROWS;
    const rows = ledger.rows.slice(cursor, cursor + size);
    const last = rows[rows.length - 1];
    pages.push({
      index: pages.length,
      rows,
      broughtForwardPence: broughtForward,
      carriedForwardPence: last?.balancePence ?? broughtForward,
    });
    broughtForward = last?.balancePence ?? broughtForward;
    cursor += size;
  }
  return pages;
}

/* ── CSV ──────────────────────────────────────────────────────────────────── */

/**
 * The bank-export CSV, WITH preamble — because `findMapping` scans the first 25
 * rows for the header rather than assuming row 0, and a fixture that starts at
 * the header never exercises the thing every real UK bank export does.
 *
 * Money is written unseparated (`1234.56`). The parser copes with `£1,234.56`,
 * but a fixture whose job is to be provably complete should not also be a test
 * of thousands-separator disambiguation.
 */
export function buildCsv(ledger: Ledger): string {
  const { plan } = ledger;
  const quote = (value: string): string => `"${value.replace(/"/g, '""')}"`;
  const money = (pence: number): string => (Math.abs(pence) / 100).toFixed(2);
  const lines: string[] = [
    `${quote(plan.bank.name)},${quote(`${plan.bank.accountType} statement`)},,,`,
    `Account Name,${quote(plan.business.name)},,,`,
    `Sort Code,${plan.bank.sortCode},,,`,
    `Account Number,${plan.bank.accountNumber},,,`,
    `Statement Period,${isoToUk(ledger.periodStart)} to ${isoToUk(ledger.periodEnd)},,,`,
    `Generated,${isoToUk(ledger.periodEnd)},,,`,
    ',,,,',
    'Date,Description,Paid Out,Paid In,Balance',
    // Dated, carries a balance, states no amount → the parser reads this as
    // BROUGHT FORWARD, which is what makes the opening balance a stated fact.
    `${isoToUk(ledger.periodStart)},${quote('BALANCE BROUGHT FORWARD')},,,${money(ledger.openingBalancePence)}`,
  ];

  for (const row of ledger.rows) {
    const out = row.amountPence < 0 ? money(row.amountPence) : '';
    const inn = row.amountPence > 0 ? money(row.amountPence) : '';
    // Never both — `amountFor` refuses a row that populates the two columns,
    // which would land as a skipped line and fail the D41 gate.
    lines.push(`${isoToUk(row.date)},${quote(row.description)},${out},${inn},${money(row.balancePence)}`);
  }
  return `${lines.join('\r\n')}\r\n`;
}

/* ── HTML ─────────────────────────────────────────────────────────────────── */

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function moneyCell(pence: number): string {
  return penceToAmount(Math.abs(pence));
}

export function buildHtml(ledger: Ledger, pages: Page[]): string {
  const { plan } = ledger;
  const total = pages.length;
  const brand = plan.bank.brandHex;

  const sheets = pages
    .map((page) => {
      const head = page.index === 0 ? firstPageHead(ledger) : continuationHead(ledger, page);
      const body = [
        `<tr class="bf"><td>${isoToUk(page.rows[0]?.date ?? ledger.periodStart)}</td>` +
          `<td>${page.index === 0 ? 'BALANCE BROUGHT FORWARD' : 'BALANCE BROUGHT FORWARD FROM PAGE ' + String(page.index)}</td>` +
          `<td></td><td></td><td class="num">${penceToAmount(page.broughtForwardPence)}</td></tr>`,
        ...page.rows.map(
          (row) =>
            `<tr><td>${isoToUk(row.date)}</td><td class="desc">${escapeHtml(row.description)}</td>` +
            `<td class="num">${row.amountPence < 0 ? moneyCell(row.amountPence) : ''}</td>` +
            `<td class="num">${row.amountPence > 0 ? moneyCell(row.amountPence) : ''}</td>` +
            `<td class="num">${penceToAmount(row.balancePence)}</td></tr>`,
        ),
        `<tr class="cf"><td></td><td>${
          page.index === total - 1 ? 'CLOSING BALANCE' : 'CARRIED FORWARD TO PAGE ' + String(page.index + 2)
        }</td><td></td><td></td><td class="num">${penceToAmount(page.carriedForwardPence)}</td></tr>`,
      ].join('');

      return `<section class="sheet">
  ${head}
  <table class="txns">
    <thead><tr><th class="c-date">Date</th><th>Description</th><th class="num c-money">Paid Out</th><th class="num c-money">Paid In</th><th class="num c-money">Balance</th></tr></thead>
    <tbody>${body}</tbody>
  </table>
  <footer class="foot">
    <div class="fscs">${escapeHtml(plan.bank.fscsNote)}</div>
    <div class="reg">${escapeHtml(plan.bank.registeredOffice)}. Authorised by the Prudential Regulation Authority and regulated by the Financial Conduct Authority and the Prudential Regulation Authority.</div>
    <div class="pager">Page ${page.index + 1} of ${total}</div>
  </footer>
</section>`;
    })
    .join('\n');

  return `<!doctype html>
<html lang="en-GB">
<head>
<meta charset="utf-8">
<title>${escapeHtml(plan.business.name)} — ${escapeHtml(plan.bank.name)} statement</title>
<style>
  @page { size: A4; margin: 0; }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; background: #fff; }
  body {
    font-family: "Helvetica Neue", Helvetica, Arial, sans-serif;
    color: #1c1c1c;
    -webkit-print-color-adjust: exact;
    print-color-adjust: exact;
    font-variant-numeric: tabular-nums;
  }
  .sheet {
    width: 210mm; height: 296.8mm;
    padding: 11mm 13mm 9mm;
    position: relative;
    page-break-after: always;
    overflow: hidden;
  }
  .sheet:last-child { page-break-after: auto; }

  /* Letterhead */
  .lh { display: flex; justify-content: space-between; align-items: flex-start; border-bottom: 2.4pt solid ${brand}; padding-bottom: 3mm; }
  .mark { display: flex; align-items: center; gap: 3mm; }
  .mark .glyph { width: 11mm; height: 11mm; border-radius: 50%; background: ${brand}; position: relative; }
  .mark .glyph::after { content: ""; position: absolute; inset: 2.6mm; border-radius: 50%; border: 1.1mm solid #fff; }
  .mark .name { font-size: 17pt; font-weight: 700; letter-spacing: -0.4pt; color: ${brand}; }
  .mark .sub { font-size: 7pt; color: #555; letter-spacing: 0.3pt; text-transform: uppercase; }
  .lh .addr { text-align: right; font-size: 7.4pt; line-height: 1.35; color: #444; }

  /* Party + details */
  .parties { display: flex; justify-content: space-between; margin-top: 5mm; gap: 8mm; }
  .parties .who { font-size: 8.6pt; line-height: 1.45; }
  .parties .who .nm { font-weight: 700; font-size: 9.6pt; }
  .parties .who .meta { margin-top: 2mm; font-size: 7.2pt; color: #555; }
  .details { border: 0.4pt solid #c8c8c8; border-radius: 1mm; padding: 3mm 4mm; min-width: 74mm; }
  .details table { border-collapse: collapse; width: 100%; font-size: 7.8pt; }
  .details td { padding: 0.7mm 0; vertical-align: top; }
  .details td:first-child { color: #555; padding-right: 5mm; white-space: nowrap; }
  .details td:last-child { text-align: right; font-weight: 600; }
  .title { margin: 5mm 0 0; font-size: 13pt; font-weight: 700; color: ${brand}; }
  .period { font-size: 8.4pt; color: #444; margin-top: 0.8mm; }

  /* Summary */
  .summary { display: flex; margin-top: 4mm; border: 0.4pt solid #c8c8c8; border-radius: 1mm; overflow: hidden; }
  .summary div { flex: 1; padding: 2.6mm 3mm; border-right: 0.4pt solid #e2e2e2; }
  .summary div:last-child { border-right: 0; background: #f6f8fa; }
  .summary .k { font-size: 6.8pt; text-transform: uppercase; letter-spacing: 0.4pt; color: #666; }
  .summary .v { font-size: 10.4pt; font-weight: 700; margin-top: 0.8mm; }

  /* Continuation header */
  .cont { display: flex; justify-content: space-between; align-items: flex-end; border-bottom: 1.6pt solid ${brand}; padding-bottom: 2.2mm; }
  .cont .l { font-size: 11pt; font-weight: 700; color: ${brand}; }
  .cont .l span { display: block; font-size: 7.6pt; font-weight: 400; color: #333; margin-top: 0.6mm; }
  .cont .r { font-size: 7.4pt; color: #444; text-align: right; line-height: 1.4; }

  /* Table */
  table.txns { width: 100%; border-collapse: collapse; margin-top: 4mm; font-size: 7.9pt; }
  table.txns th {
    background: ${brand}; color: #fff; text-align: left; font-weight: 600;
    padding: 1.5mm 2mm; font-size: 7.4pt; letter-spacing: 0.2pt;
  }
  table.txns td { padding: 0.85mm 2mm; border-bottom: 0.3pt solid #e8e8e8; height: 4.55mm; white-space: nowrap; overflow: hidden; }
  table.txns .num { text-align: right; }
  table.txns .c-date { width: 20mm; }
  table.txns .c-money { width: 24mm; }
  table.txns .desc { max-width: 78mm; text-overflow: ellipsis; }
  table.txns tr.bf td, table.txns tr.cf td { font-weight: 700; background: #f2f5f8; }
  table.txns tr.cf td { border-top: 0.6pt solid #999; }

  /* Footer */
  .foot { position: absolute; left: 13mm; right: 13mm; bottom: 7mm; border-top: 0.4pt solid #d5d5d5; padding-top: 2mm; }
  .foot .fscs { font-size: 6.4pt; color: #444; }
  .foot .reg { font-size: 5.9pt; color: #777; margin-top: 0.8mm; line-height: 1.3; }
  .foot .pager { position: absolute; right: 0; bottom: 0; font-size: 7.4pt; font-weight: 600; color: #333; }
</style>
</head>
<body>
${sheets}
</body>
</html>`;
}

function firstPageHead(ledger: Ledger): string {
  const { plan } = ledger;
  return `<header class="lh">
    <div class="mark">
      <div class="glyph"></div>
      <div>
        <div class="name">${escapeHtml(plan.bank.name)}</div>
        <div class="sub">${escapeHtml(plan.bank.accountType)}</div>
      </div>
    </div>
    <div class="addr">${plan.bank.addressLines.map(escapeHtml).join('<br>')}</div>
  </header>
  <div class="parties">
    <div class="who">
      <div class="nm">${escapeHtml(plan.business.name)}</div>
      ${plan.business.addressLines.map(escapeHtml).join('<br>')}
      <div class="meta">Company no. ${escapeHtml(plan.business.companyNumber)} &nbsp;·&nbsp; VAT ${escapeHtml(plan.business.vatNumber)}</div>
    </div>
    <div class="details">
      <table>
        <tr><td>Account type</td><td>${escapeHtml(plan.bank.accountType)}</td></tr>
        <tr><td>Sort code</td><td>${escapeHtml(plan.bank.sortCode)}</td></tr>
        <tr><td>Account number</td><td>${escapeHtml(plan.bank.accountNumber)}</td></tr>
        <tr><td>Branch</td><td>${escapeHtml(plan.bank.branch)}</td></tr>
        <tr><td>Statement number</td><td>1</td></tr>
        <tr><td>Date issued</td><td>${isoToLong(ledger.periodEnd)}</td></tr>
      </table>
    </div>
  </div>
  <h1 class="title">Statement of account</h1>
  <div class="period">${isoToLong(ledger.periodStart)} to ${isoToLong(ledger.periodEnd)}</div>
  <div class="summary">
    <div><div class="k">Opening balance</div><div class="v">&pound;${penceToAmount(ledger.openingBalancePence)}</div></div>
    <div><div class="k">Paid in</div><div class="v">&pound;${penceToAmount(ledger.totalInPence)}</div></div>
    <div><div class="k">Paid out</div><div class="v">&pound;${penceToAmount(ledger.totalOutPence)}</div></div>
    <div><div class="k">Closing balance</div><div class="v">&pound;${penceToAmount(ledger.closingBalancePence)}</div></div>
  </div>`;
}

function continuationHead(ledger: Ledger, page: Page): string {
  const { plan } = ledger;
  return `<header class="cont">
    <div class="l">${escapeHtml(plan.bank.name)}<span>${escapeHtml(plan.business.name)} &nbsp;·&nbsp; ${escapeHtml(plan.bank.accountType)}</span></div>
    <div class="r">Sort code ${escapeHtml(plan.bank.sortCode)} &nbsp;·&nbsp; Account ${escapeHtml(plan.bank.accountNumber)}<br>
      Statement 1 &nbsp;·&nbsp; ${isoToLong(ledger.periodStart)} to ${isoToLong(ledger.periodEnd)} &nbsp;·&nbsp; continued from page ${page.index}</div>
  </header>`;
}
