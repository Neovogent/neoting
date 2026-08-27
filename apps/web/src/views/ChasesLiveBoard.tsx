import { useState, type ReactNode } from 'react';
import { AlertCircle, CheckCircle2, ChevronRight, Clock, MessageSquare, Send, Smartphone, X } from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { defineMessages, useIntl, type MessageDescriptor } from 'react-intl';
import type { ChaseDetectionEngine, ChaseState } from '@neoting/contracts/model';
import { useAppContext } from '../context/AppContext';
import type { LiveChase, LiveSms } from '../api/chases';
import { currency } from '../lib/resolver';

const m = defineMessages({
  heading: { id: 'chase.liveBoard.heading', defaultMessage: 'Missing Evidence' },
  subheading: {
    id: 'chase.liveBoard.subheading',
    defaultMessage: 'Live chases — detection, sending and auto-close are the server’s.',
  },
  openCount: { id: 'chase.liveBoard.openCount', defaultMessage: '{count} open' },
  closedCount: { id: 'chase.liveBoard.closedCount', defaultMessage: '{count} closed' },
  loading: { id: 'chase.liveBoard.loading', defaultMessage: 'Loading chases from the API…' },
  empty: {
    id: 'chase.liveBoard.empty',
    defaultMessage: 'No chases yet. Ask in chat to chase a client for their missing receipts — the Review → Approve card does the rest.',
  },
  columnClient: { id: 'chase.liveBoard.columnClient', defaultMessage: 'Client' },
  columnFoundBy: { id: 'chase.liveBoard.columnFoundBy', defaultMessage: 'Found by' },
  columnItems: { id: 'chase.liveBoard.columnItems', defaultMessage: 'Chasing' },
  columnState: { id: 'chase.liveBoard.columnState', defaultMessage: 'State' },
  columnLastSms: { id: 'chase.liveBoard.columnLastSms', defaultMessage: 'Last message' },
  columnAction: { id: 'chase.liveBoard.columnAction', defaultMessage: 'Action' },
  itemsSummary: {
    id: 'chase.liveBoard.itemsSummary',
    defaultMessage: '{first}{rest, plural, =0 {} one { + # more} other { + # more}}',
  },
  openAction: { id: 'chase.liveBoard.openAction', defaultMessage: 'Open' },
  autoClosed: { id: 'chase.liveBoard.autoClosed', defaultMessage: 'Auto-closed: {reason}' },

  detailItems: { id: 'chase.liveBoard.detailItems', defaultMessage: 'Requested items' },
  detailMessages: { id: 'chase.liveBoard.detailMessages', defaultMessage: 'Messages & events' },
  detailReceived: { id: 'chase.liveBoard.detailReceived', defaultMessage: 'Received' },
  detailWaiting: { id: 'chase.liveBoard.detailWaiting', defaultMessage: 'Waiting' },
  detailClosed: { id: 'chase.liveBoard.detailClosed', defaultMessage: 'Closed {at} — {reason}' },
  detailClosedByDoc: {
    id: 'chase.liveBoard.detailClosedByDoc',
    defaultMessage: 'Answered by document {documentId} — nobody had to do anything.',
  },
  detailNoMessages: {
    id: 'chase.liveBoard.detailNoMessages',
    defaultMessage: 'Nothing sent yet for this chase.',
  },
  closeDetail: { id: 'chase.liveBoard.closeDetail', defaultMessage: 'Close' },

  outboxHeading: { id: 'chase.liveBoard.outboxHeading', defaultMessage: 'Message outbox — the client’s phone' },
  outboxDemoTag: { id: 'chase.liveBoard.outboxDemoTag', defaultMessage: 'Demo surface' },
  outboxNote: {
    id: 'chase.liveBoard.outboxNote',
    defaultMessage: 'With the demo sender nothing leaves this machine — every approved message lands here instead, link and all.',
  },
  outboxEmpty: {
    id: 'chase.liveBoard.outboxEmpty',
    defaultMessage: 'Nothing sent yet. Approve a chase and its message arrives here.',
  },
  outboxError: { id: 'chase.liveBoard.outboxError', defaultMessage: 'Could not load the outbox — {error}' },
  outboxTo: { id: 'chase.liveBoard.outboxTo', defaultMessage: 'To {to} · {at}' },
  openPortalAction: { id: 'chase.liveBoard.openPortalAction', defaultMessage: 'Open the secure link' },
});

const mState = defineMessages({
  DETECTED: { id: 'chase.liveState.detected', defaultMessage: 'Detected' },
  PROPOSED: { id: 'chase.liveState.proposed', defaultMessage: 'Awaiting approval' },
  APPROVED: { id: 'chase.liveState.approved', defaultMessage: 'Approved' },
  SENT: { id: 'chase.liveState.sent', defaultMessage: 'Sent' },
  REMINDED: { id: 'chase.liveState.reminded', defaultMessage: 'Reminded' },
  ESCALATED: { id: 'chase.liveState.escalated', defaultMessage: 'Escalated' },
  CLOSED_RECEIVED: { id: 'chase.liveState.closedReceived', defaultMessage: 'Closed — received' },
  CLOSED_UNAVAILABLE: { id: 'chase.liveState.closedUnavailable', defaultMessage: 'Closed — unavailable' },
  CLOSED_DISMISSED: { id: 'chase.liveState.closedDismissed', defaultMessage: 'Closed — dismissed' },
  CLOSED_SUPPRESSED: { id: 'chase.liveState.closedSuppressed', defaultMessage: 'Closed — suppressed' },
});

const mEngine = defineMessages({
  UNMATCHED_TRANSACTION: { id: 'chase.liveEngine.unmatchedTransaction', defaultMessage: 'Bank transaction' },
  SUPPLIER_STATEMENT_GAP: { id: 'chase.liveEngine.supplierStatementGap', defaultMessage: 'Supplier statement' },
  STATEMENT_PERIOD_GAP: { id: 'chase.liveEngine.statementPeriodGap', defaultMessage: 'Statement gap' },
  // The enum value is the contract's (LAW) and cannot be renamed here; the
  // label carries the ID-honest reading — an entry with no supporting document.
  LEDGER_TXN_NO_ATTACHMENT: { id: 'chase.liveEngine.entryNoAttachment', defaultMessage: 'Entry with no document' },
  EXPECTED_RECURRING_MISSING: { id: 'chase.liveEngine.expectedRecurringMissing', defaultMessage: 'Recurring bill' },
});

const STATE_LABEL: Record<ChaseState, MessageDescriptor> = mState;
const ENGINE_LABEL: Record<ChaseDetectionEngine, MessageDescriptor> = mEngine;

const stateTone = (state: ChaseState): string =>
  state === 'CLOSED_RECEIVED'
    ? 'bg-emerald-500/10 text-emerald-400'
    : state.startsWith('CLOSED')
      ? 'bg-zinc-800 text-zinc-500'
      : state === 'ESCALATED'
        ? 'bg-brand/15 text-brand'
        : 'bg-amber-500/10 text-amber-400';

/**
 * The Chases workspace on real data (METH Stage 12): the server's chases,
 * their verbatim SMS history, and the demo outbox as "the client's phone".
 *
 * Read-only by design — composing a chase is the chat's Review → Approve
 * card, reminders and policy are post-demo server work, and auto-close is the
 * pipeline's; this board POLLS (in `api/chases.ts`), so a portal upload
 * closing a chase flips it live on screen.
 */
export function ChasesLiveBoard({
  chases,
  loading,
  outbox,
  outboxError,
  badge,
}: {
  chases: LiveChase[];
  loading: boolean;
  outbox: LiveSms[];
  outboxError: string | null;
  badge?: ReactNode;
}) {
  const intl = useIntl();
  const { businesses } = useAppContext();
  const [openId, setOpenId] = useState<string | null>(null);

  const nameFor = (businessId: string) => businesses.find((b) => b.id === businessId)?.name ?? businessId;
  const open = chases.filter((c) => c.open);
  const closed = chases.filter((c) => !c.open);
  const detail = chases.find((c) => c.id === openId) ?? null;

  return (
    <div className="flex-1 flex flex-col min-w-0 bg-ground h-full overflow-y-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
      <div className="px-4 md:px-10 py-4 md:py-8 shrink-0">
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div>
            <h1 className="font-sans text-2xl md:text-3xl font-semibold text-white tracking-tight">{intl.formatMessage(m.heading)}</h1>
            <p className="text-zinc-400 mt-2">{intl.formatMessage(m.subheading)}</p>
          </div>
          <div className="flex items-center gap-3 flex-wrap">
            {badge}
            <span className="px-4 py-2 rounded-full text-[12px] font-bold bg-amber-500/10 text-amber-400">
              {intl.formatMessage(m.openCount, { count: open.length })}
            </span>
            <span className="px-4 py-2 rounded-full text-[12px] font-bold bg-card border border-white/5 text-zinc-400">
              {intl.formatMessage(m.closedCount, { count: closed.length })}
            </span>
          </div>
        </div>
      </div>

      <div className="flex-1 px-2 md:px-4 pb-4 flex flex-col xl:flex-row gap-4 min-h-0">
        {/* The chase table */}
        <div className="flex-1 bg-white rounded-[28px] md:rounded-[40px] p-3 md:p-8 shadow-2xl border border-white/10 overflow-y-auto">
          {loading && (
            <div className="flex flex-col gap-3" aria-hidden>
              {[0, 1, 2].map((i) => (
                <div key={i} className="h-14 rounded-2xl bg-zinc-100 animate-pulse" />
              ))}
            </div>
          )}
          {!loading && chases.length === 0 && (
            <p className="px-4 py-16 text-center text-zinc-400 font-medium">{intl.formatMessage(m.empty)}</p>
          )}
          {/* Phones: a card per chase carrying the same facts and the same
              action, because the table's Action column clips well before
              360px — exactly what ChasesView fixes for the synthetic board. */}
          {!loading && chases.length > 0 && (
            <div className="md:hidden -mx-1 divide-y divide-zinc-100">
              {[...open, ...closed].map((chase) => {
                const first = chase.items[0];
                return (
                  <div key={chase.id} className="px-3 py-4 flex flex-col gap-2.5">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="font-bold text-zinc-900 text-[15px] truncate">{nameFor(chase.businessId)}</div>
                        <div className="text-[12px] text-zinc-500 font-medium">
                          {chase.state === 'CLOSED_RECEIVED' && chase.closedReason
                            ? intl.formatMessage(m.autoClosed, { reason: chase.closedReason })
                            : chase.lastSentAt ?? '—'}
                        </div>
                      </div>
                      <span className={`inline-flex px-3 py-1 rounded-full text-[11px] font-bold uppercase tracking-wide shrink-0 ${stateTone(chase.state)}`}>
                        {intl.formatMessage(STATE_LABEL[chase.state])}
                      </span>
                    </div>
                    <div className="text-[13px] font-semibold text-zinc-700 break-words">
                      {first
                        ? intl.formatMessage(m.itemsSummary, {
                            first: `${first.supplier} ${currency(first.amount)}`,
                            rest: chase.items.length - 1,
                          })
                        : '—'}
                    </div>
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="inline-flex px-2.5 py-1 rounded-full text-[10.5px] font-bold uppercase tracking-wide bg-zinc-100 text-zinc-500">
                        {intl.formatMessage(ENGINE_LABEL[chase.engine])}
                      </span>
                      <button
                        onClick={() => setOpenId(chase.id)}
                        className="ml-auto text-sm font-bold text-zinc-700 px-4 py-2.5 rounded-full bg-zinc-100 hover:bg-zinc-200 transition-colors inline-flex items-center gap-1"
                      >
                        {intl.formatMessage(m.openAction)}
                        <ChevronRight size={14} />
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
          {!loading && chases.length > 0 && (
            <table className="hidden md:table w-full text-left text-sm whitespace-nowrap">
              <thead className="text-[11px] uppercase tracking-widest font-bold text-zinc-400">
                <tr>
                  <th className="px-4 py-4">{intl.formatMessage(m.columnClient)}</th>
                  <th className="px-4 py-4">{intl.formatMessage(m.columnFoundBy)}</th>
                  <th className="px-4 py-4">{intl.formatMessage(m.columnItems)}</th>
                  <th className="px-4 py-4">{intl.formatMessage(m.columnState)}</th>
                  <th className="px-4 py-4">{intl.formatMessage(m.columnLastSms)}</th>
                  <th className="px-4 py-4 text-right">{intl.formatMessage(m.columnAction)}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-100">
                {[...open, ...closed].map((chase) => {
                  const first = chase.items[0];
                  return (
                    <tr key={chase.id} className="hover:bg-zinc-50 transition-colors">
                      <td className="px-4 py-5 font-bold text-zinc-900">{nameFor(chase.businessId)}</td>
                      <td className="px-4 py-5">
                        <span className="inline-flex px-2.5 py-1 rounded-full text-[10.5px] font-bold uppercase tracking-wide bg-zinc-100 text-zinc-500">
                          {intl.formatMessage(ENGINE_LABEL[chase.engine])}
                        </span>
                      </td>
                      <td className="px-4 py-5 text-zinc-700 font-semibold">
                        {first
                          ? intl.formatMessage(m.itemsSummary, {
                              first: `${first.supplier} ${currency(first.amount)}`,
                              rest: chase.items.length - 1,
                            })
                          : '—'}
                      </td>
                      <td className="px-4 py-5">
                        <span className={`inline-flex px-3 py-1 rounded-full text-[11px] font-bold uppercase tracking-wide ${stateTone(chase.state)}`}>
                          {intl.formatMessage(STATE_LABEL[chase.state])}
                        </span>
                      </td>
                      <td className="px-4 py-5 text-zinc-500 font-medium">
                        {chase.state === 'CLOSED_RECEIVED' && chase.closedReason
                          ? intl.formatMessage(m.autoClosed, { reason: chase.closedReason })
                          : chase.lastSentAt ?? '—'}
                      </td>
                      <td className="px-4 py-5 text-right">
                        <button
                          onClick={() => setOpenId(chase.id)}
                          className="text-sm font-bold text-zinc-600 hover:text-black px-3 py-2 rounded-full hover:bg-zinc-100 transition-colors inline-flex items-center gap-1"
                        >
                          {intl.formatMessage(m.openAction)}
                          <ChevronRight size={14} />
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>

        {/* The outbox panel — "the phone", clearly a demo surface */}
        <div className="xl:w-[380px] shrink-0 bg-card rounded-[40px] border border-white/5 shadow-2xl p-6 overflow-y-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          <div className="flex items-center gap-3 mb-2">
            <div className="w-9 h-9 rounded-xl bg-raised border border-white/5 flex items-center justify-center text-zinc-400 shadow-inner">
              <Smartphone size={16} />
            </div>
            <h3 className="font-sans font-bold text-lg text-white tracking-tight min-w-0">{intl.formatMessage(m.outboxHeading)}</h3>
            <span className="ml-auto shrink-0 px-2.5 py-1 rounded-full text-[10px] font-bold uppercase tracking-wider bg-amber-500/10 text-amber-400 border border-amber-500/20">
              {intl.formatMessage(m.outboxDemoTag)}
            </span>
          </div>
          <p className="text-[12px] text-zinc-500 mb-5">{intl.formatMessage(m.outboxNote)}</p>

          {outboxError && (
            <div className="flex items-center gap-2.5 px-4 py-3 rounded-2xl bg-red-500/10 border border-red-500/20 text-[13px] text-red-300 mb-4">
              <AlertCircle size={15} className="shrink-0" />
              <span className="min-w-0">{intl.formatMessage(m.outboxError, { error: outboxError })}</span>
            </div>
          )}
          {!outboxError && outbox.length === 0 && (
            <p className="text-[13px] text-zinc-500 px-2 py-8 text-center">{intl.formatMessage(m.outboxEmpty)}</p>
          )}

          <div className="flex flex-col gap-3">
            {outbox.map((sms) => (
              <div key={sms.id} className="rounded-2xl bg-ground/60 border border-white/5 p-4 shadow-inner">
                <div className="text-[11px] text-zinc-500 font-semibold mb-2 flex items-center gap-1.5">
                  <Send size={11} />
                  {intl.formatMessage(m.outboxTo, { to: sms.to, at: sms.at })}
                </div>
                <div className="text-[13px] text-zinc-200 font-mono leading-relaxed whitespace-pre-wrap break-words">
                  {sms.body}
                </div>
                {sms.portalPath && (
                  <button
                    onClick={() =>
                      // A phone-sized window: the demo's "open the link on the
                      // client's phone" beat, without leaving the machine.
                      window.open(sms.portalPath!, '_blank', 'noopener,width=390,height=760')
                    }
                    className="mt-3 inline-flex items-center gap-2 px-4 py-2 rounded-full text-[12px] font-bold text-white bg-brand hover:bg-brand-hover transition-colors"
                  >
                    <Smartphone size={13} />
                    {intl.formatMessage(m.openPortalAction)}
                  </button>
                )}
              </div>
            ))}
          </div>
        </div>
      </div>

      <AnimatePresence>
        {detail && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={() => setOpenId(null)}
            className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm flex items-start justify-center overflow-y-auto p-4 md:p-10 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
          >
            <motion.div
              initial={{ opacity: 0, y: 24, scale: 0.97 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: 24, scale: 0.97 }}
              onClick={(e) => e.stopPropagation()}
              className="relative w-full max-w-2xl"
            >
              <button
                onClick={() => setOpenId(null)}
                aria-label={intl.formatMessage(m.closeDetail)}
                className="absolute -top-3 -right-3 z-10 p-2 bg-card hover:bg-raised text-zinc-400 hover:text-white rounded-full border border-white/10 transition-colors shadow-lg"
              >
                <X size={18} />
              </button>
              <div className="border border-white/5 rounded-[32px] bg-card shadow-2xl overflow-hidden">
                <div className="p-6 flex items-start justify-between gap-4 border-b border-white/5">
                  <div className="min-w-0">
                    <h3 className="font-sans font-bold text-xl text-white tracking-tight truncate">{nameFor(detail.businessId)}</h3>
                    <p className="text-[12px] text-zinc-500 mt-1 font-semibold uppercase tracking-wider">
                      {intl.formatMessage(ENGINE_LABEL[detail.engine])} · {detail.createdAt}
                    </p>
                  </div>
                  <span className={`shrink-0 px-3 py-1.5 rounded-full text-[11px] font-bold uppercase tracking-wide ${stateTone(detail.state)}`}>
                    {intl.formatMessage(STATE_LABEL[detail.state])}
                  </span>
                </div>

                <div className="p-6 flex flex-col gap-6 max-h-[60vh] overflow-y-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
                  {detail.closedAt && detail.closedReason && (
                    <div className="text-[13px] text-emerald-400 bg-emerald-500/10 border border-emerald-500/20 rounded-2xl px-4 py-3">
                      {intl.formatMessage(m.detailClosed, { at: detail.closedAt, reason: detail.closedReason })}
                      {detail.closedByDocumentId && (
                        <span className="block text-[12px] text-emerald-400/80 mt-1">
                          {intl.formatMessage(m.detailClosedByDoc, { documentId: detail.closedByDocumentId })}
                        </span>
                      )}
                    </div>
                  )}

                  <section>
                    <h4 className="text-[11px] font-bold text-zinc-500 uppercase tracking-widest mb-3">{intl.formatMessage(m.detailItems)}</h4>
                    <div className="bg-ground/60 border border-white/5 rounded-2xl divide-y divide-white/5 shadow-inner">
                      {detail.items.map((item) => (
                        <div key={item.transactionId} className="px-4 py-3 flex items-center justify-between gap-3">
                          <div className="min-w-0">
                            <div className="text-sm font-bold text-white truncate">{item.supplier}</div>
                            <div className="text-[12px] text-zinc-500">{item.date} · {currency(item.amount)}</div>
                          </div>
                          {item.received ? (
                            <span className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-[11px] font-bold text-emerald-400 bg-emerald-500/10">
                              <CheckCircle2 size={11} />
                              {intl.formatMessage(m.detailReceived)}
                            </span>
                          ) : (
                            <span className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-[11px] font-bold text-zinc-500 bg-white/[0.03]">
                              <Clock size={11} />
                              {intl.formatMessage(m.detailWaiting)}
                            </span>
                          )}
                        </div>
                      ))}
                    </div>
                  </section>

                  <section>
                    <h4 className="text-[11px] font-bold text-zinc-500 uppercase tracking-widest mb-3">{intl.formatMessage(m.detailMessages)}</h4>
                    {detail.messages.length === 0 && (
                      <p className="text-[13px] text-zinc-500">{intl.formatMessage(m.detailNoMessages)}</p>
                    )}
                    <div className="flex flex-col gap-3">
                      {detail.messages.map((msg) => (
                        <div key={msg.id} className="flex items-start gap-3">
                          <div className="w-7 h-7 rounded-lg bg-raised border border-white/5 flex items-center justify-center text-zinc-500 shrink-0 mt-0.5">
                            {msg.channel === 'sms' ? <Send size={13} /> : <MessageSquare size={13} />}
                          </div>
                          <div className="min-w-0">
                            <div className="text-[13px] text-zinc-300 font-mono leading-relaxed whitespace-pre-wrap break-words">{msg.body}</div>
                            <div className="text-[11px] text-zinc-600 font-semibold mt-1">
                              {[msg.recipient, msg.deliveryState, msg.at].filter(Boolean).join(' · ')}
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>
                  </section>
                </div>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
