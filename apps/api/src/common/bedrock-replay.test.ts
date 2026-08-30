import { mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, test } from 'vitest';

import {
  CassetteMissError,
  DEFAULT_CASSETTE_DIR,
  readCassette,
  RecordingBedrockClient,
  redactRecordedValue,
  ReplayBedrockClient,
  requestKey,
} from './bedrock-replay.js';

/** A body shaped like what the adapters actually send. */
const BODY = {
  model: 'anthropic.claude-sonnet-4-6',
  max_tokens: 4096,
  system: 'You read UK supplier documents.',
  messages: [{ role: 'user', content: 'the document' }],
  tools: [{ name: 'record_extraction', input_schema: { type: 'object' } }],
  tool_choice: { type: 'tool', name: 'record_extraction' },
};

/** A response shaped like Bedrock's, salted with everything redaction must catch. */
const RESPONSE = {
  id: 'msg_bdrk_01AbCdEfGhIjKlMnOp',
  stop_reason: 'end_turn',
  content: [
    {
      type: 'text',
      text: 'Call ops@bidfood.co.uk or 0161 496 0110, account 123456789012, arn:aws:bedrock:eu-west-2:123456789012:model/x, ref 6f9619ff-8b86-d011-b42d-00c04fc964ff',
    },
  ],
  usage: { input_tokens: 10, output_tokens: 2 },
  _request_id: 'req_abc123',
};

function scripted(response: unknown): (body: unknown, options?: unknown) => Promise<unknown> {
  return () => Promise.resolve(structuredClone(response));
}

test('the key ignores property order and per-call options, and moves with content', () => {
  // Cosmetic reordering in request assembly must not orphan every cassette…
  expect(requestKey({ a: 1, b: { d: 4, c: 3 } })).toBe(requestKey({ b: { c: 3, d: 4 }, a: 1 }));
  // …while any change the model would SEE is a different request.
  expect(requestKey(BODY)).not.toBe(requestKey({ ...BODY, system: 'a different prompt' }));
  expect(requestKey(BODY)).not.toBe(requestKey({ ...BODY, model: 'anthropic.other' }));
  expect(requestKey(BODY)).toMatch(/^[0-9a-f]{16}$/);
});

test('redaction is structural: identifiers and contact details cannot reach a committed fixture', () => {
  const redacted = redactRecordedValue(RESPONSE) as typeof RESPONSE & Record<string, unknown>;
  const text = (redacted.content[0] as { text: string }).text;

  expect(redacted.id).toBe('msg_REDACTED');
  expect(text).not.toContain('ops@bidfood.co.uk');
  expect(text).not.toContain('0161 496 0110');
  expect(text).not.toContain('123456789012');
  expect(text).not.toContain('arn:aws:bedrock:eu-west-2');
  expect(text).not.toContain('6f9619ff-8b86-d011-b42d-00c04fc964ff');
  // Request-id envelope keys are dropped outright, not just rewritten.
  expect('_request_id' in redacted).toBe(false);
  // Redaction never touches the parts replay needs.
  expect(redacted.usage).toEqual({ input_tokens: 10, output_tokens: 2 });
});

test('record → replay round trip: what the recorder writes is what replay serves', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'nt-cassettes-'));
  const recorder = new RecordingBedrockClient(scripted(RESPONSE), dir, { synthetic: true, recordedAt: '2026-08-30' });
  recorder.description = 'round trip';

  // Recording returns the LIVE response untouched — a recording run must see
  // exactly what a real run sees.
  const recorded = (await recorder.messages.create(BODY)) as typeof RESPONSE;
  expect(recorded.id).toBe('msg_bdrk_01AbCdEfGhIjKlMnOp');

  // Replay of the same body serves the cassette — redacted, usage intact.
  const replayed = (await new ReplayBedrockClient(dir).messages.create(BODY)) as Record<string, unknown>;
  expect(replayed.id).toBe('msg_REDACTED');
  expect(replayed.usage).toEqual({ input_tokens: 10, output_tokens: 2 });
  expect('_request_id' in replayed).toBe(false);
});

test('a miss fails loudly, names the record command, and never invents an answer', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'nt-cassettes-empty-'));
  const replay = new ReplayBedrockClient(dir);

  const attempt = replay.messages.create(BODY);
  await expect(attempt).rejects.toBeInstanceOf(CassetteMissError);
  await expect(attempt).rejects.toThrow(/record:cassettes/);
  await expect(attempt).rejects.toThrow(/never calls Bedrock/);
  // The adapters classify throws structurally off `status`; a miss must carry
  // none, so it takes their rethrow path instead of becoming a document
  // failure or a tier fallback.
  await expect(attempt).rejects.toSatisfy((error: unknown) => !('status' in (error as object)));
});

test('a cassette that fails its schema is refused by name — parse, do not trust a file', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'nt-cassettes-bad-'));
  const key = requestKey(BODY);
  // Valid JSON, invalid cassette: no usage, so a replayed call would silently
  // escape the budget meter — exactly what the schema exists to refuse.
  writeFileSync(join(dir, `${key}.json`), JSON.stringify({ key, response: { content: [] } }), 'utf8');

  await expect(new ReplayBedrockClient(dir).messages.create(BODY)).rejects.toThrow(/not a valid cassette/);
});

test('a renamed cassette is refused — the filename must be the key it was recorded under', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'nt-cassettes-renamed-'));
  const recorder = new RecordingBedrockClient(scripted(RESPONSE), dir, { synthetic: true });
  recorder.description = 'recorded under one key';
  await recorder.messages.create({ ...BODY, system: 'the ORIGINAL request' });

  // Pose the recorded file as the answer to a DIFFERENT request.
  const recordedKey = requestKey({ ...BODY, system: 'the ORIGINAL request' });
  const posedKey = requestKey(BODY);
  const cassette = readCassette(join(dir, `${recordedKey}.json`));
  writeFileSync(join(dir, `${posedKey}.json`), JSON.stringify(cassette, null, 2), 'utf8');

  await expect(new ReplayBedrockClient(dir).messages.create(BODY)).rejects.toThrow(/renamed or edited/);
});

test('every committed cassette parses, and its filename is its key', () => {
  // The committed fixtures are a boundary like any other: this pins that a
  // hand-edit that breaks one fails HERE, naming the file, rather than as an
  // unrelated-looking replay failure in whichever test hits it first.
  const files = readdirSync(DEFAULT_CASSETTE_DIR).filter((name) => name.endsWith('.json'));
  expect(files.length).toBeGreaterThan(0);
  for (const file of files) {
    const cassette = readCassette(join(DEFAULT_CASSETTE_DIR, file));
    expect(`${cassette.key}.json`).toBe(file);
  }
});
