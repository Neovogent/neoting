/**
 * WhatsApp media fetch (issue #79, SoT §4 Stage 1).
 *
 * A WhatsApp webhook does not carry the document — it carries a Meta media id.
 * Until something resolves that id to bytes, a client sending a receipt to the
 * Neoting number produces a signed, enqueued job and no document: a silent loss
 * on the only live channel, which this module's first invariant forbids.
 *
 * Interface + fixture, selected by config — the same shape as `IngestQueue`,
 * `DocumentStore`, `ImageNormaliser` and `DocumentGuard`, deliberately not a
 * sixth shape.
 */

import { CHANNEL_POLICY, type Channel } from '../lib/sanitisation/index.js';

/**
 * WhatsApp intake is a CLIENT channel, not a channel of its own.
 *
 * `Channel` has no `'whatsapp'` member and must not grow one: `channels.ts`
 * already documents `'client'` as "chat upload, SMS secure link, WhatsApp
 * intake" and gives it the 25 MB cap issue #79 asks for. Adding a sixth channel
 * with identical policy would be a second place to keep the same number.
 */
export const WHATSAPP_MEDIA_CHANNEL: Channel = 'client';

/** The size cap, read from the channel policy so there is one number, not two. */
export const MAX_MEDIA_BYTES = CHANNEL_POLICY[WHATSAPP_MEDIA_CHANNEL].maxBytes;

/**
 * Why a fetch failed — and, through {@link isRetryable}, whether retrying could
 * ever help.
 *
 * This distinction is the whole point of the type. Issue #79: "Fetch failure
 * must be a visible rejection with a reason and a retry path, not a swallowed
 * error and not an infinite retry." A Graph 503 is weather and deserves the
 * backoff; a media id Meta has already expired is dead, and burning five
 * attempts on it delays the DLQ entry a human needs to see.
 */
export type MediaFetchFailure =
  /** Meta no longer holds the media (ids live ~30 days). Retrying cannot help. */
  | 'expired'
  /** No such media id, or not visible to this token. Retrying cannot help. */
  | 'not_found'
  /** Token missing, malformed or refused — configuration, not weather. */
  | 'unauthorised'
  /** Over the channel cap. Refused BEFORE the bytes are allocated. */
  | 'too_large'
  /** Graph 5xx or throttling — transient. */
  | 'upstream'
  /** Socket, DNS, TLS or timeout — transient. */
  | 'transport'
  /** Graph answered with a shape we do not recognise. */
  | 'malformed_response';

const RETRYABLE: ReadonlySet<MediaFetchFailure> = new Set<MediaFetchFailure>(['upstream', 'transport']);

/** Whether another attempt could plausibly succeed. */
export function isRetryable(failure: MediaFetchFailure): boolean {
  return RETRYABLE.has(failure);
}

/**
 * A fetch that did not produce bytes.
 *
 * Carries its own retryability so the worker can route it: retryable → throw and
 * let BullMQ back off; terminal → dead-letter it now, where a human sees it,
 * rather than spending the retry budget on an id that will never resolve.
 */
export class MediaFetchError extends Error {
  readonly retryable: boolean;

  constructor(
    readonly failure: MediaFetchFailure,
    message: string,
    /** The upstream HTTP status, when there was one. */
    readonly status?: number,
  ) {
    super(message);
    this.name = 'MediaFetchError';
    this.retryable = isRetryable(failure);
  }
}

export interface FetchedMedia {
  readonly bytes: Buffer;
  /**
   * Meta's declared MIME type — a HINT, for logging only. The magic-byte sniffer
   * in `sanitise()` is the sole authority on what the bytes actually are, exactly
   * as the email lane treats a part's `Content-Type`.
   */
  readonly declaredMimeType: string | null;
  /**
   * Meta's declared filename for `document` messages. Sender-controlled — reduce
   * it to a basename before it is stored or shown, never trust it for the type.
   */
  readonly declaredFilename: string | null;
}

export interface MediaFetcher {
  /** Resolve a Meta media id to its bytes, or throw a {@link MediaFetchError}. */
  fetch(mediaId: string): Promise<FetchedMedia>;
}

/**
 * Offline fixture — seeded by tests and local dev, so the suite runs with no
 * network (`MEDIA_FETCH=fixture`).
 *
 * ⚠ AN UNSEEDED ID FAILS. It does NOT invent a placeholder image, and that is
 * deliberate: `MEDIA_FETCH` defaults to `fixture`, so a fixture that fabricated
 * bytes would turn every real receipt arriving in staging into a made-up
 * document that looks successfully ingested. A stand-in document is worse than
 * no document — a missing one is visible in the DLQ, a fake one is not visible
 * anywhere.
 */
export class FixtureMediaFetcher implements MediaFetcher {
  private readonly media = new Map<string, FetchedMedia>();
  private readonly failures = new Map<string, MediaFetchError>();
  /** Every id asked for, in order — lets a test assert the fetch happened once. */
  readonly requested: string[] = [];

  /** Seed bytes for an id. */
  put(mediaId: string, media: Partial<FetchedMedia> & Pick<FetchedMedia, 'bytes'>): this {
    this.media.set(mediaId, {
      bytes: media.bytes,
      declaredMimeType: media.declaredMimeType ?? null,
      declaredFilename: media.declaredFilename ?? null,
    });
    return this;
  }

  /** Seed a failure for an id — how a test exercises the expired/5xx paths. */
  failWith(mediaId: string, error: MediaFetchError): this {
    this.failures.set(mediaId, error);
    return this;
  }

  async fetch(mediaId: string): Promise<FetchedMedia> {
    this.requested.push(mediaId);
    const failure = this.failures.get(mediaId);
    if (failure) throw failure;
    const media = this.media.get(mediaId);
    if (media === undefined) {
      throw new MediaFetchError(
        'not_found',
        `no media seeded for id ${mediaId} — the fixture fetcher never invents bytes (MEDIA_FETCH=fixture)`,
      );
    }
    return media;
  }
}

/**
 * The media id the `demo:whatsapp` driver (METH Stage 5, §7) references.
 *
 * The demo webhook carries this id; with nothing seeded behind it the fixture
 * fetcher throws `not_found` (above) and the job dead-letters with no document,
 * which is the opposite of the beat we are demoing.
 */
export const DEMO_WHATSAPP_MEDIA_ID = 'demo-media-currys';

/**
 * A real, minimal 1x1 PNG (a single transparent pixel, ~68 bytes). It is a full
 * decodable image — not just the 8-byte signature — so the demo document survives
 * BOTH normalisers: the fixture passthrough (default local demo) AND
 * `IMAGE_NORMALISER=sharp` (staging/prod), where sharp would reject a truncated
 * signature-only buffer and the job would dead-letter. `sniff()` still classifies
 * it as PNG, and no real image asset has to live in the tree.
 */
const DEMO_PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

/**
 * Pre-seed the ONE demo media id so `demo:whatsapp` lands a document instead of
 * dead-lettering.
 *
 * // DEMO-MOCK: Meta Graph media fetch (GraphMediaFetcher) resolves real ids in
 * staging/prod. This only ever touches the fixture fetcher — `selectMediaFetcher`
 * calls it on the `fixture` branch alone, so the graph path is untouched and no
 * real receipt id is ever fabricated.
 */
export function seedDemoMedia(fetcher: FixtureMediaFetcher): void {
  fetcher.put(DEMO_WHATSAPP_MEDIA_ID, {
    bytes: DEMO_PNG_1X1,
    declaredMimeType: 'image/png',
    declaredFilename: 'currys-receipt.png',
  });
}
