import { Clock, MessageSquare } from 'lucide-react';

/**
 * How long before another text can go to the same person, and a warning that
 * says so before they press the button rather than after.
 *
 * A chase is one text asking someone to do something they already know about.
 * Sending it again an hour later does not add information — it just costs the
 * accountant's standing with their client, and the client eventually stops
 * reading any of it. So the gap between messages is a policy the practice sets
 * once, and the UI shows the clock rather than quietly refusing.
 */
export interface Cooldown {
  /** Whole hours until another message is allowed. 0 means it can go now. */
  hoursLeft: number;
  blocked: boolean;
  /** Whole hours since the last one went, for saying how recent it was. */
  sentHoursAgo: number;
}

export function cooldownFor(lastSentMs: number | undefined, waitHours: number, now = Date.now()): Cooldown {
  if (!lastSentMs) return { hoursLeft: 0, blocked: false, sentHoursAgo: 0 };
  const elapsed = (now - lastSentMs) / 3_600_000;
  const hoursLeft = Math.max(0, Math.ceil(waitHours - elapsed));
  return { hoursLeft, blocked: hoursLeft > 0, sentHoursAgo: Math.max(0, Math.floor(elapsed)) };
}

/**
 * How long ago something went, as a phrase that ends a sentence.
 *
 * `formatWait` answers "how long until", and reusing it for the past produced
 * "the link sent now ago is still live" — the zero case has no sensible "ago"
 * form, so it gets its own words.
 */
export function describeAge(hours: number): string {
  if (hours <= 0) return 'in the last hour';
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? '' : 's'} ago`;
}

/** "in 3 days" reads better than "in 71h" once it is past a day. */
export function formatWait(hours: number): string {
  if (hours <= 0) return 'now';
  if (hours < 24) return `${hours}h`;
  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? '' : 's'}`;
}

/**
 * The caution itself. Amber rather than red: nothing has gone wrong, the
 * person is simply being told to wait.
 */
export function SmsCooldownNotice({ cooldown, recipient, what = 'text' }: {
  cooldown: Cooldown;
  recipient: string;
  /** What would be sent — "chase", "reminder", "approval request". */
  what?: string;
}) {
  if (!cooldown.blocked) return null;

  return (
    <div className="flex items-start gap-3 p-3.5 rounded-2xl border border-amber-400/25 bg-amber-400/[0.07]">
      <Clock size={15} className="text-amber-400 mt-0.5 shrink-0" />
      <div className="min-w-0">
        <div className="text-[13px] font-bold text-amber-400">
          Another {what} can go in {formatWait(cooldown.hoursLeft)}
        </div>
        <p className="text-[12px] text-zinc-400 mt-0.5 leading-relaxed">
          {recipient} was texted {describeAge(cooldown.sentHoursAgo)} and the link is still live. Sending again now repeats the same ask — change the wait under Settings → Chasing.
        </p>
      </div>
    </div>
  );
}

/** Inline version for a button row, where a full banner would not fit. */
export function SmsCooldownChip({ cooldown, what = 'text' }: { cooldown: Cooldown; what?: string }) {
  if (!cooldown.blocked) return null;
  return (
    <span
      title={`The last ${what} went ${describeAge(cooldown.sentHoursAgo)}. Change the wait under Settings → Chasing.`}
      className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-[11px] font-bold text-amber-400 bg-amber-400/10 border border-amber-400/25 whitespace-nowrap"
    >
      <MessageSquare size={11} />
      Next {what} in {formatWait(cooldown.hoursLeft)}
    </span>
  );
}
