import { Clock, MessageSquare } from 'lucide-react';
import { defineMessages, useIntl, type IntlShape } from 'react-intl';

/**
 * `ageDays` and `waitDays` were `${days} day${days === 1 ? '' : 's'}` — the
 * concatenated plural §12.6 forbids. It is not a style point: the branch encodes
 * "English has two plural forms and the second is the first plus an s", which is
 * false in most of the languages this product would be translated into. ICU
 * states the rule once and lets the locale answer it.
 *
 * `ageHours` and `waitHours` keep `{hours}h` rather than becoming a plural,
 * because "3h" is a unit abbreviation with no singular form to get wrong.
 */
const m = defineMessages({
  ageLastHour: { id: 'shell.smsCooldown.ageLastHour', defaultMessage: 'in the last hour' },
  ageHours: { id: 'shell.smsCooldown.ageHours', defaultMessage: '{hours}h ago' },
  ageDays: {
    id: 'shell.smsCooldown.ageDays',
    defaultMessage: '{count, plural, one {# day ago} other {# days ago}}',
  },
  waitNow: { id: 'shell.smsCooldown.waitNow', defaultMessage: 'now' },
  waitHours: { id: 'shell.smsCooldown.waitHours', defaultMessage: '{hours}h' },
  waitDays: {
    id: 'shell.smsCooldown.waitDays',
    defaultMessage: '{count, plural, one {# day} other {# days}}',
  },
  // The noun that fills `{what}` when a caller does not name one. Callers that
  // do — "chase", "reminder" — pass their own word.
  whatDefault: { id: 'shell.smsCooldown.whatDefault', defaultMessage: 'text' },
  noticeHeading: { id: 'shell.smsCooldown.noticeHeading', defaultMessage: 'Another {what} can go in {wait}' },
  noticeDetail: {
    id: 'shell.smsCooldown.noticeDetail',
    defaultMessage:
      '{recipient} was texted {age} and the link is still live. Sending again now repeats the same ask — change the wait under Settings → Chasing.',
  },
  chipTitle: {
    id: 'shell.smsCooldown.chipTitle',
    defaultMessage: 'The last {what} went {age}. Change the wait under Settings → Chasing.',
  },
  chipLabel: { id: 'shell.smsCooldown.chipLabel', defaultMessage: 'Next {what} in {wait}' },
});

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
 *
 * `intl` is a parameter rather than a hook call, and it is first for the reason
 * `scopeLabel` in Tables.tsx gives: this is a plain function, called from two
 * components here and from ChasesView, so a hook inside it would be a hook
 * outside a render.
 */
export function describeAge(intl: IntlShape, hours: number): string {
  if (hours <= 0) return intl.formatMessage(m.ageLastHour);
  if (hours < 24) return intl.formatMessage(m.ageHours, { hours });
  return intl.formatMessage(m.ageDays, { count: Math.round(hours / 24) });
}

/** "in 3 days" reads better than "in 71h" once it is past a day. */
export function formatWait(intl: IntlShape, hours: number): string {
  if (hours <= 0) return intl.formatMessage(m.waitNow);
  if (hours < 24) return intl.formatMessage(m.waitHours, { hours });
  return intl.formatMessage(m.waitDays, { count: Math.round(hours / 24) });
}

/**
 * The caution itself. Amber rather than red: nothing has gone wrong, the
 * person is simply being told to wait.
 */
export function SmsCooldownNotice({ cooldown, recipient, what }: {
  cooldown: Cooldown;
  recipient: string;
  /** What would be sent — "chase", "reminder", "approval request". Defaults to
   *  "text", applied below rather than as a parameter default so it can go
   *  through the catalogue. */
  what?: string;
}) {
  const intl = useIntl();
  if (!cooldown.blocked) return null;

  return (
    <div className="flex items-start gap-3 p-3.5 rounded-2xl border border-amber-400/25 bg-amber-400/[0.07]">
      <Clock size={15} className="text-amber-400 mt-0.5 shrink-0" />
      <div className="min-w-0">
        <div className="text-[13px] font-bold text-amber-400">
          {intl.formatMessage(m.noticeHeading, {
            what: what ?? intl.formatMessage(m.whatDefault),
            wait: formatWait(intl, cooldown.hoursLeft),
          })}
        </div>
        <p className="text-[12px] text-zinc-400 mt-0.5 leading-relaxed">
          {intl.formatMessage(m.noticeDetail, { recipient, age: describeAge(intl, cooldown.sentHoursAgo) })}
        </p>
      </div>
    </div>
  );
}

/** Inline version for a button row, where a full banner would not fit. */
export function SmsCooldownChip({ cooldown, what }: { cooldown: Cooldown; what?: string }) {
  const intl = useIntl();
  if (!cooldown.blocked) return null;
  const noun = what ?? intl.formatMessage(m.whatDefault);
  return (
    <span
      title={intl.formatMessage(m.chipTitle, { what: noun, age: describeAge(intl, cooldown.sentHoursAgo) })}
      className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-[11px] font-bold text-amber-400 bg-amber-400/10 border border-amber-400/25 whitespace-nowrap"
    >
      <MessageSquare size={11} />
      {intl.formatMessage(m.chipLabel, { what: noun, wait: formatWait(intl, cooldown.hoursLeft) })}
    </span>
  );
}
