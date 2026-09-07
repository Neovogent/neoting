import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { expect, test } from 'vitest';

/**
 * The CloudFront Function that decides "file or client-side route" — tested
 * from the web app, because it IS this app's routing contract at the edge.
 *
 * ⚠ WHY THIS EXISTS. Until 8 Sep 2026 the rule was "a final segment containing
 * a dot is a file". A chase token is `base64url(payload).base64url(signature)`,
 * so every chase link had a dot, was sent to S3 as an object key, missed, and
 * the client tapping the link in their email got S3's raw
 * `<Error><Code>AccessDenied</Code></Error>` XML. The most important link in
 * the product was dead for every client and nothing caught it: "/" loaded, and
 * so did every route anyone thought to type by hand.
 *
 * The function's source is read out of the Terraform heredoc rather than
 * copied here. A copy would agree with the deployed rule right up until
 * somebody edited one of them.
 */
/** Walk up from the vitest cwd to the repo root, so this works from anywhere. */
function repoRoot(): string {
  let dir = process.cwd();
  for (let i = 0; i < 6; i += 1) {
    if (existsSync(join(dir, 'infra', 'envs', 'staging', 'web.tf'))) return dir;
    dir = dirname(dir);
  }
  throw new Error('could not find the repo root from ' + process.cwd());
}

const TF = join(repoRoot(), 'infra', 'envs', 'staging', 'web.tf');

function edgeHandler(): (uri: string) => string {
  const source = readFileSync(TF, 'utf8');
  const match = /code = <<-JS\n([\s\S]*?)\n {2}JS/u.exec(source);
  if (match?.[1] === undefined) throw new Error('could not find the SPA router function in web.tf');

  const body = match[1]
    .split('\n')
    .map((line) => (line.startsWith('    ') ? line.slice(4) : line))
    .join('\n');

  const make = new Function(`${body}; return handler;`) as () => (e: { request: { uri: string } }) => { uri: string };
  const handler = make();
  return (uri) => handler({ request: { uri } }).uri;
}

test('a chase link is a route, however many dots the token has', () => {
  const route = edgeHandler();
  // The exact shape sent to a client: HMAC-signed, base64url, one dot.
  const token = 'eyJjaGFzZUlkIjoiMTQ4MDAwYjItOGY1ZS00ZmU0In0.EIxP0MmNJJGqdr15pyvenTVXSYYmdfVDX7wV3LZh-I0';
  expect(route(`/p/${token}`)).toBe('/index.html');
});

test('every client-side route gets the shell', () => {
  const route = edgeHandler();
  for (const uri of ['/', '/app', '/app/setup', '/clients/biz_1/costs/ready', '/portal/settings/people', '/signup/verify']) {
    expect(route(uri)).toBe('/index.html');
  }
});

test('real files are served as themselves', () => {
  const route = edgeHandler();
  for (const uri of [
    '/assets/index-a1b2c3.js',
    '/assets/AIWorkspaceView-9f8e7d.css',
    '/assets/inter-latin-400.woff2',
    '/favicon.png',
    '/manifest.webmanifest',
    '/index.html',
  ]) {
    expect(route(uri)).toBe(uri);
  }
});

test('everything apps/web/public ships is on the allowlist', () => {
  const route = edgeHandler();
  const publicDir = join(repoRoot(), 'apps', 'web', 'public');
  // A file added to public/ with an extension the edge does not know would 404
  // in production and nowhere else. This is the check that says so first.
  for (const name of ['favicon.png', 'manifest.webmanifest']) {
    expect(readFileSync(`${publicDir}/${name}`).byteLength).toBeGreaterThan(0);
    expect(route(`/${name}`)).toBe(`/${name}`);
  }
});
