import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { z } from 'zod';

import type { AnthropicBedrock } from '@anthropic-ai/bedrock-sdk';

/**
 * Cassette record/replay for the TRANSPORT under the two Bedrock adapters.
 *
 * `EXTRACTOR=replay` and `AI_CHAT=replay` construct the REAL adapters —
 * `BedrockExtractor` and `BedrockModelProvider` — so the same request building,
 * the same Zod parse of the model's answer, the same retry, error mapping and
 * budget metering all run. Only the wire is swapped: `messages.create` is
 * served from a cassette on disk instead of from Bedrock. `demo` skips the
 * adapters entirely; replay exists precisely so local development can exercise
 * the adapter code without credentials and without spend.
 *
 * ⚠ THE SEAM IS THE ONE THE ADAPTERS ALREADY HAVE. Both take an injected
 * `Pick<AnthropicBedrock, 'messages'>` — the seam their unit tests and
 * `scripts/measure/extraction-cost.ts` drive — so replay is not a third code
 * path through either adapter; it is the existing injection point with a
 * different transport behind it.
 *
 * ⚠ IT LIVES IN `common/`, like `ai-budget.ts` and for the same reason: two
 * modules consume it (`extraction`, `chat-framework`) and neither may reach
 * into the other's internals (`no-cross-module-internals`). It is
 * infrastructure, not behaviour either module owns.
 *
 * ## The key
 *
 * A request is "the same request" when the body the model would see is
 * byte-identical: model id, system prompt, messages (which carry the document
 * bytes or OCR text and the prompt framing), tool schema, tool choice and
 * decoding params. The key is a sha256 over the canonicalised (key-sorted)
 * request BODY, first 16 hex chars — the same shape as `evals/src/
 * replay-provider.ts`, and with the same property that repo already relies on:
 * editing a prompt, a tool schema or the model pin changes every key, so the
 * replay MISSES and fails demanding a re-record, rather than silently replaying
 * an answer to a question nobody asks any more. Per-call options (the timeout)
 * are excluded: they never reach the model.
 *
 * ## What a cassette contains — and pointedly does not
 *
 * The RESPONSE plus metadata, never the request body. The request is present
 * only as its hash, so document bytes, prompt text and OCR content never land
 * in a committed fixture. Recorded responses additionally pass a structural
 * redaction sweep (ARNs, account ids, request/message ids, emails, phone
 * numbers) before writing — see `redactRecordedValue`.
 *
 * ## A miss is a hard failure, never a fallthrough
 *
 * The eval replay's argument, verbatim applicable: a transport that quietly
 * reaches for the network the moment its fixture goes stale stops being
 * deterministic — and stops being free — on precisely the run that needed it.
 * A miss names the key, the directory and the record command, and throws.
 */

/**
 * The shape a replayed answer must have to be servable at all — Zod at the
 * boundary, and A FILE ON DISK IS A BOUNDARY (parse, don't trust). Deliberately
 * loose about the content blocks themselves: judging whether the tool call's
 * `input` makes sense is the ADAPTER's Zod parse, and pre-judging it here would
 * defeat the point of replaying malformed answers through the real failure
 * path. `usage` is REQUIRED: a cassette without one would replay a call the
 * budget meter silently never sees, which is the unmetered-spend bug in fixture
 * form.
 */
const CassetteResponseSchema = z
  .object({
    stop_reason: z.string().nullish(),
    content: z.array(z.record(z.unknown())),
    usage: z
      .object({
        input_tokens: z.number().int().nonnegative(),
        output_tokens: z.number().int().nonnegative(),
        cache_read_input_tokens: z.number().int().nonnegative().optional(),
        cache_creation_input_tokens: z.number().int().nonnegative().optional(),
      })
      .passthrough(),
  })
  .passthrough();

export const CassetteSchema = z
  .object({
    /** `requestKey` of the request this answers. Must match the filename. */
    key: z.string().regex(/^[0-9a-f]{16}$/),
    recordedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    /** The model id the request named — metadata for a human, not a lookup key. */
    modelId: z.string().min(1),
    /**
     * True when the response was authored rather than recorded from Bedrock —
     * shape-faithful, but a statement about the adapter's handling, never about
     * the model's behaviour. Malformed-answer cassettes are always synthetic:
     * a real model cannot be made to misbehave on demand.
     */
    synthetic: z.boolean(),
    description: z.string().min(1),
    response: CassetteResponseSchema,
  })
  .strict();

export type Cassette = z.infer<typeof CassetteSchema>;

/**
 * `apps/api/fixtures/cassettes/bedrock`, resolved from THIS file rather than
 * from the working directory: the api, the worker and vitest are launched from
 * different places, and a cwd-relative fixture path is a miss that depends on
 * who started the process. `src/common/` and `dist/common/` are both two
 * levels under `apps/api`, so the same relative hop works before and after
 * `tsc` — though replay is refused in production, so dist never actually reads it.
 */
export const DEFAULT_CASSETTE_DIR = fileURLToPath(new URL('../../fixtures/cassettes/bedrock', import.meta.url));

/** How a developer gets a cassette. Named in every miss and parse failure. */
const RECORD_COMMAND = 'pnpm --filter @neoting/api record:cassettes';

/** Sorted keys at every depth, so cosmetic reordering in request assembly does not orphan every cassette. */
function canonicalise(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalise);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, nested]) => [key, canonicalise(nested)]),
    );
  }
  return value;
}

/** The deterministic identity of one model request — see the header. */
export function requestKey(body: unknown): string {
  return createHash('sha256').update(JSON.stringify(canonicalise(body))).digest('hex').slice(0, 16);
}

/**
 * Distinct class so a caller (or a log reader) can tell "no recording" apart
 * from a transport fault. Deliberately carries NO `status`: both adapters
 * classify errors structurally off `status`, so a status-less error takes
 * their rethrow path and surfaces intact rather than being converted into a
 * document failure or a tier fallback — loud, and attributed to the developer,
 * not to the document or the provider.
 */
export class CassetteMissError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CassetteMissError';
  }
}

/** The one method both adapters call, untyped at the seam — the SDK's own overloads stay the adapters' business. */
export type BedrockMessagesCreate = (body: unknown, options?: unknown) => Promise<unknown>;
type MessagesCreate = BedrockMessagesCreate;

/**
 * The replay transport. Reads `<dir>/<requestKey>.json`, Zod-parses it, and
 * serves the recorded response. A miss throws `CassetteMissError` naming the
 * record command — it NEVER calls Bedrock and never invents an answer.
 */
export class ReplayBedrockClient {
  readonly messages: { readonly create: MessagesCreate };

  constructor(private readonly dir: string = DEFAULT_CASSETTE_DIR) {
    this.messages = { create: (body) => this.serve(body) };
  }

  // `async` so every failure — a miss, an unparseable file, a renamed one — is
  // a REJECTION, matching the SDK method this stands in for. A synchronous
  // throw from a `create` call is a shape no caller of a promise-returning SDK
  // is written to expect.
  private async serve(body: unknown): Promise<unknown> {
    const key = requestKey(body);
    const file = join(this.dir, `${key}.json`);
    const model = typeof (body as { model?: unknown } | null)?.model === 'string' ? (body as { model: string }).model : 'unknown-model';

    if (!existsSync(file)) {
      return Promise.reject(
        new CassetteMissError(
          `no cassette ${key} for this ${model} request under ${this.dir}. ` +
            `Replay never calls Bedrock and never invents an answer — a prompt, tool schema, model pin or input ` +
            `changed since the cassettes were recorded, or this request was never recorded. ` +
            `Re-record with: ${RECORD_COMMAND} (offline synthetic set; --live records the real model, needs AWS credentials), ` +
            `or run with the demo/bedrock mode instead.`,
        ),
      );
    }

    return readCassette(file, key).response;
  }
}

/**
 * The cast the adapters' own tests use, centralised. `MessagesResource` also
 * carries `stream` and friends; stubbing those to satisfy the compiler would be
 * pretending to implement an SDK surface neither adapter calls.
 */
export function replayBedrockMessages(dir: string = DEFAULT_CASSETTE_DIR): Pick<AnthropicBedrock, 'messages'> {
  return new ReplayBedrockClient(dir) as unknown as Pick<AnthropicBedrock, 'messages'>;
}

/** Parse one cassette off disk, or say exactly which file is bad and how to replace it. */
export function readCassette(file: string, expectedKey?: string): Cassette {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    throw new Error(`${file} is not a valid cassette (unreadable or not JSON): ${String(error)}. Re-record with: ${RECORD_COMMAND}`);
  }
  const parsed = CassetteSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`).join('; ');
    throw new Error(`${file} is not a valid cassette (${issues}). Re-record with: ${RECORD_COMMAND}`);
  }
  // A renamed or hand-copied file would otherwise answer a request it was
  // never recorded for, which is replay inventing an answer with extra steps.
  if (expectedKey !== undefined && parsed.data.key !== expectedKey) {
    throw new Error(
      `${file} claims key ${parsed.data.key} but was looked up as ${expectedKey} — the file was renamed or edited. Re-record with: ${RECORD_COMMAND}`,
    );
  }
  return parsed.data;
}

/**
 * Structural redaction of recorded content — mandatory on every write, never a
 * manual step someone can forget. Anything shaped like an ARN, an AWS account
 * id, a request/message id, an email address or a UK phone number is replaced
 * before it can land in a committed fixture, and request-id envelope keys are
 * dropped entirely. Redacting the odd legitimate value in a fixture is the
 * cheap direction; a credential-adjacent identifier in the repo is not.
 */
const STRING_REDACTIONS: readonly (readonly [RegExp, string])[] = [
  [/arn:aws[a-z0-9-]*:[^\s"'`]+/gi, 'arn:aws:REDACTED'],
  [/\bmsg_[A-Za-z0-9_-]{8,}\b/g, 'msg_REDACTED'],
  [/\btoolu_[A-Za-z0-9_-]{8,}\b/g, 'toolu_REDACTED'],
  [/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, 'REDACTED-UUID'],
  [/\b\d{12}\b/g, 'REDACTED-ACCOUNT'],
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, 'redacted@example.invalid'],
  [/(?:\+44[\s-]?\d{2,4}|\b0\d{2,4})[\s-]\d{3,4}[\s-]?\d{3,4}\b/g, 'REDACTED-PHONE'],
  [/\b07\d{9}\b/g, 'REDACTED-PHONE'],
];

const DROPPED_KEYS = new Set(['_request_id', 'request_id', 'requestId']);

export function redactRecordedValue(value: unknown): unknown {
  if (typeof value === 'string') {
    return STRING_REDACTIONS.reduce<string>((text, [pattern, replacement]) => text.replace(pattern, replacement), value);
  }
  if (Array.isArray(value)) return value.map(redactRecordedValue);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([key]) => !DROPPED_KEYS.has(key))
        .map(([key, nested]) => [key, redactRecordedValue(nested)]),
    );
  }
  return value;
}

/**
 * The recording transport: forwards the request verbatim (the adapter still
 * builds it — recording anything else would record a request nobody sends),
 * then writes `<dir>/<requestKey>.json`. The cassette is validated against
 * `CassetteSchema` BEFORE writing, so a recording that could never replay
 * fails at record time, in front of the person who can fix it.
 */
export class RecordingBedrockClient {
  /** Set before each corpus entry; lands in the cassette so a human can tell files apart. */
  description = 'unlabelled exchange';

  readonly messages: { readonly create: MessagesCreate };

  constructor(
    inner: MessagesCreate,
    private readonly dir: string,
    private readonly meta: { readonly synthetic: boolean; readonly recordedAt?: string },
  ) {
    this.messages = {
      create: async (body, options) => {
        const response = await inner(body, options);
        this.write(body, response);
        return response;
      },
    };
  }

  private write(body: unknown, response: unknown): void {
    const key = requestKey(body);
    const modelId = typeof (body as { model?: unknown } | null)?.model === 'string' ? (body as { model: string }).model : 'unknown-model';
    const cassette = CassetteSchema.parse({
      key,
      recordedAt: this.meta.recordedAt ?? new Date().toISOString().slice(0, 10),
      modelId,
      synthetic: this.meta.synthetic,
      description: this.description,
      // JSON round-trip first: an SDK response object can carry non-enumerable
      // extras; what replays is what serialises.
      response: redactRecordedValue(JSON.parse(JSON.stringify(response))),
    });
    mkdirSync(this.dir, { recursive: true });
    // Two-space indent and a trailing newline: these files are committed, and a
    // diff nobody can read is a review nobody does.
    writeFileSync(join(this.dir, `${key}.json`), `${JSON.stringify(cassette, null, 2)}\n`, 'utf8');
  }
}

/** The recording seam, cast once, mirroring `replayBedrockMessages`. */
export function recordingBedrockMessages(client: RecordingBedrockClient): Pick<AnthropicBedrock, 'messages'> {
  return client as unknown as Pick<AnthropicBedrock, 'messages'>;
}
