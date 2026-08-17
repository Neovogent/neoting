/**
 * The real WhatsApp media fetcher: Meta Cloud API, two steps (issue #79).
 *
 *   1 `GET /v22.0/<media-id>` → JSON metadata carrying a short-lived download URL
 *   2 `GET <that url>` with the same bearer → the bytes
 *
 * **No new dependency.** Node 22's built-in `fetch` does both; adding an HTTP
 * client for two GETs would be a dependency decision that needs a human
 * (root CLAUDE.md), for no capability we lack.
 */

import {
  type FetchedMedia,
  MAX_MEDIA_BYTES,
  MediaFetchError,
  type MediaFetcher,
} from './media-fetcher.js';

const DEFAULT_GRAPH_BASE = 'https://graph.facebook.com/v22.0';
const DEFAULT_TIMEOUT_MS = 20_000;

/**
 * Hosts the download URL is allowed to name.
 *
 * The URL arrives in Meta's own authenticated response, so this is defence in
 * depth rather than a live threat — but the request that follows carries our
 * bearer token, and "we send a credential to whatever host a JSON field told us
 * to" is the shape of an SSRF, not a fetch. Matched on the registrable suffix,
 * with the leading dot, so `evil-fbcdn.net` does not pass.
 */
const ALLOWED_DOWNLOAD_HOSTS: readonly string[] = [
  'graph.facebook.com',
  'lookaside.facebook.com',
  'lookaside.fbsbx.com',
  '.fbcdn.net',
  '.fbsbx.com',
  '.facebook.com',
];

export interface GraphMediaFetcherOptions {
  /**
   * Bearer token with `whatsapp_business_messaging`.
   *
   * ⚠ NOT `META_APP_SECRET` (the webhook HMAC key) and NOT `META_VERIFY_TOKEN`
   * (the handshake echo). Neither authenticates a Graph call — this is a
   * separate System User credential, flagged on issue #79 as a secrets change.
   */
  readonly accessToken: string;
  readonly graphBaseUrl?: string;
  readonly timeoutMs?: number;
  readonly maxBytes?: number;
  /** Injected so the suite exercises every branch with no network. */
  readonly fetchImpl?: typeof fetch;
}

interface MediaMetadata {
  readonly url: string;
  readonly mimeType: string | null;
  readonly declaredFileSize: number | null;
}

/** Meta's error envelope, read defensively — we do not own this schema. */
function metaErrorCodes(bodyText: string): { code: number | null; subcode: number | null } {
  try {
    const parsed: unknown = JSON.parse(bodyText);
    const error = (parsed as { error?: { code?: unknown; error_subcode?: unknown } }).error;
    return {
      code: typeof error?.code === 'number' ? error.code : null,
      subcode: typeof error?.error_subcode === 'number' ? error.error_subcode : null,
    };
  } catch {
    return { code: null, subcode: null };
  }
}

/**
 * Map an upstream status onto a failure kind — which is what decides retry vs
 * straight-to-DLQ, so it is the part worth being precise about.
 *
 * Meta answers an EXPIRED media id with 404 + code 100 / subcode 33, the same
 * envelope it uses for "never existed". Both are terminal, so they are told
 * apart only for the message a human reads in the DLQ.
 */
function failureForStatus(status: number, bodyText: string): MediaFetchError {
  if (status === 401 || status === 403) {
    return new MediaFetchError(
      'unauthorised',
      'Meta refused the media access token — it is missing, expired or lacks whatsapp_business_messaging',
      status,
    );
  }
  if (status === 429 || status >= 500) {
    return new MediaFetchError('upstream', `Meta Graph returned ${status} — transient, will retry`, status);
  }
  if (status === 404 || status === 400) {
    const { code, subcode } = metaErrorCodes(bodyText);
    const expired = subcode === 33 || code === 100;
    return new MediaFetchError(
      expired ? 'expired' : 'not_found',
      expired
        ? 'Meta no longer holds this media id (they expire after ~30 days) — it cannot be fetched again'
        : `Meta Graph returned ${status} for this media id`,
      status,
    );
  }
  return new MediaFetchError('upstream', `Meta Graph returned an unexpected ${status}`, status);
}

/** A thrown `fetch` is always the network, never a decision. */
function asTransport(error: unknown, what: string): MediaFetchError {
  const reason = error instanceof Error ? error.message : String(error);
  return new MediaFetchError('transport', `${what} failed before Meta answered: ${reason}`);
}

function hostAllowed(hostname: string): boolean {
  return ALLOWED_DOWNLOAD_HOSTS.some((allowed) =>
    allowed.startsWith('.') ? hostname.endsWith(allowed) : hostname === allowed,
  );
}

/**
 * A response the fetch was told NOT to follow.
 *
 * Both requests are made with `redirect: 'manual'`, so the host allowlist is not
 * validated on the first hop and then quietly bypassed by a 30x: Node returns the
 * redirect WITHOUT following it (an opaque-redirect surfaces as status 0; some
 * versions surface the raw 3xx), so the redirect target is never requested and the
 * bearer never reaches it. A media URL resolves to bytes on the first hop — a
 * bounce is either Meta misbehaving or an open-redirect being used to steer us off
 * the allowlist, and both are refused rather than followed (SSRF, issue #79).
 */
function isRedirect(response: Response): boolean {
  return response.status === 0 || (response.status >= 300 && response.status < 400);
}

function redirectRefused(mediaId: string, step: 'metadata' | 'download'): MediaFetchError {
  return new MediaFetchError(
    'malformed_response',
    `refusing to follow a redirect on the ${step} request for media ${mediaId} — the URL must resolve on the first hop; following a bounce could steer the bearer off the Meta host allowlist (SSRF)`,
  );
}

/**
 * Read a response body, refusing to hold more than `maxBytes`.
 *
 * The cap is applied to the STREAM, not to a finished buffer. `Content-Length`
 * is checked first because it saves the transfer, but it is a claim by the
 * sender: the per-chunk running total is what actually enforces the limit, and
 * breaking out of the loop cancels the stream so the rest is never transferred.
 * A cap you check after downloading is not a cap (issue #79).
 */
async function readCapped(response: Response, maxBytes: number, mediaId: string): Promise<Buffer> {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw tooLarge(declared, maxBytes, mediaId);
  }

  const body = response.body;
  if (body === null) {
    throw new MediaFetchError('malformed_response', `Meta returned no body for media ${mediaId}`);
  }

  const chunks: Buffer[] = [];
  let total = 0;
  let overCap = false;
  try {
    // Cast: `Response.body` is a web ReadableStream, which Node's runtime makes
    // async-iterable but the DOM-free lib set here does not describe.
    for await (const chunk of body as unknown as AsyncIterable<Uint8Array>) {
      total += chunk.byteLength;
      if (total > maxBytes) {
        overCap = true;
        break; // cancels the stream — the remaining bytes are never pulled
      }
      chunks.push(Buffer.from(chunk));
    }
  } catch (error) {
    if (!overCap) throw asTransport(error, `downloading media ${mediaId}`);
  }
  if (overCap) throw tooLarge(total, maxBytes, mediaId);

  return Buffer.concat(chunks);
}

function tooLarge(seen: number, maxBytes: number, mediaId: string): MediaFetchError {
  return new MediaFetchError(
    'too_large',
    `media ${mediaId} is over the ${Math.round(maxBytes / (1024 * 1024))} MB limit for this channel (${seen} bytes)`,
  );
}

class GraphMediaFetcher implements MediaFetcher {
  private readonly graphBaseUrl: string;
  private readonly timeoutMs: number;
  private readonly maxBytes: number;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: GraphMediaFetcherOptions) {
    this.graphBaseUrl = options.graphBaseUrl ?? DEFAULT_GRAPH_BASE;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxBytes = options.maxBytes ?? MAX_MEDIA_BYTES;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async fetch(mediaId: string): Promise<FetchedMedia> {
    const metadata = await this.resolve(mediaId);

    // Refuse BEFORE allocating anything, on Meta's own declared size. The
    // stream cap in `readCapped` still runs — this only saves the transfer.
    if (metadata.declaredFileSize !== null && metadata.declaredFileSize > this.maxBytes) {
      throw tooLarge(metadata.declaredFileSize, this.maxBytes, mediaId);
    }

    const url = this.parseDownloadUrl(metadata.url, mediaId);

    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        headers: { authorization: `Bearer ${this.options.accessToken}` },
        redirect: 'manual', // do not chase a bounce off the allowlist — see isRedirect
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      throw asTransport(error, `downloading media ${mediaId}`);
    }
    if (isRedirect(response)) {
      throw redirectRefused(mediaId, 'download');
    }
    if (!response.ok) {
      throw failureForStatus(response.status, await response.text().catch(() => ''));
    }

    return {
      bytes: await readCapped(response, this.maxBytes, mediaId),
      declaredMimeType: metadata.mimeType,
      declaredFilename: null, // Meta puts the filename on the message, not the media
    };
  }

  /** Step 1 — media id → download URL. */
  private async resolve(mediaId: string): Promise<MediaMetadata> {
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.graphBaseUrl}/${encodeURIComponent(mediaId)}`, {
        headers: { authorization: `Bearer ${this.options.accessToken}` },
        redirect: 'manual', // do not chase a bounce off the allowlist — see isRedirect
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      throw asTransport(error, `resolving media ${mediaId}`);
    }
    if (isRedirect(response)) {
      throw redirectRefused(mediaId, 'metadata');
    }
    if (!response.ok) {
      throw failureForStatus(response.status, await response.text().catch(() => ''));
    }

    const body: unknown = await response.json().catch(() => null);
    const url = (body as { url?: unknown } | null)?.url;
    if (typeof url !== 'string' || url.length === 0) {
      throw new MediaFetchError('malformed_response', `Meta returned no download URL for media ${mediaId}`);
    }
    const mimeType = (body as { mime_type?: unknown }).mime_type;
    const fileSize = (body as { file_size?: unknown }).file_size;

    return {
      url,
      mimeType: typeof mimeType === 'string' ? mimeType : null,
      declaredFileSize: typeof fileSize === 'number' && Number.isFinite(fileSize) ? fileSize : null,
    };
  }

  /** The bearer only ever leaves this process towards a host on the allowlist. */
  private parseDownloadUrl(raw: string, mediaId: string): string {
    let parsed: URL;
    try {
      parsed = new URL(raw);
    } catch {
      throw new MediaFetchError('malformed_response', `Meta returned an unparseable download URL for media ${mediaId}`);
    }
    if (parsed.protocol !== 'https:' || !hostAllowed(parsed.hostname)) {
      throw new MediaFetchError(
        'malformed_response',
        `refusing to send the media token to ${parsed.protocol}//${parsed.hostname} — not a Meta host`,
      );
    }
    return parsed.toString();
  }
}

export function createGraphMediaFetcher(options: GraphMediaFetcherOptions): MediaFetcher {
  return new GraphMediaFetcher(options);
}
