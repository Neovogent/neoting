import { expect, test } from 'vitest';

import {
  type ChaseClock,
  DEFAULT_CHASE_POLICY,
  isQuietHour,
  reminderBody,
  reminderStep,
  REMINDER_PREFIX,
} from './chase-policy.js';
import { signPortalLink, verifyPortalLink } from './portal-link.js';

const DAY = 24 * 60 * 60 * 1000;
const POLICY = DEFAULT_CHASE_POLICY; // 3 / 7 days, escalate 14, max 2, quiet 20:00–08:00
// 15 Oct 2026 is BST (UTC+1): 11:00Z is noon in London, 21:00Z is 22:00.
const SENT = new Date('2026-10-01T11:00:00Z');

const clock = (over: Partial<ChaseClock> = {}): ChaseClock => ({
  firstSentAt: SENT,
  lastSentAt: SENT,
  escalatedAt: null,
  schedule: { remindersSent: 0, lastAttemptAt: null, lastFailure: null },
  ...over,
});

test('quiet hours wrap midnight in Europe/London, and start === end means none', () => {
  expect(isQuietHour(new Date('2026-10-15T21:00:00Z'), POLICY)).toBe(true); // 22:00 BST
  expect(isQuietHour(new Date('2026-10-15T06:30:00Z'), POLICY)).toBe(true); // 07:30 BST
  expect(isQuietHour(new Date('2026-10-15T07:00:00Z'), POLICY)).toBe(false); // 08:00 BST
  expect(isQuietHour(new Date('2026-10-15T21:00:00Z'), { quietHoursStart: 9, quietHoursEnd: 9 })).toBe(false);
});

test('reminder 1 at day 3, reminder 2 at day 7, then the cap; never in quiet hours', () => {
  const at = (days: number, hourUtc = 11) => new Date(SENT.getTime() + days * DAY + (hourUtc - 11) * 3_600_000);
  expect(reminderStep(clock(), POLICY, at(2)).remind).toBe(false);
  expect(reminderStep(clock(), POLICY, at(3)).remind).toBe(true);
  expect(reminderStep(clock(), POLICY, at(3, 21)).remind).toBe(false); // 22:00 London
  const afterOne = clock({ lastSentAt: at(3), schedule: { remindersSent: 1, lastAttemptAt: null, lastFailure: null } });
  expect(reminderStep(afterOne, POLICY, at(6)).remind).toBe(false);
  expect(reminderStep(afterOne, POLICY, at(7)).remind).toBe(true);
  const capped = clock({ lastSentAt: at(7), schedule: { remindersSent: 2, lastAttemptAt: null, lastFailure: null } });
  expect(reminderStep(capped, POLICY, at(30)).remind).toBe(false);
});

test('a worker that was down never sends two reminders inside a day', () => {
  const now = new Date(SENT.getTime() + 10 * DAY);
  const justSent = clock({ lastSentAt: new Date(now.getTime() - 15 * 60 * 1000), schedule: { remindersSent: 1, lastAttemptAt: null, lastFailure: null } });
  expect(reminderStep(justSent, POLICY, now).remind).toBe(false);
});

test('escalates once, at escalateAfterDays', () => {
  expect(reminderStep(clock(), POLICY, new Date(SENT.getTime() + 13 * DAY)).escalate).toBe(false);
  expect(reminderStep(clock(), POLICY, new Date(SENT.getTime() + 14 * DAY)).escalate).toBe(true);
  expect(reminderStep(clock({ escalatedAt: SENT }), POLICY, new Date(SENT.getTime() + 20 * DAY)).escalate).toBe(false);
});

test('the reminder is the approved text verbatim, prefixed, with an expired link re-signed for the same chase', () => {
  const secret = 'test-secret';
  const old = signPortalLink({ chaseId: 'chs_1', expSeconds: 60 }, secret, SENT.getTime());
  const original = `American Burger Accounts: we're missing the receipt for Currys on 9 Aug. Upload securely: https://app.test/p/${old}`;
  const now = SENT.getTime() + 8 * DAY;
  const body = reminderBody(original, 'chs_1', secret, now);

  expect(body.startsWith(`${REMINDER_PREFIX}American Burger Accounts: we're missing the receipt for Currys on 9 Aug. Upload securely: https://app.test/p/`)).toBe(true);
  const token = body.slice(body.lastIndexOf('/') + 1);
  expect(token).not.toBe(old);
  expect(verifyPortalLink(token, secret, now)).toEqual({ ok: true, chaseId: 'chs_1' });

  // A live link is kept byte-for-byte, and the prefix is never doubled.
  const live = reminderBody(original, 'chs_1', secret, SENT.getTime() + 30_000);
  expect(live).toBe(`${REMINDER_PREFIX}${original}`);
  expect(reminderBody(live, 'chs_1', secret, SENT.getTime() + 30_000)).toBe(live);
});
