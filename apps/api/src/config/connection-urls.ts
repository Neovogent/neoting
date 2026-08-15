/**
 * Connection-string composition from injected parts.
 *
 * WHY THIS FILE EXISTS AT ALL, because it looks like string concatenation that
 * belongs inline somewhere:
 *
 * ECS injects secrets as whole environment variables and CANNOT interpolate one
 * into another. The task definitions hand us `DATABASE_HOST` / `PORT` / `NAME`
 * plus a `DB_MIGRATOR_PASSWORD` secret, and `REDIS_HOST` / `PORT` / `TLS` plus a
 * `REDIS_AUTH_TOKEN` secret — while Prisma reads `DATABASE_URL`/`DIRECT_URL` and
 * `config/env.ts` reads `REDIS_URL`. Nothing bridged the two, which is why the
 * deployed workers service sat at zero and the migration never ran (see
 * apps/api/CLAUDE.md). It cannot be fixed in Terraform; it has to be done here.
 *
 * These are pure functions with no I/O so the composition is unit-testable
 * without a database, a Redis, or AWS.
 */

export interface PostgresParts {
  host: string;
  port: string | number;
  database: string;
  user: string;
  password: string;
  /**
   * Defaults to `require`. ⚠ NOT OPTIONAL IN PRACTICE: the RDS parameter group
   * sets `rds.force_ssl = 1` (infra/modules/data/main.tf), so a URL without
   * this is refused by the server. The failure is a connection error at
   * migrate time, which reads like a networking or security-group problem and
   * is neither.
   */
  // `| undefined` explicitly, not just `?`: this package sets
  // exactOptionalPropertyTypes, under which an optional property does NOT
  // accept an explicit undefined — and every caller here reads straight out of
  // process.env, where undefined is the normal absent value.
  sslmode?: string | undefined;
}

export interface RedisParts {
  host: string;
  port: string | number;
  /**
   * ElastiCache has transit encryption on in every environment (data.tf). When
   * true the scheme is `rediss://`, which is what makes ioredis — and therefore
   * BullMQ — negotiate TLS. A plain `redis://` against a TLS-only cluster does
   * not error usefully; it hangs, then reconnect-loops.
   */
  tls: boolean;
  /** ElastiCache auth token. Sent as the PASSWORD with no username. */
  password?: string | undefined;
}

/**
 * ⚠ Both credentials are percent-encoded, and that is the whole reason this is
 * a function rather than a template literal at the call site.
 *
 * RDS generates the master password itself — 28 characters, "at least one upper
 * and lowercase character, one number, and one punctuation". That punctuation
 * set includes `/`, `#` and `?`, and an unencoded one of those does not
 * degrade gracefully: it ends the authority section, and the whole string stops
 * being a URL at all. Measured with Node's WHATWG parser — `/`, `#` and `?`
 * each throw `ERR_INVALID_URL`, while `@` and `:` happen to survive because the
 * userinfo is split at the LAST `@`. Do not rely on that second group; libpq
 * and Prisma are not obliged to agree with WHATWG, and encoding all of it costs
 * nothing.
 *
 * The failure mode is the reason this is guarded rather than left to chance:
 * it appears only when RDS happens to roll a password containing one of those
 * characters, which it will, on its seven-day rotation, on a day nobody is
 * expecting it — and the error names the URL, never the password.
 */
export function composePostgresUrl(parts: PostgresParts): string {
  const user = encodeURIComponent(parts.user);
  const password = encodeURIComponent(parts.password);
  const sslmode = parts.sslmode ?? 'require';

  return `postgresql://${user}:${password}@${parts.host}:${parts.port}/${parts.database}?sslmode=${sslmode}`;
}

export function composeRedisUrl(parts: RedisParts): string {
  const scheme = parts.tls ? 'rediss' : 'redis';

  // No username, password only — `redis://:token@host`. ElastiCache auth tokens
  // are a password in the AUTH sense; sending one as a username makes the
  // server reject the handshake with a message about the wrong number of
  // arguments.
  const credentials = parts.password ? `:${encodeURIComponent(parts.password)}@` : '';

  return `${scheme}://${credentials}${parts.host}:${parts.port}`;
}

/**
 * A connection URL with its password replaced, safe to log.
 *
 * Nothing in this codebase should ever print a composed URL — the migration
 * entrypoint logs the redacted form so an operator reading CloudWatch can see
 * WHICH database was targeted without the credential being in a log group with
 * 30-day retention. Returns the input unchanged if it does not parse, because a
 * redactor that throws while handling an error is worse than useless.
 */
export function redactUrl(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.password) parsed.password = '***';
    return parsed.toString();
  } catch {
    return '(unparseable url)';
  }
}
