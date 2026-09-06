/**
 * **How often does a document actually reach the model coding rung?**
 *
 * This is the number the judgment-tier pin rests on, and it was the one gap
 * `scripts/measure/coding-cost.ts` could not close: that script measures what a
 * coding call COSTS (2.47p, measured 6 Sep 2026); this one measures how often
 * one happens. The guardrail is about the blend of the two:
 *
 *   blended per document = extraction + (escalation rate × coding)
 *
 * At the measured figures the £0.02 ceiling holds while fewer than ~27% of
 * documents reach the rung. Nothing was measuring that, so the pin rested on an
 * assumption — which is exactly the shape of the mistake the cost script already
 * caught once.
 *
 * ## It needs no new instrumentation, and that is the point
 *
 * `extraction-pipeline.ts` has written a `document_events` row per document
 * since 2 Sep 2026 — `stage: 'code'`, outcome `suggested` or `escalated`,
 * `detail.basis` naming which rung answered. Every fact this needs is already
 * recorded; it was simply never asked. So this is a query, not a feature.
 *
 * ⚠ **`basis` is what separates the rungs, not `outcome`.** A `suggested` row
 * can come from the DETERMINISTIC layer (a keyword match), from this client's
 * own remembered treatment (`SUPPLIER_MEMORY` — free, no model), or from the
 * model (`INDUSTRY_CONTEXT_REASONING`). Counting `suggested` as "the model ran"
 * would flatter the rate badly, because supplier memory is expected to be the
 * commonest answer in a mature file and costs nothing.
 *
 * ## ⚠ IT MUST CONNECT AS THE OWNER, AND GETTING THAT WRONG IS SILENT
 *
 * `document_events` is in the RLS loop with FORCE ROW LEVEL SECURITY. Connected
 * as `nt_app` — which is what `DATABASE_URL` is — an unscoped read returns an
 * **empty list and does not error**, so the first run of this script printed
 * "nothing to measure" against a database holding the rows it was looking for.
 *
 * That is not a new discovery: `db/backfill-import-fingerprints.ts` has the same
 * warning written at length, and it is the trap that cost that change a draft.
 * So this reads through `DIRECT_URL` (the owner credential the migrator uses)
 * and **refuses to start without it** rather than reporting a zero it cannot
 * distinguish from a real one. An operator asking a whole-deployment question
 * needs the credential that can see the whole deployment; the alternative —
 * resolving every practice's SYSTEM actor and looping through `scopedDb` — is
 * the right shape for a WRITE and needless ceremony for a count.
 *
 * ## Running it
 *
 *   TSX_TSCONFIG_PATH=apps/api/tsconfig.json pnpm tsx scripts/measure/coding-escalation-rate.ts
 *
 * Reads only. No model call, no spend, no writes, and no document content —
 * only the stage rows. It reports the whole population, because a per-firm
 * ceiling is a per-firm question.
 *
 * ⚠ **On a seeded laptop the answer is noise** and the script says so: a handful
 * of documents cannot estimate a rate. Run it against a real corpus — staging
 * after a week of intake is the first honest sample.
 */

import { PrismaClient } from '@prisma/client';

import { costPence, TASKS } from '../../apps/api/src/modules/chat-framework/index.js';
import { MODEL_ANSWERABLE_ESCALATIONS } from '../../apps/api/src/modules/rules-suggestions/index.js';

/** SoT §16's blended per-document ceiling, in pence. */
const GUARDRAIL_PENCE = 2;
/** Measured 27 Aug 2026, `scripts/measure/extraction-cost.ts`. */
const EXTRACTION_PENCE = 1.34;
/** Measured 6 Sep 2026, `scripts/measure/coding-cost.ts` — 5,152 in + 204 out on the judgment tier. */
const CODING_PENCE = costPence(TASKS.codingSuggestion.model, 5_152 * 100, 204 * 100) / 100;

/** Below this the rate is arithmetic on noise, and the script refuses to present it as a measurement. */
const MEANINGFUL_SAMPLE = 50;

/** The bases the MODEL produces. Everything else was decided without one. */
const MODEL_BASES = new Set(['INDUSTRY_CONTEXT_REASONING']);
/** The basis this client's own remembered treatment produces — a suggestion that costs nothing. */
const MEMORY_BASIS = 'SUPPLIER_MEMORY';

interface CodeEvent {
  readonly outcome: string | null;
  readonly detail: unknown;
}

function fieldOf(detail: unknown, key: string): string | null {
  if (typeof detail !== 'object' || detail === null || Array.isArray(detail)) return null;
  const value = (detail as Record<string, unknown>)[key];
  return typeof value === 'string' ? value : null;
}

const basisOf = (detail: unknown): string => fieldOf(detail, 'basis') ?? '(none)';

/**
 * Did THIS escalation cost a model call?
 *
 * ⚠ Not every escalation reaches the rung, and counting them all would inflate
 * the rate — which on this number means inflating the estimated spend. The rung
 * is asked about exactly three reasons (`MODEL_ANSWERABLE_ESCALATIONS`); an
 * ARITHMETIC_MISMATCH or a SOFTWARE_TERM_UNKNOWN is answered and closed by the
 * deterministic layer without a call.
 *
 * The reason on the row is the DETERMINISTIC one even when the model was asked
 * and declined — `reconsider` keeps the more specific answer — which is
 * precisely the key wanted here: if that reason is model-answerable, a call was
 * made and paid for.
 */
function escalationWasPaid(detail: unknown): boolean {
  const reason = fieldOf(detail, 'escalationReason');
  return reason !== null && MODEL_ANSWERABLE_ESCALATIONS.has(reason as never);
}

async function main(): Promise<void> {
  // ⚠ The OWNER url, explicitly, and a refusal rather than a silent zero. See
  // the header: as `nt_app` this query returns an empty list and no error.
  const ownerUrl = process.env['DIRECT_URL'];
  if (ownerUrl === undefined || ownerUrl === '') {
    console.error(
      `
DIRECT_URL is not set, and this script will not read through DATABASE_URL.
The document_events table FORCES row-level security, so the app role answers an
EMPTY LIST rather than an error — a zero you cannot tell from a real one.
Source the repo .env (or export DIRECT_URL) and run it again.
`,
    );
    process.exitCode = 1;
    return;
  }

  const prisma = new PrismaClient({ datasources: { db: { url: ownerUrl } } });
  try {
    // The events. It reads no document content, only the stage rows.
    const rows = (await prisma.documentEvent.findMany({
      where: { stage: 'code' },
      select: { outcome: true, detail: true },
    })) as CodeEvent[];

    const byBasis = new Map<string, number>();
    let escalated = 0;
    let escalatedAfterACall = 0;
    for (const row of rows) {
      const basis = basisOf(row.detail);
      byBasis.set(basis, (byBasis.get(basis) ?? 0) + 1);
      if (row.outcome === 'escalated') {
        escalated += 1;
        if (escalationWasPaid(row.detail)) escalatedAfterACall += 1;
      }
    }

    const total = rows.length;
    const modelAnswered = [...byBasis.entries()].filter(([basis]) => MODEL_BASES.has(basis)).reduce((sum, [, n]) => sum + n, 0);
    // ⚠ A document that ESCALATED also reached the rung when its reason was one
    // the model is asked about — the call was made and paid for, and the model
    // declined. Counting only successful suggestions would undercount spend.
    const reachedRung = modelAnswered + escalatedAfterACall;

    console.log('\ncoding rung — how often a document reaches the model');
    console.log(`  ${total} document(s) with a coding decision on record\n`);

    if (total === 0) {
      console.log('  Nothing to measure. `document_events` carries no `code` rows yet —');
      console.log('  upload a document with EXTRACTOR=bedrock or replay and try again.\n');
      return;
    }

    const width = Math.max(...[...byBasis.keys()].map((k) => k.length));
    for (const [basis, count] of [...byBasis.entries()].sort((a, b) => b[1] - a[1])) {
      const cost = MODEL_BASES.has(basis) ? ' (model — paid)' : basis === MEMORY_BASIS ? ' (memory — free)' : ' (deterministic — free)';
      console.log(`  ${basis.padEnd(width)}  ${String(count).padStart(5)}  ${((count / total) * 100).toFixed(1).padStart(5)}%${cost}`);
    }
    console.log(
      `  ${'escalated'.padEnd(width)}  ${String(escalated).padStart(5)}  ${((escalated / total) * 100).toFixed(1).padStart(5)}%` +
        `  (${escalatedAfterACall} of them after a model call that declined — paid)`,
    );

    const rate = reachedRung / total;
    const blended = EXTRACTION_PENCE + rate * CODING_PENCE;
    const breakEven = (GUARDRAIL_PENCE - EXTRACTION_PENCE) / CODING_PENCE;

    console.log(`\n  documents reaching the model rung: ${reachedRung}/${total} = ${(rate * 100).toFixed(1)}%`);
    console.log(`  blended cost: ${EXTRACTION_PENCE}p + ${(rate * 100).toFixed(1)}% × ${CODING_PENCE.toFixed(2)}p = ${blended.toFixed(2)}p/document`);
    console.log(`  guardrail ${GUARDRAIL_PENCE}p — ${blended <= GUARDRAIL_PENCE ? 'INSIDE' : 'OVER'} (break-even rate ${(breakEven * 100).toFixed(0)}%)\n`);

    if (total < MEANINGFUL_SAMPLE) {
      console.log(`  ⚠ ${total} documents is NOT a measurement. Below ${MEANINGFUL_SAMPLE} this is arithmetic on noise —`);
      console.log('    a seeded laptop tells you the query works, not what the rate is. Run it');
      console.log('    against a real corpus; staging after a week of intake is the first honest');
      console.log('    sample, and the figure moves as a client accumulates rules and history\n');
      console.log('    (both of which answer ABOVE this rung and cost nothing).\n');
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
  process.exitCode = 1;
});
