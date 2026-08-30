import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, test } from 'vitest';

import { type AiBudget, InMemoryAiBudget } from '../../common/ai-budget.js';
import { replayBedrockMessages } from '../../common/bedrock-replay.js';
import type { DocumentStore } from '../ingestion-routing/index.js';
import { BedrockExtractor } from './bedrock-extractor.js';
import { EXTRACTION_REPLAY_CASES, type ExtractionReplayCase } from './replay-corpus.js';

/**
 * `EXTRACTOR=replay` through the REAL adapter, against the COMMITTED cassettes.
 *
 * What runs here is `BedrockExtractor` itself — its prompt assembly, its size
 * guards, its budget gate, its Zod parse of the model's answer — with only
 * `messages.create` served from `fixtures/cassettes/bedrock/`. That is the
 * point of replay, and it is what separates these tests from the fake-runner
 * ones in `bedrock-extractor.test.ts`: those pin behaviour against invented
 * responses; these pin that the recorded corpus drives the same code.
 *
 * ⚠ The expected values are pinned to the CURRENT cassettes (synthetic today).
 * A re-record that changes an answer — a live run, a prompt change — updates
 * these expectations in the same commit. That is the eval-recording contract,
 * and a miss here that names `record:cassettes` is the mechanism working.
 */

function caseNamed(name: string): ExtractionReplayCase {
  const found = EXTRACTION_REPLAY_CASES.find((entry) => entry.name === name);
  if (found === undefined) throw new Error(`no replay corpus case named ${name}`);
  return found;
}

function extractorFor(kase: ExtractionReplayCase, budget: AiBudget, dir?: string): BedrockExtractor {
  return new BedrockExtractor({
    store: { get: () => Promise.resolve(kase.bytes) } as unknown as DocumentStore,
    region: 'eu-west-2',
    budget,
    client: replayBedrockMessages(dir),
  });
}

test('the byte path replays: a real request is built, the cassette answers, the real parse accepts it', async () => {
  const kase = caseNamed('receipt-image');
  const outcome = await extractorFor(kase, new InMemoryAiBudget(10_000)).extract(kase.request);

  expect(outcome.ok).toBe(true);
  if (!outcome.ok) return;
  // Parsed by `bedrockExtractionResult` and mapped by `toExtractedDocument` —
  // the same boundary a live read crosses, exercised by a recorded answer.
  expect(outcome.document.docType).toBe('RECEIPT');
  expect(outcome.document.supplierName).toBe('BIDFOOD WHOLESALE LTD');
  expect(outcome.document.totalPence).toBe(28296);
  expect(outcome.document.lineItems).toHaveLength(3);
  // 23580 + 4716 = 28296: the real VAT-arithmetic validator ran and agreed.
  expect(outcome.document.validatorResults['vatArithmetic']).toEqual({ ok: true });
});

test('the OCR text path replays through the same cassette store', async () => {
  const kase = caseNamed('invoice-ocr');
  const outcome = await extractorFor(kase, new InMemoryAiBudget(10_000)).extract(kase.request);

  expect(outcome.ok).toBe(true);
  if (!outcome.ok) return;
  expect(outcome.document.docType).toBe('INVOICE');
  expect(outcome.document.reference).toBe('BF-2026-118374');
});

test('a replayed read is METERED — replay runs the real budget path, not around it', async () => {
  // Task-level requirement, stated plainly: "the real adapter runs" includes
  // the meter. The exact pence-per-token arithmetic is pinned in
  // bedrock-extractor.test.ts against the one rate table; what this pins is
  // that replay mode flows through it at all.
  const kase = caseNamed('receipt-image');
  const budget = new InMemoryAiBudget(10_000);

  await extractorFor(kase, budget).extract(kase.request);

  expect((await budget.check(kase.request.practiceId)).spentPence).toBeGreaterThan(0);
  // And to the named practice, not a global pool.
  expect((await budget.check('prac_other')).spentPence).toBe(0);
});

test('the budget gate still bites FIRST in replay mode — an exhausted ceiling never touches a cassette', async () => {
  const kase = caseNamed('receipt-image');
  const spent = new InMemoryAiBudget(100);
  await spent.record(kase.request.practiceId, 100);

  // An EMPTY cassette directory: had the extractor reached the transport, this
  // would be a loud CassetteMissError. NT-EXT-008 instead proves the gate runs
  // where it runs live — before any fetch and before any call.
  const outcome = await extractorFor(kase, spent, mkdtempSync(join(tmpdir(), 'nt-empty-'))).extract(kase.request);

  expect(outcome.ok).toBe(false);
  if (!outcome.ok) expect(outcome.failure.code).toBe('NT-EXT-008');
});

test('a malformed recorded answer fails the REAL Zod parse: NT-EXT-006, naming the field, never the value', async () => {
  // The cassette is synthetic by design — a live model cannot be made to
  // misbehave on demand — and it exists to prove replay exercises the genuine
  // failure path rather than only the happy one.
  const kase = caseNamed('malformed-answer');
  const budget = new InMemoryAiBudget(10_000);
  const outcome = await extractorFor(kase, budget).extract(kase.request);

  expect(outcome.ok).toBe(false);
  if (outcome.ok) return;
  expect(outcome.failure.code).toBe('NT-EXT-006');
  expect(outcome.failure.message).toContain('docType');
  // The model's value is client-adjacent content, in a cassette or on a wire.
  expect(outcome.failure.message).not.toContain('NOT_A_TYPE');
  // The tokens were spent when the (recorded) call was made: unusable answers
  // are billed in replay exactly as live.
  expect((await budget.check(kase.request.practiceId)).spentPence).toBeGreaterThan(0);
});

test('a request with no cassette fails loudly with the record command — never live Bedrock, never an invention', async () => {
  const kase = caseNamed('receipt-image');
  const unrecorded = { ...kase.request, filename: 'never-recorded.png' };

  const attempt = extractorFor(kase, new InMemoryAiBudget(10_000)).extract(unrecorded);

  // The miss carries no `status`, so `classifyThrow` rethrows it — the retry
  // ladder and the DLQ surface it as the developer error it is, rather than
  // burning the document to FAILED with a reason that blames the client.
  await expect(attempt).rejects.toThrow(/no cassette/);
  await expect(attempt).rejects.toThrow(/record:cassettes/);
});
