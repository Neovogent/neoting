import type { RoutePayload } from '@neoting/contracts/model';

import type { ScopedClient } from '../../../common/db/scoped-db.js';
import {
  type ExecutionInput,
  type ExecutionResult,
  type FollowUp,
  ProposalExecutionRefused,
  type ProposalExecutor,
} from './proposal-executor.js';

/**
 * `document.route` — assign an Unrouted document to a business (issue #81).
 * The executor that closes the Unrouted queue loop.
 *
 * What routing IS here: setting `businessId` (and the workspace inbox) on a
 * document that has none. What it deliberately is NOT:
 *
 * - **It does not clear `practiceId`** — decision 4 on the issue. Both anchors
 *   set is the normal routed case (#103): the practice branch of
 *   `app_can_access_document` and `@@index([practiceId, inbox])` read it.
 * - **It does not move an already-routed document.** That is
 *   `document.move-business`, with its addressee-mismatch warning; letting
 *   route do it quietly would be that warning's bypass.
 * - **It does not change `DocumentState`.** Routing is a tenancy/inbox change;
 *   the state machine (#80) is not involved.
 * - **It does not create the sender rule.** `teachRouterForSender` is a seam:
 *   the rules engine is `rules-suggestions`' lane, so the flag is recorded on
 *   the event for that executor-to-be, never silently dropped.
 *
 * Dedupe on route: the document has never been deduped (detection runs per
 * business and skips unrouted documents by design). The scan cannot run in
 * this transaction — a 500-candidate Hamming scan has no business inside a
 * 10s-budget request-path transaction, and the detector opens its own scoped
 * work. So the executor writes the DEFERRED marker event in-transaction (the
 * durable intent, same principle as the outbox §4.2 names — the outbox table
 * itself does not exist yet, see the decision on #81) and returns a `dedupe`
 * follow-up the engine enqueues after commit. `dedupe-follow-up.ts` completes
 * or sweeps it.
 */
export const routeDocumentExecutor: ProposalExecutor<'document.route', RoutePayload> = {
  kind: 'document.route',

  async execute(db: ScopedClient, input: ExecutionInput<RoutePayload>): Promise<ExecutionResult> {
    const { payload, traceId, proposalId } = input;

    // Routing means giving the document a place; UNROUTED is the absence of
    // one. The contract's Inbox enum carries the value because documents DO
    // sit in it — but no approved action may SEND one there.
    if (payload.inbox === 'UNROUTED') {
      throw new ProposalExecutionRefused('document.route', 'cannot route a document to UNROUTED — routing is what takes it out');
    }

    // RLS decides visibility: an invisible document and an absent one are the
    // same refusal, so the answer never confirms existence.
    const document = await db.document.findUnique({
      where: { id: payload.documentId },
      select: { id: true, businessId: true, practiceId: true, inbox: true, byteHash: true },
    });
    if (document === null) {
      throw new ProposalExecutionRefused('document.route', 'no document with that id');
    }

    const toBusinessId = payload.toBusinessId ?? null;

    // Idempotent replay: the engine may retry after a crash between effect and
    // record. The same proposal finding the effect already applied is a
    // success that does nothing — including no second event and no second
    // dedupe.
    const alreadyApplied =
      document.inbox === payload.inbox && (toBusinessId === null || document.businessId === toBusinessId);
    if (alreadyApplied) {
      return { changed: [{ entity: 'document', id: document.id }], alreadyApplied: true, followUps: [] };
    }

    let assignedBusiness = false;

    if (toBusinessId !== null) {
      if (document.businessId !== null && document.businessId !== toBusinessId) {
        throw new ProposalExecutionRefused(
          'document.route',
          'document already belongs to a business — moving it is document.move-business, which carries the addressee-mismatch warning',
        );
      }
      if (document.businessId === null) {
        // Resolve the TARGET through RLS before writing anything — the same
        // guard web-upload runs before presigning (#76): if the approver
        // cannot see the business, they cannot route into it, and the refusal
        // must not confirm it exists.
        const business = await db.business.findUnique({ where: { id: toBusinessId }, select: { id: true } });
        if (business === null) {
          throw new ProposalExecutionRefused('document.route', 'no reachable business with that id');
        }
        assignedBusiness = true;
      }
    } else if (document.businessId === null) {
      throw new ProposalExecutionRefused(
        'document.route',
        'an unrouted document needs a business — toBusinessId is required to take it off the Unrouted queue',
      );
    }

    await db.document.update({
      where: { id: document.id },
      data: {
        inbox: payload.inbox,
        ...(assignedBusiness ? { businessId: toBusinessId } : {}),
        // practiceId deliberately untouched — see the header.
      },
    });

    await db.documentEvent.create({
      data: {
        documentId: document.id,
        stage: 'route',
        outcome: assignedBusiness ? 'routed' : 'inbox-changed',
        traceId,
        detail: {
          proposalId,
          fromInbox: document.inbox,
          toInbox: payload.inbox,
          ...(assignedBusiness ? { toBusinessId } : {}),
          // The seam, recorded rather than dropped: the rules engine reads
          // this when its executor lands (rules-suggestions lane).
          ...(payload.teachRouterForSender === true ? { teachRouterDeferred: true } : {}),
        },
      },
    });

    const followUps: FollowUp[] = [];
    if (assignedBusiness && toBusinessId !== null) {
      // The anchor CHECK guarantees an unrouted document carries practiceId,
      // so this is the newly-routed case's non-null practice by construction.
      // A document without one cannot exist here; refuse loudly if it does.
      if (document.practiceId === null) {
        throw new ProposalExecutionRefused('document.route', 'unrouted document has no practice anchor — data violates documents_tenant_anchor');
      }
      // The durable intent, committed atomically with the route itself. If the
      // process dies before the engine enqueues, the sweeper finds this event
      // with no completion and re-runs the scan — never silently dropped.
      await db.documentEvent.create({
        data: {
          documentId: document.id,
          stage: 'dedupe',
          outcome: 'deferred',
          traceId,
          detail: { proposalId, businessId: toBusinessId },
        },
      });
      followUps.push({
        kind: 'dedupe',
        documentId: document.id,
        businessId: toBusinessId,
        practiceId: document.practiceId,
      });
    }

    return {
      changed: [{ entity: 'document', id: document.id }],
      alreadyApplied: false,
      followUps,
      detail: {
        inbox: payload.inbox,
        ...(assignedBusiness && toBusinessId !== null ? { toBusinessId } : {}),
      },
    };
  },
};
