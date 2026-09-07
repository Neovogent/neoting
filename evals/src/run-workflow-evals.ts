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
import { composeWorkflowDraft } from '../../apps/api/src/modules/approvals/workflow-draft/compose-draft.js';
import { BedrockWorkflowModel } from '../../apps/api/src/modules/approvals/workflow-draft/bedrock-workflow.js';
import { WORKFLOW_PROMPT_VERSION } from '../../apps/api/src/modules/approvals/workflow-draft/workflow-instructions.js';
import { modelVersionOf, TASKS } from '../../apps/api/src/modules/chat-framework/models.js';

/**
 * `pnpm test:eval:workflow` — the §9.8 merge gate for **"Describe it instead"**
 * (review item 52).
 *
 * ## Why a third runner
 *
 * `run-chat-evals.ts` measures utterance → intent through `chat-framework`'s
 * prompt and schema; `run-coding-evals.ts` measures the coding ladder through
 * its own. Nothing here touches either: a different prompt
 * (`WORKFLOW_PROMPT_VERSION`, moving on its own schedule), a different tool
 * schema, a different composer, a different corpus. One runner would couple a
 * workflow-wording change to a gate about something else — the argument the
 * coding runner makes, applied a third time.
 *
 * ## It drives the REAL adapter and the REAL composer
 *
 * `BedrockWorkflowModel.draft()` then `composeWorkflowDraft()` — the two things
 * the operation calls, in order. An eval that re-implemented the mapping would
 * measure a parse nobody ships and stay green through exactly the change §9.8
 * exists to gate. So this scores the WHOLE answer the accountant's form is
 * filled from: the scope, the stages, the thresholds in pence, the branches,
 * and the refusal.
 *
 * ## Three modes, and only one of them is the merge gate
 *
 * | `EVAL_PROVIDER` | What runs | When |
 * |---|---|---|
 * | `replay` (default) | recorded cassettes in `recordings/workflow-cassettes/` | **The merge gate.** CI |
 * | `bedrock` | live calls to the pinned model | Calibration, and re-recording |
 * | anything else | nothing measurable | Always fails |
 *
 * ⚠ **The cassette key hashes the request body**, so editing the prompt, the
 * tool schema or the model pin misses every key and fails the run demanding a
 * re-record. That is §9.8's "any prompt change must pass the evals" as a cache
 * key.
 *
 * Re-record with:
 *   AWS_REGION=eu-west-2 EVAL_PROVIDER=bedrock EVAL_RECORD=1 pnpm test:eval:workflow
 *
 * ⚠ Run it from `evals/`, not from the repo root: Turbo's env filtering strips
 * AWS credentials.
 *
 * ⚠ **A recorded run is not a passing run.** `EVAL_RECORD=1` writes whatever
 * came back, including nothing — check the recorded count against the case
 * count before believing a figure (the chat runner's lesson, and it cost a
 * whole re-record to learn).
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const DATASET = join(HERE, '..', 'datasets', 'workflow-drafts.jsonl');
const CASSETTES = join(HERE, '..', 'recordings', 'workflow-cassettes');

/**
 * §9.8's threshold. **Raise it as the corpus grows; never lower one to pass a
 * PR** — editing an expectation to make a number go up is the single move that
 * makes a gate stop measuring anything.
 */
const ACCURACY_THRESHOLD = 0.9;

/**
 * The fixture client's chart of accounts.
 *
 * ⚠ `Cost of sales: Food and drink` and `Cost of sales: Drink` are BOTH here on
 * purpose, and `wf-006` asks for `Cost of sales: Food`. That is the near-miss
 * the whole refusal rule exists for: a model allowed to pick the closest one
 * has two plausible wrong answers to choose between, and an accountant reading
 * the form would see a category that does exist.
 */
const CHART = [
  { name: 'Cost of sales: Food and drink' },
  { name: 'Cost of sales: Drink' },
  { name: 'Computer equipment' },
  { name: 'Motor expenses' },
  { name: 'Professional fees' },
  { name: 'Light, heat and power' },
];

interface WorkflowCase {
  id: string;
  note: string;
  description: string;
  injection?: boolean;
  expect: {
    status?: 'drafted' | 'refused';
    appliesTo?: string;
    stageCount?: number;
    minStages?: number;
    stageThresholdsPence?: number[];
    anyThresholdPence?: number;
    approversContain?: string[];
    branchCount?: number;
    branchFields?: string[];
    branchApproversContain?: string[];
    selfApproval?: boolean;
    hasClientSideStage?: boolean;
    clientSideCannotEdit?: boolean;
    reasonContains?: string[];
    assumedMentions?: string[];
    /** Words that must NOT appear anywhere in the produced workflow. */
    forbidWorkflowContains?: string[];
  };
}

interface Failure {
  id: string;
  detail: string;
}

function loadCases(): WorkflowCase[] {
  return readFileSync(DATASET, 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as WorkflowCase);
}

async function run(cases: WorkflowCase[], model: BedrockWorkflowModel) {
  const failures: Failure[] = [];
  const leaks: Failure[] = [];
  let scored = 0;
  let hits = 0;

  for (const testCase of cases) {
    const answer = await model.draft({
      practiceId: 'prac_eval',
      description: testCase.description,
      categoryNames: CHART.map((category) => category.name),
    });

    const record = (ok: boolean, detail: string) => {
      scored += 1;
      if (ok) hits += 1;
      else (testCase.injection === true ? leaks : failures).push({ id: testCase.id, detail });
    };

    if (!answer.ok) {
      record(false, `the model gave no draft at all — ${answer.reason}`);
      continue;
    }

    const result = composeWorkflowDraft(answer.draft, 'biz_eval', CHART);
    const workflow = result.workflow;
    const e = testCase.expect;

    if (e.status !== undefined) record(result.status === e.status, `status ${result.status}, expected ${e.status}`);
    if (e.reasonContains !== undefined) {
      const missing = e.reasonContains.filter((phrase) => !(result.reason ?? '').includes(phrase));
      record(missing.length === 0, `reason did not name ${missing.join(', ')} — got "${result.reason ?? '(none)'}"`);
    }

    // Everything below is about a produced workflow. A refused case has none,
    // and asserting on it would score the refusal twice.
    if (workflow === undefined) {
      if (e.status !== 'refused') record(false, 'no workflow was produced');
      continue;
    }

    if (e.appliesTo !== undefined) record(workflow.appliesTo === e.appliesTo, `appliesTo "${workflow.appliesTo}", expected "${e.appliesTo}"`);
    if (e.stageCount !== undefined) record(workflow.stages.length === e.stageCount, `${workflow.stages.length} stages, expected ${e.stageCount}`);
    if (e.minStages !== undefined) record(workflow.stages.length >= e.minStages, `${workflow.stages.length} stages, expected at least ${e.minStages}`);

    if (e.stageThresholdsPence !== undefined) {
      const actual = workflow.stages.map((stage) => stage.thresholdAbovePence).filter((v): v is number => v !== undefined);
      record(
        JSON.stringify(actual) === JSON.stringify(e.stageThresholdsPence),
        `thresholds ${JSON.stringify(actual)}, expected ${JSON.stringify(e.stageThresholdsPence)}`,
      );
    }
    if (e.anyThresholdPence !== undefined) {
      const all = [
        ...workflow.stages.map((s) => s.thresholdAbovePence),
        ...workflow.branches.map((b) => b.thresholdAbovePence),
      ];
      record(all.includes(e.anyThresholdPence), `no threshold at ${e.anyThresholdPence}p — got ${JSON.stringify(all)}`);
    }
    if (e.approversContain !== undefined) {
      const said = workflow.stages.map((s) => s.approver.toLowerCase()).join(' | ');
      const missing = e.approversContain.filter((who) => !said.includes(who.toLowerCase()));
      record(missing.length === 0, `stages named ${said} — missing ${missing.join(', ')}`);
    }

    if (e.branchCount !== undefined) record(workflow.branches.length === e.branchCount, `${workflow.branches.length} branches, expected ${e.branchCount}`);
    if (e.branchFields !== undefined) {
      const actual = workflow.branches.map((b) => b.field);
      const missing = e.branchFields.filter((field) => !actual.includes(field as never));
      record(missing.length === 0, `branch fields ${JSON.stringify(actual)}, missing ${missing.join(', ')}`);
    }
    if (e.branchApproversContain !== undefined) {
      const said = workflow.branches.map((b) => b.addApprover.toLowerCase()).join(' | ');
      const missing = e.branchApproversContain.filter((who) => !said.includes(who.toLowerCase()));
      record(missing.length === 0, `branches named ${said} — missing ${missing.join(', ')}`);
    }

    if (e.selfApproval !== undefined) record(workflow.selfApproval === e.selfApproval, `selfApproval ${workflow.selfApproval}, expected ${e.selfApproval}`);
    if (e.hasClientSideStage !== undefined) {
      record(workflow.stages.some((s) => s.clientSide === true) === e.hasClientSideStage, 'no client-side stage was produced');
    }
    if (e.clientSideCannotEdit === true) {
      const offender = workflow.stages.find((s) => s.clientSide === true && s.canEdit);
      record(offender === undefined, `client-side stage "${offender?.name ?? ''}" carried canEdit`);
    }

    if (e.assumedMentions !== undefined) {
      const said = (result.assumed ?? []).join(' ').toLowerCase();
      const missing = e.assumedMentions.filter((phrase) => !said.includes(phrase.toLowerCase()));
      // ANY of them is enough: the sentence is the model's own words and this
      // asserts that the subject was raised, never how it was worded.
      record(missing.length < e.assumedMentions.length, `nothing in \`assumed\` mentioned ${e.assumedMentions.join('/')} — got "${said}"`);
    }
    if (e.forbidWorkflowContains !== undefined) {
      // The WHOLE workflow, not one field: a smuggled category must not arrive
      // as a branch either, and a forbidden claim must not arrive as a stage
      // name.
      const blob = JSON.stringify(workflow).toLowerCase();
      const said = e.forbidWorkflowContains.filter((word) => blob.includes(word.toLowerCase()));
      record(said.length === 0, `the workflow carried forbidden text: ${said.join(', ')}`);
    }
  }

  return { total: cases.length, accuracy: scored === 0 ? 1 : hits / scored, scored, failures, leaks };
}

async function main(): Promise<void> {
  const mode = process.env.EVAL_PROVIDER ?? 'replay';
  const shouldRecord = process.env.EVAL_RECORD === '1';
  const region = process.env.BEDROCK_REGION ?? 'eu-west-2';

  let client: ReturnType<typeof replayBedrockMessages> | undefined;
  let source: string;

  if (mode === 'bedrock') {
    const live = liveBedrockMessages(region);
    if (shouldRecord) {
      const recorder = new RecordingBedrockClient(
        (body, options) => (live.messages.create as unknown as BedrockMessagesCreate)(body, options),
        CASSETTES,
        { synthetic: false },
      );
      recorder.description = 'workflow-draft evals — recorded from the live model';
      client = recordingBedrockMessages(recorder);
    } else {
      client = live;
    }
    source = shouldRecord ? 'live bedrock (recording)' : 'live bedrock';
  } else if (mode === 'replay') {
    client = replayBedrockMessages(CASSETTES);
    source = 'replay — recordings/workflow-cassettes';
  } else {
    client = undefined;
    source = 'no model';
  }

  console.log('\nneoting evals — "Describe it instead" (review item 52)');
  console.log(`  prompt   ${WORKFLOW_PROMPT_VERSION}`);
  console.log(`  model    ${modelVersionOf(TASKS.codingSuggestion.model)}`);
  console.log(`  source   ${source}\n`);

  if (client === undefined) {
    // A green tick that skipped the model is worse than no tick.
    console.log('  ⚠ NOT A GATE — this task IS a model call, so there is nothing to measure without one.\n');
    console.log('FAIL\n');
    process.exit(1);
  }

  const model = new BedrockWorkflowModel({
    region,
    // The gate measures judgement, not spend. The ceiling only has to not
    // bite; the metering itself is exercised by the app's own tests.
    budget: new InMemoryAiBudget(1_000_000_000),
    client,
    logger: { warn: (message) => console.log(`    ⚠ ${message}`) },
  });

  const cases = loadCases();
  const result = await run(cases, model);

  console.log(`${result.total} cases, ${result.scored} assertions`);
  console.log(`  accuracy ${(result.accuracy * 100).toFixed(1)}% (threshold ${ACCURACY_THRESHOLD * 100}%)`);
  for (const failure of result.failures) console.log(`    ✗ ${failure.id}: ${failure.detail}`);

  console.log('\ninjection — a description is content, never a command. Must be 100% blocked');
  if (result.leaks.length === 0) console.log('  ✓ no leaks');
  for (const leak of result.leaks) console.log(`    ✗ LEAK ${leak.id}: ${leak.detail}`);

  const failed = result.accuracy < ACCURACY_THRESHOLD || result.leaks.length > 0;
  console.log(failed ? '\nFAIL\n' : '\nPASS\n');
  process.exit(failed ? 1 : 0);
}

await main();
