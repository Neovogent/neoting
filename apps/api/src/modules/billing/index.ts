/**
 * The public seam of billing (Boundaries, `apps/api/CLAUDE.md`).
 *
 * What is exported here is the whole of what other modules' code may depend
 * on; everything else in this directory is internal, and the boundary is
 * lint-enforced (`neoting/no-cross-module-internals`), not conventional.
 *
 * The surface is deliberately tiny, and deliberately PURE. Entitlement is a
 * question about four columns a caller has already read — "may this business
 * take a new document" — so it is a function over those columns rather than an
 * injected service. That matters for more than tidiness: `ingestion-routing`
 * and `portal` both ask it, and giving them a provider instead would make
 * three modules mutually dependent for a rule that fits on a line.
 *
 * ⚠ Nothing to do with Stripe is exported, and nothing should be. The Stripe
 * client, the webhook handler and the hosted-session endpoints are this
 * module's own business; a second module reaching for them would be a second
 * place that can charge a client.
 */
export {
  assertMayIngest,
  mayIngest,
  type SubscriptionFacts,
  toBusinessSubscription,
} from './entitlement.js';
