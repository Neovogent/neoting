/**
 * The local-development email source: MailHog (issue #78, acceptance "runs end to
 * end locally against MailHog with no AWS at all"). MailHog stands in for SES in
 * `docker compose` — SMTP on 1025, HTTP API on 8025. This polls its API for
 * messages, hands each raw MIME body to the same intake runner staging uses, and
 * deletes a message once it is processed.
 */

import { z } from 'zod';

import type { EmailSource, InboundRawEmail } from './email-source.js';

const DEFAULT_LIMIT = 50;

/**
 * A tolerant view of MailHog's `GET /api/v2/messages` — only the fields used
 * (Zod at the boundary; we do not own MailHog's schema). `Raw.Data` is the full
 * raw SMTP payload, and `Raw.To` the envelope recipients (what a `doc+<practice>@`
 * plus tag rides on).
 */
const MailHogMessageSchema = z
  .object({
    ID: z.string(),
    Created: z.string().optional(),
    Raw: z
      .object({
        Data: z.string(),
        To: z.array(z.string()).nullish(),
      })
      .passthrough(),
  })
  .passthrough();

const MailHogListSchema = z.object({ items: z.array(MailHogMessageSchema).nullish() }).passthrough();

function toSeconds(created: string | undefined): number {
  if (created === undefined) return 0;
  const ms = Date.parse(created);
  return Number.isNaN(ms) ? 0 : Math.floor(ms / 1000);
}

export interface MailHogEmailSourceOptions {
  /** Base URL of MailHog's HTTP API, e.g. `http://localhost:8025`. */
  readonly apiUrl: string;
  /** Injected so the suite exercises poll/ack with no network. */
  readonly fetchImpl?: typeof fetch;
  readonly limit?: number;
}

export class MailHogEmailSource implements EmailSource {
  private readonly apiUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly limit: number;

  constructor(options: MailHogEmailSourceOptions) {
    // Trim a trailing slash so `${apiUrl}/api/...` never doubles it.
    this.apiUrl = options.apiUrl.replace(/\/+$/, '');
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.limit = options.limit ?? DEFAULT_LIMIT;
  }

  async poll(): Promise<readonly InboundRawEmail[]> {
    const response = await this.fetchImpl(`${this.apiUrl}/api/v2/messages?limit=${this.limit}`);
    if (!response.ok) throw new Error(`mailhog list failed: ${response.status}`);

    const parsed = MailHogListSchema.safeParse(await response.json());
    if (!parsed.success) throw new Error('mailhog returned an unexpected messages shape');

    return (parsed.data.items ?? []).map((item) => ({
      id: item.ID,
      raw: Buffer.from(item.Raw.Data),
      envelopeRecipient: item.Raw.To?.[0] ?? null,
      receivedAtSeconds: toSeconds(item.Created),
    }));
  }

  async ack(id: string): Promise<void> {
    const response = await this.fetchImpl(`${this.apiUrl}/api/v1/messages/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    });
    // 404 = already gone, which is the state we wanted anyway.
    if (!response.ok && response.status !== 404) throw new Error(`mailhog delete failed: ${response.status}`);
  }
}
