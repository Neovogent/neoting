/**
 * Which deployed environment may be re-seeded — the pure half of `seed.ts`.
 *
 * Separated from the entrypoint for the same reason `migrate-url.ts` is: that
 * module spawns a process and calls `process.exit` at import time, so a test
 * importing it would truncate a database.
 */

/**
 * The environments whose data is synthetic by construction (Governance G2,
 * `infra/envs/*` `local.env`). An ALLOW-LIST, not a `!== 'prod'` deny: a typo,
 * a renamed environment or an unset variable must all refuse, because the
 * failure mode this guards against is `TRUNCATE ... CASCADE` against real
 * clients' books.
 */
export const SEEDABLE_ENVIRONMENTS = ['local', 'dev', 'staging'] as const;

/**
 * ⚠ THIS IS THE CHECK `prisma/seed.ts` IS REACHING FOR, DONE PROPERLY.
 *
 * The seed dataset refuses to run under `NODE_ENV=production` — and that guard
 * is right about the danger and wrong about the signal. In this repo
 * `NODE_ENV=production` means "the production BUILD", and staging runs it
 * deliberately for parity; `infra/envs/staging/services.tf` says so where it
 * sets the variable, and adds that "the environment's identity travels
 * separately, so nothing keys behaviour off NODE_ENV and accidentally behaves
 * differently in prod". `NEOTING_ENV` is that identity.
 *
 * So `seed.ts`'s guard is a proxy that reads staging as production. Rather than
 * edit it — `prisma/` is LAW (repo CLAUDE.md) and the guard is load-bearing for
 * every path that is not this one — the wrapper asserts the real property first
 * and only then relaxes the proxy for the child process. If this function ever
 * stops being called before that relaxation, the seed can reach production.
 *
 * @throws if `NEOTING_ENV` is absent or names an environment not in the list.
 */
export function assertSeedableEnvironment(env: NodeJS.ProcessEnv): string {
  const name = env.NEOTING_ENV ?? '';
  if (!(SEEDABLE_ENVIRONMENTS as readonly string[]).includes(name)) {
    throw new Error(
      `Refusing to seed: NEOTING_ENV=${name === '' ? '(unset)' : name} is not one of ` +
        `${SEEDABLE_ENVIRONMENTS.join(', ')}. The seed TRUNCATEs every table before it writes.`,
    );
  }
  return name;
}
