import type { StructuredCallInput } from './invoke-structured.js';
import { ModelTurnSchema, type ModelTurn, RESPOND_TOOL_NAME, RESPOND_TOOL_SCHEMA } from './prompts/output-schema.js';
import { SYSTEM_PROMPT } from './prompts/system-prompt.js';

/**
 * The canonical replay corpus for `AI_CHAT=replay` — `extraction/
 * replay-corpus.ts`'s sibling, under the same three-consumer contract: the
 * recorder records exactly these calls, the replay tests replay exactly these
 * calls, and anything else is a loud miss naming the record command.
 *
 * Expressed as `StructuredCallInput`s rather than raw transport bodies because
 * the body is the ADAPTER's to build: the recorder and the tests both run the
 * real `invokeStructured` → `BedrockModelProvider` path over these inputs, so
 * what lands on (and is looked up from) disk is the request the real code
 * actually assembles. `traceId` / `practiceId` / `businessId` never reach the
 * transport body, so they do not shape the cassette key — any practice replays.
 *
 * The RETRY case records TWO exchanges: a first answer that fails
 * `ModelTurnSchema`, and the corrected answer to the follow-up request that
 * §9.2's retry assembles (the model's own JSON appended, then the validation
 * error). Both requests are keyed off bodies the real code builds — which is
 * the proof that replay exercises the retry path, not a simulation of it. It
 * is ALWAYS synthetic: a live model cannot be made to fail a schema on demand.
 *
 * Editing `SYSTEM_PROMPT`, `RESPOND_TOOL_SCHEMA`, the model pin — or the
 * validation message text §9.2's retry embeds — moves the keys, and the replay
 * tests fail on a miss demanding a re-record. The eval-recording property
 * (`evals/src/replay-provider.ts`), deliberately shared.
 */

export interface ChatReplayCase {
  readonly name: string;
  readonly description: string;
  readonly input: StructuredCallInput<ModelTurn>;
  /**
   * The transport answers, in call order, that the recorder scripts when not
   * recording live (and always, for the retry case). Shape-faithful to a real
   * InvokeModel answer; marked `synthetic: true` in the cassette.
   */
  readonly syntheticResponses: readonly Record<string, unknown>[];
}

/** One transport answer carrying one forced `respond` tool call. */
function respondWith(input: Record<string, unknown>, inputTokens: number, outputTokens: number): Record<string, unknown> {
  return {
    stop_reason: 'tool_use',
    content: [{ type: 'tool_use', id: 'toolu_REDACTED', name: RESPOND_TOOL_NAME, input }],
    usage: {
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    },
  };
}

const HAPPY_INPUT: StructuredCallInput<ModelTurn> = {
  task: 'chatWorkspace',
  schema: ModelTurnSchema,
  system: SYSTEM_PROMPT,
  messages: [{ role: 'user', content: 'The accountant says: what needs review today?' }],
  toolName: RESPOND_TOOL_NAME,
  toolSchema: RESPOND_TOOL_SCHEMA,
  traceId: 'replay-corpus',
  practiceId: 'prac_replay',
  businessId: null,
};

const RETRY_INPUT: StructuredCallInput<ModelTurn> = {
  ...HAPPY_INPUT,
  messages: [
    { role: 'user', content: 'The accountant says: whenever a Bidfood invoice arrives, code it cost of sales, food.' },
  ],
};

export const CHAT_REPLAY_CASES: readonly ChatReplayCase[] = [
  {
    name: 'happy-turn',
    description: 'chat · one turn, valid on the first answer',
    input: HAPPY_INPUT,
    syntheticResponses: [
      respondWith(
        {
          intent: 'SHOW_INBOX',
          reply: 'Here is everything waiting for review.',
          navigation: { statusFilter: 'review' },
        },
        2681,
        64,
      ),
    ],
  },
  {
    // ⚠ ALWAYS SYNTHETIC — see the header. First answer: LIVE_RULE with no
    // rule, which `ModelTurnSchema`'s superRefine rejects. Second answer, to
    // the retry request the real §9.2 code assembles: the corrected turn.
    name: 'schema-retry',
    description: 'chat · first answer fails the schema, §9.2 retry corrects it (SYNTHETIC by design)',
    input: RETRY_INPUT,
    syntheticResponses: [
      respondWith({ intent: 'LIVE_RULE', reply: 'I have parsed that into a rule.' }, 2704, 38),
      respondWith(
        {
          intent: 'LIVE_RULE',
          reply: 'I have parsed that into a rule. It activates only after you review and approve it.',
          rule: { supplier: 'Bidfood', categoryCode: 'COST_OF_SALES_FOOD' },
        },
        2811,
        73,
      ),
    ],
  },
];
