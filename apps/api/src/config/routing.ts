import { RequestMethod } from '@nestjs/common';

/**
 * Where the REST surface lives, and the three things that deliberately do not.
 *
 * Governance §3 and D10: "REST under `/v1`; the OpenAPI spec in
 * `packages/contracts` is the build-first contract — handlers are
 * generated-against, not hand-drifted." The spec's `servers` block declares
 * `/v1` and `packages/contracts/src/http-client.ts` appends it, so the frontend
 * has been generating a client against a path the API never served: `/healthz`
 * answered 200 while `/v1/documents` answered 404. The contract is
 * authoritative, so the API was the non-conforming half.
 */
export const API_PREFIX = 'v1';

/**
 * ⚠ EVERY ENTRY HERE IS LOAD-BEARING AND BREAKS SOMETHING SPECIFIC IF REMOVED.
 * A global prefix is not a cosmetic change — it moves every route at once, and
 * three of them are addressed by things outside this repository.
 *
 *   healthz  The ALB target group probes it (each environment's alb.tf) and
 *            the deploy's post-check curls it through CloudFront. Move it and
 *            the target group marks every task unhealthy, the deployment
 *            circuit breaker rolls back, and the failure reads as a broken
 *            image rather than a moved path.
 *
 *   readyz   The deploy gate and synthetic checks. Same class of caller.
 *
 *   webhooks/whatsapp
 *            Meta holds this URL in its own configuration
 *            (docs/runbooks/whatsapp-sandbox.md, trap 4: "a callback URL that
 *            silently stops delivering"). Meta does not follow redirects for
 *            webhook delivery and does not report a 404 anywhere we would see
 *            — messages would simply stop arriving.
 *
 *            It is excluded on principle as well as on pragmatism: an inbound
 *            webhook is not part of OUR public REST contract. It is versioned
 *            by the provider, on the provider's schedule, and putting it under
 *            our version number would imply we get to change its shape.
 *
 * The exclusions are declared with an explicit RequestMethod so that adding,
 * say, a POST /healthz later does not silently inherit the exemption.
 */
export const UNVERSIONED_ROUTES = [
  { path: 'healthz', method: RequestMethod.GET },
  { path: 'readyz', method: RequestMethod.GET },
  // Meta's handshake is a GET, delivery is a POST. Both must stay put.
  { path: 'webhooks/whatsapp', method: RequestMethod.GET },
  { path: 'webhooks/whatsapp', method: RequestMethod.POST },
  //   d/:code  The D43 capability URL. Declared in the ID LAW batch AHEAD of
  //            its controller, because the exclusion is what makes the route
  //            exist where the contract says it does — without it Nest mounts
  //            the controller at `/v1/d/:code` and the link an accountant typed
  //            out of their ledger 404s.
  //
  //            The three characters are the whole reason. This URL has to
  //            survive a reference field that truncates SILENTLY at 30 and ~25
  //            characters (SoT §24.3.2), and `https://` plus a host has already
  //            spent most of that budget. `/d/A7K2M9` fits; `/v1/d/A7K2M9` is
  //            three characters closer to a link that looks correct and
  //            resolves to nothing.
  //
  //            An exclusion for a route no controller serves yet is a no-op, so
  //            declaring it now costs nothing and removes a silent failure from
  //            the lane that builds it. routing.test.ts couples the two.
  { path: 'd/:code', method: RequestMethod.GET },
  // Not `as const`: setGlobalPrefix's `exclude` takes a mutable
  // (string | RouteInfo)[], and a readonly tuple is not assignable to it.
];
