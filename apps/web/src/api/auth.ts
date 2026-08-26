import { useMemo } from 'react';
import { createSession, deleteCurrentSession, useGetMe } from '@neoting/contracts/client';
import { getMeResponse } from '@neoting/contracts/zod';
import type { Me, SessionCreateRequest } from '@neoting/contracts/model';
import { NtProblemError } from '@neoting/contracts';
import { unwrapBody } from './envelope';
import { errorLabel } from './slices';

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
