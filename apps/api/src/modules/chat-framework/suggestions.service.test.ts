import { describe, expect, test } from 'vitest';

import type { PrismaClient } from '../../common/db/prisma.js';
import type { ScopeContext } from '../../common/db/scope-context.js';
import { InMemoryAiBudget } from '../../common/ai-budget.js';
import { CircuitBreaker } from './provider/circuit-breaker.js';
import { ModelUnavailableError, type ModelProvider, type ModelResponse } from './provider/model-provider.js';
import {
  SUGGEST_TOOL_SCHEMA,
  SUGGESTIONS_SYSTEM_PROMPT,
  SuggestionsTurnSchema,
} from './prompts/suggestions-prompt.js';
import {
  buildSuggestionsMessage,
  derived,
  readPracticeState,
  SuggestionsService,
  type PracticeState,
} from './suggestions.service.js';

const CONTEXT: ScopeContext = {
  actorId: 'usr_1',
  practiceId: 'prac_1',
  sessionScope: 'user',
  grantedItemIds: [],
};

/** The injected reader replaces every Prisma read, so this is never touched. */
const NO_PRISMA = {} as PrismaClient;

const BUSY_STATE: PracticeState = {
  businessCount: 3,
  businessNames: ['Ananda Group', 'American Burger Ltd'],
  toReview: 4,
  readyForExport: 2,
  failed: 1,
  processing: 0,
  openChases: 2,
  oldestOpenChaseDays: 6,
  pendingProposals: 3,
};

const EMPTY_STATE: PracticeState = {
  businessCount: 0,
  businessNames: [],
  toReview: 0,
  readyForExport: 0,
  failed: 0,
  processing: 0,
  openChases: 0,
  oldestOpenChaseDays: null,
  pendingProposals: 0,
};

const MODEL_TURN = {
  suggestions: [
    { text: 'What failed, and why?', because: '1 document failed', weight: 60 },
    { text: 'Chase the quiet clients', because: 'a chase has been open 6 days', weight: 90 },
  ],
};

function providerReturning(output: unknown, calls?: { count: number }): ModelProvider {
  return {
    name: 'demo',
    invoke: () => {
      if (calls) calls.count += 1;
      return Promise.resolve({
        output,
        usage: { inputTokens: 100, outputTokens: 20, cachedInputTokens: 0, cacheCreationInputTokens: 0 },
        modelId: 'test-model',
      } satisfies ModelResponse);
    },
  };
}

const NEVER_CALLED: ModelProvider = {
  name: 'demo',
  invoke: () => {
    throw new Error('the provider must not be invoked on this path');
  },
};

function service(provider: ModelProvider, state: PracticeState, ceilingPence = 500): SuggestionsService {
  return new SuggestionsService(NO_PRISMA, provider, new CircuitBreaker(), new InMemoryAiBudget(ceilingPence), () =>
    Promise.resolve(state),
  );
}

describe('the briefing, end to end', () => {
  test('a model answer comes back ranked, with provenance and versions', async () => {
    const out = await service(providerReturning(MODEL_TURN), BUSY_STATE).getSuggestions(CONTEXT, undefined);

    expect(out.source).toBe('model');
    expect(out.suggestions.map((s) => s.weight)).toEqual([90, 60]);
    expect(out.modelVersion).toContain('claude-opus-4-6');
    expect(out.promptVersion).toContain('chat-suggestions/');
    expect(out.generatedAt).toBeTruthy();
  });

  test('an empty practice is greeted, not analysed — no model call, no spend', async () => {
    const out = await service(NEVER_CALLED, EMPTY_STATE).getSuggestions(CONTEXT, undefined);

    expect(out.source).toBe('derived');
    expect(out.suggestions[0]?.text).toContain('first client');
  });

  test('a spent budget degrades to the derived ranking rather than erroring or spending', async () => {
    const out = await service(NEVER_CALLED, BUSY_STATE, 0).getSuggestions(CONTEXT, undefined);

    expect(out.source).toBe('derived');
    expect(out.suggestions.length).toBeGreaterThan(0);
  });

  test('a model failure degrades honestly — ambient surface, deliberate exception to the §9.3 error floor', async () => {
    const failing: ModelProvider = {
      name: 'demo',
      invoke: () => Promise.reject(new ModelUnavailableError('down')),
    };
    const out = await service(failing, BUSY_STATE).getSuggestions(CONTEXT, undefined);

    expect(out.source).toBe('derived');
    // The derived list still reflects the real state, not a canned greeting.
    expect(out.suggestions.some((s) => s.because.includes('failed'))).toBe(true);
  });

  test('the second call inside the window is the cache, not a second spend', async () => {
    const calls = { count: 0 };
    const svc = service(providerReturning(MODEL_TURN, calls), BUSY_STATE);

    await svc.getSuggestions(CONTEXT, undefined);
    await svc.getSuggestions(CONTEXT, undefined);

    expect(calls.count).toBe(1);
  });

  test('a scoped and an unscoped read cache separately', async () => {
    const calls = { count: 0 };
    const svc = service(providerReturning(MODEL_TURN, calls), BUSY_STATE);

    await svc.getSuggestions(CONTEXT, undefined);
    await svc.getSuggestions(CONTEXT, 'biz_1');

    expect(calls.count).toBe(2);
  });
});

describe('the derived ranking', () => {
  test('speaks D42 — release for export, never publish, never a ledger vendor', () => {
    const everything = derived(BUSY_STATE);
    const text = everything.suggestions.map((s) => `${s.text} ${s.because}`).join(' ').toLowerCase();
    for (const forbidden of ['publish', 'xero', 'quickbooks', 'sync', 'connect']) {
      expect(text).not.toContain(forbidden);
    }
  });

  test('a clean pipeline gets one gentle overview, not an invented emergency', () => {
    const out = derived({ ...EMPTY_STATE, businessCount: 2 });
    expect(out.suggestions).toHaveLength(1);
    expect(out.suggestions[0]?.because).toBe('nothing urgent is outstanding');
  });
});

describe('the message and the prompt', () => {
  test('client names travel wrapped — a client registers their own company name', () => {
    const message = buildSuggestionsMessage(BUSY_STATE);
    expect(message).toContain('<untrusted_content>');
    expect(message).toContain('Ananda Group');
  });

  test('the system prompt stays a byte-stable cache prefix', () => {
    expect(SUGGESTIONS_SYSTEM_PROMPT).not.toMatch(/\$\{/);
  });

  test('the tool schema refuses extra properties at every level, like the Zod', () => {
    expect(SUGGEST_TOOL_SCHEMA.additionalProperties).toBe(false);
    expect(SUGGEST_TOOL_SCHEMA.properties.suggestions.items.additionalProperties).toBe(false);
    expect(
      SuggestionsTurnSchema.safeParse({ suggestions: MODEL_TURN.suggestions, extra: true }).success,
    ).toBe(false);
  });
});

/**
 * ⚠ **Trash does not become work** (soft delete, `documents.deleted_at`,
 * 2 Sep 2026).
 *
 * `readPracticeState` is where the ambient surface gets its numbers, and those
 * numbers are the whole product on this seam: they become the "4 documents to
 * review" chip and the practice state the model is given to reason from. A
 * deleted document counted here offers an accountant a job that no longer
 * exists — and because the chip is what they click, the cost is not a wrong
 * figure on a dashboard, it is a dead end at the end of a click.
 *
 * The double records the `where` rather than filtering rows by it. That is
 * deliberate and is the honest boundary: Postgres applies the predicate, and
 * the only thing THIS layer decides is what the predicate says. A fake that
 * re-implemented `deletedAt`/`archivedAt` matching would be a fake standing in
 * for the query it is meant to be testing, and would pass whatever it was
 * asked.
 */
describe('the practice state a suggestion is built from', () => {
  const readerFor = (calls: { where: unknown }[]) => {
    const tx = {
      $executeRaw: async () => 0,
      business: { findMany: async () => [] },
      document: {
        groupBy: async (args: { where: unknown }) => {
          calls.push({ where: args.where });
          return [];
        },
      },
      chase: { count: async () => 0, findFirst: async () => null },
      actionProposal: { count: async () => 0 },
    };
    return { $transaction: async (fn: (t: unknown) => Promise<unknown>) => fn(tx) } as unknown as PrismaClient;
  };

  test('⚠ the document counts exclude Trash as well as ARCHIVED — two columns, two clauses', async () => {
    const calls: { where: unknown }[] = [];
    await readPracticeState(readerFor(calls), CONTEXT, 'biz_1');

    // `archivedAt: null` was already here and is NOT the same column. A
    // document can be deleted without ever having been archived, so the
    // existing clause excludes none of Trash.
    expect(calls).toHaveLength(1);
    expect(calls[0]?.where).toEqual({ businessId: 'biz_1', archivedAt: null, deletedAt: null });
  });

  test('the whole-practice read (no business selected) is filtered too', async () => {
    // `businessId === undefined` spreads an EMPTY object into the where, so
    // this is the branch where a missing predicate would leak across every
    // client the practice has rather than one.
    const calls: { where: unknown }[] = [];
    await readPracticeState(readerFor(calls), CONTEXT, undefined);

    expect(calls[0]?.where).toEqual({ archivedAt: null, deletedAt: null });
  });
});
