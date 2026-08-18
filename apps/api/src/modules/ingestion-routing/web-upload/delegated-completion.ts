import {
  delegatedScopeFor,
  type PortalSessionContextResolver,
  portalSessionRequired,
  type PortalUploadNotifier,
  systemScopeFor,
} from '../../portal/index.js';
import type { DelegatedCompletion } from './web-upload.service.js';

/**
 * `Authorization: Bearer <portal token>` → the {@link DelegatedCompletion} the
 * completion path needs (METH Stage 9).
 *
 * **Why this exists as a function and not four lines in the controller.** It is
 * the whole of what one module has to know about another: web upload needs a
 * portal session resolved into two scope contexts, and nothing else from in
 * there. Keeping it here means the controller stays "parse, resolve, call one
 * service", and the reasoning below — which is about RLS, not about HTTP —
 * lives next to the service it constrains rather than in a route handler.
 *
 * Everything it touches crosses `portal/index.ts`, the module's public seam
 * (`neoting/no-cross-module-internals`).
 */

/** The only two things web upload needs from the portal — narrowed so tests can stand in for them. */
export type PortalCompletionResolver = Pick<PortalSessionContextResolver, 'resolve'>;
export type PortalCompletionNotifier = Pick<PortalUploadNotifier, 'notifyUploadReceived'>;

export async function delegatedCompletionFor(
  resolver: PortalCompletionResolver,
  notifier: PortalCompletionNotifier,
  authorizationHeader: string,
): Promise<DelegatedCompletion> {
  // Throws 401 `NT-OTP-002` for a missing, malformed, forged, unverified or
  // expired session. The row is re-read and re-checked there, so a session
  // shortened after its bearer was minted loses to the row.
  const facts = await resolver.resolve(authorizationHeader);

  const delegated = delegatedScopeFor(facts);
  if (!delegated.ok) {
    // `ScopeContextSchema` refuses a delegated context with an EMPTY grant, and
    // a session's grant is empty until `POST /portal/uploads` derives a document
    // id and grants it. So this is not a corrupt session — it is a session being
    // asked to complete an upload it never started. The uniform portal 401 is
    // the honest answer: from here, that session has nothing to complete.
    throw portalSessionRequired('This portal session has no upload to complete. Start the upload again.');
  }

  return {
    context: delegated.context,
    // The one write the delegated scope cannot make. `document_events` reaches
    // its tenant through `app_can_access_document`, which begins
    // `app_session_scope() = 'user'` — see `DelegatedCompletion`.
    eventsContext: systemScopeFor(facts),
    otpSessionId: facts.otpSessionId,
    chaseId: facts.chaseId,
    // SoT §4 Stage 8.8. Closed over the RESOLVED facts, so the notification
    // names the session that actually uploaded — and so web upload never has to
    // know what a `notifications` row is. `PortalSessionFacts` satisfies the
    // notifier's narrowed session type directly.
    notifyUploadReceived: async (documentId) => {
      await notifier.notifyUploadReceived(facts, { documentId });
    },
  };
}
