/**
 * A local, non-secret note that this browser has signed in before.
 *
 * ## Why this exists
 *
 * `/` is the public landing page and deliberately fires NO session probe — the
 * `portal === 'landing'` branch in `AppContext` keeps `workspaceApiOn` false so
 * a visitor reading the pricing never causes a call to `/me`. That property is
 * worth keeping, and it had one bad consequence: an accountant who is signed in
 * and arrives at the bare domain — a bookmark, a reopened tab, the browser
 * restoring a session — got "Create your account" instead of their workspace.
 *
 * ## Why not read the session cookie
 *
 * `nt_session` is HttpOnly, which is the point of it. JavaScript cannot see it
 * and must not be able to. So the redirect cannot be driven by the real
 * credential, only by a hint the app itself left behind.
 *
 * ## What this is, and what it is emphatically not
 *
 * It is one boolean in `localStorage`. It carries no identity, no practice, no
 * token, and nothing derived from any of them — read it and you learn only that
 * *somebody* signed in on this browser once, which is a thing they already know.
 * It is **not** authentication and grants nothing: the redirect it triggers
 * lands on `/app`, which runs the ordinary session probe and shows the login
 * wall if the cookie is gone or expired.
 *
 * The failure modes are therefore both benign and worth stating:
 *
 * - **Stale hint** (cookie expired, or cleared server-side) — the user is sent
 *   to `/app` and meets the login wall, which is where they were going anyway.
 * - **Missing hint** (private window, cleared site data, a different browser) —
 *   the user gets the landing page and clicks Sign in, which is today's
 *   behaviour and no worse than it.
 *
 * Neither can expose anything, because there is nothing in here to expose.
 *
 * ## Every access is guarded
 *
 * `localStorage` throws rather than returning null in several real
 * environments — Safari's private mode historically, a browser set to block
 * site data, and any embedded/thumbnail context. A throw here would take down
 * the landing page for a visitor, so both functions swallow it and the reader
 * answers `false`. Failing closed means the worst case is the behaviour we
 * already had.
 */

const KEY = 'nt.signed-in';

/** True only if this browser has completed a workspace sign-in before. */
export function hasSignedInBefore(): boolean {
  try {
    return window.localStorage.getItem(KEY) === '1';
  } catch {
    // Storage unavailable or blocked. Fail closed: no redirect, landing page.
    return false;
  }
}

/**
 * Record (or clear) the hint.
 *
 * Called on the session resolving to authenticated, and again with `false` on
 * logout — clearing it is what stops a deliberate sign-out from bouncing the
 * next visit straight back at the login wall, which would read as the sign-out
 * having failed.
 */
export function setSignedInHint(signedIn: boolean): void {
  try {
    if (signedIn) window.localStorage.setItem(KEY, '1');
    else window.localStorage.removeItem(KEY);
  } catch {
    // Nothing to do: the hint is an optimisation, never a requirement.
  }
}
