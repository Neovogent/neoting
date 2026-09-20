import { Logger } from '@nestjs/common';

import type { PrismaClient } from '../../../common/db/prisma.js';
import { systemContext } from '../../../common/db/scope-context.js';
import { scopedDb, type ScopedClient } from '../../../common/db/scoped-db.js';
import { systemActorsByPractice } from '../../../common/db/resolve-system-actor.js';
import { credentialsFor, type LedgerEnv, vaultKeyFor, vendorConfigForKind } from './ledger-config.js';
import { LedgerConnectionUnavailable, LedgerTokenStore } from './token-store.js';
import { isLedgerKind, vendorForKind } from './vendors.js';

/**
 * The refresh scheduler (D50, build brief Stage 1).
 *
 * ## What it is actually for, which is not what it sounds like
 *
 * It is **not** how an access token stays fresh. `LedgerTokenStore.connection`
 * refreshes on demand before every vendor call, which covers every connection
 * anybody is using; a scheduler for that would be a timer racing a request.
 *
 * It exists for the connection **nobody is using**. Three of the four vendors
 * expire a REFRESH token that sits idle — Xero after 60 days, Sage after 31,
 * QuickBooks after 100 — so a client whose accountant publishes nothing over a
 * quiet summer loses the connection silently, and the practice finds out when a
 * batch of forty fails in front of them in September. One refresh inside the
 * window resets the clock.
 *
 * FreeAgent has no such clock (~20 years) and is skipped rather than refreshed
 * for the sake of symmetry.
 *
 * ## Why it is a plain function and not a BullMQ job
 *
 * `runLedgerRefreshSweep` reads its work list from the database and is safe to
 * call any number of times — the same shape `runPublishFollowUp` and
 * `findStaleDedupeFollowUps` have, and the same seam a repeatable job replaces
 * without a call-site change. The worker calls it on an interval; a test calls
 * it directly.
 *
 * ## ⚠ The sanctioned sweep, not an unscoped read
 *
 * A refresh belongs to no user and to no request, so there is no context to
 * inherit. `systemActorsByPractice` + one `scopedDb` per practice is the
 * documented answer (`common/db/resolve-system-actor.ts`): **RLS answers, not a
 * filter**, so this cannot be handed a row a practice's own policies would have
 * refused. It costs one scoped read per practice and runs twice a day.
 */

/** Refresh a connection whose refresh token is within this of its idle expiry. */
const IDLE_MARGIN_MS = 7 * 24 * 60 * 60 * 1000;

/** How often the worker calls the sweep. Twice a day: the shortest idle window is 31 days. */
export const LEDGER_REFRESH_INTERVAL_MS = 12 * 60 * 60 * 1000;

export interface RefreshSweepResult {
  readonly checked: number;
  readonly refreshed: number;
  readonly failed: number;
}

export async function runLedgerRefreshSweep(
  prisma: PrismaClient,
  env: LedgerEnv,
  now: () => number = () => Date.now(),
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<RefreshSweepResult> {
  const logger = new Logger('LedgerRefreshSweep');
  if (env.LEDGER_ADAPTER !== 'http') return { checked: 0, refreshed: 0, failed: 0 };

  const vaultKey = vaultKeyFor(env);
  const practices = await systemActorsByPractice(prisma);
  let checked = 0;
  let refreshed = 0;
  let failed = 0;

  for (const practice of practices) {
    // The practice's machine actor — the sanctioned way to read without a
    // request behind it. RLS still decides what comes back.
    const ctx = systemContext(practice.practiceId, practice.systemUserId);
    const due = await scopedDb(prisma, ctx, async (db: ScopedClient) => {
      const rows = await db.integration.findMany({
        where: { isActive: true, NOT: { tokenRef: null } },
        select: { id: true, kind: true, tokenExpiresAt: true },
      });
      return rows.filter((row) => isLedgerKind(row.kind));
    });

    for (const row of due) {
      const vendor = vendorForKind(row.kind);
      // FreeAgent: no idle clock, nothing to keep alive.
      if (vendor === null || vendor.refreshIdleDays === null) continue;
      if (credentialsFor(env, vendor.slug) === null) continue;

      // ⚠ `tokenExpiresAt` is the ACCESS token's expiry, which is the only
      // clock on the row — the refresh token's own idle deadline is inside the
      // sealed blob. The access expiry is a sound PROXY for "when did anything
      // last happen on this connection", because every successful refresh
      // rewrites it: a row whose access token expired long ago is a row nobody
      // has used since, which is exactly the population this sweep is for.
      const lastActivity = row.tokenExpiresAt?.getTime() ?? 0;
      const idleDeadline = lastActivity + vendor.refreshIdleDays * 24 * 60 * 60 * 1000;
      if (idleDeadline - now() > IDLE_MARGIN_MS) continue;

      checked += 1;
      const store = new LedgerTokenStore(
        prisma,
        ctx,
        vaultKey,
        (slug) => credentialsFor(env, slug),
        // ⚠ Env-aware — a refresh posted to the wrong host is a connection lost.
        (kind) => vendorConfigForKind(env, kind),
        fetchImpl,
        now,
      );
      try {
        await store.forceRefresh(row.id);
        refreshed += 1;
      } catch (error) {
        // ⚠ One connection failing must not end the sweep. A revoked
        // connection is the expected case here, not an exception: the store
        // has already written the reason onto the row, which is where a
        // practice reads it.
        failed += 1;
        logger.warn(
          `${vendor.label} connection ${row.id} could not be renewed — ${
            error instanceof LedgerConnectionUnavailable || error instanceof Error ? error.message : 'unknown error'
          }`,
        );
      }
    }
  }

  if (checked > 0) logger.log(`ledger refresh sweep: ${refreshed} renewed, ${failed} failed, of ${checked} due`);
  return { checked, refreshed, failed };
}
