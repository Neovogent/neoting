/**
 * Measure what one CODING decision actually costs — review item 19's rung, and
 * the number Shakib's model-pin decision rests on.
 *
 * ## Why this is a script and not a number in a document
 *
 * `scripts/measure/extraction-cost.ts`'s argument, one rung over: a cost figure
 * with no way to re-take it decays into folklore and gets quoted in a pricing
 * conversation long after the model, the prompt or the chart moved underneath
 * it.
 *
 * ⚠ That is not hypothetical here. The estimate this rung was PINNED on was
 * taken from a character count of the GENERAL chart's instructions and came out
 * roughly a third low, because a real client's chart plus their own intake
 * answers make the prompt substantially bigger than the probe measured. The
 * pin still stands; the arithmetic under it moved, and this script is why that
 * was found rather than discovered in an invoice.
 *
 * Re-run whenever `TASKS.codingSuggestion`, `MODELS`, `CODING_DECISION_RULES`,
 * `CODING_TOOL_SCHEMA` or the chart in `profiles.ts` changes.
 *
 * ## What it measures
 *
 * The REAL `BedrockCodingModel` — the production class, its real instructions
 * built from a real client's chart AND their intake answers, its real forced
 * tool call, the model pinned in `chat-framework/models.ts` — over the corpus
 * documents that actually reach the rung. Nothing is stubbed but the budget,
 * which is a counter.
 *
 * The tokens are read from the same `usage` block `BedrockCodingModel.record`
 * bills from, priced through the same `costPence` and the same rate table. So
 * this is the number that lands on a practice's daily ledger, not an
 * approximation of it.
 *
 * ## ⚠ THE RATE MATTERS, NOT THE PER-CALL PRICE
 *
 * This rung is NOT reached for every document. It fires only after an
 * accountant's rule, a practice default, this client's own history AND the
 * deterministic suggestion have all declined — so the blended per-document cost
 * is `extraction + (escalation rate × this)`. The script prints the rate at
 * which the guardrail is crossed, because that is the number to watch and
 * nobody has measured it yet.
 *
 * ## Running it
 *
 *   AWS_REGION=eu-west-2 TSX_TSCONFIG_PATH=apps/api/tsconfig.json \
 *     pnpm tsx scripts/measure/coding-cost.ts
 *
 * ⚠ **`TSX_TSCONFIG_PATH` is not optional here, and its sibling does not need
 * it.** esbuild applies a tsconfig's options only to files that tsconfig
 * MATCHES, and the root one does not match `apps/api/src`. The coding rung
 * reaches `clients-team-settings`' public seam for the client's intake answers,
 * that barrel reaches `notifications`', and that one exports a Nest controller —
 * so without the flag the run dies on "Parameter decorators only work when
 * experimental decorators are enabled", pointing at a file this script never
 * calls. `extraction-cost.ts` reaches no barrel and so never met it.
 *
 * It spends real money — a few model calls, a few pence — against whatever
 * account the AWS credentials in the environment resolve to. It writes nothing
 * to a database and needs no local services.
 */

import { setTimeout as sleep } from 'node:timers/promises';

import { InMemoryAiBudget } from '../../apps/api/src/common/ai-budget.js';
import { liveBedrockMessages } from '../../apps/api/src/common/bedrock-replay.js';
import { costPence, MODELS, TASKS } from '../../apps/api/src/modules/chat-framework/index.js';
import { BedrockCodingModel } from '../../apps/api/src/modules/rules-suggestions/coding/bedrock-coding.js';
import { CODING_REPLAY_CASES } from '../../apps/api/src/modules/rules-suggestions/coding/coding-replay-corpus.js';

/** SoT §16's per-document ceiling, in pence (£0.02). Blended across the whole pipeline. */
const GUARDRAIL_PENCE = 2;

/**
 * What EXTRACTION costs the same document (S5, 27 Aug 2026 — 1.26p image /
 * 1.34p PDF). Stated as the measured figure rather than the metered one,
 * because the blend is about real spend and `costPence` rounds up per call.
 */
const EXTRACTION_PENCE = 1.34;

const TIER = TASKS.codingSuggestion.model;
const REGION = process.env['BEDROCK_REGION'] ?? process.env['AWS_REGION'] ?? 'eu-west-2';

interface Measurement {
  readonly label: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly ms: number;
  readonly answer: string;
}

/**
 * The real transport with the `usage` block kept on the way past.
 *
 * ⚠ `BedrockCodingModel` deliberately reports NOTHING about a call — every
 * failure is silence and there is no result object to hang a token count on —
 * so the tap goes on the seam its unit tests and the cassette recorder already
 * drive. Measuring THROUGH the real class rather than around it is what makes
 * the figure the one that gets billed.
 */
function tappedTransport() {
  const live = liveBedrockMessages(REGION);
  let input = 0;
  let output = 0;

  const client = {
    messages: {
      create: async (body: unknown, options?: unknown) => {
        const response = await (live.messages.create as unknown as (b: unknown, o?: unknown) => Promise<unknown>)(body, options);
        const usage = (response as { usage?: { input_tokens?: number; output_tokens?: number } }).usage;
        input = usage?.input_tokens ?? 0;
        output = usage?.output_tokens ?? 0;
        return response;
      },
    },
  } as unknown as typeof live;

  return { client, usage: () => ({ input, output }) };
}

async function measure(kase: (typeof CODING_REPLAY_CASES)[number]): Promise<Measurement> {
  const tap = tappedTransport();
  const model = new BedrockCodingModel({
    region: REGION,
    budget: new InMemoryAiBudget(1_000_000),
    client: tap.client,
    logger: { warn: (message) => process.stdout.write(`  ⚠ ${message}\n`) },
  });

  const started = Date.now();
  const answer = await model.suggest(kase.request);
  const ms = Date.now() - started;
  const { input, output } = tap.usage();

  const described =
    answer === null
      ? 'no answer'
      : answer.outcome === 'SUGGEST'
        ? `SUGGEST ${answer.categoryCode} at ${answer.confidence}`
        : `ESCALATE ${answer.reason}`;

  return { label: kase.name, inputTokens: input, outputTokens: output, ms, answer: described };
}

async function main(): Promise<void> {
  process.stdout.write(`\ncoding rung cost — ${MODELS[TIER]} (${TIER} tier), ${REGION}\n`);
  process.stdout.write(`  ${CODING_REPLAY_CASES.length} document(s) from the replay corpus, through the REAL model\n\n`);

  const results: Measurement[] = [];
  for (const kase of CODING_REPLAY_CASES) {
    process.stdout.write(`coding ${kase.name}...\n`);
    results.push(await measure(kase));
    await sleep(500); // be polite to the endpoint between calls
  }

  process.stdout.write('\n');
  let worstPence = 0;
  for (const result of results) {
    // Priced per HUNDRED through the same `costPence`, because the meter rounds
    // UP per call and at these token counts the rounding is a large part of one
    // document's number. Quote the per-100 figure in a pricing conversation,
    // never the per-call one — `extraction/CLAUDE.md` makes the same warning.
    const perHundred = costPence(TIER, result.inputTokens * 100, result.outputTokens * 100);
    const each = perHundred / 100;
    worstPence = Math.max(worstPence, each);

    process.stdout.write(`${result.label}\n`);
    process.stdout.write(`  ${result.inputTokens} in + ${result.outputTokens} out tokens · ${(result.ms / 1000).toFixed(1)} s\n`);
    process.stdout.write(`  ${costPence(TIER, result.inputTokens, result.outputTokens)}p metered · ${each.toFixed(2)}p each at volume\n`);
    process.stdout.write(`  ${result.answer}\n\n`);
  }

  const perDocument = EXTRACTION_PENCE + worstPence;
  process.stdout.write(`worst coding call ${worstPence.toFixed(2)}p.\n`);
  process.stdout.write(
    `a document that REACHES this rung costs ${perDocument.toFixed(2)}p ` +
      `(extraction ${EXTRACTION_PENCE}p + coding ${worstPence.toFixed(2)}p) — ` +
      `${perDocument <= GUARDRAIL_PENCE ? 'inside' : 'OVER'} the ${GUARDRAIL_PENCE}p blended guardrail.\n\n`,
  );

  const breakEvenRate = (GUARDRAIL_PENCE - EXTRACTION_PENCE) / worstPence;
  process.stdout.write(
    '⚠ THE RATE IS THE NUMBER TO WATCH, not the per-call price. The rung is the TAIL: it is\n' +
      'reached only after a rule, a practice default, this client’s own history and the\n' +
      'deterministic suggestion have all declined. Blended cost is\n' +
      `  extraction + (escalation rate × coding)\n` +
      `so the ${GUARDRAIL_PENCE}p guardrail holds while fewer than ${(breakEvenRate * 100).toFixed(0)}% of documents reach it.\n` +
      'Nobody has measured that rate yet. It is what the document_events rows with\n' +
      "stage 'code' and outcome 'suggested' would answer, against 'escalated' and the total.\n\n",
  );
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
