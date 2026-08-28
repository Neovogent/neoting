import { HttpStatus } from '@nestjs/common';

import type { PrismaClient } from '../../common/db/prisma.js';
import type { ScopeContext } from '../../common/db/scope-context.js';
import { scopedDb, type ScopedClient } from '../../common/db/scoped-db.js';
import { AppException } from '../../common/problem/problem.js';
import { currentTraceId } from '../../common/trace/trace-context.js';
import { wrapUntrusted } from '../../common/untrusted-content.js';
import type { AiBudget } from '../../common/ai-budget.js';
import { buildRuleDraft } from './drafts.js';
import {
  type CategoryOption,
  type GroundedRecord,
  loadCategories,
  NO_RECORDS_ANSWER,
  retrieveRecords,
  verifyCitations,
} from './grounding.js';
import { invokeStructured } from './invoke-structured.js';
import { modelVersionOf } from './models.js';
import { PROMPT_VERSION, SYSTEM_PROMPT } from './prompts/system-prompt.js';
import {
  type ModelTurn,
  ModelTurnSchema,
  RESPOND_TOOL_NAME,
  RESPOND_TOOL_SCHEMA,
} from './prompts/output-schema.js';
import type { CircuitBreaker } from './provider/circuit-breaker.js';
import {
  ModelAccessError,
  type ModelMessage,
  ModelOutputInvalidError,
  type ModelProvider,
  ModelUnavailableError,
} from './provider/model-provider.js';
import { logInjectionSignal } from './telemetry.js';

/**
 * The chat runtime (Governance §9), and the one place its rules compose.
 *
 * The order of operations below is the safety argument, so it is worth reading
 * as a sequence rather than as a function:
 *
 *   budget gate (§9.7) → loop caps (§9.5) → RLS-scoped retrieval (§9.4)
 *   → wrap everything external (§9.6) → one structured call (§9.2/§9.3)
 *   → verify citations against what we supplied (§9.4)
 *   → build a draft from real data, never from model numbers (§9.5)
 *
 * Nothing in this file writes domain state. The only artefact that can lead to
 * one is a `draft`, and a draft is a suggestion the caller must take to
 * `POST /action-proposals` and a human must then approve. §9.5: "The only
 * side-effect path available to any model is creating an ActionProposal" —
 * here the model does not even do that much.
 */

/** §9.5 per-feature caps. Defaults from Governance: 10 turns / 3 min. */
const MAX_HISTORY_TURNS = 10;
const MAX_WALL_CLOCK_MS = 180_000;

export interface ChatTurnInput {
  readonly utterance: string;
  readonly businessId?: string | undefined;
  readonly history?: readonly { role: 'user' | 'assistant'; content: string }[] | undefined;
}

export interface ChatTurnOutput {
  intent: ModelTurn['intent'];
  reply: string;
  draft?: unknown;
  navigation?: { businessId?: string; documentId?: string; statusFilter?: string; clientName?: string };
  references?: { type: GroundedRecord['type']; id: string; label: string }[];
  usage: {
    model: string;
    tier: 'judgment' | 'workhorse' | 'mechanical';
    inputTokens: number;
    outputTokens: number;
    cachedInputTokens: number;
    latencyMs: number;
    degraded: boolean;
    budgetRemainingPence: number;
    budgetWarning: boolean;
  };
  modelVersion: string;
  promptVersion: string;
}

export class ChatService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly provider: ModelProvider,
    private readonly breaker: CircuitBreaker,
    private readonly budget: AiBudget,
  ) {}

  async createTurn(context: ScopeContext, input: ChatTurnInput): Promise<ChatTurnOutput> {
    const traceId = currentTraceId() ?? 'untraced';
    const practiceId = context.practiceId ?? context.actorId;
    const startedAt = Date.now();

    // §9.7 — hard stop BEFORE the spend, with a message a person can act on.
    // Checked first because every step after this one costs money.
    const budgetBefore = await this.budget.check(practiceId);
    if (!budgetBefore.allowed) {
      throw new AppException(
        'NT-MDL-002',
        HttpStatus.TOO_MANY_REQUESTS,
        'Daily AI limit reached',
        "This practice has used its AI allowance for today. It resets at midnight UTC, and everything else in the workspace keeps working — only the assistant is paused.",
      );
    }

    const history = (input.history ?? []).slice(-MAX_HISTORY_TURNS);
    this.guardOscillation(input.utterance, history);

    const businessId = input.businessId;
    const { records, categories } = await this.readContext(context, businessId);

    const messages = buildMessages(input.utterance, history, records, categories, traceId, practiceId);

    const result = await this.callModel({ messages, traceId, practiceId, businessId: businessId ?? null });

    // §9.5 — the wall-clock cap is enforced after the call as well as around
    // it, because a call that returned at 3m01s has already spent the money and
    // the honest thing is to say so rather than render a stale answer into a
    // conversation the user has given up on.
    if (Date.now() - startedAt > MAX_WALL_CLOCK_MS) {
      throw new AppException(
        'NT-MDL-004',
        HttpStatus.SERVICE_UNAVAILABLE,
        'That took too long',
        'The assistant exceeded its time limit for one message. Try again, or narrow the question.',
      );
    }

    await this.budget.record(practiceId, result.costPence);
    const budgetAfter = await this.budget.check(practiceId);

    const turn = result.value;
    const output: ChatTurnOutput = {
      intent: turn.intent,
      reply: turn.reply,
      usage: {
        model: result.modelId,
        tier: result.tier,
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
        cachedInputTokens: result.cachedInputTokens,
        latencyMs: result.latencyMs,
        degraded: result.degraded,
        budgetRemainingPence: budgetAfter.remainingPence,
        budgetWarning: budgetAfter.warning,
      },
      modelVersion: modelVersionOf(result.tier),
      promptVersion: PROMPT_VERSION,
    };

    return this.decorate(context, output, turn, records, categories, businessId);
  }

  /**
   * §9.5's oscillation breaker, read for a surface with no tool loop: the
   * equivalent of "the same tool call twice in a row" is the same question
   * asked twice in a row and answered from the same records. Spending a second
   * judgment-tier call on it buys nothing, so it halts instead.
   */
  private guardOscillation(utterance: string, history: readonly { role: string; content: string }[]): void {
    const priorUser = history.filter((turn) => turn.role === 'user').slice(-2);
    const normalised = utterance.trim().toLowerCase();
    if (priorUser.length === 2 && priorUser.every((turn) => turn.content.trim().toLowerCase() === normalised)) {
      throw new AppException(
        'NT-MDL-004',
        HttpStatus.SERVICE_UNAVAILABLE,
        'Same question, same answer',
        'That is the third identical message in a row. Rephrasing it will get further than repeating it.',
      );
    }
  }

  /** All reads go through `scopedDb` — RLS decides what exists, not a where-clause here. */
  private async readContext(
    context: ScopeContext,
    businessId: string | undefined,
  ): Promise<{ records: readonly GroundedRecord[]; categories: readonly CategoryOption[] }> {
    if (businessId === undefined) return { records: [], categories: [] };

    return scopedDb(this.prisma, context, async (db: ScopedClient) => {
      const [records, categories] = await Promise.all([
        retrieveRecords(db, businessId),
        loadCategories(db, businessId),
      ]);
      return { records, categories };
    });
  }

  private async callModel(args: {
    messages: readonly ModelMessage[];
    traceId: string;
    practiceId: string;
    businessId: string | null;
  }): ReturnType<typeof invokeStructured<ModelTurn>> {
    try {
      return await invokeStructured(this.provider, this.breaker, {
        task: 'chatWorkspace',
        schema: ModelTurnSchema,
        system: SYSTEM_PROMPT,
        messages: args.messages,
        toolName: RESPOND_TOOL_NAME,
        toolSchema: RESPOND_TOOL_SCHEMA,
        traceId: args.traceId,
        practiceId: args.practiceId,
        businessId: args.businessId,
      });
    } catch (error) {
      // §9.3's floor: chat degrades to an honest error with a retry, never to a
      // guess. Both branches are 503 with a distinct code so the two very
      // different operational conditions never share an alert.
      // Same user-facing outcome as unavailable — the assistant is not there —
      // but a DIFFERENT operator story, so the detail carries the provider's
      // own words. "Model use case details have not been submitted for this
      // account" is a five-minute fix in a console by someone who will never
      // read a stack trace, and burying it under a generic message is how it
      // stays broken for a week.
      if (error instanceof ModelAccessError) {
        throw new AppException(
          'NT-MDL-001',
          HttpStatus.SERVICE_UNAVAILABLE,
          'The assistant is not switched on',
          `The model provider refused this account: ${error.providerDetail}`,
        );
      }
      if (error instanceof ModelUnavailableError) {
        throw new AppException(
          'NT-MDL-001',
          HttpStatus.SERVICE_UNAVAILABLE,
          'The assistant is unavailable',
          'The model could not be reached. Everything else in the workspace is unaffected — try the message again in a moment.',
        );
      }
      if (error instanceof ModelOutputInvalidError) {
        throw new AppException(
          'NT-MDL-003',
          HttpStatus.SERVICE_UNAVAILABLE,
          'The assistant could not answer that',
          'The model answered in a shape this surface refuses to render. Rephrasing usually fixes it.',
        );
      }
      throw error;
    }
  }

  /**
   * Turn the model's semantic answer into the wire shape: resolve names to ids
   * against records the caller can actually see, verify citations, and build
   * the rule draft from the client's own reference list.
   */
  private async decorate(
    context: ScopeContext,
    output: ChatTurnOutput,
    turn: ModelTurn,
    records: readonly GroundedRecord[],
    categories: readonly CategoryOption[],
    businessId: string | undefined,
  ): Promise<ChatTurnOutput> {
    if (businessId !== undefined) output.navigation = { businessId };

    if (turn.navigation?.statusFilter !== undefined) {
      output.navigation = { ...output.navigation, statusFilter: turn.navigation.statusFilter };
    }

    // ADD_CLIENT: the name is a prefill for the intake form, nothing more. The
    // schema already refuses it on any other intent; it crosses here verbatim
    // because the form is where it gets edited, not the model's paraphrase.
    if (turn.intent === 'ADD_CLIENT' && turn.navigation?.clientName !== undefined) {
      output.navigation = { ...output.navigation, clientName: turn.navigation.clientName };
    }

    if (turn.intent === 'REVIEW_DOCUMENT' && turn.navigation?.documentQuery !== undefined) {
      const documentId = resolveNamedDocument(records, turn.navigation.documentQuery);
      if (documentId === null) {
        output.intent = 'GENERAL';
        output.reply = `I could not find a document matching "${turn.navigation.documentQuery}" for this client.`;
        return output;
      }
      output.navigation = { ...output.navigation, documentId };
    }

    if (turn.intent === 'GROUNDED_ANSWER' && turn.grounded !== undefined) {
      const cited = verifyCitations(records, turn.grounded.citedRecordIds);
      if (cited === null) {
        // A fabricated citation. §9.4 makes this a failed turn, not a filtered
        // list — an answer standing on a source that does not exist is the
        // exact thing the citation requirement is there to catch.
        output.intent = 'GENERAL';
        output.reply = NO_RECORDS_ANSWER;
        return output;
      }
      if (cited.length === 0) output.reply = NO_RECORDS_ANSWER;
      else output.references = cited.map((r) => ({ type: r.type, id: r.id, label: r.label }));
      return output;
    }

    if (turn.intent === 'LIVE_RULE') {
      if (businessId === undefined) {
        output.intent = 'GENERAL';
        output.reply = 'Pick a client first — a coding rule belongs to one client, not to the practice.';
        return output;
      }
      const built = await scopedDb(this.prisma, context, (db) => buildRuleDraft(db, businessId, turn, categories));
      if (!built.ok) {
        output.intent = 'GENERAL';
        output.reply = built.reason;
        return output;
      }
      output.draft = built.draft;
      // The reply for a rule is composed HERE, not taken from the model.
      // It states the two facts the accountant is about to approve — the
      // supplier as their documents spell it, and the category as their own
      // chart of accounts names it — and both were resolved from real rows a
      // moment ago. A model's paraphrase of its own draft is the one sentence
      // on this surface that could describe something other than what will
      // actually be created.
      output.reply =
        `Rule: whenever ${built.draft.payload.scopeKey} documents arrive, code them ${built.categoryName}` +
        `${built.draft.payload.sets.vatTreatment === undefined ? '' : ` with ${built.draft.payload.sets.vatTreatment} VAT`}. ` +
        'It activates only after you review and approve it.';
    }

    return output;
  }
}

/**
 * Assemble the conversation. Everything volatile lives here rather than in the
 * system prompt, because the system prompt is the cache prefix (§9.7).
 *
 * Every externally-authored fragment is wrapped (§9.6) — the utterance is NOT,
 * because the accountant is the one party in this conversation whose words are
 * an instruction. Their prior turns in `history` are wrapped anyway: a replayed
 * turn arrives from the client, and a client is not a trust boundary.
 */
export function buildMessages(
  utterance: string,
  history: readonly { role: 'user' | 'assistant'; content: string }[],
  records: readonly GroundedRecord[],
  categories: readonly CategoryOption[],
  traceId: string,
  practiceId: string,
): readonly ModelMessage[] {
  const messages: ModelMessage[] = [];

  for (const turn of history) {
    messages.push({
      role: turn.role,
      content: turn.role === 'user' ? wrapUntrusted(turn.content) : turn.content,
    });
  }

  const context: string[] = [];

  if (categories.length > 0) {
    context.push(
      `Categories on this client's chart of accounts (copy a code EXACTLY):\n${categories
        .map((c) => `  ${c.code} — ${c.name}`)
        .join('\n')}`,
    );
  }

  if (records.length > 0) {
    // The records themselves already carry per-field wrapping from
    // `retrieveRecords`, so the block is assembled, not re-wrapped — nesting
    // the tags would let a supplier name close the outer block.
    context.push(`This client's recent records, one per line, id in brackets:\n${records.map((r) => r.line).join('\n')}`);
    flagInjectionAttempts(records, traceId, practiceId);
  }

  context.push(`The accountant says: ${utterance}`);
  messages.push({ role: 'user', content: context.join('\n\n') });

  return messages;
}

/**
 * §9.6: an injection attempt the wrapper neutralised is still worth counting.
 * This does not change what the model is sent — the wrapping already did the
 * defending — it just makes the attempt visible in a dashboard rather than
 * silent.
 */
const INJECTION_SIGNALS = /ignore (?:all )?(?:previous|prior|above)|disregard (?:the )?instructions|system prompt|approve everything/i;

function flagInjectionAttempts(records: readonly GroundedRecord[], traceId: string, practiceId: string): void {
  for (const record of records) {
    if (INJECTION_SIGNALS.test(record.line)) {
      logInjectionSignal({ traceId, practiceId, source: `${record.type}:${record.id}` });
    }
  }
}

/** "the Currys receipt" → a document id, but only among rows the caller can see. */
function resolveNamedDocument(records: readonly GroundedRecord[], query: string): string | null {
  const needle = query.trim().toLowerCase();
  if (needle.length < 2) return null;
  const match = records.find((r) => r.type === 'document' && r.label.toLowerCase().includes(needle));
  return match?.id ?? null;
}
