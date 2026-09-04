/**
 * Where the client portal's bearer survives a reload — extracted from
 * `useBusinessPortalSession.ts` (5 Sep 2026) so the SETUP JOURNEY can adopt
 * its session into the portal without importing the whole portal hook onto
 * the onboarding chunk.
 *
 * The rule is #243's, unchanged: an OWN-PORTAL bearer (a session opened by a
 * code sent to the registered address — the onboarding scope is exactly that)
 * may live in `sessionStorage`, which dies with the tab; the CHASE portal's
 * bearer stays memory-only, because that one is an anonymous delegated grant
 * from a forwardable link. Nothing here may ever touch `localStorage`.
 *
 * Why the setup journey writes here at all: `subscribe()` hands the whole tab
 * to Stripe, and `sessionStorage` survives that round trip where React state
 * cannot — so the return leg's "Sign in to your portal" link lands the client
 * INSIDE their portal instead of at a second sign-in for a session they
 * opened two minutes earlier (5 Sep 2026 review finding: "after the payment
 * it is required to be redirected to the user portal directly").
 */

const BEARER_KEY = 'nt-business-portal-bearer';

/**
 * ⚠ The session's `expiresAt` is stored BESIDE the bearer, and it has to be.
 * `useBusinessPortalSession` watches the bearer's own clock so the client is
 * told the session ended rather than discovering it through an upload that
 * fails; restoring a bearer without its clock would leave that watch inert.
 * It is a timestamp, not a credential, and it dies with the tab like the
 * bearer does.
 */
const EXPIRES_KEY = 'nt-business-portal-expires';

export function storedBearer(): string | null {
  try {
    return window.sessionStorage.getItem(BEARER_KEY);
  } catch {
    return null;
  }
}

export function storedExpiry(): string | null {
  try {
    return window.sessionStorage.getItem(EXPIRES_KEY);
  } catch {
    return null;
  }
}

/**
 * The try/catch is for browsers where storage access throws (private modes,
 * storage-partitioned iframes); there the portal degrades to the old
 * behaviour, memory-only.
 */
export function storeSession(token: string | null, expiresAt: string | null): void {
  try {
    if (token === null) window.sessionStorage.removeItem(BEARER_KEY);
    else window.sessionStorage.setItem(BEARER_KEY, token);
    if (expiresAt === null) window.sessionStorage.removeItem(EXPIRES_KEY);
    else window.sessionStorage.setItem(EXPIRES_KEY, expiresAt);
  } catch {
    /* memory-only fallback */
  }
}
