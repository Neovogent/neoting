import type { Prisma, PrismaClient } from '@prisma/client';

import { type ScopeContext, ScopeContextSchema } from './scope-context.js';

/**
 * The Prisma client as callers see it inside `scopedDb`. It is the transaction
 * client, not the root client, and that is the point: the root client has
 * `$transaction`, `$connect` and `$executeRaw` on it, and none of those should
 * be reachable from inside a scoped unit of work.
 */
export type ScopedClient = Omit<PrismaClient, ITX_EXCLUDED>;
type ITX_EXCLUDED = '$connect' | '$disconnect' | '$on' | '$transaction' | '$use' | '$extends';

/**
 * Governance §5.2, R6: **the only sanctioned way to reach the database.**
 *
 * Opens a transaction, sets the five request GUCs on that connection, and hands
 * the transaction client to `fn`. Every policy in `prisma/sql/rls.sql` reads
 * those GUCs, so a query issued outside this wrapper runs with no context at
 * all — which does not error, it just quietly returns nothing, or (as the
 * migration role) quietly returns everything.
 *
 * Three details that are load-bearing:
 *
 * 1. **`SET LOCAL`, not `SET`.** Local settings die with the transaction. The
 *    application runs on a pooled connection, so a plain `SET` would leak one
 *    user's context to whoever gets that connection next — a cross-tenant read
 *    with no bug at the call site and nothing in the code to point at.
 *
 * 2. **`set_config($1, $2, true)`, not string interpolation.** `SET LOCAL x =
 *    ${value}` cannot be parameterised by Postgres, so building it as a string
 *    would make every one of these values an injection point — including
 *    `actorId`, which on the portal path derives from a link a stranger may be
 *    holding. `set_config` takes the value as a bind parameter.
 *
 * 3. **All five are always written, even when absent.** An unset GUC reads as
 *    NULL, which is safe — but only if nothing else on this connection set it
 *    first. Writing every key on every entry means the context is a function of
 *    this transaction alone, not of whatever ran before it.
 */
export async function scopedDb<T>(
  prisma: PrismaClient,
  context: ScopeContext,
  fn: (db: ScopedClient) => Promise<T>,
  options: { timeoutMs?: number } = {},
): Promise<T> {
  // Parse at the boundary, not at the call site. By the time these values reach
  // SQL they are indistinguishable from correct ones.
  const ctx = ScopeContextSchema.parse(context);

  return prisma.$transaction(
    async (tx) => {
      await setContext(tx, ctx);
      return fn(tx as ScopedClient);
    },
    {
      // Prisma's default interactive-transaction timeout is 5s. Every query in
      // a request now lives inside one of these, so the ceiling is really "how
      // long may a request hold a connection" — 10s is generous for the 100ms
      // p95 budget (Governance §5.1) while still killing a stuck transaction
      // before it exhausts the pool. Long-running work belongs in a job, not in
      // a longer timeout here.
      timeout: options.timeoutMs ?? 10_000,
      maxWait: 5_000,
    },
  );
}

async function setContext(tx: Prisma.TransactionClient, ctx: ScopeContext): Promise<void> {
  // `is_local = true` is the third argument — this is set_config's equivalent of
  // SET LOCAL. Passing false here would be the pooled-connection leak described
  // above, and it is a one-character difference.
  await tx.$executeRaw`SELECT
    set_config('app.actor_id',         ${ctx.actorId},                  true),
    set_config('app.practice_id',      ${ctx.practiceId ?? ''},         true),
    set_config('app.business_id',      ${ctx.businessId ?? ''},         true),
    set_config('app.session_scope',    ${ctx.sessionScope},             true),
    set_config('app.granted_item_ids', ${ctx.grantedItemIds.join(',')}, true)`;
}
