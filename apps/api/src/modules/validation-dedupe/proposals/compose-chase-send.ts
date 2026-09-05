import { randomUUID } from 'node:crypto';

import type { ChaseSendPayload } from '@neoting/contracts/model';

import type { ScopedClient } from '../../../common/db/scoped-db.js';
import { composeChaseSms, composeStatementRequestSms, signPortalLink, statementItemRef } from '../../chase/index.js';
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
 * Two message kinds since Phase 5, decided by which field the message carries
 * (exactly one, refused otherwise):
 * - **`transactionIds`** — a document chase (engine (a)): the body lists the
 *   unmatched lines, `composeChaseSms`.
 * - **`statementPeriod`** — a bank-statement request (engine (c),
 *   `STATEMENT_PERIOD_GAP`): the body names the month,
 *   `composeStatementRequestSms`, and `businessId` is stamped from the
 *   PROPOSAL's own anchor because there are no transactions to derive it from.
 *
 * What is minted here, per message:
 * - **`chaseId`** — the id the portal link names, generated before the chase
 *   exists (`documentIdFor(uploadId)`'s move, applied to chases). The executor
 *   creates the chase WITH this id at approve time.
 * - **`body`** — composed over rows read through RLS (never the caller's),
 *   with the full portal URL `<APP_ORIGIN>/p/<token>`. Whatever body the
 *   caller sent is discarded, exactly as publish.batch discards a caller-sent
 *   preview.
 * - **The recipient** — the caller's named contact when given; otherwise the
 *   business's PRIMARY contact, resolved here (D45: the registered identity,
 *   never a typed one). `recipientEmail` is stamped so Read review shows where
 *   the email transport sends; `recipientE164` defaults from the contact's
 *   registered mobile when the caller sent none. No resolvable recipient at
 *   all refuses — a chase nobody can receive is not worth reviewing.
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
  /** The proposal's own business anchor — the only source a statement request has. */
  proposalBusinessId: string | null = null,
  nowMs: number = Date.now(),
): Promise<ChaseSendPayload> {
  const messages = [];
  for (const message of payload.messages) {
    const hasTransactions = (message.transactionIds?.length ?? 0) > 0;
    const hasPeriod = typeof message.statementPeriod === 'string' && message.statementPeriod !== '';
    if (hasTransactions === hasPeriod) {
      throw new ProposalExecutionRefused(
        'chase.send',
        'a message asks for EITHER transactions OR a statement period — exactly one',
      );
    }

    const chaseId = randomUUID();
    const token = signPortalLink({ chaseId, expSeconds: CHASE_LINK_TTL_SECONDS }, config.portalLinkSecret, nowMs);
    const portalLink = `${config.appOrigin.replace(/\/$/, '')}/p/${token}`;

    let businessId: string;
    let body: string;
    if (hasTransactions) {
      // One row per DISTINCT id — a benign duplicate in the payload must not be
      // misreported as unreachable (the executor's own discipline).
      const requestedIds = [...new Set(message.transactionIds)];
      const transactions = await db.bankTransaction.findMany({
        where: { id: { in: requestedIds } },
        select: {
          id: true,
          businessId: true,
          amountPence: true,
          bookedAt: true,
          descriptionRaw: true,
          merchantName: true,
          matchState: true,
          chaseSuppressed: true,
        },
      });
      if (transactions.length !== requestedIds.length) {
        throw new ProposalExecutionRefused('chase.send', 'a chased transaction is not reachable');
      }
      // The chase-detection predicate, enforced at COMPOSE (5 Sep 2026). The
      // caller's list is a courtesy, never the decision: a CONFIRMED line has
      // its evidence on file, a SUGGESTED one is already in front of a human,
      // and a suppressed line (a settlement credit, a bank charge) has no
      // receipt in existence — a client asked for any of these gets a request
      // the accountant then has to apologise for. Mirrors detection.ts's
      // `matchState: 'UNMATCHED', chaseSuppressed: false`; refuses the whole
      // message (the batch discipline) so the reviewer never reads a body
      // quietly missing lines the caller named.
      const unchaseable = transactions.filter((t) => t.matchState !== 'UNMATCHED' || t.chaseSuppressed);
      if (unchaseable.length > 0) {
        throw new ProposalExecutionRefused(
          'chase.send',
          `${unchaseable.length} of the ${transactions.length} lines cannot be chased: already matched, suggested, or a line with no paperwork to ask for (a credit or a bank charge)`,
        );
      }
      const businessIds = new Set(transactions.map((t) => t.businessId));
      const first = transactions[0]?.businessId;
      if (businessIds.size !== 1 || first === undefined) {
        throw new ProposalExecutionRefused('chase.send', 'a grouped message must chase transactions from one client');
      }
      businessId = first;

      const business = await requireBusiness(db, businessId);
      body = composeChaseSms({
        businessName: business.name,
        items: transactions.map((t) => ({
          transactionId: t.id,
          amountPence: t.amountPence,
          bookedAt: t.bookedAt,
          supplierLabel: t.merchantName ?? t.descriptionRaw,
        })),
        portalLink,
      });
    } else {
      // A statement request has no transactions to derive a business from —
      // the proposal's own anchor is the answer, and a proposal without one
      // cannot say whose statement it wants.
      if (proposalBusinessId === null) {
        throw new ProposalExecutionRefused('chase.send', 'a statement request needs the proposal to name a business');
      }
      businessId = proposalBusinessId;
      const business = await requireBusiness(db, businessId);
      body = composeStatementRequestSms({
        businessName: business.name,
        period: message.statementPeriod as string,
        portalLink,
      });
    }

    // The recipient. The caller's named contact when given; otherwise the
    // business's PRIMARY contact (D45 — the registered identity, resolved
    // here so the reviewer approves a real destination, not a typed one).
    // Display-tier for email: the transport re-resolves and refuses at send
    // time, so a contact that loses its address between creation and approve
    // refuses there.
    const contact =
      message.recipientContactId != null
        ? await db.contact.findFirst({
            where: { id: message.recipientContactId, businessId },
            select: { id: true, email: true, mobileE164: true },
          })
        : await db.contact.findFirst({
            where: { businessId, isPrimary: true },
            select: { id: true, email: true, mobileE164: true },
          });
    if (message.recipientContactId != null && contact === null) {
      throw new ProposalExecutionRefused('chase.send', 'the named recipient contact is not reachable for this client');
    }

    const recipientE164 = message.recipientE164 ?? contact?.mobileE164 ?? null;
    const recipientEmail = contact?.email ?? null;
    // A reachable CHANNEL, not specifically a mobile (2 Sep 2026). Intake
    // makes the mobile optional and ID's live transport is email
    // (SMS_SENDER=email), so requiring an E164 here refused a statement
    // request for every client whose contact registered only an address —
    // found on the first real walkthrough. The SMS-only senders refuse a
    // mobile-less message at THEIR seam, where "cannot deliver" is true.
    if (recipientE164 === null && recipientEmail === null) {
      throw new ProposalExecutionRefused(
        'chase.send',
        'no reachable recipient: the client needs a registered mobile or email address',
      );
    }

    messages.push({
      ...message,
      chaseId,
      businessId,
      recipientContactId: contact?.id ?? message.recipientContactId ?? null,
      recipientEmail,
      // Omitted rather than null when absent: the stored payload re-parses
      // against the generated schema at execution, and the contract types the
      // field as a patterned string — absent is legal, null is not.
      ...(recipientE164 === null ? {} : { recipientE164 }),
      ...(hasPeriod ? { statementPeriod: message.statementPeriod } : {}),
      body,
    });
  }
  return { ...payload, messages };
}

async function requireBusiness(db: ScopedClient, businessId: string): Promise<{ name: string }> {
  const business = await db.business.findUnique({ where: { id: businessId }, select: { name: true } });
  if (business === null) {
    throw new ProposalExecutionRefused('chase.send', 'a referenced record is not reachable');
  }
  return business;
}

/** Re-exported for the executor: the itemRefs tag a statement request carries. */
export { statementItemRef };
