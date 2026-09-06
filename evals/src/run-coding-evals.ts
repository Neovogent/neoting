import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { InMemoryAiBudget } from '../../apps/api/src/common/ai-budget.js';
import {
  type BedrockMessagesCreate,
  liveBedrockMessages,
  RecordingBedrockClient,
  recordingBedrockMessages,
  replayBedrockMessages,
} from '../../apps/api/src/common/bedrock-replay.js';
import type { ScopedClient } from '../../apps/api/src/common/db/scoped-db.js';
import { ChartOfAccountsService } from '../../apps/api/src/modules/rules-suggestions/chart-of-accounts/chart-of-accounts.service.js';
import { BedrockCodingModel } from '../../apps/api/src/modules/rules-suggestions/coding/bedrock-coding.js';
import { CODING_PROMPT_VERSION } from '../../apps/api/src/modules/rules-suggestions/coding/coding-instructions.js';
import { CORRECTION_OPINION_PROMPT_VERSION } from '../../apps/api/src/modules/rules-suggestions/coding/correction-opinion.js';
import { codingSuggestionFor, SupplierCodingService } from '../../apps/api/src/modules/rules-suggestions/coding/supplier-coding.service.js';
import { modelVersionOf, TASKS } from '../../apps/api/src/modules/chat-framework/models.js';

/**
 * `pnpm test:eval:coding` — the §9.8 merge gate for the **coding ladder** and
 * the **correction second opinion** (review items 19, 48 and 22/47's model
 * half).
 *
 * ## Why this is a second runner rather than more cases in the chat one
 *
 * `run-chat-evals.ts` measures utterance → intent through
 * `chat-framework`'s prompt, schema and provider. Nothing here touches any of
 * those: a different prompt, a different tool schema, a different task class
 * (`codingSuggestion`), a different replay corpus and a different version
 * constant that moves on its own schedule (`CODING_PROMPT_VERSION` is
 * deliberately NOT `PROMPT_VERSION` — see `coding-instructions.ts`). One runner
 * would have coupled a coding-rule change to the chat eval gate, which is the
 * exact coupling that constant exists to prevent.
 *
 * ## It drives the REAL ladder, not a re-implementation of it
 *
 * `SupplierCodingService.decide()` + `.reconsider()` + `codingSuggestionFor()`,
 * over a fake `ScopedClient` that answers the four reads the ladder makes. An
 * eval that re-implemented the tier order would measure a ladder nobody ships
 * and stay green through exactly the change §9.8 exists to gate — the same
 * argument the chat runner makes about importing the real prompt.
 *
 * So this scores the WHOLE answer an accountant sees: which tier won, the code,
 * the confidence, the basis and the sentence.
 *
 * ## Three modes, and only one of them is the merge gate
 *
 * | `EVAL_PROVIDER` | What runs | When |
 * |---|---|---|
 * | `replay` (default) | recorded cassettes in `recordings/coding-cassettes/` | **The merge gate.** CI |
 * | `bedrock` | live calls to the pinned model | Calibration, and re-recording |
 * | `none` | the deterministic ladder only | Harness development — always fails |
 *
 * ⚠ **The cassette key hashes the request body**, so editing the prompt, the
 * tool schema or the model pin misses every key and fails the run demanding a
 * re-record. That is §9.8's "any prompt change must pass the evals" expressed
 * as a cache key — the same mechanism, and the same files, as the app's own
 * replay transport.
 *
 * Re-record with:
 *   AWS_REGION=eu-west-2 EVAL_PROVIDER=bedrock EVAL_RECORD=1 pnpm test:eval:coding
 *
 * ⚠ Run it from `evals/`, not from the repo root: Turbo's env filtering strips
 * AWS credentials (the chat runner's README note, and it applies identically).
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const DATASET = join(HERE, '..', 'datasets', 'coding-ladder.jsonl');
const CASSETTES = join(HERE, '..', 'recordings', 'coding-cassettes');

/**
 * §9.8 thresholds. **Raise them as the corpus grows; never lower one to pass a
 * PR** — editing an expectation to make a number go up is the single move that
 * makes a gate stop measuring anything.
 *
 * Injection has no percentage and is not supposed to have one.
 */
const LADDER_ACCURACY_THRESHOLD = 0.9;
const OPINION_ACCURACY_THRESHOLD = 0.9;

interface HistoryEntry {
  categoryCode: string;
  receivedAt: string;
}

interface LadderCase {
  id: string;
  kind: 'ladder';
  note: string;
  profile: Record<string, unknown> | null;
  supplier: string | null;
  history: HistoryEntry[];
  evidence: { currency: string | null; totalPence: number | null; taxPence: number | null; lines: unknown[] };
  injection?: boolean;
  expect: {
    outcome?: 'SUGGEST' | 'ESCALATE';
    outcomeIn?: string[];
    reason?: string;
    basis?: string;
    forbidBasis?: string;
    acceptableCodes?: string[];
    forbidCodes?: string[];
    forbidNoteContains?: string[];
    minConfidence?: number;
    maxConfidence?: number;
    /** The tier order says this case must never reach the model. Asserted, not assumed. */
    noModelCall?: boolean;
  };
}

interface OpinionCase {
  id: string;
  kind: 'opinion';
  note: string;
  document: {
    docType: string | null;
    supplierName: string | null;
    totalPence: number | null;
    taxPence: number | null;
    currency: string | null;
    documentDate: string | null;
    lineDescriptions: string[];
  };
  typed: { supplierName?: string; totalPence?: number; categoryCode?: string; categoryLabel?: string };
  injection?: boolean;
  expect: { verdicts: Record<string, string> };
}

type Case = LadderCase | OpinionCase;

function loadCases(): Case[] {
  return readFileSync(DATASET, 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Case);
}

/**
 * The four reads `decide()` makes, answered from a case file.
 *
 * `integration` answers null on purpose so the chart is DERIVED and never
 * written — the storage behaviour belongs to its own tests, and an eval that
 * also exercised it would be measuring two things.
 */
function world(testCase: LadderCase): ScopedClient {
  const documents = testCase.history.map((entry, index) => ({
    id: `hist_${index}`,
    supplierName: testCase.supplier,
    categoryCode: entry.categoryCode,
    receivedAt: new Date(`${entry.receivedAt}T00:00:00.000Z`),
    extractions: [
      {
        extractorKind: 'human',
        fields: { categoryCode: { value: entry.categoryCode, provenance: 'HUMAN_CONFIRMED', wasCorrected: true } },
      },
    ],
  }));

  return {
    business: { findUnique: async () => ({ id: 'biz_eval', contextQuestionnaire: testCase.profile }) },
    integration: { findFirst: async () => null },
    referenceSync: { findUnique: async () => null },
    rule: { findMany: async () => [] },
    document: { findMany: async () => documents },
  } as unknown as ScopedClient;
}

interface Failure {
  id: string;
  detail: string;
}

async function runLadder(cases: LadderCase[], model: BedrockCodingModel | undefined, asked: () => number) {
  const failures: Failure[] = [];
  const leaks: Failure[] = [];
  let scored = 0;
  let hits = 0;

  const prisma = undefined as unknown as never; // never reached: `decide` takes the db
  const service = new SupplierCodingService(prisma, new ChartOfAccountsService(prisma), undefined, model);

  for (const testCase of cases) {
    const before = asked();
    let suggestion;
    try {
      const decided = await service.decide(world(testCase), 'biz_eval', testCase.supplier, testCase.evidence as never);
      const reconsidered = await service.reconsider(decided, testCase.evidence as never, 'prac_eval');
      suggestion = codingSuggestionFor(reconsidered);
    } catch (error) {
      failures.push({ id: testCase.id, detail: `call failed: ${error instanceof Error ? error.message : String(error)}` });
      continue;
    }

    const record = (ok: boolean, detail: string) => {
      scored += 1;
      if (ok) hits += 1;
      else (testCase.injection === true ? leaks : failures).push({ id: testCase.id, detail });
    };

    if (suggestion === null) {
      record(false, 'the ladder answered nothing at all — the one outcome this module forbids');
      continue;
    }

    const expected = testCase.expect;
    if (expected.outcome !== undefined) record(suggestion.outcome === expected.outcome, `outcome ${suggestion.outcome}, expected ${expected.outcome}`);
    if (expected.outcomeIn !== undefined) record(expected.outcomeIn.includes(suggestion.outcome), `outcome ${suggestion.outcome}, expected one of ${expected.outcomeIn.join('/')}`);
    if (expected.reason !== undefined) {
      const reason = suggestion.outcome === 'ESCALATE' ? suggestion.reason : '(suggested)';
      record(reason === expected.reason, `reason ${reason}, expected ${expected.reason}`);
    }
    if (expected.basis !== undefined) record(suggestion.basis === expected.basis, `basis ${suggestion.basis}, expected ${expected.basis}`);
    if (expected.forbidBasis !== undefined) record(suggestion.basis !== expected.forbidBasis, `basis ${suggestion.basis} was forbidden`);

    const code = suggestion.outcome === 'SUGGEST' ? suggestion.categoryCode : null;
    if (expected.acceptableCodes !== undefined) {
      record(code !== null && expected.acceptableCodes.includes(code), `code ${code ?? '(none)'}, expected one of ${expected.acceptableCodes.join('/')}`);
    }
    if (expected.forbidCodes !== undefined) {
      // The whole answer, not just the winning code: a forbidden code must not
      // arrive as a second choice or as a candidate either.
      const blob = JSON.stringify(suggestion);
      const said = expected.forbidCodes.filter((forbidden) => blob.includes(forbidden));
      record(said.length === 0, `answer carried forbidden code(s) ${said.join(', ')}`);
    }
    if (expected.forbidNoteContains !== undefined) {
      const said = expected.forbidNoteContains.filter((phrase) => suggestion.note.toLowerCase().includes(phrase.toLowerCase()));
      record(said.length === 0, `note repeated "${said.join('", "')}"`);
    }
    if (expected.minConfidence !== undefined) {
      record((suggestion.confidence ?? 0) >= expected.minConfidence, `confidence ${suggestion.confidence ?? 'null'} below ${expected.minConfidence}`);
    }
    if (expected.maxConfidence !== undefined) {
      record((suggestion.confidence ?? 0) <= expected.maxConfidence, `confidence ${suggestion.confidence ?? 'null'} above ${expected.maxConfidence}`);
    }
    if (expected.noModelCall === true) {
      record(asked() === before, 'the model was consulted about a document a tier above it answered');
    }
  }

  return { total: cases.length, accuracy: scored === 0 ? 1 : hits / scored, scored, failures, leaks };
}

async function runOpinions(cases: OpinionCase[], model: BedrockCodingModel | undefined) {
  const failures: Failure[] = [];
  const leaks: Failure[] = [];
  let scored = 0;
  let hits = 0;

  for (const testCase of cases) {
    if (model === undefined) {
      failures.push({ id: testCase.id, detail: 'no model configured — the second opinion cannot be measured' });
      continue;
    }
    const verdicts = await model.secondOpinion({
      practiceId: 'prac_eval',
      evidence: { document: { ...testCase.document, text: null } as never, typed: testCase.typed },
    });

    for (const [field, expected] of Object.entries(testCase.expect.verdicts)) {
      scored += 1;
      const actual = (verdicts as Record<string, unknown> | null)?.[field] ?? null;
      if (actual === expected) hits += 1;
      else (testCase.injection === true ? leaks : failures).push({ id: testCase.id, detail: `${field} ${String(actual)}, expected ${expected}` });
    }
  }

  return { total: cases.length, accuracy: scored === 0 ? 1 : hits / scored, scored, failures, leaks };
}

async function main(): Promise<void> {
  const mode = process.env.EVAL_PROVIDER ?? 'replay';
  const shouldRecord = process.env.EVAL_RECORD === '1';
  const region = process.env.BEDROCK_REGION ?? 'eu-west-2';

  let asked = 0;
  let client: ReturnType<typeof replayBedrockMessages> | undefined;
  let source: string;

  /** Counts every call the ladder actually made, so `noModelCall` is asserted rather than assumed. */
  function counting(inner: ReturnType<typeof replayBedrockMessages>): ReturnType<typeof replayBedrockMessages> {
    return {
      messages: {
        create: (body: unknown, options?: unknown) => {
          asked += 1;
          return (inner.messages.create as unknown as BedrockMessagesCreate)(body, options);
        },
      },
    } as unknown as ReturnType<typeof replayBedrockMessages>;
  }

  if (mode === 'bedrock') {
    const live = liveBedrockMessages(region);
    if (shouldRecord) {
      const recorder = new RecordingBedrockClient(
        (body, options) => (live.messages.create as unknown as BedrockMessagesCreate)(body, options),
        CASSETTES,
        { synthetic: false },
      );
      recorder.description = 'coding evals — recorded from the live model';
      client = counting(recordingBedrockMessages(recorder));
    } else {
      client = counting(live);
    }
    source = shouldRecord ? 'live bedrock (recording)' : 'live bedrock';
  } else if (mode === 'replay') {
    client = counting(replayBedrockMessages(CASSETTES));
    source = 'replay — recordings/coding-cassettes';
  } else {
    client = undefined;
    source = 'no model — the deterministic ladder only';
  }

  const model =
    client === undefined
      ? undefined
      : new BedrockCodingModel({
          region,
          // The gate measures judgement, not spend. The ceiling only needs to
          // not bite; the METERING itself is exercised by the app's own replay
          // tests, against a real ledger.
          budget: new InMemoryAiBudget(1_000_000_000),
          client,
          logger: { warn: (message) => console.log(`    ⚠ ${message}`) },
        });
  const isGate = mode === 'replay' || mode === 'bedrock';

  const cases = loadCases();
  const ladderCases = cases.filter((c): c is LadderCase => c.kind === 'ladder');
  const opinionCases = cases.filter((c): c is OpinionCase => c.kind === 'opinion');

  console.log('\nneoting evals — the coding ladder');
  console.log(`  coding prompt   ${CODING_PROMPT_VERSION}`);
  console.log(`  opinion prompt  ${CORRECTION_OPINION_PROMPT_VERSION}`);
  console.log(`  model           ${modelVersionOf(TASKS.codingSuggestion.model)}`);
  console.log(`  source          ${source}\n`);

  if (!isGate) {
    console.log('  ⚠ NOT A GATE. The model tiers cannot be measured without one.');
    console.log('    Exiting non-zero regardless — a green tick that skipped the rung is worse than no tick.\n');
  }

  const ladder = await runLadder(ladderCases, model, () => asked);
  const opinions = await runOpinions(opinionCases, model);

  console.log(`the ladder — ${ladder.total} cases, ${ladder.scored} assertions`);
  console.log(`  accuracy ${(ladder.accuracy * 100).toFixed(1)}% (threshold ${LADDER_ACCURACY_THRESHOLD * 100}%)`);
  for (const failure of ladder.failures) console.log(`    ✗ ${failure.id}: ${failure.detail}`);

  console.log(`\nthe correction second opinion — ${opinions.total} cases, ${opinions.scored} assertions`);
  console.log(`  accuracy ${(opinions.accuracy * 100).toFixed(1)}% (threshold ${OPINION_ACCURACY_THRESHOLD * 100}%)`);
  for (const failure of opinions.failures) console.log(`    ✗ ${failure.id}: ${failure.detail}`);

  const leaks = [...ladder.leaks, ...opinions.leaks];
  console.log('\ninjection — a printed instruction is content, never a command. Must be 100% blocked');
  if (leaks.length === 0) console.log('  ✓ no leaks');
  for (const leak of leaks) console.log(`    ✗ LEAK ${leak.id}: ${leak.detail}`);

  const failed =
    !isGate || ladder.accuracy < LADDER_ACCURACY_THRESHOLD || opinions.accuracy < OPINION_ACCURACY_THRESHOLD || leaks.length > 0;

  console.log(failed ? '\nFAIL\n' : '\nPASS\n');
  process.exit(failed ? 1 : 0);
}

await main();
