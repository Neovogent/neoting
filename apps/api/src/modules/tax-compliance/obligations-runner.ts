import type { PrismaClient } from '../../common/db/prisma.js';
import { systemActorsByPractice } from '../../common/db/resolve-system-actor.js';
import { systemContext } from '../../common/db/scope-context.js';
import { scopedDb } from '../../common/db/scoped-db.js';
import { addDays, DUE_SOON_DAYS, iso, longDate, parseIsoDate } from './obligations.js';
import { BUSINESS_PROFILE_SELECT, londonToday, refreshStatuses, regenerateBusinessObligations } from './tax-compliance.service.js';

/**
 * The daily deadline sweep: recompute every active client's obligations,
 * bring the stored statuses up to today, and write ONE bell notification per
 * obligation when it comes within seven days and ONE when it goes overdue
 * (`notified_due_soon_at` / `notified_overdue_at` make a re-run a no-op).
 *
 * A plain interval, the ledger-refresh-sweep precedent: the work list is read
 * from the database and the sweep is safe to run any number of times, so two
 * worker tasks running it costs a duplicate read, never a duplicate notice.
 */
export const OBLIGATIONS_SWEEP_INTERVAL_MS = 24 * 60 * 60 * 1000;

export interface ObligationsSweepResult {
  readonly practices: number;
  readonly businesses: number;
  readonly notified: number;
}

export async function runObligationsSweep(prisma: PrismaClient, now: Date = new Date()): Promise<ObligationsSweepResult> {
  const today = londonToday(now);
  const todayYmd = parseIsoDate(today);
  if (todayYmd === null) return { practices: 0, businesses: 0, notified: 0 };
  const soonEnd = new Date(`${iso(addDays(todayYmd, DUE_SOON_DAYS - 1))}T00:00:00.000Z`);
  const todayDate = new Date(`${today}T00:00:00.000Z`);

  const practices = await systemActorsByPractice(prisma);
  let businesses = 0;
  let notified = 0;

  for (const practice of practices) {
    const ctx = systemContext(practice.practiceId, practice.systemUserId);
    const ids = await scopedDb(prisma, ctx, (db) => db.business.findMany({ where: { isActive: true }, select: { id: true } }));
    for (const { id } of ids) {
      await scopedDb(prisma, ctx, async (db) => {
        const row = await db.business.findUniqueOrThrow({ where: { id }, select: BUSINESS_PROFILE_SELECT });
        await regenerateBusinessObligations(db, row, today);
      });
      businesses += 1;
    }

    notified += await scopedDb(prisma, ctx, async (db) => {
      await refreshStatuses(db, { practiceId: practice.practiceId }, today);
      const pending = await db.obligation.findMany({
        where: {
          business: { isActive: true },
          doneAt: null,
          dueDate: { lte: soonEnd },
          OR: [
            { dueDate: { lt: todayDate }, notifiedOverdueAt: null },
            { dueDate: { gte: todayDate }, notifiedDueSoonAt: null },
          ],
        },
        select: { id: true, businessId: true, title: true, dueDate: true },
        take: 500,
      });
      for (const o of pending) {
        const overdue = o.dueDate < todayDate;
        const due = parseIsoDate(o.dueDate.toISOString().slice(0, 10));
        const when = due === null ? o.dueDate.toISOString().slice(0, 10) : longDate(due);
        await db.notification.create({
          data: {
            businessId: o.businessId,
            event: overdue ? 'obligation.overdue' : 'obligation.due-soon',
            payload: {
              obligationId: o.id,
              message: overdue ? `${o.title} was due on ${when} and is not marked done.` : `${o.title} is due on ${when}.`,
            },
          },
        });
        await db.obligation.update({
          where: { id: o.id },
          data: overdue ? { notifiedOverdueAt: now, notifiedDueSoonAt: now } : { notifiedDueSoonAt: now },
        });
      }
      return pending.length;
    });
  }

  return { practices: practices.length, businesses, notified };
}
