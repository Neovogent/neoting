import { afterEach, expect, test, vi } from 'vitest';
import { NtProblemError } from '@neoting/contracts';

import { login, logout, toSessionState } from './auth';

/**
 * The session boundary.
 *
 * Offline by construction (Governance §15.1): the state mapping is a pure
 * function, and the two wire calls run against a recorder in place of
 * `globalThis.fetch`. What earns a pin here:
 *
 *   · 401 and "the API is down" are DIFFERENT states. The first shows the
 *     login screen; the second must not — a login wall against a dead API is
 *     a wall nobody can pass, so it degrades to synthetic data instead
 *     (METH_MODE §8). Collapsing them would turn every transient outage into
 *     a lock-out.
 *   · a /me body that drifts from the contract is 'degraded', never
 *     'authenticated' with garbage in the header.
 *   · logout never throws — the caller's goal is decided by the /me refetch,
 *     not by whether the clear reached the server.
 */

const ME = {
  user: { id: 'usr_shakib_demo', email: 'shakib@neoting.test', firstName: 'Shakib', lastName: 'Bin Kabir' },
  practice: { id: 'prc_neovogent', name: 'Neovogent Accounting' },
  role: 'PRACTICE_ADMIN',
  // Required since `Me` gained it: D44's release gate is role AND ownership,
  // and a body without it is contract drift, which must NOT authenticate.
  isOwner: true,
  businesses: [{ id: 'biz_burger', name: 'American Burger Ltd' }],
};

/* ── the state mapping ────────────────────────────────────────────────────── */

test('disabled is off — synthetic mode never sees a login wall', () => {
  expect(toSessionState({ enabled: false, error: null, data: undefined })).toEqual({ status: 'off' });
  // Even a lingering error from a previous enablement does not resurrect it.
  expect(toSessionState({ enabled: false, error: new Error('stale'), data: undefined })).toEqual({ status: 'off' });
});

test('no answer yet is loading, never a flash of the login screen', () => {
  expect(toSessionState({ enabled: true, error: null, data: undefined })).toEqual({ status: 'loading' });
});

test('a 401 is unauthenticated — the one state that shows LoginView', () => {
  const denied = new NtProblemError({ status: 401, code: 'NT-AUTH-001', title: 'Unauthenticated' });
  expect(toSessionState({ enabled: true, error: denied, data: undefined })).toEqual({ status: 'unauthenticated' });
});

test('a server fault or an unreachable API degrades — it does not lock the door', () => {
  const broken = new NtProblemError({ status: 500, code: 'NT-SYS-001', title: 'Internal error' });
  expect(toSessionState({ enabled: true, error: broken, data: undefined })).toMatchObject({ status: 'degraded' });

  const offline = toSessionState({ enabled: true, error: new Error('Failed to fetch'), data: undefined });
  expect(offline).toMatchObject({ status: 'degraded', error: 'Failed to fetch' });
});

test('a contracted /me body authenticates, raw or wrapped in the typed envelope', () => {
  const raw = toSessionState({ enabled: true, error: null, data: ME });
  expect(raw.status).toBe('authenticated');
  if (raw.status === 'authenticated') {
    expect(raw.me.user.email).toBe('shakib@neoting.test');
    expect(raw.me.role).toBe('PRACTICE_ADMIN');
    expect(raw.me.businesses).toHaveLength(1);
  }

  // The generated types promise `{ status, data }`; the mutator returns the
  // body. The mapping must be right in either world (see api/envelope.ts).
  const wrapped = toSessionState({ enabled: true, error: null, data: { status: 200, data: ME } });
  expect(wrapped.status).toBe('authenticated');
});

test('a /me body that drifts from the contract degrades, naming the field', () => {
  const { role: _dropped, ...meWithoutRole } = ME;
  const state = toSessionState({ enabled: true, error: null, data: meWithoutRole });
  expect(state.status).toBe('degraded');
  if (state.status === 'degraded') expect(state.error).toContain('role');
});

test('a business-only login (null practice) still authenticates', () => {
  const state = toSessionState({ enabled: true, error: null, data: { ...ME, practice: null } });
  expect(state.status).toBe('authenticated');
});

/* ── the wire ─────────────────────────────────────────────────────────────── */

interface Recorded {
  url: string;
  init: RequestInit;
}

function stubFetch(reply: { status: number; body?: unknown }): Recorded[] {
  const calls: Recorded[] = [];
  vi.stubGlobal('fetch', (url: string | URL, init: RequestInit = {}) => {
    calls.push({ url: String(url), init });
    return Promise.resolve(
      reply.body === undefined
        ? new Response(null, { status: reply.status })
        : new Response(JSON.stringify(reply.body), {
            status: reply.status,
            headers: { 'content-type': 'application/json' },
          }),
    );
  });
  return calls;
}

afterEach(() => vi.unstubAllGlobals());

test('login posts the three credentials to /auth/sessions and sends the cookie jar', async () => {
  const calls = stubFetch({ status: 204 });

  await login({ email: 'shakib@neoting.test', password: 'demo-neoting-2026', totp: '000000' });

  expect(calls).toHaveLength(1);
  expect(calls[0]!.url).toContain('/v1/auth/sessions');
  expect(calls[0]!.init.method).toBe('POST');
  // The session is the httpOnly cookie the 204 sets — the request must carry
  // credentials or the browser will not keep it.
  expect(calls[0]!.init.credentials).toBe('include');
  expect(JSON.parse(String(calls[0]!.init.body))).toEqual({
    email: 'shakib@neoting.test',
    password: 'demo-neoting-2026',
    totp: '000000',
  });
});

test('a refused login surfaces the problem, code intact', async () => {
  // Not stubFetch: ntFetch only maps a problem when the content-type says
  // `application/problem+json`, so the reply here has to carry it.
  vi.stubGlobal('fetch', () =>
    Promise.resolve(
      new Response(JSON.stringify({ status: 401, code: 'NT-AUTH-003', title: 'Invalid credentials' }), {
        status: 401,
        headers: { 'content-type': 'application/problem+json' },
      }),
    ),
  );

  await expect(login({ email: 'x@y.test', password: 'wrong', totp: '111111' })).rejects.toMatchObject({
    code: 'NT-AUTH-003',
    status: 401,
  });
});

test('logout resolves even when the API is unreachable', async () => {
  vi.stubGlobal('fetch', () => Promise.reject(new Error('Failed to fetch')));
  await expect(logout()).resolves.toBeUndefined();
});
