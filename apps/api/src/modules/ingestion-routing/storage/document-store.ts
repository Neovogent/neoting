import { createHash } from 'node:crypto';

/**
 * Object storage for sanitised documents (issue #16). Same interface-plus-fixture
 * shape as `VirusScanner` / `IngestQueue` / `EmailParser`, so unit tests stay
 * offline and the real S3 client drops in behind the interface.
 */

export interface StoredDocument {
  readonly key: string;
  readonly sha256: string;
  readonly byteLength: number;
}

export interface DocumentStorePutInput {
  readonly bytes: Buffer;
  readonly sha256: string;
  readonly contentType: string;
  /** The routed workspace, or null when the document is Unrouted. */
  readonly workspaceId: string | null;
  /**
   * The practice that received it. Required whenever there is no workspace —
   * an unrouted object still belongs to someone, and the key is the only place
   * that fact survives once the bytes are in a bucket.
   */
  readonly practiceId: string | null;
}

/** A presigned direct-to-storage `PUT` (issue #76) — the API never sees the bytes. */
export interface PresignPutInput {
  /** The object key to presign to. Must start `w/` (built via {@link uploadIntentKey}). */
  readonly key: string;
  /** Declared content type; pinned into the signature so the PUT must match. */
  readonly contentType: string;
  /** Declared exact size; pinned into the signature so the presigned policy enforces the cap too. */
  readonly byteSize: number;
  readonly expiresInSeconds: number;
}

export interface PresignedPut {
  readonly key: string;
  readonly url: string;
  /** Send these verbatim with the PUT — the presigned signature covers them. */
  readonly headers: Readonly<Record<string, string>>;
}

/**
 * A presigned direct-from-storage `GET` (issue #77) — the read half of the same
 * bargain: `GET /documents/{id}/original` hands back a URL rather than proxying
 * bytes through the API.
 *
 * **Short-lived and scoped to one object.** The signature covers this key alone,
 * so the URL cannot be walked to another document, and it expires — which is
 * what makes it safe to put in an `<img src>` that a browser will cache and a
 * referrer header may leak. The alternative the issue explicitly rules out — a
 * redirect to a public object — is permanent and enumerable.
 */
export interface PresignGetInput {
  readonly key: string;
  readonly expiresInSeconds: number;
  /**
   * Pinned onto the response so the browser does not content-sniff. The stored
   * MIME is magic-byte-authoritative by then (sanitisation overwrote the
   * declared one), so this is the trustworthy value, not the uploader's claim.
   */
  readonly contentType: string;
  /** Suggested download name. Untrusted — see `contentDisposition`. */
  readonly filename: string;
}

export interface PresignedGet {
  readonly url: string;
  /** When the signature stops working, so the caller can tell a client when to re-ask. */
  readonly expiresAt: Date;
}

export interface DocumentStore {
  put(input: DocumentStorePutInput): Promise<StoredDocument>;
  get(key: string): Promise<Buffer>;
  /**
   * SHA-256 of the object at `key`, hex — computed WITHOUT materialising the
   * object in this process. The completion path verifies up to a channel-cap's
   * worth of bytes (100 MB on the accountant lane), and `get()` would hold all
   * of them in one Buffer per in-flight request; the whole point of the
   * presigned two-step is that the API never carries the bytes (#76).
   */
  sha256(key: string): Promise<string>;
  /** Presigned `PUT` for a browser→storage upload; the caller signs, the client uploads (#76). */
  presignPut(input: PresignPutInput): Promise<PresignedPut>;
  /** Presigned `GET` for a browser→storage read; short-lived, one object (#77). */
  presignGet(input: PresignGetInput): Promise<PresignedGet>;
  /** Object size if it exists, else null — the "did the PUT land?" check on completion (#76). */
  head(key: string): Promise<{ readonly byteLength: number } | null>;
}

/**
 * `Content-Disposition` for a presigned GET, built from a filename **the
 * uploader chose**.
 *
 * That is the whole reason this is a function. `originalFilename` is
 * client-supplied and travels into a response header: a name containing a CR or
 * LF splits the header and lets the uploader inject headers of their own into a
 * response served from the bucket's origin, and an unescaped `"` ends the quoted
 * string early. Both are stripped rather than escaped — no legitimate filename
 * contains a newline, and a document called `in"voice.pdf` downloading as
 * `invoice.pdf` is not a bug worth a parser for.
 *
 * The strip covers the **whole C0/C1 control range plus DEL**, not just CR and
 * LF. CR and LF are the header-splitting pair everyone thinks of, but they are
 * not the only characters that have no business in a header value: RFC 7230
 * §3.2.6 forbids NUL outright, and several HTTP parsers truncate a field at the
 * first NUL — which would serve a silently shortened filename rather than fail
 * loudly. A bare TAB is legal inside a quoted-string and is stripped anyway,
 * because a filename that renders as a column break is a bug either way and
 * "legal but nobody means it" is not worth the carve-out.
 *
 * Postgres already refuses NUL in a `text` column, so the storage path cannot
 * currently deliver one here. That is a reason this is defence in depth rather
 * than a live hole — not a reason to leave it out. This function is the single
 * point where an uploader-chosen name becomes a header, and it should not
 * depend on a column type three layers away staying the way it is.
 *
 * `inline` rather than `attachment`: the review screen renders the original in
 * an overlay, and forcing a download would break the single most-used screen in
 * the product. That is safe because the type is pinned from the sanitised MIME
 * rather than sniffed, and because the object is served from the bucket origin,
 * not the app's.
 *
 * ⚠ Non-ASCII is passed through as-is. RFC 6266 wants `filename*=UTF-8''…` for
 * anything outside ISO-8859-1, so `facture-café.pdf` may render mojibake in the
 * download name. It is a cosmetic bug, not a safety one, and the fix is a
 * second `filename*` parameter — see `storage/CLAUDE.md`.
 */
export function contentDisposition(filename: string): string {
  // The control characters in this class are deliberate, not a paste accident —
  // stripping them is the entire point of the function.
  const safe = filename.replace(/[\x00-\x1f\x7f-\x9f"\\]/g, '').trim();
  return safe === '' ? 'inline' : `inline; filename="${safe}"`;
}

/**
 * The key a web-upload intent is presigned to (#76). Content addressing can't
 * apply yet — the sha256 is not known until the bytes land — so an intent uses a
 * random nonce under the business's `w/` prefix. It still starts `w/` (the IAM
 * constraint) and still names the business (so "erase practice X" has an answer).
 */
export function uploadIntentKey(businessId: string, nonce: string): string {
  return `w/${businessId}/uploads/${nonce}`;
}

/**
 * The reserved pseudo-workspace for Unrouted documents. Unrouted mail has no
 * workspace yet, but the object must still live SOMEWHERE under `w/` (see
 * `documentKey`). `_unrouted` sits under that prefix so the IAM policy grants it,
 * and its leading underscore cannot collide with a real workspace id (business
 * ids are cuid/uuid — never `_`-prefixed). When routing later assigns a
 * workspace, the object is re-keyed under it; nothing here deletes.
 */
export const UNROUTED_WORKSPACE = '_unrouted';

/**
 * The object key for a sanitised document. **Every key starts `w/` — this is a
 * hard constraint, not a style choice.** The staging IAM policy grants the task
 * role `<bucket>/w/*` (and `receipts/inbound/*`) and nothing else, so a key that
 * ignores the prefix passes every unit test and then `AccessDenied`s in staging
 * — the reason lives in `infra/envs/staging/policies`, which the next person
 * will not think to read, which is why it is written here.
 *
 * Content-addressed on the sha256: an identical file stored twice is one object,
 * and the key is therefore stable for identical content (what lets an SES
 * redelivery collapse rather than duplicate).
 */
export function documentKey(input: {
  workspaceId: string | null;
  practiceId: string | null;
  sha256: string;
}): string {
  if (input.workspaceId !== null) return `w/${input.workspaceId}/documents/${input.sha256}`;

  // UNROUTED OBJECTS ARE PARTITIONED BY PRACTICE, and it has to be this way.
  //
  // `w/_unrouted/<sha256>` would be one prefix shared by every practice on the
  // platform, and combined with content addressing that is not merely untidy:
  // two practices receiving the SAME file — a common supplier's invoice
  // template, a standard bank statement PDF — resolve to one object. Then
  // "erase everything belonging to practice X" (UK GDPR, D12) has no answer,
  // because the key does not say whose it is and deleting it destroys the other
  // practice's document. Inbound mail from an unrecognised sender is the common
  // case, not the edge case, so that is most of the estate.
  //
  // It also defeats ADR 0008's per-prefix narrowing exactly where it matters
  // most, and a HeadObject on a guessed sha256 would answer "does anyone on this
  // platform hold this file".
  if (input.practiceId !== null) {
    return `w/${UNROUTED_WORKSPACE}/${input.practiceId}/documents/${input.sha256}`;
  }

  // Deliberately mirrors the `documents_tenant_anchor` CHECK constraint: a
  // document belongs to a business or to a practice, and a document belonging to
  // neither is one nobody can ever reach. Refused in both places rather than
  // trusted in either.
  throw new Error(
    'a document key needs a workspace or a practice — an object owned by neither is unreachable and unerasable',
  );
}

/**
 * Offline fixture — an in-memory map keyed exactly as S3 would be. Non-negotiable
 * so `pnpm test` never needs Docker (issue #16).
 */
export class InMemoryDocumentStore implements DocumentStore {
  private readonly objects = new Map<string, Buffer>();

  async put(input: DocumentStorePutInput): Promise<StoredDocument> {
    const key = documentKey(input);
    this.objects.set(key, input.bytes); // content-addressed → idempotent overwrite
    return { key, sha256: input.sha256, byteLength: input.bytes.length };
  }

  async get(key: string): Promise<Buffer> {
    const bytes = this.objects.get(key);
    if (bytes === undefined) throw new Error(`no object stored at key ${key}`);
    return bytes;
  }

  async sha256(key: string): Promise<string> {
    const bytes = this.objects.get(key);
    if (bytes === undefined) throw new Error(`no object stored at key ${key}`);
    return createHash('sha256').update(bytes).digest('hex');
  }

  async presignPut(input: PresignPutInput): Promise<PresignedPut> {
    // Offline stand-in: a fake URL the client never actually reaches (unit tests
    // simulate the landed object with `putRaw`). Keeps the whole flow runnable
    // with `OBJECT_STORE=fixture` and no MinIO.
    return {
      key: input.key,
      url: `https://fixture.local/${input.key}`,
      headers: { 'Content-Type': input.contentType },
    };
  }

  async presignGet(input: PresignGetInput): Promise<PresignedGet> {
    // Offline stand-in, same as `presignPut`: a URL nothing fetches. It still
    // refuses a missing object, because "the row exists but the bytes do not" is
    // a real state (a document persisted before its PUT landed) and a fixture
    // that happily signs a URL for nothing would hide it until staging.
    if (!this.objects.has(input.key)) throw new Error(`no object stored at key ${input.key}`);
    return {
      url: `https://fixture.local/${input.key}?download`,
      expiresAt: new Date(Date.now() + input.expiresInSeconds * 1000),
    };
  }

  async head(key: string): Promise<{ readonly byteLength: number } | null> {
    const bytes = this.objects.get(key);
    return bytes === undefined ? null : { byteLength: bytes.length };
  }

  /** Test-only: stand in for the direct PUT the presigned URL would have received. */
  putRaw(key: string, bytes: Buffer): void {
    this.objects.set(key, bytes);
  }
}
