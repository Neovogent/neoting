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
