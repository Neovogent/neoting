import { expect, test } from 'vitest';

import type { Env } from '../../../config/env.js';
import { noQuarantine, type Quarantine } from '../lib/sanitisation/quarantine.js';
import { selectQuarantine } from './select-quarantine.js';

// Only the fields this selector reads; the full Env is not needed to prove the switch.
function env(overrides: Partial<Env>): Env {
  return { QUARANTINE_BUCKET: '', ...overrides } as unknown as Env;
}

test('an empty QUARANTINE_BUCKET keeps nothing (offline default)', () => {
  expect(selectQuarantine(env({ QUARANTINE_BUCKET: '' }))).toBe(noQuarantine);
});

test('a named bucket builds the S3 quarantine from config — no client opened in the test', () => {
  const stub: Quarantine = { async put() {} };
  let seen: string | null = null;
  const chosen = selectQuarantine(env({ QUARANTINE_BUCKET: 'nt-staging-quarantine-1' }), (resolved) => {
    seen = resolved.QUARANTINE_BUCKET;
    return stub;
  });
  expect(chosen).toBe(stub);
  expect(seen).toBe('nt-staging-quarantine-1');
});
