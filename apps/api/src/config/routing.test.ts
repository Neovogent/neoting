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

test('the prefix is the one the OpenAPI servers block declares', () => {
  // Every server URL in the spec must agree, or "the prefix" is not a single
  // thing and this file cannot express it.
  const paths = [...SPEC.matchAll(/^\s*-\s*url:\s*(\S+)/gm)].map((m) => new URL(m[1]!).pathname);

  expect(paths.length).toBeGreaterThan(0);
  expect(new Set(paths)).toEqual(new Set([`/${API_PREFIX}`]));
});

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
