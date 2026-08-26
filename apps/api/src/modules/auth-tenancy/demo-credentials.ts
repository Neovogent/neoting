import type { Env } from '../../config/env.js';
import { burnPasswordHash, verifyPasswordHash } from './password.js';

/**
 * The demo credential table (METH Stage 1, issue #118).
 *
 * // DEMO-MOCK: the real credential store is `users.password_hash`, written by
 * // practice signup (launch stage A1, `practice-signup.service.ts`) and read by
 * // `auth.service.ts`. This table is now the FALLBACK, not the system: it exists
 * // so a laptop with a seeded database keeps its two known logins. The passwords
 * // below are PUBLISHED demo fixtures (METH_MODE §7), not secrets in the diff.
 *
 * ⚠ **PRODUCTION REFUSES THIS TABLE**, the way `config/env.ts` refuses
 * `AUTH_MODE=fixture`. `verifyDemoPassword` takes `NODE_ENV` as a REQUIRED
 * argument and answers `null` under `production` before it looks at anything —
 * so the refusal is not a call-site convention a future caller can forget, it is
 * the function's signature. A published password minting a real session against
 * a real practice's books is the failure this closes.
 *
 * It is a request-time refusal rather than a boot gate because, unlike
 * `AUTH_MODE`, there is no configuration to refuse: the table is compiled in.
 * The gate therefore has to live where the table is read.
 *
 * ⚠ COORDINATION CONTRACT WITH THE SEED: the seed must create users with
 * EXACTLY these ids and emails, holding the §7 memberships (Shakib-demo →
 * Practice Admin, Abdullah-demo → Standard User) and `emailVerified: true`.
 * Since A1, a demo login is ALSO gated on the `users` row being present,
 * verified and active — see `auth.service.ts`. It always was in effect (a
 * session with no membership 401s on every later request); now it fails at the
 * login, where the cause is legible.
 */

export interface DemoCredential {
  readonly userId: string;
  /** `scrypt$<salt b64url>$<hash b64url>`, N/r/p at node defaults, 32-byte key. */
  readonly scryptHash: string;
}

/** Keyed by login email, lower-cased. Passwords are in METH_MODE §7. */
export const DEMO_CREDENTIALS: Readonly<Record<string, DemoCredential>> = Object.freeze({
  'shakib@neoting.test': {
    userId: 'usr_shakib_demo',
    scryptHash: 'scrypt$ZRYg8crAQo13A2H4nlyZrw$ceNFLZuBaOt9B3b2tm-9BD0vQD9SeS7p2WD3gvE25Ho',
  },
  'abdullah@neoting.test': {
    userId: 'usr_abdullah_demo',
    scryptHash: 'scrypt$k4TgCD8MvqCuz-7oTGrvoA$cs8dl8sLYaoaL8Glwe8gDfzzswpp6odHDDJQ7XUdhLk',
  },
});

/**
 * Verify an email + password against the fixture table. Returns the userId on
 * success, null on ANY failure — the caller maps every miss to the one
 * `NT-AUTH-003`.
 *
 * `nodeEnv` is required, not optional and not defaulted: an omitted argument
 * must not be able to mean "allow". Under `production` this returns null
 * without burning a scrypt, because in production there is nothing here to hide
 * — the table is not consulted at all, so there is no membership of it to leak
 * through timing.
 */
export function verifyDemoPassword(email: string, password: string, nodeEnv: Env['NODE_ENV']): string | null {
  if (nodeEnv === 'production') return null;

  const credential = DEMO_CREDENTIALS[email.toLowerCase()];
  if (credential === undefined) {
    // Burn the same scrypt an existing entry would cost, so a timing probe
    // cannot enumerate the (published, but still) table.
    burnPasswordHash(password);
    return null;
  }
  return verifyPasswordHash(password, credential.scryptHash) ? credential.userId : null;
}
