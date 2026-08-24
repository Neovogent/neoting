import type { Tier } from '../models.js';

/**
 * The seam every model call goes through. Config-selected, never
 * import-selected — the house pattern (`selectExtractor`, `selectSmsSender`,
 * `selectDocumentStore`), and the reason a test never opens a socket.
 */

export interface ModelMessage {
  readonly role: 'user' | 'assistant';
  /**
   * Already-assembled text. Any externally-authored fragment inside it has been
   * through `wrapUntrusted` before reaching here (§9.6) — providers do not wrap,
   * because a provider that could forget to is a provider that eventually does.
   */
  readonly content: string;
}

export interface ModelRequest {
  readonly tier: Tier;
  readonly system: string;
  readonly messages: readonly ModelMessage[];
  readonly toolName: string;
  readonly toolSchema: unknown;
  readonly maxTokens: number;
  readonly timeoutMs: number;
}

export interface ModelUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  /** Tokens served FROM the cache. This is the hit-rate numerator (§9.7). */
  readonly cachedInputTokens: number;
  /**
   * Tokens WRITTEN to the cache on this call.
   *
   * Tracked separately from reads because zero-hits has two completely
   * different causes and they need different fixes: if creation is also zero
   * the provider ignored `cache_control` entirely (or the prefix is under the
   * ~1024-token minimum and cached silently nothing); if creation is non-zero
   * but reads stay zero, something per-request is leaking into the prefix and
   * invalidating it every time. A single `cachedInputTokens` cannot tell those
   * apart, which is exactly the position this ended up in on the first live run.
   */
  readonly cacheCreationInputTokens: number;
}

export interface ModelResponse {
  /** The forced tool call's arguments, unparsed. Zod is the caller's job (§9.2). */
  readonly output: unknown;
  readonly usage: ModelUsage;
  readonly modelId: string;
}

export interface ModelProvider {
  readonly name: 'bedrock' | 'demo';
  invoke(request: ModelRequest): Promise<ModelResponse>;
}

/**
 * A model call that failed in a way §9.3 recognises as a fallback trigger:
 * HTTP 5xx, a timeout past the task budget, or a 429 that survived backoff.
 * Anything else (a 400 from a malformed request, for instance) is a bug in this
 * repo and must NOT be retried onto another tier — retrying a programming error
 * three times just spends three times the money on the same mistake.
 */
export class ModelUnavailableError extends Error {
  constructor(
    message: string,
    override readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'ModelUnavailableError';
  }
}

/**
 * The provider is reachable and refuses to serve this model — model access not
 * granted, the account's Bedrock use-case form not submitted, or the principal
 * lacking `bedrock:InvokeModel` on this ARN.
 *
 * Deliberately its OWN class, sitting between the two above, because it is the
 * only failure here that is neither transient nor ours to fix in code:
 *
 * - It must NOT trip the breaker or walk the degrade ladder. Retrying a
 *   permanent authorisation refusal spends money to be refused again, and
 *   every tier behind the same account is refused identically.
 * - It must NOT be a generic 500 either. From the accountant's side the
 *   assistant simply is not available, and `NT-SRV-001` would page whoever
 *   owns "unexpected internal error" about an AWS console checkbox.
 *
 * Found by the first live smoke against eu-west-2 on 21 Aug 2026: the models
 * list fine and every invocation 404s with "Model use case details have not
 * been submitted for this account".
 */
export class ModelAccessError extends Error {
  constructor(
    message: string,
    readonly providerDetail: string,
  ) {
    super(message);
    this.name = 'ModelAccessError';
  }
}

/** The model answered, but not in the shape the schema demands (§9.2). */
export class ModelOutputInvalidError extends Error {
  constructor(
    message: string,
    readonly validationDetail: string,
  ) {
    super(message);
    this.name = 'ModelOutputInvalidError';
  }
}
