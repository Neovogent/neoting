import { useState } from 'react';
import { CalendarDays, Loader2, Send, X } from 'lucide-react';
import { defineMessages, useIntl } from 'react-intl';
import { requestStatementProposal } from '../../api/proposals';
import { Modal } from './Modal';

/**
 * Ask a client for a month's bank statement — the accountant's side of the
 * engine (c) chase (Phase 5). The `OffboardClientDialog` posture, exactly:
 * confirming CREATES a `chase.send` proposal and stops. The engine composes
 * the message server-side (month, working portal link, the client's PRIMARY
 * contact), review shows it verbatim, and only the firm's super admin
 * releases it (D44) — so the dialog's copy says "queued", never "sent".
 */
const m = defineMessages({
  title: { id: 'bank.requestStatement.title', defaultMessage: 'Request a bank statement' },
  detail: {
    id: 'bank.requestStatement.detail',
    defaultMessage:
      'Confirming queues a request for {client}. The message is composed at review — the month, a secure upload link, and the client’s registered contact — and it sends only when your practice’s super admin approves it.',
  },
  monthLabel: { id: 'bank.requestStatement.monthLabel', defaultMessage: 'Statement month' },
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
      <div className="p-6 flex flex-col gap-4">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-2xl bg-brand/10 text-brand flex items-center justify-center shrink-0">
            <CalendarDays size={18} />
          </div>
          <h3 className="font-sans font-bold text-lg text-white tracking-tight">{intl.formatMessage(m.title)}</h3>
        </div>
        <p className="text-[13px] text-zinc-400 leading-relaxed">{intl.formatMessage(m.detail, { client: clientName })}</p>

        <div>
          <label htmlFor="statement-month" className="block text-[11px] font-bold text-zinc-500 uppercase tracking-widest mb-2">
            {intl.formatMessage(m.monthLabel)}
          </label>
          <input
            id="statement-month"
            type="month"
            value={period}
            onChange={(e) => setPeriod(e.target.value)}
            className="w-full bg-ground border border-white/5 rounded-2xl px-4 py-3 text-sm font-semibold text-white focus:outline-none focus:border-brand transition-colors"
          />
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
              disabled={busy || !/^[0-9]{4}-(0[1-9]|1[0-2])$/.test(period)}
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
