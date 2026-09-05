import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * The stateless `uploadId` (issue #76).
 *
 * There is no `DocumentUpload` table — `prisma/` is LAW, and the contract's
 * response carries no server-state fields, so the intended design is a signed
 * token that IS the state. Everything completion needs travels inside it, HMAC
 * signed with `UPLOAD_URL_SECRET`, so a forged or tampered `uploadId` fails
 * verification rather than resolving to a row an attacker could not have created.
 * `expiresAt` and `NT-ING-005` are claims on the token, not lookups.
 */
export interface UploadClaims {
  readonly businessId: string;
  /** The practice the actor is in (null for a standalone-business actor), captured at intent time. */
  readonly practiceId: string | null;
  readonly channel: string; // contract DocumentChannel
  readonly filename: string;
  /** Declared — a hint. Magic-byte sniffing decides the real type after the bytes land. */
  readonly mimeType: string;
  readonly byteSize: number;
  readonly splitMode: string; // contract SplitMode
  readonly description?: string;
  readonly documentOwnerContactId?: string | null;
  /**
   * The chased bank transaction the client said this upload answers — the
   * portal's `PortalUploadRequest.transactionId` (METH Stage 9). Optional and
   * absent on every other lane.
   *
   * **Client-declared and deliberately unverified.** The contract calls it a
   * hint ("null lets extraction decide — the pipeline compares the extraction
   * against every open item regardless"), and nothing downstream branches on it:
   * auto-close compares the extracted supplier + amount + date against every
   * open chase, so a client who taps the wrong item still gets the right
   * outcome. It travels in the claims because completion is a separate request
   * with no body field for it, and it is recorded on the document's event trail
   * as what the client SAID rather than as a fact. Dropping it silently would
   * be the one thing this lane's invariant forbids.
   */
  readonly chaseTransactionId?: string | null;
  /**
   * The raw note the client typed on a portal upload (5 Sep 2026, review item
   * 11) — `PortalUploadRequest.note`, carried so completion can record on the
   * provenance event what the client SAID. The display consequence (the note
   * becoming the document's filename) is already applied to `filename` at
   * intent time; this is the unedited original, untrusted content, data never
   * instructions. Optional and absent on every other lane.
   */
  readonly portalNote?: string | null;
  /**
   * The provenance words `documents.submitter_label` will carry (review items
   * 21/43/62) — composed at INTENT time by the portal service from facts the
   * server holds (the session's kind, its contact, the business row), never
   * from client words, and signed here so completion copies rather than
   * re-derives. Absent on a workspace intent (completion attributes those to
   * the session actor) and on any token minted before this field existed —
   * completion falls back to the legacy `uploaded-by-delegated-session`.
   */
  readonly submitterLabel?: string;
  /** The object-storage key the bytes were presigned to. */
  readonly s3Key: string;
  /** Epoch millis after which completion is refused with NT-ING-005. */
  readonly expiresAtMs: number;
}

export type VerifyResult =
  | { readonly ok: true; readonly claims: UploadClaims }
  | { readonly ok: false; readonly reason: 'malformed' | 'bad_signature' };

/** `base64url(claims) . base64url(hmacSha256(secret, payload))` — compact and URL-safe. */
export function signUploadToken(claims: UploadClaims, secret: string): string {
  requireSecret(secret);
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
  return `${payload}.${sign(payload, secret)}`;
}

export function verifyUploadToken(token: string, secret: string): VerifyResult {
  requireSecret(secret);
  const dot = token.indexOf('.');
  if (dot <= 0 || dot === token.length - 1) return { ok: false, reason: 'malformed' };
  const payload = token.slice(0, dot);
  const signature = token.slice(dot + 1);

  // Signature first: never parse attacker bytes we have not authenticated.
  if (!constantTimeEqual(signature, sign(payload, secret))) return { ok: false, reason: 'bad_signature' };
  try {
    return { ok: true, claims: JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as UploadClaims };
  } catch {
    return { ok: false, reason: 'malformed' };
  }
}

function sign(payload: string, secret: string): string {
  return createHmac('sha256', secret).update(payload).digest('base64url');
}

function requireSecret(secret: string): void {
  // Fail closed — an empty secret must never silently mint or accept a forgeable
  // token (same stance as the Meta webhook secrets in env.ts).
  if (secret === '') throw new Error('UPLOAD_URL_SECRET is empty — refusing to sign or verify an upload intent with no secret');
}

function constantTimeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}
