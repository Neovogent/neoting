import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { RequestMethod } from '@nestjs/common';
import { expect, test } from 'vitest';

import { API_PREFIX, UNVERSIONED_ROUTES } from './routing.js';

/**
 * The contract is authoritative (Governance §3, D10), so the interesting
 * assertion is not "the prefix is v1" — it is "the prefix is whatever the spec
 * says". Pinning it to a literal would let the two drift apart again silently,
 * which is exactly how the API ended up serving at root while the generated
 * client called /v1 and every request 404'd.
 */
const SPEC = readFileSync(
  fileURLToPath(new URL('../../../../packages/contracts/openapi.yaml', import.meta.url)),
  'utf8',
);

const SPEC_LINES = SPEC.split('\n');

/**
 * The server URLs declared at one indentation level, scanned by line.
 *
 * A line scanner rather than a multi-line regex, and rather than a YAML parse:
 * regexes over a 3 700-line document with two `servers:` blocks at different
 * depths were unreadable and quietly wrong on the first attempt, and adding a
 * YAML dependency to `apps/api` for one test would be a real cost for a file
 * whose whole point is to be cheap enough to keep.
 *
 * `indent` is the column `servers:` itself sits at — 0 for the top-level block,
 * 4 for a path item's own override.
 */
function serverUrlsAt(indent: number, startLine: number): string[] {
  const key = `${' '.repeat(indent)}servers:`;
  const from = SPEC_LINES.findIndex((line, i) => i >= startLine && line === key);
  if (from === -1) return [];

  const urls: string[] = [];
  for (const line of SPEC_LINES.slice(from + 1)) {
    // Blank lines and comments belong to the block; anything at or left of the
    // key's own indentation ends it.
    if (line.trim() === '' || line.trimStart().startsWith('#')) continue;
    if (line.search(/\S/) <= indent) break;
    const url = /^\s*-\s*url:\s*(\S+)/.exec(line)?.[1];
    if (url !== undefined) urls.push(url);
  }
  return urls;
}

test('the prefix is the one the OpenAPI servers block declares', () => {
  // The TOP-LEVEL block only. It used to be every `- url:` in the file, which
  // was right while the spec had exactly one servers block — the ID LAW batch
  // added a second (see the next test), and reading both made "the prefix" two
  // things and failed this test on a deliberate change.
  //
  // Every top-level server URL must still agree with every other, or the prefix
  // is not a single thing and this file cannot express it.
  const paths = serverUrlsAt(0, 0).map((url) => new URL(url).pathname);

  expect(paths.length).toBeGreaterThan(0);
  expect(new Set(paths)).toEqual(new Set([`/${API_PREFIX}`]));
});

test('a path declaring root-origin servers is excluded from the global prefix', () => {
  // The coupling that stops a contract change and the Nest config drifting
  // apart silently. A path item overriding `servers` to the origin ROOT is
  // saying "I am not under /v1"; if `setGlobalPrefix` has not been told the
  // same thing, Nest mounts its controller at `/v1/...` and the URL the
  // contract published — the one an accountant typed out of their ledger —
  // 404s.
  //
  // Scanned from the spec rather than compared against a literal list, so a
  // SECOND such path fails here on the day it is added rather than in
  // production.
  const rootOriginPaths = SPEC_LINES.flatMap((line, i) => {
    const specPath = /^ {2}(\/\S*):\s*$/.exec(line)?.[1];
    if (specPath === undefined) return [];
    const urls = pathItemServerUrls(i);
    if (urls.length === 0) return [];
    return urls.every((url) => new URL(url).pathname === '/') ? [specPath] : [];
  });

  expect(rootOriginPaths).toEqual(['/d/{code}']);

  for (const specPath of rootOriginPaths) {
    // `/d/{code}` in OpenAPI is `d/:code` in Nest — one route, two dialects.
    const nestPath = specPath.replace(/^\//, '').replace(/\{(\w+)\}/g, ':$1');
    expect(UNVERSIONED_ROUTES.map((r) => r.path), specPath).toContain(nestPath);
  }
});

/** The `servers:` a single path item declares for itself, if any. */
function pathItemServerUrls(pathLine: number): string[] {
  for (let i = pathLine + 1; i < SPEC_LINES.length; i += 1) {
    const line = SPEC_LINES[i]!;
    if (line.trim() === '' || line.trimStart().startsWith('#')) continue;
    // Back out to column 2 or less: the next path item, or the end of `paths:`.
    if (line.search(/\S/) <= 2) return [];
    if (line === '    servers:') return serverUrlsAt(4, i);
  }
  return [];
}

test('the routes outside the contract are excluded, with their methods', () => {
  const excluded = UNVERSIONED_ROUTES.map((r) => `${RequestMethod[r.method]} ${r.path}`);

  expect(excluded).toEqual([
    // The ALB target group probes this and the deploy post-check curls it
    // through CloudFront. Moving it fails the health check, trips the
    // deployment circuit breaker, and reads as a broken image.
    'GET healthz',
    'GET readyz',
    // Meta holds this URL in its own configuration and does not follow
    // redirects for delivery. Both the handshake (GET) and delivery (POST).
    'GET webhooks/whatsapp',
    'POST webhooks/whatsapp',
    // The D43 capability URL. Excluded ahead of its controller (ID LAW batch,
    // stage S0) because the exclusion is what makes the route exist where the
    // contract says it does — and because `/v1/` is three characters this URL
    // cannot spare against a ledger field that truncates silently.
    'GET d/:code',
  ]);
});

test('the excluded webhook path still matches the controller that serves it', () => {
  // If someone renames the @Controller path, the exclusion silently stops
  // applying and Meta's callback moves under /v1 without anyone noticing until
  // messages stop arriving. This is the only cheap way to couple the two
  // without booting Nest.
  const controller = readFileSync(
    fileURLToPath(new URL('../modules/ingestion-routing/webhooks/whatsapp/whatsapp.controller.ts', import.meta.url)),
    'utf8',
  );
  const declared = /@Controller\('([^']+)'\)/.exec(controller)?.[1];

  expect(declared).toBe('webhooks/whatsapp');
  expect(UNVERSIONED_ROUTES.map((r) => r.path)).toContain(declared);
});

test('health routes are not accidentally versioned by a stray prefix', () => {
  expect(UNVERSIONED_ROUTES.some((r) => r.path.startsWith(API_PREFIX))).toBe(false);
});

test('the STRIPE webhook is deliberately NOT excluded — it stays under /v1', () => {
  // Meta's is excluded because Meta holds that URL in its own configuration and
  // does not follow redirects. Stripe's endpoint URL is ours to choose and is
  // set once in the Stripe dashboard against whatever we register, so it goes
  // where the contract puts it. Asserted rather than assumed, because "the
  // other webhook is excluded" is exactly the reasoning that would move it.
  const controller = readFileSync(
    fileURLToPath(new URL('../modules/billing/stripe-webhook.controller.ts', import.meta.url)),
    'utf8',
  );
  const declared = /@Controller\('([^']+)'\)/.exec(controller)?.[1];

  expect(declared).toBe('webhooks/stripe');
  expect(UNVERSIONED_ROUTES.map((r) => r.path)).not.toContain(declared);
  // And the contract agrees: it declares no root-origin `servers` override for
  // this path, so `/v1/webhooks/stripe` is the published URL.
  expect(SPEC).toContain('  /webhooks/stripe:');
});
