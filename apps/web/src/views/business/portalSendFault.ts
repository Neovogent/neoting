import { NtProblemError, NtTransportError } from '@neoting/contracts';

import { PortalStorageError } from '../../api/portal';

/**
 * Why one portal upload did not send.
 *
 * ## The reported failure this exists to close
 *
 * A client photographed two receipts, pressed **Send to accountant**, and read
 * *"2 photos did not send — they are still here, try again."* That one sentence
 * stood in front of four different problems with four different remedies:
 *
 * | What actually happened | What the client should do |
 * |---|---|
 * | the bytes never reached storage (CORS, offline, DNS) | nothing — it is not their photograph, and trying again may not help |
 * | the subscription has lapsed (`402 NT-BIL-001`) | pay, and the portal has a checkout button |
 * | the sixty-minute session expired (`401 NT-OTP-002`) | ask for a new code |
 * | the file itself was refused (`400`) | send a different file |
 *
 * "Try again" is the right advice for exactly one of those and actively wrong
 * for the other three. The reason was never missing — `send()` computed it and
 * the view threw it away.
 *
 * ## The reason is a machine value, and the sentence belongs to the view
 *
 * The same rule `portalUploadRules.ts` already states for refused files: a
 * reason built as English in here is a string this module cannot translate and
 * a test can only assert by matching prose. Callers get a discriminant and a
 * `MessageDescriptor` table, exactly as `faultMessageFor` does for the
 * onboarding journey.
 *
 * ## ⚠ Never invent a cause
 *
 * `storage-unreachable` carries **no code and no status, and there never will
 * be one**.
 * A cross-origin `fetch` failure is opaque by design — the browser withholds
 * the status precisely so a page cannot probe another origin — so the honest
 * sentence says the upload could not reach storage and stops. Guessing at CORS,
 * a dropped connection or a blocked network would be three different lies, and
 * one of them would send the client to their wifi settings for a bucket
 * misconfiguration on our side.
 */

/** `402` for a lapsed subscription (D48). */
export const LAPSED_CODE = 'NT-BIL-001';

/** The one code every portal call answers once the bearer is finished. */
export const SESSION_EXPIRED_CODE = 'NT-OTP-002';

export type PortalSendReason =
  /** `fetch` threw at the presigned PUT. No status exists, anywhere, ever. */
  | 'storage-unreachable'
  /** Storage answered and refused. It is not our API, so there is no `NT-` code. */
  | 'storage-refused'
  /** `fetch` threw on one of OUR two calls — the client's own connection. */
  | 'api-unreachable'
  /** `402 NT-BIL-001` — the subscription lapsed, and the portal can take payment. */
  | 'lapsed'
  /** `401 NT-OTP-002` — the sixty-minute bearer is finished. */
  | 'expired'
  /** `400` — the file itself: its type, its size, its shape. */
  | 'refused'
  /** Our API answered with something else. The code is what makes it reportable. */
  | 'server';

export interface PortalSendFault {
  readonly reason: PortalSendReason;
  /** The stable `NT-` code, for the client to quote. Null when nothing answered. */
  readonly code: string | null;
  /** The server's own words, when it sent any worth showing. */
  readonly detail: string | null;
}

/**
 * An unknown thrown value, named.
 *
 * Order matters: `PortalStorageError` is checked before `NtTransportError`
 * because it is one, and `NtProblemError` before either because a problem body
 * is the only thing carrying a code.
 */
export function sendFaultFor(error: unknown): PortalSendFault {
  if (error instanceof NtProblemError) {
    const detail = error.detail ?? null;
    if (error.code === SESSION_EXPIRED_CODE) return { reason: 'expired', code: error.code, detail };
    // The code is the authority and the status is the fallback: a 402 that
    // arrives under some other code is still a lapsed subscription, and the
    // client still needs the checkout button rather than "try again".
    if (error.code === LAPSED_CODE || error.status === 402) return { reason: 'lapsed', code: error.code, detail };
    if (error.status === 400) return { reason: 'refused', code: error.code, detail };
    return { reason: 'server', code: error.code, detail };
  }

  if (error instanceof PortalStorageError) {
    // A status means storage ANSWERED, over the very connection an
    // "unreachable" sentence would blame — the split `faultMessageFor` makes
    // for the onboarding journey, made here for the same reason.
    return {
      reason: error.status === undefined ? 'storage-unreachable' : 'storage-refused',
      code: null,
      detail: null,
    };
  }

  // Our own API, unreachable. Deliberately NOT the storage sentence: the two
  // failures point the client at different things, and the commonest cause of
  // this one really is their own connection, which is never the honest first
  // guess for the other.
  if (error instanceof NtTransportError) return { reason: 'api-unreachable', code: null, detail: null };

  return { reason: 'server', code: null, detail: null };
}
