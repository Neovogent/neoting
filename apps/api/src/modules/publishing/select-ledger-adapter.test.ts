import { expect, test } from 'vitest';

import { DemoXeroAdapter } from './demo-xero-adapter.js';
import { selectLedgerAdapter } from './select-ledger-adapter.js';

test('demo mode returns the deterministic fixture ledger', () => {
  expect(selectLedgerAdapter({ LEDGER_ADAPTER: 'demo' })).toBeInstanceOf(DemoXeroAdapter);
});
