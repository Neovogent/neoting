import { expect, test } from 'vitest';

import type { Clock } from './clock.js';
import { InMemoryReplayStore } from './replay-store.js';

function fakeClock(startMs: number): { clock: Clock; advance: (ms: number) => void } {
  let t = startMs;
  return { clock: { now: () => t }, advance: (ms: number) => { t += ms; } };
}

test('reserve returns true the first time and false on a repeat (dedup)', async () => {
  const store = new InMemoryReplayStore({ now: () => 0 });
  expect(await store.reserve('wamid.1', 1000)).toBe(true);
  expect(await store.reserve('wamid.1', 1000)).toBe(false);
  expect(await store.reserve('wamid.2', 1000)).toBe(true);
});

test('an id can be reserved again once its ttl has expired', async () => {
  const { clock, advance } = fakeClock(0);
  const store = new InMemoryReplayStore(clock);
  expect(await store.reserve('wamid.1', 1000)).toBe(true);
  advance(1001);
  expect(await store.reserve('wamid.1', 1000)).toBe(true);
});
