import { useEffect, useMemo } from 'react';
import { createSession, deleteCurrentSession, useGetMe } from '@neoting/contracts/client';
import { getMeResponse } from '@neoting/contracts/zod';
import type { Me, SessionCreateRequest } from '@neoting/contracts/model';
import { NtProblemError } from '@neoting/contracts';
import { unwrapBody } from './envelope';
import { errorLabel } from './slices';
import { setSignedInHint } from '../lib/signed-in-hint';

/**
 * The workspace session, read from `GET /me` (METH Stage 6).
 *
 * One query answers "who is signed in" for the whole app: the login wall in
 * `App.tsx`, the §13.3 context header, and the per-slice hydration gates in
 * `AppContext` all read the same state, so they cannot disagree about whether
 * a person exists.
 *
 * The five states are deliberate, and 'degraded' is the load-bearing one:
 *
 *   'off'             — the app runs synthetic (`VITE_API_ENABLED=false`, or a
 *                       client-facing shell). No login wall, no identity.
 *   'loading'         — /me is in flight. The shell shows a skeleton, never a
 *                       flash of the login screen at somebody who has a session.
 *   'unauthenticated' — the server said 401. The one state that shows LoginView.
 *   'degraded'        — the API is enabled but unreachable, answered with
 *                       something other than 401, or broke the contract. A
 *                       login screen against a dead API is a wall nobody can
 *                       pass, so the app renders the workspace shell instead —
 *                       EMPTY, never on fixtures impersonating real records
 *                       (launch M2) — and the context header wears the
 *                       failure badge, visible in every build.
 *   'authenticated'   — /me parsed. `me` carries user, practice, role, scope.
 */
export type SessionState =
  | { status: 'off' }
  | { status: 'loading' }
  | { status: 'unauthenticated' }
  | { status: 'degraded'; error: string }
  | { status: 'authenticated'; me: Me };

/**
 * Pure mapping from the query's observable state, kept separate from the hook
 * so the 401 / transport / contract-drift branches are testable offline.
 */
export function toSessionState(input: { enabled: boolean; error: unknown; data: unknown }): SessionState {
  if (!input.enabled) return { status: 'off' };

  if (input.error) {
    // 401 is an answer — "nobody is signed in" — not a fault. Anything else
    // (a 5xx, an unreachable host, a misconfigured AUTH_MODE) is the API
    // failing to answer the question, which is what 'degraded' means.
    if (input.error instanceof NtProblemError && input.error.status === 401) {
      return { status: 'unauthenticated' };
    }
    return {
      status: 'degraded',
      error: errorLabel(input.error) ?? 'The request failed',
    };
  }

  // No data and no error: in flight, or not yet fired. Both render the same
  // skeleton — the one thing this must never do is flash the login screen at
  // somebody whose answer simply has not arrived.
  if (input.data === undefined) return { status: 'loading' };

  const parsed = getMeResponse.safeParse(unwrapBody(input.data));
  if (!parsed.success) {
    return {
      status: 'degraded',
      error: parsed.error.issues
        .slice(0, 3)
        .map((i) => `${i.path.join('.') || 'response'}: ${i.message}`)
        .join('; '),
    };
  }

  return { status: 'authenticated', me: parsed.data as Me };
}

export function useSession({ enabled }: { enabled: boolean }) {
  const query = useGetMe({ query: { enabled } });

  const session = useMemo(
    () => toSessionState({ enabled, error: query.error, data: query.data }),
    [enabled, query.error, query.data],
  );

  /**
   * Leave (or clear) the local note that this browser has signed in, so the
   * public landing page at `/` can send a signed-in accountant to `/app`
   * without probing `/me` for every anonymous visitor. See
   * `lib/signed-in-hint.ts` — it holds no identity and grants nothing.
   *
   * Only the two DECIDED states write. 'loading' and 'degraded' must not: a
   * slow or unreachable API is not evidence either way, and clearing on
   * 'degraded' would log a signed-in user out of the landing page every time
   * the network hiccuped.
   */
  useEffect(() => {
    if (session.status === 'authenticated') setSignedInHint(true);
    else if (session.status === 'unauthenticated') setSignedInHint(false);
  }, [session.status]);

  return { session, refetch: query.refetch };
}

/**
 * Log in. A 204 sets the httpOnly `nt_session` cookie — the response body is
 * empty on purpose, so "who am I now" is answered by refetching /me, not by
 * anything returned here. Every credential failure is the same `NT-AUTH-003`
 * (an enumeration oracle otherwise); the caller renders it with its code.
 */
export async function login(request: SessionCreateRequest): Promise<void> {
  await createSession(request);
}

/**
 * Log out. Tolerant of failure by design: if the API is unreachable the cookie
 * cannot be cleared server-side, but the caller invalidates the session query
 * either way and the next /me answer decides what is true.
 */
export async function logout(): Promise<void> {
  try {
    await deleteCurrentSession();
  } catch {
    // The goal — not being signed in — is decided by the /me refetch.
  }
}

/**
 * **Does this session hold D44's release authority?** — review item 24.
 *
 * `canRelease(role) && isOwner`, which is `mayRelease` in
 * `apps/api/src/modules/approvals/assert-can.ts`, verbatim. One expression, one
 * place, read by every surface that has something to say about who releases —
 * so the publish dialog, the statement request, the offboard panel and the
 * staging flow cannot drift into four different claims about the same person.
 *
 * ## Why this can exist now, and could not before
 *
 * The dialogs' standing rule was that they *"can never claim the permission IS
 * held"*, because `/me` carried the role and not `memberships.is_owner` — so
 * the honest thing was to name who releases and stop. That produced item 24:
 *
 * > *I'm the super admin and it is giving me lecture*
 *
 * `Me.isOwner` is required in the contract now (package F), answered from the
 * same acting membership `role` comes from, so the two can never describe
 * different people. The dialogs may branch.
 *
 * ⚠ **It is a fact for DISPLAY and never a gate.** Governance §11.2: *"a UI
 * that merely hides the button is not an implementation of this."* The server
 * refuses with `NT-PRM-001` regardless, and a `/me` thirty seconds stale is
 * exactly how that refusal arrives — every surface reading this must still
 * handle the refusal when it comes.
 *
 * ⚠ **Not authenticated answers FALSE**, unlike `actsForWholePractice`, and the
 * asymmetry is deliberate. That one answers "is this surface any of your
 * business", where a synthetic session must keep seeing everything
 * (METH_MODE §1). This one answers "may you release", where the safe reading of
 * an unknown session is the one that promises nothing.
 */
export function holdsReleaseAuthority(session: SessionState): boolean {
  return session.status === 'authenticated' && session.me.role === 'PRACTICE_ADMIN' && session.me.isOwner;
}

/**
 * **Does this session act for the whole practice?** — review item 39, the
 * `docs/Access_and_Approval_Matrix.md` predicate every practice-wide surface
 * gates on.
 *
 * ⚠ **`practice === null` is a SCOPE fact, not a role fact, and that is the
 * whole point of this function existing rather than a `role ===` test at each
 * call site.** A `PRACTICE_STANDARD` invited WITH a client list holds one
 * membership per assigned client carrying `practice_id` NULL — deliberately,
 * because that null is what makes RLS confine them
 * (`auth-tenancy/invitation-acceptance.service.ts`). `loadScopeForUser` then
 * produces a context with no `practiceId`, `GET /me` answers `practice: null`,
 * and every server predicate of the form `ctx.practiceId === undefined`
 * refuses them. So this returns EXACTLY what the server will decide, off the
 * one fact the server decides it from.
 *
 * Their role still reads `PRACTICE_STANDARD`, which is why the naive
 * `role === 'PRACTICE_STANDARD'` gate would be wrong in both directions: it
 * would hide the surface from a practice-wide standard user who may use it,
 * and show it to the scoped colleague who may not.
 *
 * ⚠ **It is presentation, never the gate** (Governance §11.2 — *"a UI that
 * merely hides the button is not an implementation of this"*). The server
 * refuses regardless, and its refusal names the scope.
 *
 * **Every non-authenticated state answers `true`**, and that is what keeps
 * synthetic mode byte-for-byte unchanged (METH_MODE §1): the seeded cast is a
 * practice-wide firm with no `/me` behind it, and a screen that hid its own
 * Team tab in the demo would be answering a question nobody asked.
 */
export function actsForWholePractice(session: SessionState): boolean {
  return session.status !== 'authenticated' || session.me.practice !== null;
}
