import IORedis, { type Redis } from 'ioredis';

/**
 * Per-firm daily token budgets (Governance §9.7): warn at 80%, hard-stop at
 * 100% with a clear user-facing message.
 *
 * ⚠ IT LIVES IN `common/`, NOT IN `chat-framework/`, SINCE S5 (27 Aug 2026).
 * It sat inside the chat module while chat was the only thing that spent money.
 * `BedrockExtractor` is now the second spender — and the bigger one by volume —
 * so the meter has two consumers in two different modules. `common/` is where
 * this codebase keeps shared infrastructure (`common/db/`,
 * `common/untrusted-content.ts`) and is the one place both may import from:
 * `no-cross-module-internals` deliberately does not police `common/`, whereas
 * reaching into `chat-framework/budget.js` from `extraction` would be a lint
 * error and re-exporting it through that module's seam would have broken the
 * seam's own stated rule — it carries CONFIGURATION, NOT BEHAVIOUR, and a
 * ledger with a Redis connection is behaviour.
 *
 * ⚠ ONE METER, TWO SPENDERS, AND THAT COUPLING IS DELIBERATE. §9.7 defines a
 * per-FIRM daily budget, and a firm that wants to know what it spent on AI today
 * must get one number, not two. The consequence is real and worth stating: a
 * practice that exhausts the ceiling in chat will see that day's documents land
 * FAILED, and a document flood will make chat return its honest budget error.
 * Both refusals are visible and neither invents data, which is the property that
 * matters — but if the two ever need separate ceilings, this is the file, and it
 * is a second key segment rather than a second implementation.
 *
 * The key is §9.7's, verbatim: `nt:{practiceId}:_:ai:budget:{date}`. The `_`
 * segment is the business slot — AI spend is a practice-level meter, not a
 * per-client one, and writing the placeholder keeps the key shape identical to
 * every other namespaced key so a future per-client budget is a segment change
 * rather than a new key family.
 *
 * **The ledger is in pence, not tokens.** §9.7 calls it a token budget, but a
 * ceiling that has to be compared against a price list at read time is a
 * ceiling nobody can reason about when three tiers cost different amounts.
 * Tokens are converted once, at the point of spend, by `costPence` in
 * `models.ts` — the one place the rates live.
 *
 * **Check-then-spend, not reserve-then-settle.** A turn is checked before it
 * runs and recorded after it finishes, so a practice can overshoot its ceiling
 * by at most the cost of one in-flight turn. Holding a reservation across a
 * model call would mean a crashed process leaks budget until the key expires,
 * which is a worse failure than a few pence of overshoot.
 */

export interface BudgetVerdict {
  readonly allowed: boolean;
  readonly spentPence: number;
  readonly remainingPence: number;
  /** True from 80% onward (§9.7). Surfaced on the turn so the user sees it coming. */
  readonly warning: boolean;
}

export interface AiBudget {
  check(practiceId: string): Promise<BudgetVerdict>;
  record(practiceId: string, pence: number): Promise<void>;
}

/** UTC date, because storage is UTC (Governance §12) and a budget day must not move with BST. */
export function budgetKey(practiceId: string, now: Date): string {
  const date = now.toISOString().slice(0, 10);
  return `nt:${practiceId}:_:ai:budget:${date}`;
}

const WARN_AT = 0.8;
/** Two days, so a key written at 23:59 UTC is still readable for a full day after. */
const KEY_TTL_SECONDS = 172_800;

export class RedisAiBudget implements AiBudget {
  constructor(
    private readonly redis: Pick<Redis, 'get' | 'incrby' | 'expire'>,
    private readonly ceilingPence: number,
    private readonly now: () => Date = () => new Date(),
  ) {}

  static fromUrl(url: string, ceilingPence: number): RedisAiBudget {
    return new RedisAiBudget(new IORedis(url), ceilingPence);
  }

  async check(practiceId: string): Promise<BudgetVerdict> {
    const raw = await this.redis.get(budgetKey(practiceId, this.now()));
    const spentPence = raw === null ? 0 : Number.parseInt(raw, 10);
    // A corrupt value must not read as "unlimited". NaN fails the comparison
    // below in the permissive direction, so it is normalised to the ceiling —
    // fail closed, and the operator sees a stuck budget rather than a runaway.
    const spent = Number.isFinite(spentPence) ? spentPence : this.ceilingPence;
    return verdict(spent, this.ceilingPence);
  }

  async record(practiceId: string, pence: number): Promise<void> {
    if (pence <= 0) return;
    const key = budgetKey(practiceId, this.now());
    await this.redis.incrby(key, pence);
    // Set on every write rather than only on creation: one EXPIRE is cheaper
    // than the GET that would tell us whether it is needed, and a key that
    // never expires is a slow leak nobody notices.
    await this.redis.expire(key, KEY_TTL_SECONDS);
  }
}

/**
 * The in-process budget for `AI_CHAT=demo` and for tests. Same arithmetic, no
 * Redis — so budget behaviour is unit-testable without a container, and a
 * laptop without Redis still enforces a ceiling rather than silently having none.
 */
export class InMemoryAiBudget implements AiBudget {
  private readonly ledger = new Map<string, number>();

  constructor(
    private readonly ceilingPence: number,
    private readonly now: () => Date = () => new Date(),
  ) {}

  check(practiceId: string): Promise<BudgetVerdict> {
    const spent = this.ledger.get(budgetKey(practiceId, this.now())) ?? 0;
    return Promise.resolve(verdict(spent, this.ceilingPence));
  }

  record(practiceId: string, pence: number): Promise<void> {
    if (pence > 0) {
      const key = budgetKey(practiceId, this.now());
      this.ledger.set(key, (this.ledger.get(key) ?? 0) + pence);
    }
    return Promise.resolve();
  }
}

function verdict(spentPence: number, ceilingPence: number): BudgetVerdict {
  const remainingPence = Math.max(0, ceilingPence - spentPence);
  return {
    allowed: spentPence < ceilingPence,
    spentPence,
    remainingPence,
    warning: spentPence >= ceilingPence * WARN_AT,
  };
}
