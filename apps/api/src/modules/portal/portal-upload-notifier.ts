import type { PrismaClient } from '../../common/db/prisma.js';
import { systemContext } from '../../common/db/scope-context.js';
import { scopedDb } from '../../common/db/scoped-db.js';
import { currentTraceId } from '../../common/trace/trace-context.js';
import type { PortalSessionFacts } from './portal-session-context.js';

/**
 * "Notify the accountant when a client uploads" (SoT §4 Stage 8.8, the 45-vote
 * gap; METH Stage 9 build item 5).
 *
 * A client answers a chase from a phone in a car park. Nobody at the practice is
 * watching the portal, so the arrival has to travel back into the workspace on
 * its own. This writes the row that does it — the same `notifications` table,
 * the same shape and the same convention Stage 8's auto-close uses for
 * `chase.closed`, so the workspace has one inbox to read and not two.
 *
 * // DEMO-MOCK: notification delivery channels. The row IS the in-app toast;
 * // the email/SMS/push fan-out and the per-event preferences SoT §4 Stage 8.8
 * // describes ("granular per event", both directions configurable) are not
 * // built. `channels` is left at its `[]` default rather than claiming a
 * // delivery that does not happen, and `recipientUserId` is null because the
 * // arrival concerns whoever is holding the client, not one named person.
 *
 * ## Scope: SYSTEM, not delegated — and this is the crux of the module
 *
 * `notifications` carries only the `notifications_tenant` policy, which goes
 * through `app_can_access_business()`, which begins `app_session_scope() =
 * 'user'`. **A delegated context cannot write this row** — the INSERT does not
 * error, it fails the WITH CHECK and raises, and a portal upload would appear to
 * half-work. So the write runs under the practice SYSTEM context
 * (`systemScopeFor`), the same actor every machine write in this codebase uses,
 * and is CONSTRAINED to the session's own business.
 */

/**
 * The event name. `<domain>.<past-tense-fact>`, matching `chase.closed`
 * (`chase/auto-close.ts`) — the workspace switches on this string.
 */
export const PORTAL_UPLOAD_EVENT = 'portal.upload';

/**
 * The session this upload came in on — the five facts the row needs, and no
 * more.
 *
 * Structural rather than `PortalSessionFacts` itself so the ONE caller that
 * matters can satisfy it without holding a whole session: the completion path
 * lives in `ingestion-routing/web-upload`, where the document is actually
 * created, and `delegatedCompletionFor` already resolves the facts on its way
 * there. `PortalSessionFacts` assigns to this directly.
 */
export type PortalNotificationSession = Pick<
  PortalSessionFacts,
  'businessId' | 'chaseId' | 'otpSessionId' | 'practiceId' | 'systemUserId'
>;

export interface PortalUploadNotice {
  /** The document that has just landed — derived from the upload intent, so it names a real row. */
  readonly documentId: string;
  /** Defaults to the ambient request trace, so the toast can be tied back to the upload. */
  readonly traceId?: string | null;
}

export class PortalUploadNotifier {
  constructor(private readonly prisma: PrismaClient) {}

  /**
   * Write the accountant's notification for a portal upload. Returns whether a
   * row was written — `false` means one was already there.
   *
   * **Call it once the document row EXISTS**, on the completion path
   * (`POST /document-uploads/{uploadId}/complete` under the portal bearer),
   * where web-upload already distinguishes the completion that created the
   * document from a replay that found it. Notifying at intent time would tell
   * the practice about bytes that may never arrive.
   *
   * Idempotent on the document: a replayed completion, a retried request or a
   * second tap writes no second toast. The check is a read followed by a write
   * rather than a constraint, because `notifications` has no unique key for it
   * and Stage 9 changes nothing in `prisma/` — so two genuinely concurrent
   * completions of the same intent could still write two rows. That is a
   * duplicate toast, not a duplicate document, and the alternative is a
   * migration this stage is not allowed to make.
   */
  async notifyUploadReceived(facts: PortalNotificationSession, notice: PortalUploadNotice): Promise<boolean> {
    const traceId = notice.traceId ?? currentTraceId() ?? null;

    // `systemScopeFor(facts)` by another name — the same `systemContext`, built
    // here because this service takes a NARROWED session (see
    // `PortalNotificationSession`) rather than the whole of `PortalSessionFacts`.
    const ctx = systemContext(facts.practiceId, facts.systemUserId);

    return scopedDb(this.prisma, ctx, async (db) => {
      const existing = await db.notification.findFirst({
        where: {
          businessId: facts.businessId,
          event: PORTAL_UPLOAD_EVENT,
          payload: { path: ['documentId'], equals: notice.documentId },
        },
        select: { id: true },
      });
      if (existing !== null) return false;

      await db.notification.create({
        data: {
          businessId: facts.businessId,
          event: PORTAL_UPLOAD_EVENT,
          // The audit trail SoT Stage 8.3 asks for: WHICH delegated session
          // uploaded, separately from who we asked (that is
          // `otp_sessions.requested_from_contact_id`, one join away). No
          // filename and no extracted values — those are on the document, and a
          // client-supplied string does not need a second home in a row the
          // workspace renders.
          payload: {
            documentId: notice.documentId,
            otpSessionId: facts.otpSessionId,
            source: 'portal',
            ...(facts.chaseId === null ? {} : { chaseId: facts.chaseId }),
            ...(traceId === null ? {} : { traceId }),
          },
        },
      });
      return true;
    });
  }
}
