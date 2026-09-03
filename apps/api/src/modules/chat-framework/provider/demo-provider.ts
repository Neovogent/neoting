import { RESPOND_TOOL_NAME } from '../prompts/output-schema.js';
import { MODELS } from '../models.js';
import type { ModelProvider, ModelRequest, ModelResponse } from './model-provider.js';

/**
 * A deterministic stand-in for the model, selected by `AI_CHAT=demo`.
 *
 * // DEMO-MOCK: this is not the product's classifier and must never be selected
 * // in staging or production — `env.ts` refuses `AI_CHAT=demo` under
 * // NODE_ENV=production for exactly that reason.
 *
 * It exists for two honest jobs, and neither of them is "be the AI":
 *
 * 1. **Tests never open a socket.** Every other external in this repo has a
 *    fixture behind the same kind of seam (`selectExtractor`,
 *    `selectDocumentStore`, `selectSmsSender`); a chat runtime whose unit tests
 *    required AWS credentials would simply not be run.
 * 2. **A cold clone still works.** `pnpm dev` on a laptop with no AWS
 *    credentials gets a workspace that responds, so the ten-minute
 *    clone-to-running target survives.
 *
 * The matching below is intentionally crude — first keyword wins, no attempt at
 * nuance. Making it clever would invite someone to mistake it for the product.
 * Anything it does not recognise returns `GENERAL`, which is the same graceful
 * answer the real model is instructed to prefer over a wrong guess.
 */
export class DemoModelProvider implements ModelProvider {
  readonly name = 'demo' as const;

  invoke(request: ModelRequest): Promise<ModelResponse> {
    const utterance = lastUserText(request).toLowerCase();
    const output = classify(utterance);

    return Promise.resolve({
      output,
      // Token counts are fabricated but proportional, so the budget ledger and
      // the telemetry path are exercised rather than bypassed in dev.
      usage: {
        inputTokens: Math.ceil(request.system.length / 4),
        outputTokens: Math.ceil(JSON.stringify(output).length / 4),
        cachedInputTokens: 0,
        cacheCreationInputTokens: 0,
      },
      modelId: `${MODELS[request.tier]} (demo stand-in)`,
    });
  }
}

/**
 * The accountant's words, and only those.
 *
 * `buildMessages` assembles the last user turn as reference list + records +
 * `The accountant says: …`, so a naive "read the last user message" hands this
 * classifier the client's whole record set. That is not a cosmetic problem: a
 * seeded bank row carrying the words `chase-suppressed` made every eval case
 * classify as LIVE_CHASE, which looked like a model failure and was a harness
 * failure. Split on the marker; fall back to the whole turn only if it is
 * absent.
 */
const UTTERANCE_MARKER = 'The accountant says: ';

function lastUserText(request: ModelRequest): string {
  for (let i = request.messages.length - 1; i >= 0; i -= 1) {
    const message = request.messages[i];
    if (message?.role !== 'user') continue;
    const marker = message.content.lastIndexOf(UTTERANCE_MARKER);
    return marker === -1 ? message.content : message.content.slice(marker + UTTERANCE_MARKER.length);
  }
  return '';
}

const CATEGORY_WORDS: readonly (readonly [RegExp, string])[] = [
  [/cost of sales[,\s—-]*food|food cost/, 'COST_OF_SALES_FOOD'],
  [/cost of sales[,\s—-]*drink|drink cost/, 'COST_OF_SALES_DRINK'],
  [/advertising|marketing/, 'ADVERTISING'],
  [/software|subscription/, 'SOFTWARE'],
  [/office equipment/, 'OFFICE_EQUIPMENT'],
  [/general expense/, 'GENERAL_EXPENSES'],
];

function classify(text: string): unknown {
  if (/\b(whenever|always|every time)\b/.test(text)) {
    const supplier = /whenever\s+(?:an?\s+)?([a-z0-9&' -]{2,30}?)\s+(?:invoices?|bills?|receipts?|documents?)/.exec(
      text,
    )?.[1];
    const category = CATEGORY_WORDS.find(([pattern]) => pattern.test(text))?.[1];
    if (supplier !== undefined && category !== undefined) {
      return {
        intent: 'LIVE_RULE',
        reply: 'I have parsed that into a rule. It activates only after you review and approve it.',
        rule: {
          supplier: supplier.trim().replace(/\b\w/g, (c) => c.toUpperCase()),
          categoryCode: category,
          ...(/\bstandard\b/.test(text) ? { vatTreatment: 'standard' } : {}),
        },
      };
    }
  }

  if (/\b(chase|nudge|remind|follow up)\b/.test(text)) {
    return {
      intent: 'LIVE_CHASE',
      reply: 'I have drafted the chase from the live bank feed. Nothing sends until you approve it.',
    };
  }
  if (/\b(publish|push)\b/.test(text)) {
    return { intent: 'LIVE_PUBLISH', reply: 'Here is the publish batch. The review shows server-computed totals.' };
  }
  if (/\b(missing|outstanding|unmatched|no receipt)\b/.test(text)) {
    return { intent: 'LIVE_MISSING', reply: "Here is what is missing, straight from the bank feed." };
  }
  if (/\b(to|for|needs?|awaiting)\s+review\b/.test(text)) {
    return { intent: 'SHOW_INBOX', reply: 'Here is everything waiting for review.', navigation: { statusFilter: 'review' } };
  }
  const named = /\b(?:open|show me|pull up)\s+(?:the\s+)?(.+?)\s+(?:receipt|invoice|bill|document)\b/.exec(text)?.[1];
  if (named !== undefined) {
    return {
      intent: 'REVIEW_DOCUMENT',
      reply: 'Here it is. Every field shows its confidence and provenance.',
      navigation: { documentQuery: named.trim() },
    };
  }

  // Name what was asked before listing alternatives — a fallback that ignores
  // the question reads as not listening, however honest the list is. The echo
  // is truncated so the reply stays inside ModelTurnSchema's 1200-char cap.
  // (The real model's GENERAL behaviour is the prompt's to shape; changing
  // that is a §9.8 re-record, tracked in this module's CLAUDE.md.)
  const echoed = text.length > 80 ? `${text.slice(0, 79)}…` : text;
  return {
    intent: 'GENERAL',
    reply:
      `I did not understand "${echoed}". ` +
      'I can show missing paperwork, draft a chase, teach a coding rule, publish approved costs, or open a document.',
  };
}

/** Named for the forced-tool contract the real provider honours. */
export const DEMO_TOOL_NAME = RESPOND_TOOL_NAME;
