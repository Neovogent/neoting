import { expect, test } from 'vitest';

import { selectVirusScanner } from './select-virus-scanner.js';
import { EICAR_TEST_STRING, fixtureVirusScanner } from './virus-scan.js';

test('fixture mode returns the offline EICAR-only scanner (the default for laptops and CI)', () => {
  expect(selectVirusScanner('fixture')).toBe(fixtureVirusScanner);
});

test('clamd mode builds the real client — and it fails CLOSED against nothing, not open', async () => {
  // Port 1 on loopback: nothing legitimate listens there, so the connection is
  // refused immediately. The point is the direction of the failure.
  const scanner = selectVirusScanner('clamd', { host: '127.0.0.1', port: 1, timeoutMs: 2_000 });
  expect(scanner).not.toBe(fixtureVirusScanner);
  await expect(scanner.scan(Buffer.from(EICAR_TEST_STRING, 'latin1'))).rejects.toThrow(/virus scan unavailable/);
});
