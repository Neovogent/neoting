import { HttpStatus, Logger } from '@nestjs/common';
import { z } from 'zod';

import { AppException } from '../../common/problem/problem.js';
import type {
  CreateCheckoutSessionRequest,
  CreateCustomerRequest,
  CreatePortalSessionRequest,
  HostedSession,
  StripeClient,
} from './stripe-client.js';

/**
 * Stripe's REST API over `fetch`, with no SDK.
 *
 * The surface is three form-encoded POSTs and one HMAC (`stripe-signature.ts`),
 * which is smaller than the seam an SDK would need to be faked behind — and
 * `CLAUDE.md` asks that a new dependency be a decision a human makes rather
 * than one a stage takes on its way past. If this grows past creating
 * customers and hosted sessions, that decision is worth revisiting; today it
 * would buy retries we do not want on a user-facing request anyway.
 */

/**
 * ⚠ PINNED, and pinned HERE rather than in `env.ts` — the same stance
 * `chat-framework/models.ts` takes about the Bedrock model id. An API version
 * in an environment variable means the shape of every Stripe response can be
 * changed by editing an ECS task definition, with no PR and no test run.
 * Changing it is a PR that changes this line and re-reads the parsers below.
 */
export const STRIPE_API_VERSION = '2026-07-29.dahlia';

const STRIPE_API_BASE = 'https://api.stripe.com/v1';

/**
 * Tags every session so checkout flows can be compared in Stripe's dashboard.
 * The random-looking suffix is Stripe's own convention for the label and is a
 * CONSTANT on purpose: a value that changed per request would put every
 * session in its own bucket and measure nothing.
 */
const INTEGRATION_IDENTIFIER = 'neoting-id-subscription-qhrvmzbt';

/** How VAT is added on top of the net price. See `env.ts` for why `rate` is the default. */
export type StripeTaxMode = 'rate' | 'automatic';

export interface HttpStripeConfig {
  readonly secretKey: string;
  readonly priceId: string;
  readonly taxMode: StripeTaxMode;
  /** The `txr_…` id of the 20% GB VAT rate. Only read when `taxMode === 'rate'`. */
  readonly taxRateId: string;
}

/** Only the fields we actually read. Stripe owns this schema; a pinned full copy of it would rot. */
const CustomerSchema = z.object({ id: z.string().min(1) }).passthrough();

const HostedSessionSchema = z
  .object({
    url: z.string().url(),
    // Checkout sessions expire; portal sessions do not, and Stripe omits the field.
    expires_at: z.number().int().positive().nullish(),
  })
  .passthrough();

const StripeErrorSchema = z
  .object({
    error: z
      .object({
        type: z.string().optional(),
        code: z.string().optional(),
        param: z.string().optional(),
      })
      .passthrough(),
  })
  .passthrough();

export class HttpStripeClient implements StripeClient {
  private readonly logger = new Logger(HttpStripeClient.name);

  constructor(
    private readonly config: HttpStripeConfig,
    /** Injected so the request shape is unit-testable without opening a socket. */
    private readonly fetchImpl: typeof fetch = globalThis.fetch,
  ) {}

  async createCustomer(request: CreateCustomerRequest): Promise<{ readonly id: string }> {
    const body = await this.post(
      'customers',
      {
        name: request.name,
        // Conditional spread rather than `undefined` — exactOptionalPropertyTypes,
        // and Stripe reads an empty string as "clear this field" rather than
        // "leave it alone".
        ...(request.email === null ? {} : { email: request.email }),
        metadata: tenantMetadata(request.businessId, request.practiceId),
      },
      request.idempotencyKey,
    );
    return { id: CustomerSchema.parse(body).id };
  }

  async createCheckoutSession(request: CreateCheckoutSessionRequest): Promise<HostedSession> {
    const body = await this.post(
      'checkout/sessions',
      {
        mode: 'subscription',
        customer: request.customerId,
        // ⚠ NO `payment_method_types`. Omitting it is what lets Stripe show the
        // methods each client is actually eligible for, configured from the
        // dashboard; hardcoding `['card']` locks out everything else forever.
        line_items: [{ price: this.config.priceId, quantity: 1 }],
        success_url: request.successUrl,
        cancel_url: request.cancelUrl,
        client_reference_id: request.businessId,
        // On the SESSION as well as on the subscription: `checkout.session.completed`
        // carries the session's own metadata and nothing of the subscription's.
        metadata: tenantMetadata(request.businessId, request.practiceId),
        // ⚠ REQUIRED, and it is a VAT requirement rather than a UX preference:
        // the customer already exists (we create it before checkout), so
        // without this Stripe reuses whatever address is on file — which for a
        // brand-new customer is none, and an unresolvable location is what
        // makes a tax calculation quietly return zero.
        billing_address_collection: 'required',
        // Write what the client types at checkout back onto the customer, so the
        // next invoice and the portal both agree with the first one.
        //
        // ⚠ `name: 'auto'` is NOT optional alongside `tax_id_collection` — the
        // API refuses the whole request with "Tax ID collection requires
        // updating business name on the customer". Found against the real API,
        // not in review: nothing about the parameter names suggests they are
        // coupled, and the failure is a 400 on the one call that takes money.
        customer_update: { address: 'auto', name: 'auto' },
        // B2B: a client with a valid VAT number gets reverse-charge treatment
        // instead of being billed VAT as if they were a consumer.
        tax_id_collection: { enabled: true },
        subscription_data: {
          metadata: tenantMetadata(request.businessId, request.practiceId),
          // Merged INTO subscription_data rather than spread beside it: a
          // second `subscription_data` key would replace this one wholesale
          // and take the metadata with it.
          ...this.subscriptionTaxParams(),
        },
        integration_identifier: INTEGRATION_IDENTIFIER,
        ...this.sessionTaxParams(),
      },
      request.idempotencyKey,
    );
    return toHostedSession(body);
  }

  async createPortalSession(request: CreatePortalSessionRequest): Promise<HostedSession> {
    const body = await this.post(
      'billing_portal/sessions',
      { customer: request.customerId, return_url: request.returnUrl },
      request.idempotencyKey,
    );
    return toHostedSession(body);
  }

  /**
   * VAT, and the one line in this file most likely to be wrong in a way nobody
   * notices.
   *
   * `automatic_tax` and `default_tax_rates` are mutually exclusive — Stripe
   * rejects a request carrying both — so this returns one or the other, never
   * a merge. `automatic` is correct once there is an ACTIVE UK registration in
   * the Stripe dashboard and silently collects nothing before then; `rate`
   * attaches the explicit 20% GB rate and works with no registration at all.
   * `env.ts` refuses to boot `rate` without an id, because the failure mode of
   * a missing one is charging 8.50 gross and absorbing the VAT.
   */
  private sessionTaxParams(): Record<string, unknown> {
    return this.config.taxMode === 'automatic' ? { automatic_tax: { enabled: true } } : {};
  }

  private subscriptionTaxParams(): Record<string, unknown> {
    return this.config.taxMode === 'rate' ? { default_tax_rates: [this.config.taxRateId] } : {};
  }

  private async post(path: string, params: Record<string, unknown>, idempotencyKey: string): Promise<unknown> {
    const response = await this.fetchImpl(`${STRIPE_API_BASE}/${path}`, {
      method: 'POST',
      headers: {
        // Bearer, not Basic. Both work; this one keeps the key out of a
        // base64 blob that looks decorative in a log line.
        Authorization: `Bearer ${this.config.secretKey}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        'Stripe-Version': STRIPE_API_VERSION,
        'Idempotency-Key': idempotencyKey,
      },
      body: encodeForm(params),
    });

    const text = await response.text();
    if (!response.ok) throw this.refuse(path, response, text);
    try {
      return JSON.parse(text);
    } catch {
      throw this.refuse(path, response, '');
    }
  }

  /**
   * A Stripe failure, turned into our own problem+json.
   *
   * **Nothing from Stripe's body reaches the caller.** `error.message` is
   * written for a developer reading a dashboard and can quote submitted values
   * back; error responses are logged and screenshotted far more freely than
   * request bodies are. The `type`/`code` pair and Stripe's request id go to
   * the log, which is where someone debugging this actually looks.
   */
  private refuse(path: string, response: Response, text: string): AppException {
    const parsed = StripeErrorSchema.safeParse(safeJson(text));
    const kind = parsed.success ? `${parsed.data.error.type ?? 'unknown'}/${parsed.data.error.code ?? 'none'}` : 'unparseable';
    this.logger.error(
      `Stripe ${path} failed: HTTP ${response.status}, ${kind}, request-id ${response.headers.get('request-id') ?? '(none)'}`,
    );
    return new AppException(
      'NT-SRV-001',
      HttpStatus.INTERNAL_SERVER_ERROR,
      'Billing is temporarily unavailable',
      'The payment provider could not be reached. Nothing was charged.',
    );
  }
}

/**
 * The two ids every event we handle has to carry home.
 *
 * `practiceId` is omitted rather than sent empty when there is none: Stripe
 * stores metadata as strings, an empty string round-trips as `''`, and a
 * handler comparing that against "absent" is one `!==` away from opening a
 * scope on a practice called nothing.
 */
function tenantMetadata(businessId: string, practiceId: string | null): Record<string, string> {
  return { businessId, ...(practiceId === null ? {} : { practiceId }) };
}

function toHostedSession(body: unknown): HostedSession {
  const parsed = HostedSessionSchema.parse(body);
  return {
    url: parsed.url,
    // Stripe counts in whole seconds; everything in storage is a UTC instant.
    expiresAt: parsed.expires_at == null ? null : new Date(parsed.expires_at * 1000).toISOString(),
  };
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * Stripe's form encoding, which is not `JSON.stringify` and not flat
 * `URLSearchParams` either: nesting is expressed in the KEY —
 * `metadata[businessId]=b_1`, `line_items[0][price]=price_1`.
 *
 * Written out rather than reached for from a library because getting it subtly
 * wrong is silent: Stripe ignores a parameter it does not recognise, so a
 * mis-encoded `subscription_data[default_tax_rates][0]` does not error, it
 * charges the net price with no VAT on it.
 *
 * Exported for its own test — the encoding is the part worth pinning.
 */
export function encodeForm(params: Record<string, unknown>): string {
  const pairs: Array<[string, string]> = [];
  const walk = (prefix: string, value: unknown): void => {
    if (value === undefined || value === null) return;
    if (Array.isArray(value)) {
      value.forEach((item, index) => walk(`${prefix}[${index}]`, item));
      return;
    }
    if (typeof value === 'object') {
      for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
        walk(`${prefix}[${key}]`, nested);
      }
      return;
    }
    pairs.push([prefix, String(value)]);
  };
  for (const [key, value] of Object.entries(params)) walk(key, value);
  return new URLSearchParams(pairs).toString();
}
