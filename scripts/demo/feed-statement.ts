/**
 * Feed a generated bank statement into the app, through the REAL ingest path.
 *
 * This is the "…and test" half of the statement-generation exercise. The
 * generator in `scripts/demo/bank-statement/` produces a PDF and a CSV twin from
 * one ledger; this puts the CSV through the code that actually runs in
 * production — `ingestStatement`, under RLS, through `scopedDb` — and then reads
 * the result back through the real services rather than through raw SQL.
 *
 * ## Why the CSV and not the PDF
 *
 * `STATEMENT_READER=none` locally, and Textract cannot read MinIO
 * (`banking-matching/CLAUDE.md`). A PDF statement is therefore REFUSED here by
 * design, with `readerNotConfigured`. That refusal is correct behaviour and this
 * script asserts it rather than skipping it — a PDF that silently imported would
 * mean a fixture reader had been added, which that lane deleted on purpose.
 *
 * ## It writes to a REAL local practice
 *
 * There is no demo seed on this database, so the target is an existing business
 * (default `Neovogent`). Everything it creates is removable with `--cleanup`,
 * and the ingest itself is idempotent on `documentId`.
 *
 *   pnpm tsx scripts/demo/feed-statement.ts
 *   pnpm tsx scripts/demo/feed-statement.ts --business 'Neovogent'
 *   pnpm tsx scripts/demo/feed-statement.ts --cleanup
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';

import { PrismaClient } from '@prisma/client';

import { ScopeContextSchema } from '../../apps/api/src/common/db/scope-context.js';
import { scopedDb } from '../../apps/api/src/common/db/scoped-db.js';
import {
  ingestStatement,
  readStatementFor,
  type StatementScopedClient,
} from '../../apps/api/src/modules/banking-matching/statement-ingest/statement-ingest.js';

/** One id, so a re-run is the idempotency path rather than a second statement. */
const DOC_ID = 'feed-stmt-doc';
const PDF_DOC_ID = 'feed-stmt-doc-pdf';

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : (process.argv[i + 1] ?? fallback);
}

const businessName = arg('business', 'Neovogent');
const csvPath = resolve(arg('csv', 'scripts/demo/bank-statement/out/statement.csv'));
const pdfPath = resolve(arg('pdf', 'scripts/demo/bank-statement/out/statement.pdf'));
const cleanupOnly = process.argv.includes('--cleanup');

const DATABASE_URL = process.env['DATABASE_URL'];
const OWNER_URL = process.env['DIRECT_URL'];
if (DATABASE_URL === undefined || OWNER_URL === undefined) {
  throw new Error('DATABASE_URL and DIRECT_URL must be set — source .env first.');
}

// Two clients, exactly as the integration suites use: the owner role sets up and
// tears down (it bypasses RLS), the app role does the work under the policies.
const owner = new PrismaClient({ datasources: { db: { url: OWNER_URL } } });
const app = new PrismaClient({ datasources: { db: { url: DATABASE_URL } } });

const log = {
  log: (m: string) => console.log(`  ${m}`),
  warn: (m: string) => console.warn(`  ⚠ ${m}`),
};

function pounds(pence: number | null): string {
  if (pence === null) return '—';
  const neg = pence < 0;
  const abs = Math.abs(pence);
  return `${neg ? '−' : ''}£${Math.trunc(abs / 100).toLocaleString('en-GB')}.${String(abs % 100).padStart(2, '0')}`;
}

async function cleanup(businessId: string): Promise<void> {
  // Explicit ids, never `startsWith` — Prisma compiles that to an unescaped
  // LIKE where `_` is a wildcard (banking-matching/CLAUDE.md).
  const ids = [DOC_ID, PDF_DOC_ID];
  const statements = await owner.statement.findMany({
    where: { documentId: { in: ids } },
    select: { id: true, accountId: true },
  });
  const accountIds = [...new Set(statements.map((s) => s.accountId))];
  if (accountIds.length > 0) {
    await owner.bankTransaction.deleteMany({ where: { accountId: { in: accountIds } } });
  }
  await owner.statement.deleteMany({ where: { documentId: { in: ids } } });
  if (accountIds.length > 0) {
    await owner.bankAccount.deleteMany({ where: { id: { in: accountIds }, businessId } });
  }
  await owner.documentEvent.deleteMany({ where: { documentId: { in: ids } } });
  await owner.document.deleteMany({ where: { id: { in: ids } } });
}

async function main(): Promise<void> {
  const business = await owner.business.findFirst({
    where: { name: businessName },
    select: { id: true, practiceId: true, name: true },
  });
  if (business === null || business.practiceId === null) {
    throw new Error(`No business named "${businessName}" with a practice on this database.`);
  }

  // A human actor, because RLS requires one and every policy reads it. The
  // SYSTEM actor would work too; a practice admin is what an accountant
  // uploading a statement actually is.
  const actor = await owner.membership.findFirst({
    where: { practiceId: business.practiceId, user: { kind: 'HUMAN' } },
    select: { userId: true },
  });
  if (actor === null) throw new Error(`Practice ${business.practiceId} has no human member.`);

  console.log(`Target: ${business.name} (${business.id}) in practice ${business.practiceId}`);

  await cleanup(business.id);
  if (cleanupOnly) {
    console.log('Cleaned up. Nothing else done.');
    return;
  }

  const csv = readFileSync(csvPath);
  const ctx = ScopeContextSchema.parse({ actorId: actor.userId, practiceId: business.practiceId });

  const makeDoc = (id: string, file: string, mime: string, bytes: Buffer) =>
    owner.document.create({
      data: {
        id,
        practiceId: business.practiceId,
        businessId: business.id,
        s3Key: `w/${business.id}/documents/${id}`,
        // ⚠ The REAL hash of the real bytes. The first draft wrote `feed-<id>`,
        // which violates the contract's `^[a-f0-9]{64}$` — every one of these
        // documents then failed the detail parse in the web app with
        // "byteHash: Invalid" (walkthrough finding 8, 4 Sep 2026). A fixture
        // row that is read back through the contract has to satisfy it.
        byteHash: createHash('sha256').update(bytes).digest('hex'),
        mimeType: mime,
        byteSize: bytes.length,
        channel: 'WEB_UPLOAD',
        originalFilename: file,
        // ⚠ TO_REVIEW, not READY — the truthful state, and what the real path
        // produces: a statement has no supplier, no total and no category, so
        // `resolveProcessedState` lands it TO_REVIEW. Hand-setting READY put
        // rows on the accountant's Ready tab reading "Ready — blocked", £0.00,
        // "Unknown" (the same finding 8).
        state: 'TO_REVIEW',
        // What the extractor would have written. `statement-step` keys on this
        // and answers "not mine" for anything else.
        docType: 'STATEMENT',
        inbox: 'COSTS',
      },
    });

  /* ── 1 · the CSV, through the real ingest ──────────────────────────────── */
  console.log(`\n1 · Ingesting ${basename(csvPath)} (${(csv.length / 1024).toFixed(0)} KB)`);
  await makeDoc(DOC_ID, basename(csvPath), 'text/csv', csv);

  const input = {
    documentId: DOC_ID,
    businessId: business.id,
    fileName: basename(csvPath),
    bytes: csv,
    mimeType: 'text/csv',
    s3Key: null,
  };

  // The read happens OUTSIDE the transaction, which is not tidiness — see the
  // 10-second interactive-transaction timeout note in statement-ingest.ts.
  const parsed = await readStatementFor(input);
  const outcome = await scopedDb(app, ctx, (db) =>
    ingestStatement(db as unknown as StatementScopedClient, input, log, parsed),
  );

  if (outcome.status !== 'ingested') {
    console.error(`\n✗ Ingest did not happen: ${JSON.stringify(outcome)}`);
    process.exitCode = 1;
    return;
  }

  console.log(`\n  statement ${outcome.statementId}`);
  console.log(`  rows imported     ${outcome.rowCount}`);
  console.log(`  D41 assurance     ${outcome.report.assurance}`);
  console.log(`  proven by         ${outcome.report.provenBy ?? '—'}`);
  console.log(`  findings          ${outcome.report.findings.length}`);
  for (const f of outcome.report.findings.slice(0, 5)) {
    console.log(`    · ${f.kind}: ${f.detail.slice(0, 140)}`);
  }

  /* ── 2 · the PDF must be REFUSED, and refused honestly ─────────────────── */
  console.log(`\n2 · Uploading ${basename(pdfPath)} — expecting an honest refusal`);
  let pdfRefusal = 'not attempted';
  try {
    const pdf = readFileSync(pdfPath);
    await makeDoc(PDF_DOC_ID, basename(pdfPath), 'application/pdf', pdf);
    const pdfInput = {
      documentId: PDF_DOC_ID,
      businessId: business.id,
      fileName: basename(pdfPath),
      bytes: pdf,
      mimeType: 'application/pdf',
      s3Key: null,
    };
    // No OCR argument — which is exactly what STATEMENT_READER=none produces.
    const pdfParsed = await readStatementFor(pdfInput);
    const pdfOutcome = await scopedDb(app, ctx, (db) =>
      ingestStatement(db as unknown as StatementScopedClient, pdfInput, log, pdfParsed),
    );
    pdfRefusal = pdfOutcome.status === 'refused' ? pdfOutcome.reason : `UNEXPECTED: ${pdfOutcome.status}`;
    console.log(`  ${pdfOutcome.status}: ${pdfRefusal}`);
    if (pdfOutcome.status !== 'refused') process.exitCode = 1;
  } catch (error) {
    console.log(`  skipped — ${(error as Error).message}`);
  }

  /* ── 3 · read it back the way the product does ─────────────────────────── */
  console.log('\n3 · Reading back through the app');
  const readBack = await scopedDb(app, ctx, async (db) => {
    const statement = await db.statement.findFirst({
      where: { documentId: DOC_ID },
      select: {
        id: true,
        periodStart: true,
        periodEnd: true,
        openingBalancePence: true,
        closingBalancePence: true,
        rowCount: true,
        gapAnalysis: true,
      },
    });
    const count = await db.bankTransaction.count({ where: { businessId: business.id } });
    const unmatched = await db.bankTransaction.count({
      where: { businessId: business.id, matchState: 'UNMATCHED' },
    });
    const newest = await db.bankTransaction.findMany({
      where: { businessId: business.id },
      orderBy: { bookedAt: 'desc' },
      take: 3,
      select: { bookedAt: true, descriptionRaw: true, amountPence: true, balanceAfterPence: true },
    });
    return { statement, count, unmatched, newest };
  });

  const s = readBack.statement;
  if (s === null) {
    console.error('  ✗ the statement is not readable back under RLS');
    process.exitCode = 1;
    return;
  }
  const iso = (d: Date) => d.toISOString().slice(0, 10);
  const months =
    (s.periodEnd.getFullYear() - s.periodStart.getFullYear()) * 12 +
    (s.periodEnd.getMonth() - s.periodStart.getMonth());

  console.log(`  period            ${iso(s.periodStart)} → ${iso(s.periodEnd)}  (${months} months)`);
  console.log(`  opening balance   ${pounds(s.openingBalancePence)}`);
  console.log(`  closing balance   ${pounds(s.closingBalancePence)}`);
  console.log(`  bank_transactions ${readBack.count}  (${readBack.unmatched} UNMATCHED — the chase list's set)`);
  console.log('  newest three:');
  for (const t of readBack.newest) {
    console.log(
      `    ${iso(t.bookedAt)}  ${t.descriptionRaw.slice(0, 38).padEnd(38)} ${pounds(t.amountPence).padStart(12)}  bal ${pounds(t.balanceAfterPence)}`,
    );
  }

  /* ── 4 · the assertions ────────────────────────────────────────────────── */
  console.log('\n4 · Assertions');
  const checks: [string, boolean, string][] = [
    ['statement row created', s !== null, ''],
    ['assurance is complete', outcome.report.assurance === 'complete', `got ${outcome.report.assurance}`],
    ['proven by balance continuity', outcome.report.provenBy === 'balanceContinuity', ''],
    ['no findings', outcome.report.findings.length === 0, `${outcome.report.findings.length} finding(s)`],
    ['rowCount matches transactions', s.rowCount === readBack.count, `${s.rowCount} vs ${readBack.count}`],
    ['every line UNMATCHED', readBack.unmatched === readBack.count, ''],
    ['period spans ≥ 12 months', months >= 12, `${months} months`],
    ['PDF refused, not imported', pdfRefusal.includes('document reader') || pdfRefusal.includes('not switched on'), pdfRefusal.slice(0, 60)],
  ];
  let failed = 0;
  for (const [name, ok, detail] of checks) {
    if (!ok) failed += 1;
    console.log(`  ${ok ? '✓' : '✗'} ${name}${ok || detail === '' ? '' : ` — ${detail}`}`);
  }
  console.log(failed === 0 ? '\nAll checks passed.' : `\n${failed} check(s) FAILED.`);
  if (failed > 0) process.exitCode = 1;
}

main()
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await owner.$disconnect();
    await app.$disconnect();
  });
