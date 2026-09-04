// A full, realistic UK business bank statement — as a TEST ARTIFACT.
//
//   pnpm tsx scripts/demo/bank-statement/generate.ts
//   pnpm tsx scripts/demo/bank-statement/generate.ts --reuse-plan
//   pnpm tsx scripts/demo/bank-statement/verify.ts
//
// Synthetic throughout. A fictional account at a real bank's name, a fictional
// sort code and account number, fictional staff and suppliers. It exists to
// exercise D40/D41 — manual statement upload is ID's only bank input, and the
// gate that proves a statement complete had no full-size fixture to prove
// itself against.
//
// It is the SEEDED client's statement on purpose: American Burger Ltd
// (`biz_burger`, industry "Restaurants"). A ledger for any other trade attached
// to a burger restaurant would be exactly the incoherence the fixture is meant
// to rule out.
//
// Three steps, and each one's output is auditable:
//   1. `claude-fable-5` plans the transaction universe  → out/plan.json
//   2. a seeded PRNG expands it into 13 months of banking (integer pence only)
//   3. one ledger renders as out/statement.pdf and out/statement.csv
//
// Everything lands in `out/`, which the repo already gitignores. NOTHING here
// adds a dependency: the PDF is printed by headless Google Chrome, the plan is
// fetched with `fetch`, and the arithmetic is the standard library's.

import { execFileSync, spawn } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, readSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildLedger, isoToUk, penceToAmount, type LedgerRow } from './ledger.js';
import { CSV_PATH, HTML_PATH, META_PATH, OUT_DIR, PDF_PATH, PLAN_PATH, PLAN_RAW_PATH } from './paths.js';
import { requestPlan, validatePlan } from './plan.js';
import { buildCsv, buildHtml, paginate } from './render.js';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

/**
 * Prints the HTML with headless Chrome.
 *
 * Two things here are workarounds, and both are load-bearing:
 *
 * 1. **`--user-data-dir` is not optional.** Without it, a Chrome already
 *    running on this machine answers the launch, the new process exits at once,
 *    and `--print-to-pdf` silently writes nothing at all.
 * 2. **Chrome 152 headless writes the PDF and then does not exit** (macOS).
 *    `execFileSync` therefore blocks forever on a file that is already finished
 *    and valid. So it is spawned in its own process GROUP, polled until the
 *    output stops growing and carries a `%%EOF` trailer, and then the whole
 *    group is killed. Waiting on the exit code would hang the generator; the
 *    completed trailer is the better completion signal anyway, and `verify.ts`
 *    re-checks it independently.
 */
function printPdf(htmlPath: string, pdfPath: string): void {
  if (!existsSync(CHROME)) throw new Error(`Google Chrome not found at ${CHROME} — it is what renders the PDF.`);
  rmSync(pdfPath, { force: true });

  const profile = mkdtempSync(join(tmpdir(), 'nt-statement-chrome-'));
  const child = spawn(
    CHROME,
    [
      '--headless',
      '--disable-gpu',
      '--no-first-run',
      '--no-default-browser-check',
      `--user-data-dir=${profile}`,
      '--no-pdf-header-footer',
      `--print-to-pdf=${pdfPath}`,
      `file://${htmlPath}`,
    ],
    { stdio: 'ignore', detached: true },
  );

  try {
    const deadline = Date.now() + 180_000;
    let lastSize = -1;
    let stableFor = 0;
    while (Date.now() < deadline) {
      execFileSync('/bin/sleep', ['0.5']);
      if (!existsSync(pdfPath)) continue;
      const size = statSync(pdfPath).size;
      stableFor = size === lastSize && size > 0 ? stableFor + 1 : 0;
      lastSize = size;
      // Two quiet polls AND a complete trailer — a growing file can happen to
      // end in `%%EOF` from an earlier incremental section.
      if (stableFor >= 2 && endsWithEof(pdfPath)) return;
    }
    throw new Error('Chrome did not finish writing a complete PDF within 180s.');
  } finally {
    if (child.pid !== undefined) {
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {
        // Already gone. Nothing to clean up.
      }
    }
    rmSync(profile, { recursive: true, force: true });
  }
}

function endsWithEof(path: string): boolean {
  const size = statSync(path).size;
  if (size < 8) return false;
  const fd = openSync(path, 'r');
  try {
    const tail = Buffer.alloc(Math.min(64, size));
    readSync(fd, tail, 0, tail.length, size - tail.length);
    return tail.toString('latin1').trimEnd().endsWith('%%EOF');
  } finally {
    closeSync(fd);
  }
}

/** `date | description | amount | balance` — the four cells a printed line shows. */
function renderedLine(row: LedgerRow | undefined): string[] {
  if (row === undefined) return [];
  return [isoToUk(row.date), row.description, penceToAmount(Math.abs(row.amountPence)), penceToAmount(row.balancePence)];
}

async function main(): Promise<void> {
  mkdirSync(OUT_DIR, { recursive: true });
  const reuse = process.argv.includes('--reuse-plan');

  let plan;
  if (reuse && existsSync(PLAN_PATH)) {
    // Re-parsed through the SAME boundary the model's answer went through, so a
    // hand-edited plan.json cannot get in by a side door.
    plan = validatePlan(JSON.parse(readFileSync(PLAN_PATH, 'utf8')));
    process.stdout.write(`1. plan  · reused ${PLAN_PATH}\n`);
  } else {
    process.stdout.write('1. plan  · asking claude-fable-5 over Foundry…\n');
    const result = await requestPlan();
    plan = result.plan;
    // Both: the validated plan the generator actually expands, and the model's
    // answer verbatim — so "the model produced this" is auditable rather than
    // asserted.
    writeFileSync(PLAN_RAW_PATH, result.raw);
    writeFileSync(PLAN_PATH, `${JSON.stringify(plan, null, 2)}\n`);
    process.stdout.write(`         · accepted on attempt ${result.attempts} → ${PLAN_PATH} (raw: ${PLAN_RAW_PATH})\n`);
  }
  process.stdout.write(`         · ${plan.business.type}: ${plan.business.justification}\n`);

  process.stdout.write('2. ledger\n');
  const ledger = buildLedger(plan);
  process.stdout.write(
    `         · ${ledger.rows.length} transactions, ${ledger.periodStart} → ${ledger.periodEnd}\n` +
      `         · opening £${penceToAmount(ledger.openingBalancePence)} · closing £${penceToAmount(ledger.closingBalancePence)}\n` +
      `         · balance range £${penceToAmount(ledger.minBalancePence)} – £${penceToAmount(ledger.maxBalancePence)}` +
      ` (takings scaled to ${(ledger.incomeScaleBps / 100).toFixed(2)}%)\n`,
  );

  process.stdout.write('3. render\n');
  writeFileSync(CSV_PATH, buildCsv(ledger), 'utf8');
  const pages = paginate(ledger);
  writeFileSync(HTML_PATH, buildHtml(ledger, pages), 'utf8');
  printPdf(HTML_PATH, PDF_PATH);

  // What `verify.ts` checks the artifacts against. Written by the generator so
  // the verifier never re-derives the numbers it is supposed to be checking.
  writeFileSync(
    META_PATH,
    `${JSON.stringify(
      {
        business: plan.business.name,
        businessType: plan.business.type,
        bank: plan.bank.name,
        sortCode: plan.bank.sortCode,
        accountNumber: plan.bank.accountNumber,
        periodStart: ledger.periodStart,
        periodEnd: ledger.periodEnd,
        rowCount: ledger.rows.length,
        pageCount: pages.length,
        openingBalancePence: ledger.openingBalancePence,
        closingBalancePence: ledger.closingBalancePence,
        minBalancePence: ledger.minBalancePence,
        maxBalancePence: ledger.maxBalancePence,
        totalInPence: ledger.totalInPence,
        totalOutPence: ledger.totalOutPence,
        firstDescription: ledger.rows[0]?.description ?? '',
        lastDescription: ledger.rows[ledger.rows.length - 1]?.description ?? '',
        // The full first and last printed lines, so `verify.ts` can look for a
        // whole statement line rather than a description that appears 400 times.
        firstLine: renderedLine(ledger.rows[0]),
        lastLine: renderedLine(ledger.rows[ledger.rows.length - 1]),
      },
      null,
      2,
    )}\n`,
  );

  process.stdout.write(
    `         · ${pages.length} pages\n` +
      `         · ${CSV_PATH}\n         · ${PDF_PATH}\n         · ${HTML_PATH}\n\nNow run: pnpm tsx scripts/demo/bank-statement/verify.ts\n`,
  );
}

main().catch((error: unknown) => {
  process.stderr.write(`\n${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
  process.exit(1);
});
