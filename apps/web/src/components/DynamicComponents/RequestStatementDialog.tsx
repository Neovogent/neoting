import { useState } from 'react';
import { CalendarDays, Loader2, Send, X } from 'lucide-react';
import { defineMessages, useIntl } from 'react-intl';
import { holdsReleaseAuthority } from '../../api/auth';
import { useAppContext } from '../../context/AppContext';
import { requestStatementProposal } from '../../api/proposals';
import { Modal } from './Modal';
import { ukLongMonth, UkMonthField } from './UkDateField';

/**
 * Ask a client for a month's bank statement — the accountant's side of the
 * engine (c) chase (Phase 5). The `OffboardClientDialog` posture, exactly:
 * confirming CREATES a `chase.send` proposal and stops. The engine composes
 * the message server-side (month, working portal link, the client's PRIMARY
 * contact), review shows it verbatim, and only the firm's super admin
 * releases it (D44) — so the dialog's copy says "queued", never "sent".
 *
 * Since review item 24 that sentence is ROLE-AWARE: a member reads who
 * releases, the super admin reads that it sends once THEY have read the
 * review. Neither claims a permission — the server is still the rule.
 */
const m = defineMessages({
  title: { id: 'bank.requestStatement.title', defaultMessage: 'Request a bank statement' },
  detail: {
    id: 'bank.requestStatement.detail',
    defaultMessage:
      'Confirming queues a request for {client}. The message is composed at review — the month, a secure upload link, and the client’s registered contact — and it sends only when your practice’s super admin approves it.',
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
      'Confirming queues a request for {client}. The message is composed at review — the month, a secure upload link, and the client’s registered contact — and it sends once you have read that review and approved it in Approvals.',
  },
  monthLabel: { id: 'bank.requestStatement.monthLabel', defaultMessage: 'Which month?' },
  // ⚠ The confirm's gate is now the CONTROL's — a month and a year are chosen
  // or they are not — so this line no longer has to explain a regex. It says
  // what will be asked for, in words, which is what the accountant is about to
  // put their name to.
  monthChosen: { id: 'bank.requestStatement.monthChosen', defaultMessage: 'Asking for the {month} statement.' },
  confirm: { id: 'bank.requestStatement.confirm', defaultMessage: 'Queue the request' },
  cancel: { id: 'bank.requestStatement.cancel', defaultMessage: 'Cancel' },
  queued: {
    id: 'bank.requestStatement.queued',
    defaultMessage: 'Request queued — it sends when it is approved in Approvals.',
  },
  failed: {
    id: 'bank.requestStatement.failed',
    defaultMessage: 'The request could not be queued. Nothing was sent — try again.',
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
  const [period, setPeriod] = useState('');
  const [busy, setBusy] = useState(false);
  const [queued, setQueued] = useState(false);
  const [failed, setFailed] = useState(false);

  const confirm = async () => {
    setBusy(true);
    setFailed(false);
    try {
      await requestStatementProposal(businessId, period);
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
          <label htmlFor="statement-month" className="block text-[11px] font-bold text-zinc-500 uppercase tracking-widest mb-2">
            {intl.formatMessage(m.monthLabel)}
          </label>
          {/*
            Review item 16. This was `<input type="month">`, which renders as an
            unlabelled free-text box in several browsers — the reviewer's
            screenshot is that box with `12` typed into it and the confirm greyed
            out against a `YYYY-MM` regex he had no way to discover. Two selects,
            with the month as a NAME: nothing to parse and nothing to guess at.

            ⚠ Still ONE MONTH, not a range. `chase.send`'s `statementPeriod` is a
            single `YYYY-MM` on the wire and the engine composes the message from
            it — so the rest of item 16's ask (a range, a year, a single date;
            the SMS/email checkboxes; the preview step) is a contract and engine
            widening, written up in the review notes rather than half-built here.
          */}
          <UkMonthField id="statement-month" value={period} onChange={setPeriod} />
          {period !== '' && (
            <p className="text-[12px] font-semibold text-zinc-400 mt-2">
              {intl.formatMessage(m.monthChosen, { month: ukLongMonth(intl, period) })}
            </p>
          )}
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
