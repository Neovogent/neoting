import { expect, test } from 'vitest';

import { assertSeedableEnvironment, SEEDABLE_ENVIRONMENTS } from './seed-environment.js';

test.each(SEEDABLE_ENVIRONMENTS)('allows %s — synthetic data by construction (G2)', (name) => {
  expect(assertSeedableEnvironment({ NEOTING_ENV: name } as NodeJS.ProcessEnv)).toBe(name);
});

test('refuses prod — the environment infra/envs/prod sets', () => {
  expect(() => assertSeedableEnvironment({ NEOTING_ENV: 'prod' } as NodeJS.ProcessEnv)).toThrow(
    /Refusing to seed: NEOTING_ENV=prod/,
  );
});

test('refuses an unset variable rather than defaulting to permissive', () => {
  expect(() => assertSeedableEnvironment({} as NodeJS.ProcessEnv)).toThrow(/NEOTING_ENV=\(unset\)/);
});

test('refuses an unknown environment — an allow-list, not a prod deny-list', () => {
  expect(() => assertSeedableEnvironment({ NEOTING_ENV: 'production' } as NodeJS.ProcessEnv)).toThrow(/Refusing to seed/);
  expect(() => assertSeedableEnvironment({ NEOTING_ENV: 'stagingg' } as NodeJS.ProcessEnv)).toThrow(/Refusing to seed/);
});

test('NODE_ENV alone never satisfies the guard — that is the signal this replaces', () => {
  expect(() => assertSeedableEnvironment({ NODE_ENV: 'development' } as NodeJS.ProcessEnv)).toThrow(/Refusing to seed/);
});

test('says what it would have done, so the refusal is self-explaining', () => {
  expect(() => assertSeedableEnvironment({ NEOTING_ENV: 'prod' } as NodeJS.ProcessEnv)).toThrow(/TRUNCATEs every table/);
});
