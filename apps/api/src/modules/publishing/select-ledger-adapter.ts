import type { PrismaClient } from '../../common/db/prisma.js';
import type { ScopeContext } from '../../common/db/scope-context.js';
import type { Env } from '../../config/env.js';
import { selectDocumentStore } from '../ingestion-routing/index.js';
import { DemoXeroAdapter } from './demo-xero-adapter.js';
import { HttpLedgerAdapter } from './ledger/http-ledger-adapter.js';
import { credentialsFor, vaultKeyFor } from './ledger/ledger-config.js';
import { LedgerTokenStore } from './ledger/token-store.js';
import type { LedgerAdapter } from './ledger-adapter.js';

/**
 * Pick the ledger adapter from config — never by import, the house pattern
 * shared with `selectExtractor` / `selectIngestQueue` / `selectDocumentStore`.
 *
 * ## ⚠ Why this returns a FACTORY rather than an adapter
 *
 * The demo adapter is in-process and stateless, so a singleton was right for
 * it. A real one is not: before it can call a vendor it has to read that
 * client's sealed tokens out of `integrations`, and **every Prisma query goes
 * through `scopedDb(ctx)`** — so it needs a tenant context, which a singleton
 * built at boot cannot have.
 *
 * The three options were: give the adapter an unscoped Prisma client (a tenancy
 * leak and a CI failure), push a mutable context onto a shared singleton (a
 * cross-tenant bug waiting for the first concurrent batch), or build the
 * adapter per unit of work with the context it will run under. The third is
 * this, and it costs one object per batch.
 *
 * ⚠ **`LedgerAdapter` itself is unchanged.** The brief says not to redesign it
 * and nothing here does — this is composition, which is the composition root's
 * business, and every call site still holds a plain `LedgerAdapter`.
 */
export type LedgerAdapterFactory = (prisma: PrismaClient, ctx: ScopeContext) => LedgerAdapter;

export function selectLedgerAdapter(env: Env): LedgerAdapterFactory {
  if (env.LEDGER_ADAPTER === 'demo') {
    // Ignores both arguments: the demo ledger is in-process and reaches no
    // database, which is exactly why it can stay a single shared instance.
    const demo = new DemoXeroAdapter();
    return () => demo;
  }

  // Built ONCE, outside the factory: an S3 client per batch would be a new
  // connection pool per approval. `env.ts` has already refused to boot if the
  // sealing key is missing, so this cannot throw here.
  const documentStore = selectDocumentStore(env);
  const vaultKey = vaultKeyFor(env);
  const credentials = (slug: Parameters<typeof credentialsFor>[1]) => credentialsFor(env, slug);

  return (prisma, ctx) =>
    new HttpLedgerAdapter(
      prisma,
      ctx,
      new LedgerTokenStore(prisma, ctx, vaultKey, credentials),
      (s3Key) => documentStore.get(s3Key),
    );
}

export { DemoXeroAdapter } from './demo-xero-adapter.js';
