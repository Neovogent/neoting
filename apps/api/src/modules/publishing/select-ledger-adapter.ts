import type { Env } from '../../config/env.js';
import { DemoXeroAdapter } from './demo-xero-adapter.js';
import type { LedgerAdapter } from './ledger-adapter.js';

/**
 * Pick the ledger adapter from config — never by import, the house pattern
 * shared with `selectExtractor` / `selectIngestQueue` / `selectDocumentStore`.
 * `demo` is the only value today (METH Stage 10); the Xero SDK + OAuth adapter
 * lands behind the same seam post-demo, and no real vendor call may leave this
 * codebase before the pilot.
 */
export function selectLedgerAdapter(_env: Pick<Env, 'LEDGER_ADAPTER'>): LedgerAdapter {
  // Only `demo` exists, and the enum makes it the only value the type admits,
  // so the switch is a single arm — kept as a return so adding `xero` is a
  // compile-guided edit, not a search for the call site.
  return new DemoXeroAdapter();
}

export { DemoXeroAdapter } from './demo-xero-adapter.js';
