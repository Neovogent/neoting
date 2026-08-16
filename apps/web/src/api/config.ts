/**
 * Whether the app is talking to an API at all.
 *
 * Off by default, so the seeded demo is exactly what it was. Turned on with
 * `VITE_API_ENABLED=true`, at which point the documents surface reads from
 * `GET /documents` — mocked by MSW when `VITE_API_MOCKING=enabled`, or the
 * real backend when `VITE_API_BASE_URL` points at one.
 *
 * A flag rather than a build split because the migration is surface by
 * surface: for a while some screens are live and the rest are not, and both
 * have to work in the same running app.
 */
/**
 * Read once, defensively.
 *
 * `import.meta.env` only exists under Vite. Reading it directly means this
 * module cannot be imported by anything else — a Node test, a script, or a
 * server render — and it fails at import time with a message about `undefined`
 * rather than about configuration.
 */
const env: Record<string, string | undefined> =
  (typeof import.meta !== 'undefined' && (import.meta as unknown as { env?: Record<string, string> }).env) || {};

export const API_ENABLED = env.VITE_API_ENABLED === 'true';
export const API_MOCKED = env.VITE_API_MOCKING === 'enabled';
export const API_BASE_URL: string = (env.VITE_API_BASE_URL ?? '').replace(/\/$/, '');

/** For the corner of a screen that says where the data came from. */
export const dataSourceLabel = (): 'live API' | 'mocked API' | 'seed data' =>
  !API_ENABLED ? 'seed data' : API_MOCKED ? 'mocked API' : 'live API';

/**
 * BOOTSTRAP: https://github.com/Neovogent/neoting/issues/59 — remove with that issue.
 *
 * Whether the chat box may call `POST /api/chat`, the Gemini-backed classifier
 * that lives in the pre-monorepo frontend's `server.ts`.
 *
 * **Off unless explicitly turned on, and that default is the point.** D22 and
 * D28 fix model access to Amazon Bedrock in eu-west-2, and D30 is UK-first
 * residency — Gemini is outside both. Issue #59 records the exception as
 * deliberate and temporary, and rests it entirely on one condition: *removed
 * before the frontend is deployed anywhere that is not a developer's laptop.*
 *
 * Nothing was enforcing that condition. The call was unconditional, so the day
 * a web deploy lands — and one is on the infrastructure backlog — the exception
 * ships with it, silently, because nobody has to decide anything for that to
 * happen. Now shipping it is an act: someone has to set the variable.
 *
 * `server.ts` did not come across in the frontend import (PR #68), so in this
 * repository the route does not exist and the call has been failing on every
 * message since. It is caught, and the deterministic classifier in
 * `lib/resolver.ts` already produced the answer — the model only ever
 * overrode it — so switching the default to off changes no behaviour a user
 * can observe. It removes a wasted round-trip and a console error per message.
 */
export const CHAT_PROXY_ENABLED = env.VITE_CHAT_PROXY === 'enabled';
