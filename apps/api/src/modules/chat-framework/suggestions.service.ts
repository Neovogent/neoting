import type { PrismaClient } from '../../common/db/prisma.js';
import type { ScopeContext } from '../../common/db/scope-context.js';
import { scopedDb, type ScopedClient } from '../../common/db/scoped-db.js';
import { currentTraceId } from '../../common/trace/trace-context.js';
import { wrapUntrusted } from '../../common/untrusted-content.js';
import type { AiBudget } from '../../common/ai-budget.js';
import { invokeStructured } from './invoke-structured.js';
import { modelVersionOf } from './models.js';
import {
  SUGGEST_TOOL_NAME,
  SUGGEST_TOOL_SCHEMA,
  SUGGESTIONS_PROMPT_VERSION,
  SUGGESTIONS_SYSTEM_PROMPT,
  SuggestionsTurnSchema,
} from './prompts/suggestions-prompt.js';
import type { CircuitBreaker } from './provider/circuit-breaker.js';
import type { ModelProvider } from './provider/model-provider.js';

/**
 * The chat box's briefing (`GET /v1/chat/suggestions`).
 *
 * The one surface in this module where a model failure degrades instead of
 * erroring, and the contract says so in as many words: §9.3's honest-error
 * floor exists so a person who ASKED something is never given a guess, but
 * nobody asked this endpoint anything — it is ambient. A briefing that
 * degrades to a deterministic ranking over the same RLS-scoped counts, and
 * says `source: 'derived'` when it does, keeps both halves of the honesty
 * rule: the sentence is never invented, and its provenance is never dressed
 * up. The same fallback serves when the daily budget (§9.7) is spent —
 * a hint is the last thing a capped practice should spend its ceiling on.
 *
 * Cached per practice+scope for a short window because the workspace calls it
 * on every load and poll; without the cache, an idle browser would meter the
 * budget for nobody.
 */

export interface SuggestionItem {
  readonly text: string;
  readonly because: string;
  readonly weight: number;
}

export interface SuggestionsOutput {
  suggestions: SuggestionItem[];
  source: 'model' | 'derived';
  modelVersion?: string;
  promptVersion?: string;
  generatedAt: string;
}

/** Everything the briefing may know. Counts and names — never row contents. */
export interface PracticeState {
  readonly businessCount: number;
  /** Up to five names, for a suggestion that names a client. Externally authored — wrapped before any model sees them. */
  readonly businessNames: readonly string[];
  readonly toReview: number;
  readonly readyForExport: number;
  readonly failed: number;
  readonly processing: number;
  readonly openChases: number;
  readonly oldestOpenChaseDays: number | null;
  readonly pendingProposals: number;
}

export type PracticeStateReader = (
  prisma: PrismaClient,
  context: ScopeContext,
  businessId: string | undefined,
) => Promise<PracticeState>;

const CACHE_TTL_MS = 60_000;

/** ChaseState values that mean "still somebody's problem". */
const OPEN_CHASE_STATES = ['DETECTED', 'PROPOSED', 'APPROVED', 'SENT', 'REMINDED', 'ESCALATED'] as const;

export class SuggestionsService {
  private readonly cache = new Map<string, { at: number; value: SuggestionsOutput }>();

  constructor(
    private readonly prisma: PrismaClient,
    private readonly provider: ModelProvider,
    private readonly breaker: CircuitBreaker,
    private readonly budget: AiBudget,
    // Injectable so the unit tests exercise the model/fallback/cache paths
    // without a database; the default is the real RLS-scoped read.
    private readonly readState: PracticeStateReader = readPracticeState,
  ) {}

  async getSuggestions(context: ScopeContext, businessId: string | undefined): Promise<SuggestionsOutput> {
    const practiceId = context.practiceId ?? context.actorId;
    const cacheKey = `${practiceId}:${businessId ?? ''}`;

    const cached = this.cache.get(cacheKey);
    if (cached !== undefined && Date.now() - cached.at < CACHE_TTL_MS) return cached.value;

    const state = await this.readState(this.prisma, context, businessId);
    const value = await this.compose(practiceId, businessId ?? null, state);

    this.cache.set(cacheKey, { at: Date.now(), value });
    return value;
  }

  private async compose(practiceId: string, businessId: string | null, state: PracticeState): Promise<SuggestionsOutput> {
    // A brand-new practice needs the door pointed at, not an analysis of an
    // empty pipeline — and not a model call spent describing nothing.
    if (state.businessCount === 0) return derived(state);

    const budgetNow = await this.budget.check(practiceId);
    if (!budgetNow.allowed) return derived(state);

    const traceId = currentTraceId() ?? 'untraced';
    try {
      const result = await invokeStructured(this.provider, this.breaker, {
        task: 'chatSuggestions',
        schema: SuggestionsTurnSchema,
        system: SUGGESTIONS_SYSTEM_PROMPT,
        messages: [{ role: 'user', content: buildSuggestionsMessage(state) }],
        toolName: SUGGEST_TOOL_NAME,
        toolSchema: SUGGEST_TOOL_SCHEMA,
        traceId,
        practiceId,
        businessId,
      });
      await this.budget.record(practiceId, result.costPence);

      return {
        suggestions: [...result.value.suggestions].sort((a, b) => b.weight - a.weight),
        source: 'model',
        modelVersion: modelVersionOf(result.tier),
        promptVersion: SUGGESTIONS_PROMPT_VERSION,
        generatedAt: new Date().toISOString(),
      };
    } catch {
      // Ambient surface, deliberate degrade — see the module comment and the
      // operation's own contract prose. The provenance says what happened.
      return derived(state);
    }
  }
}

/** The real read: counts through `scopedDb`, RLS deciding what exists. */
export async function readPracticeState(
  prisma: PrismaClient,
  context: ScopeContext,
  businessId: string | undefined,
): Promise<PracticeState> {
  return scopedDb(prisma, context, async (db: ScopedClient) => {
    const scoped = businessId === undefined ? {} : { businessId };

    const [businesses, docStates, openChases, oldestOpen, pendingProposals] = await Promise.all([
      db.business.findMany({ select: { name: true }, orderBy: { name: 'asc' }, take: 6 }),
      db.document.groupBy({
        by: ['state'],
        where: { ...scoped, archivedAt: null },
        _count: { _all: true },
      }),
      db.chase.count({ where: { ...scoped, state: { in: [...OPEN_CHASE_STATES] } } }),
      db.chase.findFirst({
        where: { ...scoped, state: { in: [...OPEN_CHASE_STATES] } },
        orderBy: { createdAt: 'asc' },
        select: { createdAt: true },
      }),
      db.actionProposal.count({ where: { state: { in: ['CREATED', 'REVIEWED'] } } }),
    ]);

    const countOf = (state: string): number =>
      docStates.find((row) => row.state === state)?._count._all ?? 0;

    return {
      businessCount: businesses.length,
      businessNames: businesses.slice(0, 5).map((b) => b.name),
      toReview: countOf('TO_REVIEW'),
      readyForExport: countOf('READY'),
      failed: countOf('FAILED') + countOf('REJECTED'),
      processing: countOf('PROCESSING'),
      openChases,
      oldestOpenChaseDays:
        oldestOpen === null ? null : Math.floor((Date.now() - oldestOpen.createdAt.getTime()) / 86_400_000),
      pendingProposals,
    };
  });
}

/**
 * The volatile half of the conversation, after the cache breakpoint. Counts
 * are the server's own; the client NAMES are externally authored (a client
 * registers their own company details), so the names line is wrapped.
 */
export function buildSuggestionsMessage(state: PracticeState): string {
  const lines = [
    `Clients: ${state.businessCount}`,
    state.businessNames.length > 0
      ? `Client names: ${wrapUntrusted(state.businessNames.join(', '))}`
      : 'Client names: none',
    `Documents to review: ${state.toReview}`,
    `Documents ready for export: ${state.readyForExport}`,
    `Documents failed: ${state.failed}`,
    `Documents still processing: ${state.processing}`,
    `Open chases: ${state.openChases}` +
      (state.oldestOpenChaseDays === null ? '' : ` (oldest open ${state.oldestOpenChaseDays} days)`),
    `Proposals awaiting review or approval: ${state.pendingProposals}`,
  ];
  return `The practice's pipeline right now:\n${lines.join('\n')}\n\nWrite the suggestions.`;
}

/**
 * The deterministic fallback, and the empty-practice greeting. Mirrors the
 * ranking the web's own `suggestPrompts` uses, so a degrade reads as the same
 * product with plainer prose — D42 vocabulary throughout (release for export,
 * never publish-to-ledger).
 */
export function derived(state: PracticeState): SuggestionsOutput {
  const out: SuggestionItem[] = [];

  if (state.businessCount === 0) {
    out.push({
      text: 'Add my first client',
      because: 'no clients yet — intake takes two minutes, the rest is emailed to them',
      weight: 100,
    });
  } else {
    if (state.failed > 0) {
      out.push({
        text: 'What failed, and why?',
        because: `${state.failed} document${state.failed === 1 ? '' : 's'} failed`,
        weight: 95,
      });
    }
    if (state.openChases > 0 && (state.oldestOpenChaseDays ?? 0) >= 3) {
      out.push({
        text: 'Which chases have had no reply, and what should I do about them?',
        because: `a chase has been open ${state.oldestOpenChaseDays} days`,
        weight: 90,
      });
    }
    if (state.toReview > 0) {
      out.push({
        text: 'Show me everything waiting to be reviewed',
        because: `${state.toReview} document${state.toReview === 1 ? '' : 's'} to review`,
        weight: 70,
      });
    }
    if (state.readyForExport > 0) {
      out.push({
        text: 'What is ready to release for export?',
        because: `${state.readyForExport} document${state.readyForExport === 1 ? '' : 's'} ready`,
        weight: 60,
      });
    }
    if (state.pendingProposals > 0) {
      out.push({
        text: 'What is waiting on my approval?',
        because: `${state.pendingProposals} item${state.pendingProposals === 1 ? '' : 's'} pending approval`,
        weight: 55,
      });
    }
    if (out.length === 0) {
      out.push({ text: 'How is the month looking?', because: 'nothing urgent is outstanding', weight: 10 });
    }
  }

  return {
    suggestions: out.sort((a, b) => b.weight - a.weight).slice(0, 6),
    source: 'derived',
    generatedAt: new Date().toISOString(),
  };
}
