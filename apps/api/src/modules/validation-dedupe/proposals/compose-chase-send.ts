import { randomUUID } from 'node:crypto';

import type { ChaseSendPayload } from '@neoting/contracts/model';

import type { ScopedClient } from '../../../common/db/scoped-db.js';
import { composeChaseSms, signPortalLink } from '../../chase/index.js';
import { ProposalExecutionRefused } from './proposal-executor.js';

/**
 * `chase.send` composition at PROPOSAL CREATION — the publish.batch preview
 * precedent (`computePublishBatchPayload`), applied to the message body.
 *
 * The payload's own contract says "composition is server-side … never
 * free-typed by a caller", and until this existed no server surface ran it:
 * the chat card composed the SoT copy client-side with a TOKENLESS `/p/` path,
 * so no chase message ever carried a link that verified (the S13 compose-seam
 * gap, `modules/chase/CLAUDE.md`). This closes it the way that file suggested:
 * the engine composes at creation, and the executor adopts the token's chase
 * id — so the body a reviewer reads byte-for-byte is a body whose link works.
 *
 * What is minted here, per message:
 * - **`chaseId`** — the id the portal link names, generated before the chase
 *   exists (`documentIdFor(uploadId)`'s move, applied to chases). The executor
 *   creates the chase WITH this id at approve time.
 * - **`body`** — `composeChaseSms` over the chased transactions read through
 *   RLS (never the caller's rows), with the full portal URL
 *   `<APP_ORIGIN>/p/<token>` — the web portal's published address shape.
 *   Whatever body the caller sent is discarded, exactly as publish.batch
 *   discards a caller-sent preview.
 * - **`recipientEmail`** — the named contact's address, so Read review shows
 *   where the message actually goes under the email transport (the A13
 *   leftover: the render only showed `recipientE164`). Display-tier; the
 *   transport re-resolves from the contact at send time.
 *
 * ⚠ The link TTL is SEVEN DAYS, not the portal's 24-hour default. The link is
 * signed at CREATION and the body is frozen by the review hash, so a re-sign
 * at approve would break reviewed-bytes-are-sent-bytes; a 24-hour token minted
 * on Friday afternoon would be dead before a Monday approval. The link still
 * grants nothing on its own — the OTP and the delegated RLS scope gate the
 * data (`portal-link.ts`'s own words) — so the longer window costs identity
 * nothing.
 */
export const CHASE_LINK_TTL_SECONDS = 7 * 24 * 60 * 60;

export interface ChaseComposeConfig {
  /** Signs the portal link — the same secret the portal verifies with. */
  readonly portalLinkSecret: string;
  /** The web origin `/p/<token>` is served from, e.g. `https://app.example.com`. */
  readonly appOrigin: string;
}

export async function computeChaseSendPayload(
  db: ScopedClient,
  payload: ChaseSendPayload,
  config: ChaseComposeConfig,
  nowMs: number = Date.now(),
): Promise<ChaseSendPayload> {
  const messages = [];
  for (const message of payload.messages) {
    // One row per DISTINCT id — a benign duplicate in the payload must not be
    // misreported as unreachable (the executor's own discipline).
    const requestedIds = [...new Set(message.transactionIds)];
    const transactions = await db.bankTransaction.findMany({
      where: { id: { in: requestedIds } },
      select: { id: true, businessId: true, amountPence: true, bookedAt: true, descriptionRaw: true, merchantName: true },
    });
    if (transactions.length !== requestedIds.length) {
      throw new ProposalExecutionRefused('chase.send', 'a chased transaction is not reachable');
    }
    const businessIds = new Set(transactions.map((t) => t.businessId));
    const businessId = transactions[0]?.businessId;
    if (businessIds.size !== 1 || businessId === undefined) {
      throw new ProposalExecutionRefused('chase.send', 'a grouped message must chase transactions from one client');
    }

    const business = await db.business.findUnique({ where: { id: businessId }, select: { name: true } });
    if (business === null) {
      throw new ProposalExecutionRefused('chase.send', 'a chased transaction is not reachable');
    }

    // The named contact, resolved for the REVIEW (where does this go?), not
    // for delivery — the transport re-resolves and refuses at send time, so a
    // contact that loses its email between creation and approve refuses there.
    let recipientEmail: string | null = null;
    if (message.recipientContactId != null) {
      const contact = await db.contact.findFirst({
        where: { id: message.recipientContactId, businessId },
        select: { email: true },
      });
      if (contact === null) {
        throw new ProposalExecutionRefused('chase.send', 'the named recipient contact is not reachable for this client');
      }
      recipientEmail = contact.email ?? null;
    }

    const chaseId = randomUUID();
    const token = signPortalLink({ chaseId, expSeconds: CHASE_LINK_TTL_SECONDS }, config.portalLinkSecret, nowMs);
    const body = composeChaseSms({
      businessName: business.name,
      items: transactions.map((t) => ({
        transactionId: t.id,
        amountPence: t.amountPence,
        bookedAt: t.bookedAt,
        supplierLabel: t.merchantName ?? t.descriptionRaw,
      })),
      portalLink: `${config.appOrigin.replace(/\/$/, '')}/p/${token}`,
    });

    messages.push({ ...message, chaseId, recipientEmail, body });
  }
  return { ...payload, messages };
}
