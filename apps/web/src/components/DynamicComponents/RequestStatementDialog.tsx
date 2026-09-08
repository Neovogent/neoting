import { useState } from 'react';
import { CalendarDays, Loader2, Send, X } from 'lucide-react';
import { defineMessages, useIntl } from 'react-intl';
import { holdsReleaseAuthority } from '../../api/auth';
import { useAppContext } from '../../context/AppContext';
import { sendStatementRequestNow } from '../../api/proposals';
import { Modal } from './Modal';
import { ukLongDate, ukLongMonth, UkDateField, UkMonthField } from './UkDateField';

/**
 * Ask a client for a period's bank statement — the accountant's side of the
 * engine (c) chase (Phase 5). The engine composes the message server-side
 * (month, working portal link, the client's PRIMARY contact) and review shows
 * it verbatim.
 *
 * ⚠ **Confirming SENDS it, since 8 Sep 2026 (item 3).** It used to create the
 * proposal and stop, because `chase.send` was tier 1 and only the firm's super
 * admin could release it — which is precisely the ceremony the owner removed:
 * *"only publishing an entry will require approval by default; a normal email
 * chase is going under approval [and should not]"*. `sendStatementRequestNow`
 * drives the same three calls the server has always required — create, open
 * the review, approve echoing its hash — so the proposal, the rendered review
 * and the audit row all still exist. What is gone is the wait.
 *
 * The role-aware sentence from item 24 stays, reworded: neither branch claims
 * a permission, because the server is still the rule and a member the server
 * refuses meets `NT-PRM-001` here with its own words.
 */
const m = defineMessages({
  // The delivery channel (review item 16). The owner ruled on 7 Sep 2026:
  // SHOW the SMS option, greyed out — so the accountant can see the product
  // intends to text one day, rather than wondering whether it silently did.
  sendByLabel: { id: 'chases.requestStatement.sendByLabel', defaultMessage: 'Send by' },
  sendByEmail: { id: 'chases.requestStatement.sendByEmail', defaultMessage: 'Email' },
  sendBySms: { id: 'chases.requestStatement.sendBySms', defaultMessage: 'Text message' },
  sendBySmsWhy: {
    id: 'chases.requestStatement.sendBySmsWhy',
    defaultMessage: 'Not available yet — this release sends document requests by email.',
  },
  title: { id: 'bank.requestStatement.title', defaultMessage: 'Request a bank statement' },
  detail: {
    id: 'bank.requestStatement.detail',
    defaultMessage:
      'Confirming sends the request to {client}. The message is composed here — the period, a secure upload link, and the client’s registered contact — and it is recorded in Approvals with your name on it.',
  },
  /**
   * Item 24 — the same sentence for somebody who holds the release. It says
   * what the flow does next, never *"you have permission"*: the server is the
   * rule (`NT-PRM-001` on approve) and a `/me` thirty seconds stale is exactly
   * how its refusal arrives.
   */
  detailYours: {
    id: 'bank.requestStatement.detailYours',
    defaultMessage:
      'Confirming sends the request to {client}. The message is composed here — the period, a secure upload link, and the client’s registered contact — and it is recorded in Approvals with your name on it.',
  },
  monthLabel: { id: 'bank.requestStatement.monthLabel', defaultMessage: 'Which month?' },
  /* ── The period, review item 16, the owner's choice of 8 Sep 2026 ─────────
     He was offered three shapes and picked "start and end date", for the
     reason that makes it the right one: a range already IS a month, a quarter,
     a year or a single day, so one control answers all four asks without four
     modes to explain. A whole month stays its own choice because it is the
     common case and picking "1 Aug" and "31 Aug" by hand to mean August is
     work the product can do for you. */
  periodLabel: { id: 'bank.requestStatement.periodLabel', defaultMessage: 'Which period?' },
  modeMonth: { id: 'bank.requestStatement.modeMonth', defaultMessage: 'A whole month' },
  modeRange: { id: 'bank.requestStatement.modeRange', defaultMessage: 'Between two dates' },
  fromLabel: { id: 'bank.requestStatement.fromLabel', defaultMessage: 'From' },
  toLabel: { id: 'bank.requestStatement.toLabel', defaultMessage: 'To' },
  rangeChosen: {
    id: 'bank.requestStatement.rangeChosen',
    defaultMessage: 'Asking for the statement covering {from} to {to}. Both days are included.',
  },
  rangeBackwards: {
    id: 'bank.requestStatement.rangeBackwards',
    defaultMessage: 'The end date is before the start date — swap them.',
  },
  // ⚠ The confirm's gate is now the CONTROL's — a month and a year are chosen
  // or they are not — so this line no longer has to explain a regex. It says
  // what will be asked for, in words, which is what the accountant is about to
  // put their name to.
  monthChosen: { id: 'bank.requestStatement.monthChosen', defaultMessage: 'Asking for the {month} statement.' },
  confirm: { id: 'bank.requestStatement.confirm', defaultMessage: 'Queue the request' },
  cancel: { id: 'bank.requestStatement.cancel', defaultMessage: 'Cancel' },
  // ⚠ "Sent", not "queued", since 8 Sep 2026 (item 3): the owner took the
  // chase out of the release tier, so this act finishes where it is performed
  // — create, review, approve, all three server-side behind this one press.
  // The proposal and its audit row are still written; the WAIT is what went.
  queued: {
    id: 'bank.requestStatement.queued',
    defaultMessage: 'Request sent — the client has been emailed their secure upload link.',
  },
  failed: {
    id: 'bank.requestStatement.failed',
    defaultMessage: 'The request could not be sent. Nothing has gone to the client — try again.',
  },
});

export default function RequestStatementDialog({
  businessId,
  clientName,
  onClose,
}: {
  businessId: string;
  clientName: string;
  onClose: () => void;
}) {
  const intl = useIntl();
  // D44, item 24 — the one shared fact, so this dialog and its three
  // siblings cannot make different claims about the same person.
  const { session } = useAppContext();
  const canRelease = holdsReleaseAuthority(session);
  const [mode, setMode] = useState<'month' | 'range'>('month');
  const [month, setMonth] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [busy, setBusy] = useState(false);
  const [queued, setQueued] = useState(false);
  const [failed, setFailed] = useState(false);

  /**
   * The one string the wire takes — `YYYY-MM` or `YYYY-MM-DD..YYYY-MM-DD`,
   * inclusive at both ends. Empty whenever the choice is incomplete, which is
   * also what disables the confirm: the gate is the CONTROL's, never a regex
   * the accountant has to discover.
   */
  const backwards = mode === 'range' && from !== '' && to !== '' && to < from;
  const period = mode === 'month' ? month : from !== '' && to !== '' && !backwards ? `${from}..${to}` : '';

  const confirm = async () => {
    setBusy(true);
    setFailed(false);
    try {
      await sendStatementRequestNow(businessId, period);
      setQueued(true);
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal onClose={onClose} label={intl.formatMessage(m.title)}>
      {/* The card surface every other `Modal` child draws. Without it this
          dialog was bare text on the scrim, and — before the frame forced
          `w-full` — a wrapper that shrink-wrapped to its own longest line. */}
      <div className="w-full border border-white/5 rounded-[32px] bg-card shadow-2xl p-6 flex flex-col gap-4">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-2xl bg-brand/10 text-brand flex items-center justify-center shrink-0">
            <CalendarDays size={18} />
          </div>
          <h3 className="font-sans font-bold text-lg text-white tracking-tight">{intl.formatMessage(m.title)}</h3>
        </div>
        <p className="text-[13px] text-zinc-400 leading-relaxed">{intl.formatMessage(canRelease ? m.detailYours : m.detail, { client: clientName })}</p>

        <div>
          <span className="block text-[11px] font-bold text-zinc-500 uppercase tracking-widest mb-2">
            {intl.formatMessage(m.periodLabel)}
          </span>
          <div className="flex items-center gap-2 flex-wrap mb-3">
            {(['month', 'range'] as const).map((option) => (
              <button
                key={option}
                type="button"
                onClick={() => setMode(option)}
                aria-pressed={mode === option}
                className={`px-3 py-1.5 rounded-full text-[12px] font-bold transition-colors ${
                  mode === option
                    ? 'bg-brand/10 text-brand border border-brand/25'
                    : 'text-zinc-400 border border-white/5 hover:text-white'
                }`}
              >
                {intl.formatMessage(option === 'month' ? m.modeMonth : m.modeRange)}
              </button>
            ))}
          </div>
          <label htmlFor="statement-month" className="sr-only">
            {intl.formatMessage(m.monthLabel)}
          </label>
          {/*
            Review item 16. This was `<input type="month">`, which renders as an
            unlabelled free-text box in several browsers — the reviewer's
            screenshot is that box with `12` typed into it and the confirm greyed
            out against a `YYYY-MM` regex he had no way to discover. Two selects,
            with the month as a NAME: nothing to parse and nothing to guess at.

            ⚠ A RANGE SHIPS TOO, since 8 Sep 2026 — `statementPeriod` now takes
            `YYYY-MM-DD..YYYY-MM-DD` beside `YYYY-MM`, and a range already IS a
            quarter, a year or a single day, which is why the owner chose it over
            four separate modes. The month stays its own choice because picking
            "1 Aug" and "31 Aug" by hand to mean August is work the product can
            do for you.
          */}
          {mode === 'month' ? (
            <UkMonthField id="statement-month" value={month} onChange={setMonth} />
          ) : (
            <div className="grid grid-cols-1 @sm:grid-cols-2 gap-3">
              <div>
                <label htmlFor="statement-from" className="block text-[11px] font-bold text-zinc-500 uppercase tracking-widest mb-1.5">
                  {intl.formatMessage(m.fromLabel)}
                </label>
                <UkDateField id="statement-from" value={from} onChange={setFrom} />
              </div>
              <div>
                <label htmlFor="statement-to" className="block text-[11px] font-bold text-zinc-500 uppercase tracking-widest mb-1.5">
                  {intl.formatMessage(m.toLabel)}
                </label>
                <UkDateField id="statement-to" value={to} onChange={setTo} />
              </div>
            </div>
          )}
          {/* The ask restated in words — what the accountant is putting their
              name to, not the ISO string that will travel. */}
          {mode === 'month' && month !== '' && (
            <p className="text-[12px] font-semibold text-zinc-400 mt-2">
              {intl.formatMessage(m.monthChosen, { month: ukLongMonth(intl, month) })}
            </p>
          )}
          {mode === 'range' && backwards && (
            <p role="alert" className="text-[12px] font-semibold text-amber-400 mt-2">
              {intl.formatMessage(m.rangeBackwards)}
            </p>
          )}
          {mode === 'range' && period !== '' && (
            <p className="text-[12px] font-semibold text-zinc-400 mt-2">
              {intl.formatMessage(m.rangeChosen, { from: ukLongDate(intl, from), to: ukLongDate(intl, to) })}
            </p>
          )}
        </div>

        {/* ⚠ The delivery channel, SHOWN with SMS disabled — the owner's ruling
            of 7 Sep 2026 on review item 16, taken over the alternative of
            hiding it. The reasoning matters because launch M8 swept every
            claim of texting out of this app: a LIVE tickbox offering SMS would
            be exactly the lie M8 removed. A DISABLED one wearing its reason is
            a different statement — it says the product knows about the channel
            and this release does not have it, which is true, and it stops an
            accountant wondering whether a text was silently sent as well.

            It is deliberately not a form control that submits anything: email
            is the only value, so there is nothing to choose and nothing rides
            on the request. The day SMS_SENDER=aws ships to a practice, this
            becomes a real pair and the request grows a channel field. */}
        <div className="space-y-2">
          <span className="text-[13px] font-bold text-zinc-400 block">{intl.formatMessage(m.sendByLabel)}</span>
          <div className="flex items-center gap-2 flex-wrap">
            <span className="px-3 py-1.5 rounded-full text-[12px] font-bold bg-brand/10 text-brand border border-brand/25">
              {intl.formatMessage(m.sendByEmail)}
            </span>
            <span
              title={intl.formatMessage(m.sendBySmsWhy)}
              aria-disabled="true"
              className="px-3 py-1.5 rounded-full text-[12px] font-bold text-zinc-600 border border-white/5 opacity-50 cursor-not-allowed"
            >
              {intl.formatMessage(m.sendBySms)}
            </span>
          </div>
          <p className="text-[12px] text-zinc-500">{intl.formatMessage(m.sendBySmsWhy)}</p>
        </div>

        {queued ? (
          <p role="status" className="text-[13px] font-semibold text-brand">
            {intl.formatMessage(m.queued)}
          </p>
        ) : (
          <div className="flex items-center justify-end gap-3">
            {failed && (
              <p role="alert" className="mr-auto text-[12px] text-red-400">
                {intl.formatMessage(m.failed)}
              </p>
            )}
            <button
              onClick={onClose}
              className="flex items-center gap-2 px-4 py-2.5 rounded-full text-[13px] font-bold text-zinc-400 hover:text-white transition-colors"
            >
              <X size={14} />
              {intl.formatMessage(m.cancel)}
            </button>
            <button
              onClick={() => void confirm()}
              disabled={busy || period === ''}
              className="flex items-center gap-2 px-5 py-2.5 rounded-full text-[13px] font-bold text-white bg-brand hover:bg-brand-hover disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            >
              {busy ? <Loader2 size={14} className="animate-spin" /> : <Send size={14} />}
              {intl.formatMessage(m.confirm)}
            </button>
          </div>
        )}
      </div>
    </Modal>
  );
}
