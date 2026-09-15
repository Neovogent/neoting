import { expect, test } from 'vitest';

import type { Env } from '../../config/env.js';
import { DemoXeroAdapter } from './demo-xero-adapter.js';
import { selectLedgerAdapter } from './select-ledger-adapter.js';

/**
 * ⚠ `selectLedgerAdapter` returns a FACTORY since D50 — a real adapter needs
 * the approver's scope context to read its own sealed tokens, which a singleton
 * built at boot cannot have. The demo one ignores both arguments, which is the
 * property this pins: `LEDGER_ADAPTER=demo` must stay in-process and reach no
 * database, or `pnpm test` starts needing one.
 */
test('demo mode returns the deterministic fixture ledger, and reaches nothing', () => {
  const build = selectLedgerAdapter({ LEDGER_ADAPTER: 'demo' } as Env);
  // Deliberately `null as never` for both: if the demo path ever touched either
  // argument this line would throw rather than quietly passing.
  expect(build(null as never, null as never)).toBeInstanceOf(DemoXeroAdapter);
});

test('the demo adapter is one shared instance — it holds no per-batch state', () => {
  const build = selectLedgerAdapter({ LEDGER_ADAPTER: 'demo' } as Env);
  expect(build(null as never, null as never)).toBe(build(null as never, null as never));
});
