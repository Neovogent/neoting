import type { ChaseSendPayload } from '@neoting/contracts/model';

import type { ScopedClient } from '../../../common/db/scoped-db.js';
import type { OutboundSms, SmsSender } from '../../chase/index.js';
import {
  type ExecutionInput,
  type ExecutionResult,
  ProposalExecutionRefused,
  type ProposalExecutor,
} from './proposal-executor.js';

/**
 * `chase.send` — the flagship effect (METH Stage 8, SoT §4 Stage 8).
 *
 * This is the #81 executor for the chase kind: it runs INSIDE the Review →
 * Approve engine's approve transaction, after the human has read every SMS
 * verbatim (`render-summary.ts` renders the payload's bodies byte-for-byte). The
 * engine owns the gate, the shown-hash check and the audit write; this executor
 * performs exactly one effect — turn the approved payload into chases, chase
 * messages, and a "send" through the `SmsSender` — and decides nothing about
 * whether it may happen.
 *
 * The Review → Approve guarantee, made concrete: **the `chase_messages.body` and
 * the `sms_log.body` are the payload's `body` verbatim.** Nothing here composes
 * or edits copy — composition ran at proposal time (`chase/sms-copy.ts`), its
 * output IS the payload, and if the sent text ever differed from the reviewed
 * text the guarantee would be broken (the schema comment on both columns says
 * exactly this). The portal link inside each body is likewise the reviewed link.
 *
 * One message per client, grouped (SoT Stage 8.2). Each payload message becomes
 * one `Chase` (detection engine (a) — the only one built) whose items are the
 * message's `transactionIds`, one `ChaseMessage`, and one outbound SMS. The
 * chase lands in `SENT` because approval IS the send.
 *
 * // DEMO-MOCK: the send goes through `DemoSmsSender`, which writes the outbox
 * // rows the SMS-outbox screen reads — no Twilio, ever (METH_MODE §0.5).
 */
export function chaseSendExecutor(sender: SmsSender): ProposalExecutor<'chase.send', ChaseSendPayload> {
  return {
    kind: 'chase.send',

    async execute(db: ScopedClient, input: ExecutionInput<ChaseSendPayload>): Promise<ExecutionResult> {
      const { payload, traceId, proposalId } = input;

      // Idempotent replay: the engine may retry after a crash between effect and
      // record. A chase already stamped with this proposal id is this exact send,
      // already done — return it as an applied no-op rather than sending twice.
      const existing = await db.chase.findFirst({
        where: { actionProposalId: proposalId },
        select: { id: true },
      });
      if (existing !== null) {
        const priorChases = await db.chase.findMany({
          where: { actionProposalId: proposalId },
          select: { id: true },
        });
        return {
          changed: priorChases.map((c) => ({ entity: 'chase' as const, id: c.id })),
          alreadyApplied: true,
          followUps: [],
        };
      }

      const changed: { entity: 'chase'; id: string }[] = [];
      const outbound: OutboundSms[] = [];

      for (const message of payload.messages) {
        // Resolve the business from the chased transactions THROUGH RLS, before
        // writing anything (the web-upload / route guard applied to effects): an
        // approver who cannot see a transaction cannot chase it, and the refusal
        // must not confirm whether the id exists. All ids in one grouped message
        // must belong to ONE business — that is what "grouped per client" means.
        // Compare against the DISTINCT requested ids: `findMany(in: [...])` returns
        // one row per id, so a benign duplicate in the payload must not be
        // misreported as "not reachable" — dedupe before the reachability count.
        const requestedIds = new Set(message.transactionIds);
        const transactions = await db.bankTransaction.findMany({
          where: { id: { in: [...requestedIds] } },
          select: { id: true, businessId: true },
        });
        if (transactions.length !== requestedIds.size) {
          throw new ProposalExecutionRefused('chase.send', 'a chased transaction is not reachable');
        }
        const businessIds = new Set(transactions.map((t) => t.businessId));
        if (businessIds.size !== 1) {
          throw new ProposalExecutionRefused('chase.send', 'a grouped message must chase transactions from one client');
        }
        const businessId = transactions[0]?.businessId;
        if (businessId === undefined) {
          throw new ProposalExecutionRefused('chase.send', 'a message must chase at least one transaction');
        }

        // recipientContactId is optional in the payload; when present it must be a
        // contact this approver can see in THIS business (RLS + the business gate),
        // never a foreign id smuggled in. Absent is legitimate — the audit trail
        // records requested-from separately, and a forwarded link has no contact.
        const recipientContactId = message.recipientContactId ?? null;
        if (recipientContactId !== null) {
          const contact = await db.contact.findFirst({
            where: { id: recipientContactId, businessId },
            select: { id: true },
          });
          if (contact === null) {
            throw new ProposalExecutionRefused('chase.send', 'the named recipient contact is not reachable for this client');
          }
        }

        const now = new Date();
        const chase = await db.chase.create({
          data: {
            // The id the portal link inside `body` already names — minted at
            // proposal creation by `computeChaseSendPayload`, adopted here so
            // the reviewed link verifies against the chase it created. Absent
            // on proposals older than the compose seam; Prisma's default then
            // mints one (whose link, being tokenless, never worked anyway).
            ...(message.chaseId != null ? { id: message.chaseId } : {}),
            businessId,
            detectionEngine: 'UNMATCHED_TRANSACTION',
            // The single-transaction convenience column, plus the full grouped
            // list — one message per client covers many receipts (SoT Stage 8.2).
            transactionId: message.transactionIds[0] ?? null,
            itemRefs: message.transactionIds,
            recipientContactId,
            state: 'SENT',
            firstSentAt: now,
            lastSentAt: now,
            actionProposalId: proposalId,
          },
          select: { id: true },
        });

        // The exact-text audit surface. `body` is the payload verbatim — the
        // sender records the send onto this row, it never rewrites the text.
        const chaseMessage = await db.chaseMessage.create({
          data: {
            chaseId: chase.id,
            channel: 'sms',
            body: message.body,
            recipientE164: message.recipientE164,
          },
          select: { id: true },
        });

        changed.push({ entity: 'chase', id: chase.id });
        outbound.push({
          businessId,
          chaseId: chase.id,
          chaseMessageId: chaseMessage.id,
          toE164: message.recipientE164,
          body: message.body,
        });
      }

      // "Send" — the demo sender writes the outbox rows, inside THIS transaction
      // and under the engine's RLS context. No network, no Twilio.
      await sender.send(db, outbound);

      return {
        changed,
        alreadyApplied: false,
        followUps: [],
        detail: { chases: changed.length, messages: outbound.length, traceId },
      };
    },
  };
}
