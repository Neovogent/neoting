import type { Prisma, PrismaClient, ChasePolicy as ChasePolicyRow } from '@prisma/client';

import type { ChasePolicy, ChasePolicySettings } from '@neoting/contracts/model';

import type { ScopeContext } from '../../common/db/scope-context.js';
import { scopedDb } from '../../common/db/scoped-db.js';
import { signPortalLink, verifyPortalLink } from './portal-link.js';

/**
 * The practice's chasing schedule — the automatic-reminder policy (SoT §4
 * Stage 8 item 6, rush/chase-scheduler).
 *
 * Everything here is pure except `readChasePolicy`: the worker's reminder
 * sweep (`worker/chase-reminders.ts`) decides WHAT to do with these functions
 * and does it; the `policy.activate` executor is the only writer of the row.
 *
 * Days are counted from the chase's FIRST send. Reminder 1 at
 * `firstReminderDays`, reminder 2 at `secondReminderDays`, every later one the
 * same gap again, capped at `maxReminders`. Escalation (an in-app notice to
 * the practice — never a message to the client) at `escalateAfterDays`.
 * "No response" means the chase is still open: auto-close shuts it the moment
 * a matching document arrives.
 */

/** What a practice reads before it has ever approved a schedule. Off. */
export const DEFAULT_CHASE_POLICY: ChasePolicySettings = {
  firstReminderDays: 3,
  secondReminderDays: 7,
  escalateAfterDays: 14,
  maxReminders: 2,
  quietHoursStart: 20,
  quietHoursEnd: 8,
};

/** Chase states a reminder or an escalation may act on: sent and still unanswered. */
export const REMINDABLE_CHASE_STATES = ['SENT', 'REMINDED', 'ESCALATED'] as const;

export const REMINDER_PREFIX = 'Reminder: ';

/** A re-signed link lives as long as the original chase link did (compose-chase-send's 7 days). */
const REMINDER_LINK_TTL_SECONDS = 7 * 24 * 60 * 60;

/** Never two reminders inside a day, even after the worker was down and both fell due. */
const MIN_GAP_MS = 24 * 60 * 60 * 1000;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

type QuietHours = Pick<ChasePolicySettings, 'quietHoursStart' | 'quietHoursEnd'>;

export function toChasePolicy(row: ChasePolicyRow | null): ChasePolicy {
  if (row === null) return { enabled: false, ...DEFAULT_CHASE_POLICY, actionProposalId: null, updatedAt: null };
  return {
    enabled: row.enabled,
    firstReminderDays: row.firstReminderDays,
    secondReminderDays: row.secondReminderDays,
    escalateAfterDays: row.escalateAfterDays,
    maxReminders: row.maxReminders,
    quietHoursStart: row.quietHoursStart,
    quietHoursEnd: row.quietHoursEnd,
    actionProposalId: row.actionProposalId,
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** The caller's practice's schedule, through RLS. A business-scoped caller has no practice and reads the defaults. */
export async function readChasePolicy(prisma: PrismaClient, ctx: ScopeContext): Promise<ChasePolicy> {
  const practiceId = ctx.practiceId;
  if (practiceId === undefined) return toChasePolicy(null);
  const row = await scopedDb(prisma, ctx, (db) => db.chasePolicy.findUnique({ where: { practiceId } }));
  return toChasePolicy(row);
}

/** Hour of day, 0–23, in Europe/London — rendering-time zone, storage stays UTC. */
export function londonHour(at: Date): number {
  return Number(
    new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', hour: '2-digit', hourCycle: 'h23' }).format(at),
  );
}

/** Inside the no-messages window? A window may wrap midnight (20 → 8). start === end means none. */
export function isQuietHour(at: Date, policy: QuietHours): boolean {
  const { quietHoursStart: start, quietHoursEnd: end } = policy;
  if (start === end) return false;
  const hour = londonHour(at);
  return start < end ? hour >= start && hour < end : hour >= start || hour < end;
}

/** What the chase's `schedule` JSON column carries. Nothing else writes it. */
export interface ChaseSchedule {
  readonly remindersSent: number;
  readonly lastAttemptAt: string | null;
  readonly lastFailure: string | null;
}

export function readChaseSchedule(value: Prisma.JsonValue | null): ChaseSchedule {
  const record: Prisma.JsonObject =
    value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Prisma.JsonObject) : {};
  const sent = record['remindersSent'];
  const at = record['lastAttemptAt'];
  const failure = record['lastFailure'];
  return {
    remindersSent: typeof sent === 'number' && Number.isInteger(sent) && sent >= 0 ? sent : 0,
    lastAttemptAt: typeof at === 'string' ? at : null,
    lastFailure: typeof failure === 'string' ? failure : null,
  };
}

export interface ChaseClock {
  readonly firstSentAt: Date;
  readonly lastSentAt: Date | null;
  readonly escalatedAt: Date | null;
  readonly schedule: ChaseSchedule;
}

/** When the next reminder falls due, or null when the cap is reached. */
export function nextReminderAt(chase: ChaseClock, policy: ChasePolicySettings): Date | null {
  const n = chase.schedule.remindersSent + 1;
  if (n > policy.maxReminders) return null;
  const gap = policy.secondReminderDays - policy.firstReminderDays;
  const days = policy.firstReminderDays + (n - 1) * gap;
  return new Date(chase.firstSentAt.getTime() + days * MS_PER_DAY);
}

/** What the sweep should do to one open chase right now. */
export function reminderStep(
  chase: ChaseClock,
  policy: ChasePolicySettings,
  now: Date,
): { readonly remind: boolean; readonly escalate: boolean } {
  const due = nextReminderAt(chase, policy);
  const lastAttempt = Math.max(
    chase.lastSentAt?.getTime() ?? 0,
    chase.schedule.lastAttemptAt === null ? 0 : Date.parse(chase.schedule.lastAttemptAt) || 0,
  );
  return {
    remind:
      due !== null &&
      now.getTime() >= due.getTime() &&
      now.getTime() - lastAttempt >= MIN_GAP_MS &&
      !isQuietHour(now, policy),
    escalate:
      chase.escalatedAt === null && now.getTime() - chase.firstSentAt.getTime() >= policy.escalateAfterDays * MS_PER_DAY,
  };
}

/**
 * The reminder text: the APPROVED body, verbatim, behind a "Reminder: " prefix
 * — nothing composed, so what the policy approver signed for is what goes out.
 * The trailing portal link is re-signed for the same chase only when it no
 * longer verifies (expired, or the secret rotated); a live link is kept as is.
 */
export function reminderBody(original: string, chaseId: string, portalLinkSecret: string, nowMs: number): string {
  const body = original.startsWith(REMINDER_PREFIX) ? original : `${REMINDER_PREFIX}${original}`;
  if (portalLinkSecret === '') return body;
  return body.replace(/(https?:\/\/\S*\/p\/)([A-Za-z0-9_.-]+)$/, (whole, base: string, token: string) =>
    verifyPortalLink(token, portalLinkSecret, nowMs).ok
      ? whole
      : `${base}${signPortalLink({ chaseId, expSeconds: REMINDER_LINK_TTL_SECONDS }, portalLinkSecret, nowMs)}`,
  );
}
