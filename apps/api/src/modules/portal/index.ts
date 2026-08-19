/**
 * The public seam of portal (Boundaries, `apps/api/CLAUDE.md`).
 *
 * What is exported here is the whole of what other modules' code may depend on;
 * everything else in this directory is internal, and the boundary is
 * lint-enforced (`neoting/no-cross-module-internals`), not conventional.
 * Growing this list is a boundary decision — a name here is a name every other
 * module may build against.
 *
 * The seam exists for ONE consumer the contract itself creates:
 * `POST /v1/document-uploads/{uploadId}/complete` accepts the portal bearer
 * alongside the workspace session (`openapi.yaml`), because that is step two of
 * every portal upload. `modules/ingestion-routing/web-upload` therefore needs
 * to resolve a portal session and build a delegated scope — and nothing else
 * from in here.
 *
 * The three portal endpoints themselves live INSIDE this module and import
 * these files directly; they are not consumers of the seam.
 */

// The bearer, for a composition root that needs to mint or check one outside a
// request (integration tests assembling the portal journey end to end).
export {
  type PortalSessionClaims,
  PORTAL_SESSION_TTL_MS,
  type PortalSessionVerdict,
  signPortalSessionToken,
  verifyPortalSessionHeader,
} from './portal-session-token.js';

// The resolver, its facts, and the two scope contexts derived from them — the
// delegated one (the RLS document boundary) and the practice SYSTEM one (the
// only way to read the chase; constrain every query to `facts.chaseId`).
export {
  type DelegatedScopeResult,
  delegatedScopeFor,
  type PortalSessionFacts,
  PortalSessionContextResolver,
  portalSessionRequired,
  systemScopeFor,
} from './portal-session-context.js';

// The session core. `grantItems` is the only way to widen what a session may
// touch; the upload path calls it with the derived document id.
export {
  type CreatePortalSessionInput,
  type IssuedPortalSession,
  type PortalSessionConfig,
  PortalSessionService,
} from './portal-session.service.js';

/**
 * The accountant's notification for a portal upload (SoT §4 Stage 8.8 —
 * "notify the accountant when a client uploads").
 *
 * On the seam for the same reason the resolver is: the document row is created
 * by `POST /document-uploads/{uploadId}/complete` in `ingestion-routing`, which
 * is where "a client uploaded" first becomes TRUE. Notifying at intent time —
 * inside this module, where it would need no seam — would announce bytes that
 * may never land.
 *
 * `PortalNotificationSession` is the narrowed session the writer needs;
 * `PortalSessionFacts` (which `delegatedCompletionFor` already resolves)
 * assigns to it directly.
 */
export {
  PORTAL_UPLOAD_EVENT,
  type PortalNotificationSession,
  PortalUploadNotifier,
  type PortalUploadNotice,
} from './portal-upload-notifier.js';

// The DI tokens, so a consuming Nest module can inject what `PortalModule`
// exports rather than construct a second resolver.
export { PORTAL_SESSION_CONTEXT, PORTAL_SESSION_SERVICE, PORTAL_UPLOAD_NOTIFIER } from './tokens.js';

/**
 * ⚠ `PortalModule` is exported here deliberately, unlike `auth-tenancy`'s.
 * There is no circular-evaluation hazard: nothing in `common/` imports this
 * seam, so `web-upload.module.ts` may `imports: [PortalModule]` to reach
 * `PORTAL_SESSION_CONTEXT`. `app.module.ts` is a composition root and imports
 * the module file directly, as it does for every other module.
 */
export { PortalModule } from './portal.module.js';
