import type { PrismaClient } from '@prisma/client';

import { systemActorsByPractice } from '../common/db/resolve-system-actor.js';
import { systemContext } from '../common/db/scope-context.js';
import { scopedDb } from '../common/db/scoped-db.js';
import { AppException } from '../common/problem/problem.js';
import { appendAuditEvent, canonicalStringify, sha256Hex } from '../modules/approvals/index.js';
import {
  type ChaseClock,
  readChaseSchedule,
  REMINDABLE_CHASE_STATES,
  reminderBody,
  reminderStep,
} from '../modules/chase/chase-policy.js';
import type { SmsSender } from '../modules/chase/index.js';

/**
 * The chase reminder sweep (rush/chase-scheduler, SoT §4 Stage 8 item 6) —
 * runs every 15 minutes from the worker's scheduler.
 *
 * ## ⚠ Why this may message a client without a per-item proposal
 *
 * Governance §10.5: a standing automation executes without per-item proposals
 * ONLY under a policy that was itself approved, and records that policy. The
 * practice's `chase_policies` row exists only because a super admin approved a
 * `policy.activate` proposal (tier 1); no row, or `enabled: false`, and this
 * sweep does nothing for that practice. Every reminder's audit row names the
 * policy's proposal id. And nothing new is composed: a reminder is the chase's
 * ORIGINAL approved text, verbatim, behind "Reminder: ", with its portal link
 * re-signed only when it no longer verifies.
 *
 * ## What it does, per open chase in an enabled practice
 *
 * - **escalate** (once, `escalateAfterDays` after the first send): state →
 *   ESCALATED, an `event` line on the chase, and an in-app `chase.overdue`
 *   notification addressed to the practice owner. Internal only, so quiet
 *   hours do not apply.
 * - **remind** (`reminderStep` decides; never in quiet hours, never twice in a
 *   day, capped at `maxReminders`): resend through the SAME `SmsSender` the
 *   `chase.send` executor uses — so STOP (`OptedOutRecipientError`), the
 *   per-number ceiling and the contact's `receivesChases` are the sender's
 *   refusals, unchanged. A refused or failed send still COUNTS as an attempt
 *   (recorded on the chase with the reason), which is what keeps a STOP'd
 *   number from being retried every 15 minutes forever.
 *
 * ponytail: "no response" = the chase is still open. A client portal upload
 * that did not match leaves it open and is reminded; reading upload events to
 * pause the clock is the upgrade if clients complain.
 */

export const CHASE_REMINDER_INTERVAL_MS = 15 * 60 * 1000;

export interface ChaseReminderDeps {
  readonly prisma: PrismaClient;
  readonly sender: SmsSender;
  readonly portalLinkSecret: string;
  readonly logger: { log(message: string): void; warn(message: string): void };
  readonly now?: () => Date;
}

export interface ChaseReminderResult {
  readonly reminded: number;
  readonly escalated: number;
  readonly failed: number;
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;

export async function runChaseReminderSweep(deps: ChaseReminderDeps): Promise<ChaseReminderResult> {
  const { prisma, logger } = deps;
  const now = deps.now?.() ?? new Date();
  let reminded = 0;
  let escalated = 0;
  let failed = 0;

  for (const { practiceId, systemUserId } of await systemActorsByPractice(prisma)) {
    const ctx = systemContext(practiceId, systemUserId);
    const work = await scopedDb(prisma, ctx, async (db) => {
      const policy = await db.chasePolicy.findUnique({ where: { practiceId } });
      if (policy === null || !policy.enabled) return null;
      const chases = await db.chase.findMany({
        where: {
          state: { in: [...REMINDABLE_CHASE_STATES] },
          firstSentAt: { not: null },
          business: { practiceId, isActive: true },
        },
        select: { id: true, businessId: true, firstSentAt: true, lastSentAt: true, escalatedAt: true, schedule: true },
      });
      return { policy, chases };
    });
    if (work === null) continue;
    const { policy } = work;

    for (const row of work.chases) {
      const clock: ChaseClock = {
        firstSentAt: row.firstSentAt!,
        lastSentAt: row.lastSentAt,
        escalatedAt: row.escalatedAt,
        schedule: readChaseSchedule(row.schedule),
      };
      const step = reminderStep(clock, policy, now);

      if (step.escalate) {
        const days = Math.floor((now.getTime() - clock.firstSentAt.getTime()) / MS_PER_DAY);
        const done = await scopedDb(prisma, ctx, async (db) => {
          // Compare-and-swap: a chase closed or escalated meanwhile is left alone.
          const updated = await db.chase.updateMany({
            where: { id: row.id, escalatedAt: null, state: { in: [...REMINDABLE_CHASE_STATES] } },
            data: { state: 'ESCALATED', escalatedAt: now },
          });
          if (updated.count === 0) return false;
          const message = `A document request has had no reply for ${days} days. Follow it up with the client.`;
          await db.chaseMessage.create({ data: { chaseId: row.id, channel: 'event', body: `Escalated — ${message}` } });
          const owner = await db.membership.findFirst({ where: { practiceId, isOwner: true }, select: { userId: true } });
          await db.notification.create({
            data: {
              businessId: row.businessId,
              event: 'chase.overdue',
              recipientUserId: owner?.userId ?? null,
              payload: { chaseId: row.id, message, policyProposalId: policy.actionProposalId },
            },
          });
          return true;
        });
        if (done) escalated += 1;
      }

      if (!step.remind) continue;
      const attempt = clock.schedule.remindersSent + 1;
      try {
        const sent = await scopedDb(prisma, ctx, async (db) => {
          const chase = await db.chase.findFirst({
            where: { id: row.id, state: { in: [...REMINDABLE_CHASE_STATES] } },
            select: { state: true, schedule: true, recipient: { select: { receivesChases: true } } },
          });
          // Closed meanwhile, or another worker already sent this reminder.
          if (chase === null || readChaseSchedule(chase.schedule).remindersSent !== clock.schedule.remindersSent) return false;
          if (chase.recipient?.receivesChases === false) {
            throw new Error('the client contact does not receive document requests');
          }
          const original = await db.chaseMessage.findFirst({
            where: { chaseId: row.id, channel: { not: 'event' } },
            orderBy: { createdAt: 'asc' },
            select: { body: true, recipientE164: true },
          });
          if (original === null) throw new Error('the chase has no approved message to repeat');

          const body = reminderBody(original.body, row.id, deps.portalLinkSecret, now.getTime());
          const message = await db.chaseMessage.create({
            data: { chaseId: row.id, channel: 'sms', body, recipientE164: original.recipientE164 },
            select: { id: true },
          });
          await deps.sender.send(db, [
            { businessId: row.businessId, chaseId: row.id, chaseMessageId: message.id, toE164: original.recipientE164, body },
          ]);
          await db.chase.update({
            where: { id: row.id },
            data: {
              state: chase.state === 'ESCALATED' ? 'ESCALATED' : 'REMINDED',
              lastSentAt: now,
              schedule: { remindersSent: attempt, lastAttemptAt: now.toISOString(), lastFailure: null },
            },
          });
          const outcome = { chaseId: row.id, reminder: attempt, automated: true, policyId: policy.actionProposalId };
          await appendAuditEvent(db, {
            businessId: row.businessId,
            event: 'chase.reminder.sent',
            // §10.5's literal requirement: the policy this ran under.
            proposalId: policy.actionProposalId,
            payloadHash: sha256Hex(canonicalStringify(outcome)),
            renderedSummaryHash: null,
            traceId: null,
            outcome,
          });
          return true;
        });
        if (sent) reminded += 1;
      } catch (error) {
        failed += 1;
        const reason = reasonOf(error);
        logger.warn(`chase reminder ${attempt} not sent for chase ${row.id}: ${reason}`);
        // Counted as an attempt, so a refusal (STOP, ceiling) is retried at the
        // next reminder slot at most, never every tick.
        await scopedDb(prisma, ctx, async (db) => {
          await db.chase.update({
            where: { id: row.id },
            data: { schedule: { remindersSent: attempt, lastAttemptAt: now.toISOString(), lastFailure: reason } },
          });
          await db.chaseMessage.create({
            data: { chaseId: row.id, channel: 'event', body: `Reminder ${attempt} not sent — ${reason}` },
          });
        }).catch((recordError: unknown) => logger.warn(`could not record the failed reminder: ${reasonOf(recordError)}`));
      }
    }
  }

  if (reminded + escalated + failed > 0) {
    logger.log(`chase reminders: ${reminded} sent, ${escalated} escalated, ${failed} not sent`);
  }
  return { reminded, escalated, failed };
}

function reasonOf(error: unknown): string {
  if (error instanceof AppException) return error.publicDetail ?? error.title;
  return error instanceof Error ? error.message : String(error);
}
