import { Logger } from '@nestjs/common';
import { z } from 'zod';

import type { PrismaClient } from '../../common/db/prisma.js';
import { systemActorsByPractice } from '../../common/db/resolve-system-actor.js';
import { systemContext } from '../../common/db/scope-context.js';
import { scopedDb } from '../../common/db/scoped-db.js';
import type { SmsSender } from './sms-sender.js';
import type { SqsQueue } from './sqs-queue.js';

/**
 * SMS delivery receipts: AWS End User Messaging SMS → SNS → SQS → here.
 *
 * Each event updates the `sms_log` row (and the `chase_messages` row) the
 * sender wrote with the delivery state and the cost in integer pence. A text
 * reported UNDELIVERED is re-sent — the same reviewed bytes, never recomposed —
 * by email through the existing `EmailChaseSender`, when the chase's contact
 * has an address. That is delivery of an already-approved message by the other
 * channel, not a new message.
 */

/** v2 (End User Messaging) fields, plus Pinpoint v1's `metrics.price_in_millicents_usd`. */
const DeliveryEvent = z
  .object({
    eventType: z.string(),
    messageId: z.string().min(1),
    eventTimestamp: z.number().optional(),
    totalMessagePrice: z.number().nonnegative().optional(),
    totalCarrierFee: z.number().nonnegative().optional(),
    metrics: z.object({ price_in_millicents_usd: z.number().nonnegative().optional() }).passthrough().optional(),
  })
  .passthrough();
export type DeliveryEvent = z.infer<typeof DeliveryEvent>;

const SnsEnvelope = z.object({ Type: z.literal('Notification'), Message: z.string() }).passthrough();

/** An SQS body (raw delivery, or still wrapped in the SNS envelope) → an event, or null. */
export function parseDeliveryEvent(body: string): DeliveryEvent | null {
  try {
    let json: unknown = JSON.parse(body);
    const envelope = SnsEnvelope.safeParse(json);
    if (envelope.success) json = JSON.parse(envelope.data.Message);
    const event = DeliveryEvent.safeParse(json);
    return event.success ? event.data : null;
  } catch {
    return null;
  }
}

export type DeliveryOutcome = 'delivered' | 'pending' | 'failed';

/** `TEXT_DELIVERED`/`TEXT_SUCCESSFUL` delivered; queued/pending wait; anything else is a failure. */
export function classify(eventType: string): DeliveryOutcome {
  const type = eventType.toUpperCase();
  if (type === 'TEXT_DELIVERED' || type === 'TEXT_SUCCESSFUL') return 'delivered';
  if (type === 'TEXT_QUEUED' || type === 'TEXT_PENDING') return 'pending';
  return 'failed';
}

/** `TEXT_CARRIER_UNREACHABLE` → `failed:carrier_unreachable`; `delivered`/`pending` as is. */
export function deliveryStateFor(eventType: string): string {
  const outcome = classify(eventType);
  return outcome === 'failed' ? `failed:${eventType.toLowerCase().replace(/^text_/, '')}` : outcome;
}

/** A non-negative USD amount → integer USD millicents (1 USD = 100,000), by string, never by float maths. */
function usdToMillicents(usd: number): number {
  const [whole = '0', fraction = ''] = usd.toFixed(8).split('.');
  const digits = fraction.padEnd(8, '0');
  // 5 digits are millicents; the 6th rounds half up.
  return Number(whole) * 100_000 + Number(digits.slice(0, 5)) + (Number(digits[5]) >= 5 ? 1 : 0);
}

/**
 * The event's cost in integer pence, or null when it carries no price.
 * `fxGbpPerUsdMilli` is GBP per USD × 1000 (790 = £0.79/$1). Integer maths only;
 * rounds half up to the penny.
 */
export function costPenceFor(event: DeliveryEvent, fxGbpPerUsdMilli: number): number | null {
  let millicents: number | null = null;
  if (event.totalMessagePrice !== undefined || event.totalCarrierFee !== undefined) {
    millicents = usdToMillicents(event.totalMessagePrice ?? 0) + usdToMillicents(event.totalCarrierFee ?? 0);
  } else if (event.metrics?.price_in_millicents_usd !== undefined) {
    millicents = Math.round(event.metrics.price_in_millicents_usd);
  }
  if (millicents === null) return null;
  // pence = millicents / 100,000 USD × fx/1000 GBP/USD × 100 p/GBP
  return Math.floor((millicents * fxGbpPerUsdMilli + 500_000) / 1_000_000);
}

export interface ApplyDeps {
  readonly fxGbpPerUsdMilli: number;
  /** The email half of the chase senders — `EmailChaseSender`. */
  readonly emailFallback?: SmsSender;
  readonly logger?: { log(m: string): void; warn(m: string): void };
}

/**
 * Apply a batch of events. Returns the message ids that matched a row — the
 * caller deletes those from the queue (and old unmatched ones).
 */
export async function applyDeliveryEvents(
  prisma: PrismaClient,
  events: readonly DeliveryEvent[],
  deps: ApplyDeps,
): Promise<Set<string>> {
  const matched = new Set<string>();
  if (events.length === 0) return matched;
  const byId = new Map(events.map((e) => [e.messageId, e]));
  const logger = deps.logger ?? new Logger('SmsDeliveryEvents');

  for (const practice of await systemActorsByPractice(prisma)) {
    const pending = [...byId.keys()].filter((id) => !matched.has(id));
    if (pending.length === 0) break;
    await scopedDb(prisma, systemContext(practice.practiceId, practice.systemUserId), async (db) => {
      const rows = await db.smsLog.findMany({
        where: { providerMessageId: { in: pending } },
        select: { id: true, businessId: true, providerMessageId: true, deliveryState: true, chaseId: true, body: true },
      });
      for (const row of rows) {
        const event = row.providerMessageId === null ? undefined : byId.get(row.providerMessageId);
        if (event === undefined) continue;
        matched.add(event.messageId);
        const state = deliveryStateFor(event.eventType);
        const cost = costPenceFor(event, deps.fxGbpPerUsdMilli);
        // A late "pending" never overwrites a final state.
        if (state === 'pending' && row.deliveryState !== null && row.deliveryState !== 'sent') continue;
        await db.smsLog.update({ where: { id: row.id }, data: { deliveryState: state, ...(cost === null ? {} : { costPence: cost }) } });
        const chaseMessage = await db.chaseMessage.findFirst({
          where: { providerMessageId: event.messageId },
          select: { id: true, chaseId: true },
        });
        if (chaseMessage !== null) {
          await db.chaseMessage.update({ where: { id: chaseMessage.id }, data: { deliveryState: state } });
        }

        // Fall back to email ONCE, on the transition into failure.
        const alreadyFailed = row.deliveryState?.startsWith('failed:') === true;
        if (classify(event.eventType) !== 'failed' || alreadyFailed || chaseMessage === null || deps.emailFallback === undefined) continue;
        try {
          await deps.emailFallback.send(db, [
            { businessId: row.businessId, chaseId: chaseMessage.chaseId, chaseMessageId: chaseMessage.id, toE164: null, body: row.body },
          ]);
          logger.log(`sms ${event.messageId} undelivered (${state}) — the reviewed message was emailed instead`);
        } catch (error) {
          // No address, opted out of chases, or rate-limited: the text failed and
          // the state says so; nothing else is attempted.
          logger.warn(`sms ${event.messageId} undelivered and could not be emailed: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    });
  }
  return matched;
}

/** Unmatched events older than this are dropped (sign-in code texts have no `sms_log` row). */
const UNMATCHED_DROP_AFTER_MS = 10 * 60 * 1000;

/**
 * The long-poll loop. Unmatched recent events stay on the queue (the send's
 * transaction may not have committed yet) and come back after the visibility
 * timeout; the queue's redrive policy is the final backstop.
 */
export function startSmsDeliveryConsumer(
  prisma: PrismaClient,
  queue: Pick<SqsQueue, 'receive' | 'deleteBatch'>,
  deps: ApplyDeps,
): { stop(): void } {
  const logger = deps.logger ?? new Logger('SmsDeliveryEvents');
  let running = true;
  const loop = async (): Promise<void> => {
    while (running) {
      try {
        const messages = await queue.receive();
        const parsed = messages.map((m) => ({ m, event: parseDeliveryEvent(m.body) }));
        const events = parsed.flatMap((p) => (p.event === null ? [] : [p.event]));
        const matched = await applyDeliveryEvents(prisma, events, { ...deps, logger });
        const done = parsed.filter(
          (p) =>
            p.event === null ||
            matched.has(p.event.messageId) ||
            Date.now() - (p.event.eventTimestamp ?? 0) > UNMATCHED_DROP_AFTER_MS,
        );
        await queue.deleteBatch(done.map((p) => p.m.receiptHandle));
      } catch (error) {
        logger.warn(`sms delivery-event poll failed: ${error instanceof Error ? error.message : String(error)}`);
        await new Promise((resolve) => setTimeout(resolve, 30_000).unref());
      }
    }
  };
  void loop();
  return {
    stop: () => {
      running = false;
    },
  };
}
