import { Logger } from '@nestjs/common';
import type { z } from 'zod';

import type { ResolvedConnection } from './token-store.js';

/**
 * One HTTP surface for all four vendors: the bearer, the per-vendor routing
 * header, the Zod parse, and the classification of what went wrong.
 *
 * ⚠ **Zod at every boundary, adapter responses included.** A vendor's JSON is
 * untrusted input arriving over a network from a system we do not control, and
 * the numbers in it end up in somebody's books. Nothing in this module returns
 * a value that has not been through a schema, which is why `json()` takes one
 * and there is no `any`-shaped escape hatch beside it.
 *
 * ⚠ **`retryable` is set from the STATUS, honestly.** A 429 and a 5xx can be
 * tried again; a 400 from a vendor is the vendor saying no, and marking it
 * retryable would put a permanently-failing item in front of an accountant
 * forever. The adapter contract calls this out by name.
 */

/** A vendor call that did not succeed. Never carries the vendor's own prose. */
export class LedgerApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly retryable: boolean,
    /** The vendor's own request id, for a support ticket. Logged, never shown. */
    readonly vendorTraceId: string | null = null,
  ) {
    super(message);
    this.name = 'LedgerApiError';
  }
}

/** FreeAgent requires an identifying User-Agent; the others accept one happily. */
const USER_AGENT = 'Neoting/1.0 (+https://neoacc.neovogent.com)';

export class VendorApi {
  private readonly logger = new Logger(VendorApi.name);

  constructor(
    private readonly connection: ResolvedConnection,
    private readonly fetchImpl: typeof fetch = globalThis.fetch,
    /** Milliseconds before a single vendor call is abandoned as a timeout. */
    private readonly timeoutMs = 30_000,
  ) {}

  /** `GET`, parsed. */
  async get<T>(schema: z.ZodType<T>, path: string, query?: Record<string, string>): Promise<T> {
    const suffix = query === undefined ? '' : `?${new URLSearchParams(query).toString()}`;
    return this.json(schema, `${path}${suffix}`, { method: 'GET' });
  }

  /** `POST` with a JSON body, parsed. */
  async postJson<T>(schema: z.ZodType<T>, path: string, body: unknown): Promise<T> {
    return this.json(schema, path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  /** `POST` of raw bytes — Xero's attachment endpoint, which takes the file and nothing else. */
  async postBytes<T>(schema: z.ZodType<T>, path: string, bytes: Buffer, contentType: string): Promise<T> {
    return this.json(schema, path, {
      method: 'POST',
      headers: { 'Content-Type': contentType, 'Content-Length': String(bytes.byteLength) },
      body: new Uint8Array(bytes),
    });
  }

  /** `POST` of a multipart body — Intuit's upload endpoint. */
  async postForm<T>(schema: z.ZodType<T>, path: string, form: FormData): Promise<T> {
    // No Content-Type header: `fetch` writes it with the boundary it generated,
    // and setting one by hand is how a multipart POST becomes an unparseable one.
    return this.json(schema, path, { method: 'POST', body: form });
  }

  /**
   * The one place a request leaves for a vendor.
   *
   * The timeout is an `AbortSignal` rather than a race, so the socket is
   * actually released — a batch of 500 against a vendor that has stopped
   * answering would otherwise hold 500 of them.
   */
  private async json<T>(schema: z.ZodType<T>, path: string, init: RequestInit): Promise<T> {
    const url = path.startsWith('http') ? path : `${this.connection.vendor.apiBase}${path}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        ...init,
        signal: controller.signal,
        headers: { ...this.headers(), ...(init.headers as Record<string, string> | undefined) },
      });
    } catch (error) {
      const aborted = error instanceof Error && error.name === 'AbortError';
      // Both are retryable and both are honest about which happened.
      throw new LedgerApiError(
        aborted
          ? `${this.connection.vendor.label} did not answer within ${Math.round(this.timeoutMs / 1000)} seconds.`
          : `${this.connection.vendor.label} could not be reached.`,
        0,
        true,
      );
    } finally {
      clearTimeout(timer);
    }

    // ⚠ Intuit's `intuit_tid` from EVERY response, success or failure. The App
    // Assessment Questionnaire asks whether we capture it, and Intuit support
    // asks for it on any ticket.
    const vendorTraceId =
      response.headers.get('intuit_tid') ??
      response.headers.get('xero-correlation-id') ??
      response.headers.get('x-request-id');
    if (vendorTraceId !== null) {
      this.logger.log(`${this.connection.vendor.label} ${init.method ?? 'GET'} ${path} -> ${response.status} [${vendorTraceId}]`);
    }

    const text = await response.text();
    if (!response.ok) throw this.classify(response, text, vendorTraceId);

    let body: unknown;
    try {
      // A 204 and an empty 200 are both legitimate; `undefined` lets a schema
      // decide whether that is acceptable rather than this function deciding.
      body = text.trim() === '' ? undefined : JSON.parse(text);
    } catch {
      throw new LedgerApiError(`${this.connection.vendor.label} answered with something that is not JSON.`, response.status, true, vendorTraceId);
    }

    const parsed = schema.safeParse(body);
    if (!parsed.success) {
      // The ISSUE PATHS, never the body: the body is the client's bookkeeping.
      this.logger.error(
        `${this.connection.vendor.label} ${path} did not match the expected shape at ${parsed.error.issues
          .map((issue) => issue.path.join('.'))
          .join(', ')} [${vendorTraceId ?? 'no trace id'}]`,
      );
      throw new LedgerApiError(
        `${this.connection.vendor.label} answered in a shape this build does not recognise.`,
        response.status,
        // Retryable: a shape change is usually a vendor deploy, and the next
        // attempt after a fix is what should succeed.
        true,
        vendorTraceId,
      );
    }
    return parsed.data;
  }

  /**
   * The bearer plus whichever header routes the call to the right set of books.
   *
   * ⚠ This is the ONLY per-vendor branch in the shared layer, and it is here
   * because it genuinely is a per-vendor fact with no data shape: Xero routes on
   * a header, Sage routes on a different header, QuickBooks routes on the PATH,
   * and FreeAgent's token is already organisation-specific.
   */
  private headers(): Record<string, string> {
    const base: Record<string, string> = {
      Authorization: `Bearer ${this.connection.accessToken}`,
      Accept: 'application/json',
      'User-Agent': USER_AGENT,
    };
    const orgRef = this.connection.orgRef;
    if (orgRef === null) return base;
    if (this.connection.vendor.slug === 'xero') return { ...base, 'Xero-Tenant-Id': orgRef };
    if (this.connection.vendor.slug === 'sage') return { ...base, 'X-Business': orgRef };
    return base;
  }

  private classify(response: Response, text: string, vendorTraceId: string | null): LedgerApiError {
    const label = this.connection.vendor.label;
    this.logger.error(`${label} refused with HTTP ${response.status} [${vendorTraceId ?? 'no trace id'}]`);

    if (response.status === 401) {
      return new LedgerApiError(
        `The ${label} connection is no longer authorised — reconnect it from the client's Connections screen.`,
        401,
        false,
        vendorTraceId,
      );
    }
    if (response.status === 403) {
      return new LedgerApiError(
        `${label} refused this action for this organisation — the connection may not have the permissions it needs.`,
        403,
        false,
        vendorTraceId,
      );
    }
    if (response.status === 429) {
      return new LedgerApiError(`${label} is rate-limiting this practice — this will be tried again.`, 429, true, vendorTraceId);
    }
    if (response.status >= 500) {
      return new LedgerApiError(`${label} had a problem at their end — this will be tried again.`, response.status, true, vendorTraceId);
    }
    // 4xx: the vendor read the request and said no. A retry cannot fix it, and
    // the summary is OURS — a vendor's validation prose quotes the submitted
    // figures back, which here is somebody's bookkeeping.
    return new LedgerApiError(
      `${label} would not accept this transaction${summarise(text)}. It needs a correction, not a retry.`,
      response.status,
      false,
      vendorTraceId,
    );
  }
}

/**
 * The one piece of a vendor's refusal worth showing an accountant: a short,
 * field-level reason.
 *
 * Deliberately conservative — only a plainly short message, only from the three
 * shapes the four use, truncated, and dropped entirely when it does not look
 * like a sentence. An accountant reading "Account code 429 is not valid" can
 * act; the same field carrying a 4 kB stack trace is noise on a screen and a
 * leak in a screenshot.
 */
function summarise(text: string): string {
  try {
    const body: unknown = JSON.parse(text);
    if (typeof body !== 'object' || body === null) return '';
    const record = body as Record<string, unknown>;
    const candidate =
      // Xero
      firstString(record['Message']) ??
      // Intuit
      firstString(nested(record, ['Fault', 'Error', 0, 'Detail'])) ??
      // Sage
      firstString(nested(record, ['$diagnoses', 0, 'message'])) ??
      // FreeAgent
      firstString(nested(record, ['errors', 'error', 'message']));
    if (candidate === null || candidate.length > 200) return '';
    return `: ${candidate}`;
  } catch {
    return '';
  }
}

function nested(value: unknown, path: readonly (string | number)[]): unknown {
  let current = value;
  for (const key of path) {
    if (typeof current !== 'object' || current === null) return undefined;
    current = (current as Record<string | number, unknown>)[key];
  }
  return current;
}

function firstString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}
