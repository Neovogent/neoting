// Step 4 — prove the fixture passes D41, using the REPO'S OWN code.
//
//   pnpm tsx scripts/demo/bank-statement/verify.ts
//
// ⚠ Nothing here reimplements a check. It imports `parseStatement` and
// `assessCompleteness` from `apps/api/src/modules/banking-matching/` and asserts
// against what they say. A verifier with its own copy of the rules proves only
// that two files agree with each other — the point is that the shipped gate,
// unmodified, reports `complete` on this statement.
//
// It also re-derives the ledger from `out/plan.json` and compares it to the
// parsed CSV row by row. That is what pins the artifacts to ONE ledger: a
// renderer that quietly dropped, reordered or re-signed a line fails here even
// though the balance chain would still add up.

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';

import { assessCompleteness } from '../../../apps/api/src/modules/banking-matching/statement-ingest/completeness.js';
import { parseStatement } from '../../../apps/api/src/modules/banking-matching/statement-ingest/statement-parser.js';

import { buildLedger, penceToAmount } from './ledger.js';
import { CSV_PATH, META_PATH, PDF_PATH, PLAN_PATH } from './paths.js';
import { validatePlan } from './plan.js';

/* ── Reporting ────────────────────────────────────────────────────────────── */

let failures = 0;
let skipped = 0;

function check(label: string, ok: boolean, detail = ''): void {
  if (!ok) failures += 1;
  process.stdout.write(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail === '' ? '' : `  — ${detail}`}\n`);
}

/** Reported, never silently passed: an unrun check is not a green one. */
function skip(label: string, why: string): void {
  skipped += 1;
  process.stdout.write(`  SKIP  ${label}  — ${why}\n`);
}

function heading(text: string): void {
  process.stdout.write(`\n${text}\n`);
}

function monthsBetween(startIso: string, endIso: string): number {
  const [sy, sm] = startIso.split('-').map((p) => Number.parseInt(p, 10));
  const [ey, em] = endIso.split('-').map((p) => Number.parseInt(p, 10));
  return ((ey ?? 0) - (sy ?? 0)) * 12 + ((em ?? 0) - (sm ?? 0));
}

function have(binary: string): boolean {
  try {
    execFileSync('/usr/bin/which', [binary], { stdio: ['ignore', 'ignore', 'ignore'] });
    return true;
  } catch {
    return false;
  }
}

/* ── The run ──────────────────────────────────────────────────────────────── */

interface Meta {
  readonly rowCount: number;
  readonly pageCount: number;
  readonly periodStart: string;
  readonly periodEnd: string;
  readonly openingBalancePence: number;
  readonly closingBalancePence: number;
  readonly firstDescription: string;
  readonly lastDescription: string;
  /** `[date, description, amount, balance]` — a whole printed statement line. */
  readonly firstLine: string[];
  readonly lastLine: string[];
  readonly business: string;
  readonly sortCode: string;
  readonly accountNumber: string;
}

function main(): void {
  for (const path of [PLAN_PATH, CSV_PATH, PDF_PATH, META_PATH]) {
    if (!existsSync(path)) {
      process.stderr.write(`Missing ${path}. Run: pnpm tsx scripts/demo/bank-statement/generate.ts\n`);
      process.exit(1);
    }
  }

  const meta = JSON.parse(readFileSync(META_PATH, 'utf8')) as Meta;
  const plan = validatePlan(JSON.parse(readFileSync(PLAN_PATH, 'utf8')));
  const ledger = buildLedger(plan);

  process.stdout.write(
    `\n${meta.business} · ${plan.business.type} · ${plan.bank.name} ${meta.sortCode} ${meta.accountNumber}\n` +
      `${meta.periodStart} → ${meta.periodEnd}\n`,
  );

  /* 1 ── the CSV, through the shipped parser ───────────────────────────── */

  heading('CSV — apps/api … statement-ingest/statement-parser.ts');
  const result = parseStatement(readFileSync(CSV_PATH), 'statement.csv');
  if (!result.ok) {
    check('parseStatement succeeds', false, JSON.stringify(result.failure));
    process.stdout.write('\nParse failed — nothing downstream can be checked.\n');
    process.exit(1);
  }
  const statement = result.statement;
  check('parseStatement succeeds', true, `header row ${statement.mapping.headerRow + 1}, after the preamble`);
  check(
    'the two-column Paid Out / Paid In path was used',
    statement.mapping.paidOut !== null && statement.mapping.paidIn !== null && statement.mapping.amount === null,
    JSON.stringify({ paidOut: statement.mapping.paidOut, paidIn: statement.mapping.paidIn, balance: statement.mapping.balance }),
  );
  check('rows.length matches the generated ledger', statement.rows.length === meta.rowCount, `${statement.rows.length} vs ${meta.rowCount}`);
  check(
    'no skipped lines',
    statement.skipped.length === 0,
    statement.skipped.length === 0 ? '' : JSON.stringify(statement.skipped.slice(0, 3)),
  );
  check(
    'periodStart / periodEnd match',
    statement.periodStart === meta.periodStart && statement.periodEnd === meta.periodEnd,
    `${statement.periodStart} → ${statement.periodEnd}`,
  );
  const span = monthsBetween(statement.periodStart, statement.periodEnd) + 1;
  check('the period spans at least 12 months', span >= 12, `${span} calendar months, first to last transaction`);
  check(
    'opening balance is the one the generator intended',
    statement.openingBalancePence === meta.openingBalancePence,
    `£${penceToAmount(statement.openingBalancePence ?? 0)}`,
  );
  check(
    'closing balance is the one the generator intended',
    statement.closingBalancePence === meta.closingBalancePence,
    `£${penceToAmount(statement.closingBalancePence ?? 0)}`,
  );

  /* 2 ── the D41 gate ──────────────────────────────────────────────────── */

  heading('D41 — apps/api … statement-ingest/completeness.ts');
  const report = assessCompleteness(statement);
  check("assurance is 'complete'", report.assurance === 'complete', report.assurance);
  check("provenBy is 'balanceContinuity'", report.provenBy === 'balanceContinuity', String(report.provenBy));
  check('rowCount agrees', report.rowCount === meta.rowCount, String(report.rowCount));
  check(
    'no findings at all',
    report.findings.length === 0,
    report.findings.length === 0 ? '' : report.findings.slice(0, 3).map((f) => `${f.kind}: ${f.detail}`).join(' | '),
  );

  /* 3 ── one ledger, two artifacts ─────────────────────────────────────── */

  heading('Provenance — the CSV is the generated ledger, line for line');
  check('the re-derived ledger has the same row count', ledger.rows.length === statement.rows.length, `${ledger.rows.length} vs ${statement.rows.length}`);
  let mismatch: string | null = null;
  for (let i = 0; i < Math.min(ledger.rows.length, statement.rows.length) && mismatch === null; i += 1) {
    const want = ledger.rows[i];
    const got = statement.rows[i];
    if (want === undefined || got === undefined) continue;
    if (
      want.date !== got.bookedOn ||
      want.description !== got.description ||
      want.amountPence !== got.amountPence ||
      want.balancePence !== got.balanceAfterPence
    ) {
      mismatch = `row ${i + 1}: expected ${JSON.stringify(want)}, parsed ${JSON.stringify(got)}`;
    }
  }
  check('every row round-trips (date, description, signed pence, balance)', mismatch === null, mismatch ?? '');

  /* 4 ── the PDF ───────────────────────────────────────────────────────── */

  heading('PDF — out/statement.pdf');
  const pdf = readFileSync(PDF_PATH);
  const head = pdf.subarray(0, 8).toString('latin1');
  const tail = pdf.subarray(Math.max(0, pdf.length - 64)).toString('latin1');
  check('starts with a %PDF header', head.startsWith('%PDF-'), head.split('\n')[0] ?? '');
  check('ends with a %%EOF trailer', tail.trimEnd().endsWith('%%EOF'), `${pdf.length.toLocaleString('en-GB')} bytes`);

  // Structural page count, from the page tree in the raw bytes. Chrome's Skia
  // writer does not use object streams, so the `/Type /Page` objects are
  // legible without inflating anything — and this needs no tool to be present.
  const rawPages = (pdf.toString('latin1').match(/\/Type\s*\/Page[^s]/g) ?? []).length;
  check('structural page count matches the generator', rawPages === meta.pageCount, `${rawPages} /Type /Page objects vs ${meta.pageCount} sheets`);

  if (have('pdfinfo')) {
    const info = execFileSync('pdfinfo', [PDF_PATH], { encoding: 'utf8' });
    const reported = Number.parseInt(/^Pages:\s+(\d+)$/m.exec(info)?.[1] ?? '0', 10);
    check('pdfinfo agrees on the page count', reported === meta.pageCount, `${reported} pages`);
    check('the page size is A4', /Page size:\s+59[45](\.\d+)? x 84[12](\.\d+)? pts/.test(info), (/Page size:.*/.exec(info) ?? [''])[0]);
  } else {
    skip('pdfinfo page count / page size', 'pdfinfo (poppler) is not installed — structural count above still ran');
  }

  if (have('pdftotext')) {
    const text = execFileSync('pdftotext', ['-layout', PDF_PATH, '-'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    // A whole printed LINE, not just the description — "BACS WORLDPAY UK
    // SETTLEMENT" appears on nearly every page, so finding it proves nothing
    // about the first and last transactions specifically.
    const linePresent = (cells: string[]): boolean =>
      new RegExp(`^\\s*${cells.map((c) => c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\s+')}\\s*$`, 'm').test(text);
    check('the FIRST transaction is printed in full', linePresent(meta.firstLine), meta.firstLine.join('  '));
    check('the LAST transaction is printed in full', linePresent(meta.lastLine), meta.lastLine.join('  '));
    check('the account holder appears', text.includes(meta.business));
    check('the sort code and account number appear', text.includes(meta.sortCode) && text.includes(meta.accountNumber));
    check('the closing balance appears', text.includes(penceToAmount(meta.closingBalancePence)), `£${penceToAmount(meta.closingBalancePence)}`);
    check('page 1 and the last page are both numbered', text.includes('Page 1 of ' + String(meta.pageCount)) && text.includes(`Page ${meta.pageCount} of ${meta.pageCount}`));
    const carried = (text.match(/BALANCE BROUGHT FORWARD/g) ?? []).length;
    check('every page carries its brought-forward line', carried === meta.pageCount, `${carried} of ${meta.pageCount}`);
    // The strongest of the PDF checks: every transaction line is on a page.
    const dated = (text.match(/^\s*\d{2}\/\d{2}\/\d{4}\s/gm) ?? []).length;
    check(
      'every transaction line is printed',
      dated >= meta.rowCount,
      `${dated} dated lines for ${meta.rowCount} transactions + ${meta.pageCount} brought-forward lines`,
    );
  } else {
    skip('PDF text extraction', 'pdftotext (poppler) is not installed — the PDF was checked structurally only');
  }

  heading(
    failures === 0
      ? `RESULT: complete — ${meta.rowCount} transactions, ${meta.pageCount} pages, D41 assurance '${report.assurance}' proven by ${String(report.provenBy)}.` +
          (skipped === 0 ? '' : `\n(${skipped} check${skipped === 1 ? '' : 's'} skipped — see SKIP above.)`)
      : `RESULT: ${failures} check${failures === 1 ? '' : 's'} FAILED.`,
  );
  process.stdout.write('\n');
  process.exit(failures === 0 ? 0 : 1);
}

main();
