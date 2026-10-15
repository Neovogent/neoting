import { getPrismaClient, type PrismaClient } from '../db/prisma.js';
import type { ScopeContext } from '../db/scope-context.js';
import { scopedDb } from '../db/scoped-db.js';

/**
 * Feature flags (rush/admin): the `feature_flags` table finally has a reader.
 *
 * A flag's value for a session is the global `is_enabled`, overridden by the
 * session's practice's row in `feature_flag_overrides` when one exists. Both
 * reads run inside `scopedDb(ctx)` — `feature_flags` is unpoliced platform
 * config, the overrides are RLS-confined to the caller's own practice.
 *
 * Cached per practice for {@link FLAG_CACHE_TTL_MS}. ponytail: per-process
 * cache — a toggle reaches other API tasks within the TTL, not instantly.
 * Unleash would replace this class behind the same `evaluate` signature.
 */
export const FLAG_CACHE_TTL_MS = 30_000;

export type EvaluatedFlags = Readonly<Record<string, boolean>>;

export class FeatureFlagService {
  readonly #cache = new Map<string, { at: number; flags: EvaluatedFlags }>();

  constructor(
    private readonly prisma: () => PrismaClient,
    private readonly now: () => number = Date.now,
  ) {}

  async evaluate(ctx: ScopeContext): Promise<EvaluatedFlags> {
    const key = ctx.practiceId ?? '';
    const hit = this.#cache.get(key);
    if (hit !== undefined && this.now() - hit.at < FLAG_CACHE_TTL_MS) return hit.flags;

    const flags = await scopedDb(this.prisma(), ctx, async (db) => {
      const [globals, overrides] = await Promise.all([
        db.featureFlag.findMany({ select: { key: true, isEnabled: true } }),
        ctx.practiceId === undefined
          ? Promise.resolve([])
          : db.featureFlagOverride.findMany({
              where: { practiceId: ctx.practiceId },
              select: { flagKey: true, isEnabled: true },
            }),
      ]);
      return evaluateFlags(globals, overrides);
    });
    this.#cache.set(key, { at: this.now(), flags });
    return flags;
  }

  /** Drop the cache — called after an admin toggle so this process sees it at once. */
  invalidate(): void {
    this.#cache.clear();
  }
}

/** Pure: globals, then a practice's overrides win. An override for a flag with no global row is ignored. */
export function evaluateFlags(
  globals: readonly { key: string; isEnabled: boolean }[],
  overrides: readonly { flagKey: string; isEnabled: boolean }[],
): EvaluatedFlags {
  const out: Record<string, boolean> = {};
  for (const flag of globals) out[flag.key] = flag.isEnabled;
  for (const override of overrides) if (override.flagKey in out) out[override.flagKey] = override.isEnabled;
  return out;
}

let shared: FeatureFlagService | undefined;

/** The process-wide instance, shared by `GET /me` and the admin console. */
export function sharedFeatureFlags(): FeatureFlagService {
  shared ??= new FeatureFlagService(getPrismaClient);
  return shared;
}
