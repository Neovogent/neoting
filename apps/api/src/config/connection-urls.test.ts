import { expect, test } from 'vitest';

import { composePostgresUrl, composeRedisUrl, redactUrl } from './connection-urls.js';

test('composes a postgres url and forces sslmode=require', () => {
  const url = composePostgresUrl({
    host: 'nt-staging.abc.eu-west-2.rds.amazonaws.com',
    port: 5432,
    database: 'neoting',
    user: 'nt_migrator',
    password: 'simple',
  });

  expect(url).toBe(
    'postgresql://nt_migrator:simple@nt-staging.abc.eu-west-2.rds.amazonaws.com:5432/neoting?sslmode=require',
  );
});

// The regression this whole module exists for. RDS generates the master
// password itself and guarantees punctuation in it; every character below is
// structural in a URL, and each one fails in a way that blames something else.
test('percent-encodes punctuation RDS can put in a generated password', () => {
  const url = composePostgresUrl({
    host: 'db.internal',
    port: '5432',
    database: 'neoting',
    user: 'nt_migrator',
    password: 'p@ss/w#rd?x:y',
  });

  // Parsing it back is the real assertion: the host must survive intact.
  const parsed = new URL(url);
  expect(parsed.hostname).toBe('db.internal');
  expect(parsed.port).toBe('5432');
  expect(parsed.pathname).toBe('/neoting');
  expect(decodeURIComponent(parsed.password)).toBe('p@ss/w#rd?x:y');
});

// Measured, not assumed: `/`, `#` and `?` each make the string stop being a URL
// at all. `@` and `:` survive WHATWG parsing because userinfo splits at the LAST
// `@` — encoded anyway, because libpq and Prisma are not obliged to agree.
test.each(['pa/ss', 'pa#ss', 'pa?ss'])('an unencoded %s would not parse as a URL at all', (password) => {
  expect(() => new URL(`postgresql://nt_migrator:${password}@db.internal:5432/neoting`)).toThrow();

  const encoded = composePostgresUrl({
    host: 'db.internal',
    port: 5432,
    database: 'neoting',
    user: 'nt_migrator',
    password,
  });

  const parsed = new URL(encoded);
  expect(parsed.hostname).toBe('db.internal');
  expect(decodeURIComponent(parsed.password)).toBe(password);
});

test('redis url uses rediss:// when TLS is on, and sends the token as a password', () => {
  const url = composeRedisUrl({ host: 'redis.internal', port: 6379, tls: true, password: 'token' });

  expect(url).toBe('rediss://:token@redis.internal:6379');

  const parsed = new URL(url);
  expect(parsed.protocol).toBe('rediss:');
  expect(parsed.username).toBe('');
  expect(parsed.password).toBe('token');
});

test('redis url falls back to redis:// without TLS and omits credentials when there is no token', () => {
  expect(composeRedisUrl({ host: 'localhost', port: 6379, tls: false })).toBe('redis://localhost:6379');
});

test('redis auth tokens are encoded too', () => {
  const url = composeRedisUrl({ host: 'redis.internal', port: 6379, tls: true, password: 'a/b@c' });
  expect(new URL(url).hostname).toBe('redis.internal');
  expect(decodeURIComponent(new URL(url).password)).toBe('a/b@c');
});

test('redactUrl hides the password and keeps everything an operator needs', () => {
  const url = composePostgresUrl({
    host: 'db.internal',
    port: 5432,
    database: 'neoting',
    user: 'nt_migrator',
    password: 'hunter2',
  });

  const redacted = redactUrl(url);
  expect(redacted).not.toContain('hunter2');
  expect(redacted).toContain('db.internal');
  expect(redacted).toContain('neoting');
  expect(redacted).toContain('nt_migrator');
});

test('redactUrl never throws on rubbish', () => {
  expect(redactUrl('not a url')).toBe('(unparseable url)');
});
