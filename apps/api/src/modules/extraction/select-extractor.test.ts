import { expect, test } from 'vitest';

import { type AiBudget, InMemoryAiBudget } from '../../common/ai-budget.js';
import type { DocumentStore } from '../ingestion-routing/index.js';
import { BedrockExtractor } from './bedrock-extractor.js';
import { DemoExtractor } from './demo-extractor.js';
import { selectExtractor } from './select-extractor.js';

const ENV = {
  EXTRACTOR: 'demo',
  BEDROCK_REGION: 'eu-west-2',
} as const;

/** Never called in these tests — selection must not touch the store. */
const store = {} as DocumentStore;

/** Likewise never metered here; selection must not spend anything either. */
const budget = (): AiBudget => new InMemoryAiBudget(1000);

test('demo mode returns the deterministic fixture extractor', () => {
  expect(selectExtractor(ENV)).toBeInstanceOf(DemoExtractor);
});

test('demo mode ignores a store — the fixture extractor never reads bytes', () => {
  expect(selectExtractor(ENV, store)).toBeInstanceOf(DemoExtractor);
});

test('bedrock mode returns the real extractor UNWRAPPED — a failed read must not become fixture data', () => {
  // This assertion is the point of the test, not a detail of it. A
  // `FallbackExtractor` used to wrap this, so a throw from Bedrock answered with
  // `DemoExtractor`'s output for the same real client document: an invented
  // supplier, total, tax and VAT number, every field non-null, which makes
  // `resolveProcessedState` return READY. A throttle was enough to trigger it.
  // If anything ever wraps this again, that failure mode comes back.
  const extractor = selectExtractor({ ...ENV, EXTRACTOR: 'bedrock' }, store, budget());
  expect(extractor).toBeInstanceOf(BedrockExtractor);
});

test('bedrock without a store fails at construction, not on first document', () => {
  // A real extractor needs the bytes. Returning something that fails later would
  // surface as an unreadable document rather than as the wiring bug it is.
  expect(() => selectExtractor({ ...ENV, EXTRACTOR: 'bedrock' })).toThrow(/needs a DocumentStore/);
});

test('the extractor names itself, so the audit columns cannot claim to be the fixture one', () => {
  // `extractions.extractorKind` / `.modelVersion` are the audit answer to "which
  // reader produced this value". The pipeline used to hardcode the demo
  // constants, so a genuine model read was persisted labelled `demo`.
  expect(selectExtractor(ENV).kind).toBe('demo');
  expect(selectExtractor({ ...ENV, EXTRACTOR: 'bedrock' }, store, budget()).kind).toBe('bedrock');
  // Pinned in chat-framework/models.ts, never from env — no `eu.`/`global.`
  // prefix, because an inference profile routes outside the UK (D30/ADR 0001).
  expect(selectExtractor({ ...ENV, EXTRACTOR: 'bedrock' }, store, budget()).modelVersion).toMatch(/^anthropic\./);
});

test('bedrock without a budget fails at construction — real extraction may not run unmetered', () => {
  // The store and the budget are both required, but they fail differently and
  // that is why this test exists separately. A missing store fails LOUDLY on the
  // first document. A missing ceiling fails SILENTLY and for ever: it reads
  // every document perfectly and simply spends without limit, which is what
  // `EXTRACTOR=bedrock` did on staging between S1 and S5. The only defence
  // against a hazard nobody can see is to make the unmetered object impossible
  // to construct.
  expect(() => selectExtractor({ ...ENV, EXTRACTOR: 'bedrock' }, store)).toThrow(/spend ceiling/);
});

test('demo mode needs no budget — a fixture spends nothing', () => {
  expect(selectExtractor(ENV)).toBeInstanceOf(DemoExtractor);
});

test('replay mode returns the REAL Bedrock adapter — only the transport is swapped', () => {
  // The point of replay is exercising BedrockExtractor's actual code (request
  // building, the Zod parse, the metering) against cassettes. A dedicated
  // ReplayExtractor class here would be a third code path — the exact thing
  // the mode exists to avoid.
  const extractor = selectExtractor({ ...ENV, EXTRACTOR: 'replay' }, store, budget());
  expect(extractor).toBeInstanceOf(BedrockExtractor);
});

test('replay makes the bedrock demands: no store or no budget fails at construction', () => {
  // A replayed read still fetches bytes to build the request from, and still
  // meters against the same per-firm ledger — that metering being real is part
  // of what replay exists to prove, so the unmetered object stays impossible
  // to construct in this mode too.
  expect(() => selectExtractor({ ...ENV, EXTRACTOR: 'replay' })).toThrow(/needs a DocumentStore/);
  expect(() => selectExtractor({ ...ENV, EXTRACTOR: 'replay' }, store)).toThrow(/spend ceiling/);
});
