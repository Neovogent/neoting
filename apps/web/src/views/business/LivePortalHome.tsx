import type { ComponentType, ReactNode } from 'react';
import { AlertCircle, Camera, CheckCircle2, Clock, FileText, ShieldCheck, Upload } from 'lucide-react';
import { defineMessages, useIntl } from 'react-intl';

import type { BusinessPortalHome, PortalSentPage } from '../../api/onboarding';
import { currency } from '../../lib/resolver';
import { PortalPill, PortalStatusPill } from './PortalStatusPill';
import { asksFrom, askKey, type PortalAsk } from './portalAsk';

/**
 * The portal home, on real data.
 *
 * What the business sees first: what its accountant is still waiting on, and
 * what it has already sent — the same pipeline the practice watches, phrased
 * from the client's side of the relationship.
 *
 * Three things on this screen are decisions:
 *
 * - **The two derived counters say what they are counting.** `Requested` and
 *   `Sent` are the server's own totals; `Processing` and `Needs a new copy` are
 *   counted over the page of documents this screen actually holds, so when
 *   there are more the caption says so rather than presenting a partial count
 *   as a total.
 * - **The reason on each ask is not a guess.** The server sends two lists, and
 *   what each list IS supplies the reason: an `item` is an open chase on a bank
 *   line (a payment left the account with no receipt), a `statementRequest` is
 *   a month of statement nobody has. No detection-engine field is invented.
 * - **Nothing here claims a ledger** (D42). A document that has been through is
 *   "filed" — dealt with by the accountant — and no copy says posted, synced,
 *   or sent to any accounting software, because in this release nothing is.
 */

const m = defineMessages({
  // ⚠ No first name. `GET /portal/context` carries the business, not the
  // person, and greeting a client by a name guessed out of the local part of
  // their email address is exactly the sort of confident wrongness this
  // product is sold against. The business name is in the header above.
  greeting: { id: 'portal.livePortalHome.greeting', defaultMessage: 'Hello there' },
  waitingOn: {
    id: 'portal.livePortalHome.waitingOn',
    defaultMessage: 'Your accountant is waiting on {count, plural, one {# document} other {# documents}}.',
  },
  nothingOutstanding: {
    id: 'portal.livePortalHome.nothingOutstanding',
    defaultMessage: 'Nothing outstanding — your accountant has everything they asked for.',
  },

  statRequested: { id: 'portal.livePortalHome.statRequested', defaultMessage: 'Requested' },
  statSent: { id: 'portal.livePortalHome.statSent', defaultMessage: 'Documents sent' },
  statProcessing: { id: 'portal.livePortalHome.statProcessing', defaultMessage: 'Processing' },
  statRejected: { id: 'portal.livePortalHome.statRejected', defaultMessage: 'Needs a new copy' },
  statPartialNote: {
    id: 'portal.livePortalHome.statPartialNote',
    defaultMessage:
      'Processing and “needs a new copy” count your {count} most recent documents. Requested and documents sent are totals.',
  },

  captureHeading: { id: 'portal.livePortalHome.captureHeading', defaultMessage: 'Capture a document' },
  captureDetail: {
    id: 'portal.livePortalHome.captureDetail',
    defaultMessage: 'Photograph a receipt or invoice with your camera',
  },
  uploadHeading: { id: 'portal.livePortalHome.uploadHeading', defaultMessage: 'Upload a file' },
  uploadDetail: {
    id: 'portal.livePortalHome.uploadDetail',
    defaultMessage: 'PDF, photo or spreadsheet from this device',
  },

  waitingPanelTitle: {
    id: 'portal.livePortalHome.waitingPanelTitle',
    defaultMessage: 'What your accountant is waiting for',
  },
  waitingPanelSubtitle: {
    id: 'portal.livePortalHome.waitingPanelSubtitle',
    defaultMessage: 'Found in your bank statements and in what your suppliers have sent',
  },
  waitingEmpty: {
    id: 'portal.livePortalHome.waitingEmpty',
    defaultMessage: 'Nothing outstanding. You are all caught up.',
  },
  askStatement: { id: 'portal.livePortalHome.askStatement', defaultMessage: '{month} bank statement' },
  askUnnamed: { id: 'portal.livePortalHome.askUnnamed', defaultMessage: 'A card payment' },
  askItemDetail: { id: 'portal.livePortalHome.askItemDetail', defaultMessage: '{date} · {amount} · {reason}' },
  askStatementDetail: { id: 'portal.livePortalHome.askStatementDetail', defaultMessage: '{reason}' },
  reasonBankTransaction: {
    id: 'portal.livePortalHome.reasonBankTransaction',
    defaultMessage: 'a payment left your account with no receipt',
  },
  reasonStatementGap: {
    id: 'portal.livePortalHome.reasonStatementGap',
    defaultMessage: 'a gap in your bank statements',
  },
  // ⚠ Every open ask is one the accountant has ASKED for — the server sends
  // only chased lines and open statement requests. There is no "spotted but
  // not yet chased" state on this endpoint, so there is no pill for one:
  // inventing the distinction would put a word on screen with nothing behind
  // it.
  askRequested: { id: 'portal.livePortalHome.askRequested', defaultMessage: 'Requested' },
  askReceived: { id: 'portal.livePortalHome.askReceived', defaultMessage: 'Got it' },
  askSendAction: { id: 'portal.livePortalHome.askSendAction', defaultMessage: 'Send it' },

  sentPanelTitle: { id: 'portal.livePortalHome.sentPanelTitle', defaultMessage: 'Recently sent' },
  sentPanelSubtitle: {
    id: 'portal.livePortalHome.sentPanelSubtitle',
    defaultMessage: 'The status changes as your accountant works through them',
  },
  sentEmpty: {
    id: 'portal.livePortalHome.sentEmpty',
    defaultMessage: 'Nothing sent yet. Photograph or upload your first document.',
  },
  sentLoading: { id: 'portal.livePortalHome.sentLoading', defaultMessage: 'Loading what you have sent…' },
  sentUnnamed: { id: 'portal.livePortalHome.sentUnnamed', defaultMessage: 'Not read yet' },
  sentDetail: { id: 'portal.livePortalHome.sentDetail', defaultMessage: '{date} · {amount}' },
  sentDetailNoAmount: { id: 'portal.livePortalHome.sentDetailNoAmount', defaultMessage: '{date}' },
  sentNoDate: { id: 'portal.livePortalHome.sentNoDate', defaultMessage: 'Sent {date}' },

  lastSent: { id: 'portal.livePortalHome.lastSent', defaultMessage: 'Last one {when}' },
  lastSentNever: { id: 'portal.livePortalHome.lastSentNever', defaultMessage: 'Nothing sent yet' },

  // ⚠ D42. "Your accountant reviews everything" — never "published to the
  // accounting software", which is what this sentence used to say on the
  // synthetic home and which nothing in this release does.
  privacyNote: {
    id: 'portal.livePortalHome.privacyNote',
    defaultMessage:
      'You only ever see your own business here. Your accountant does the coding and the filing — nothing you send goes anywhere until they have reviewed it.',
  },
});

export function LivePortalHome({
  home,
  documents,
  documentsFault,
  onGoCapture,
  onGoUpload,
  onSendFor,
}: {
  readonly home: BusinessPortalHome;
  readonly documents: PortalSentPage | null;
  readonly documentsFault: string | null;
  readonly onGoCapture: () => void;
  readonly onGoUpload: () => void;
  readonly onSendFor: (ask: PortalAsk) => void;
}) {
  const intl = useIntl();

  const asks = asksFrom(home);
  const outstanding = asks.filter((a) => !a.received);
  const rows = documents?.rows ?? [];
  const processing = rows.filter((d) => d.status === 'processing').length;
  const needsCopy = rows.filter((d) => d.status === 'needs_another_copy').length;

  return (
    <div className="p-4 md:p-8 max-w-3xl mx-auto flex flex-col gap-6 pb-safe-6">
      <div>
        <h1 className="font-sans text-2xl font-bold text-white tracking-tight">{intl.formatMessage(m.greeting)}</h1>
        <p className="text-[13px] text-zinc-500 mt-1">
          {home.awaitingYou > 0
            ? intl.formatMessage(m.waitingOn, { count: home.awaitingYou })
            : intl.formatMessage(m.nothingOutstanding)}
        </p>
      </div>

      <div data-tour="portal-home" className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Stat
          icon={AlertCircle}
          label={intl.formatMessage(m.statRequested)}
          value={home.awaitingYou}
          tone={home.awaitingYou > 0 ? 'amber' : 'zinc'}
        />
        <Stat icon={Upload} label={intl.formatMessage(m.statSent)} value={home.documentsSent} tone="zinc" />
        <Stat icon={Clock} label={intl.formatMessage(m.statProcessing)} value={processing} tone="zinc" />
        <Stat
          icon={AlertCircle}
          label={intl.formatMessage(m.statRejected)}
          value={needsCopy}
          tone={needsCopy > 0 ? 'red' : 'zinc'}
        />
      </div>
      {documents !== null && documents.hasMore && (
        <p className="text-[12px] text-zinc-600 leading-relaxed -mt-3">
          {intl.formatMessage(m.statPartialNote, { count: rows.length })}
        </p>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <button
          onClick={onGoCapture}
          className="flex items-center gap-4 p-5 rounded-2xl border border-white/5 bg-card hover:border-brand/40 transition-colors text-left"
        >
          <span className="w-12 h-12 rounded-2xl bg-brand flex items-center justify-center text-brand-on shrink-0 shadow-glow-tile">
            <Camera size={20} />
          </span>
          <span className="min-w-0">
            <span className="block text-sm font-bold text-white">{intl.formatMessage(m.captureHeading)}</span>
            <span className="block text-[12px] text-zinc-500 mt-0.5">{intl.formatMessage(m.captureDetail)}</span>
          </span>
        </button>
        <button
          onClick={onGoUpload}
          className="flex items-center gap-4 p-5 rounded-2xl border border-white/5 bg-card hover:border-brand/40 transition-colors text-left"
        >
          <span className="w-12 h-12 rounded-2xl bg-raised border border-white/5 flex items-center justify-center text-zinc-300 shrink-0">
            <Upload size={20} />
          </span>
          <span className="min-w-0">
            <span className="block text-sm font-bold text-white">{intl.formatMessage(m.uploadHeading)}</span>
            <span className="block text-[12px] text-zinc-500 mt-0.5">{intl.formatMessage(m.uploadDetail)}</span>
          </span>
        </button>
      </div>

      <Panel
        title={intl.formatMessage(m.waitingPanelTitle)}
        subtitle={intl.formatMessage(m.waitingPanelSubtitle)}
      >
        {outstanding.length === 0 ? (
          <Empty icon={CheckCircle2} message={intl.formatMessage(m.waitingEmpty)} />
        ) : (
          <ul className="flex flex-col gap-2">
            {asks.map((ask) => (
              <li
                key={askKey(ask)}
                className="flex items-center justify-between gap-3 p-4 rounded-2xl bg-ground/60 border border-white/5"
              >
                <div className="min-w-0">
                  <div className="text-sm font-bold text-white truncate">
                    {ask.kind === 'statement'
                      ? intl.formatMessage(m.askStatement, { month: monthName(intl, ask.period) })
                      : (ask.label ?? intl.formatMessage(m.askUnnamed))}
                  </div>
                  <div className="text-[12px] text-zinc-500 mt-0.5">
                    {ask.kind === 'statement'
                      ? intl.formatMessage(m.askStatementDetail, {
                          reason: intl.formatMessage(m.reasonStatementGap),
                        })
                      : intl.formatMessage(m.askItemDetail, {
                          date: ask.date,
                          amount: currency(Math.abs(ask.amount)),
                          reason: intl.formatMessage(m.reasonBankTransaction),
                        })}
                  </div>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  {ask.received ? (
                    <PortalPill tone="green">{intl.formatMessage(m.askReceived)}</PortalPill>
                  ) : (
                    <>
                      <PortalPill tone="amber">{intl.formatMessage(m.askRequested)}</PortalPill>
                      <button
                        onClick={() => onSendFor(ask)}
                        className="px-4 py-2 rounded-full text-[12px] font-bold text-brand-on bg-brand hover:bg-brand-hover transition-colors"
                      >
                        {intl.formatMessage(m.askSendAction)}
                      </button>
                    </>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </Panel>

      <Panel title={intl.formatMessage(m.sentPanelTitle)} subtitle={intl.formatMessage(m.sentPanelSubtitle)}>
        {documentsFault !== null ? (
          <p role="alert" className="text-[13px] text-red-400 leading-relaxed py-2">
            {documentsFault}
          </p>
        ) : documents === null ? (
          <div className="flex flex-col gap-2" role="status" aria-busy="true">
            <span className="sr-only">{intl.formatMessage(m.sentLoading)}</span>
            <div className="h-14 rounded-2xl bg-white/[0.04] animate-pulse" />
            <div className="h-14 rounded-2xl bg-white/[0.04] animate-pulse" />
          </div>
        ) : rows.length === 0 ? (
          <Empty icon={FileText} message={intl.formatMessage(m.sentEmpty)} />
        ) : (
          <ul className="flex flex-col gap-2">
            {rows.slice(0, 8).map((doc) => (
              <li
                key={doc.id}
                className="flex items-center justify-between gap-3 p-4 rounded-2xl bg-ground/60 border border-white/5"
              >
                <div className="min-w-0">
                  {/* Untrusted content: extracted off a scanned page by a
                      model, rendered as text and nothing else. */}
                  <div className="text-sm font-bold text-white truncate">
                    {doc.supplier ?? intl.formatMessage(m.sentUnnamed)}
                  </div>
                  <div className="text-[12px] text-zinc-500 mt-0.5 truncate">
                    {doc.date === null
                      ? intl.formatMessage(m.sentNoDate, {
                          date: intl.formatDate(doc.receivedAt, {
                            day: 'numeric',
                            month: 'short',
                            timeZone: 'Europe/London',
                          }),
                        })
                      : doc.total === null
                        ? intl.formatMessage(m.sentDetailNoAmount, { date: doc.date })
                        : intl.formatMessage(m.sentDetail, {
                            date: doc.date,
                            amount: currency(Math.abs(doc.total)),
                          })}
                  </div>
                </div>
                <PortalStatusPill status={doc.status} />
              </li>
            ))}
          </ul>
        )}
        <p className="text-[12px] text-zinc-600 mt-4">
          {home.lastDocumentAt === null
            ? intl.formatMessage(m.lastSentNever)
            : intl.formatMessage(m.lastSent, {
                when: intl.formatDate(home.lastDocumentAt, {
                  day: 'numeric',
                  month: 'short',
                  year: 'numeric',
                  timeZone: 'Europe/London',
                }),
              })}
        </p>
      </Panel>

      <div className="flex items-start gap-3 p-4 rounded-2xl border border-white/5 bg-card/60">
        <ShieldCheck size={16} className="text-zinc-500 mt-0.5 shrink-0" />
        <p className="text-[12px] text-zinc-500 leading-relaxed">{intl.formatMessage(m.privacyNote)}</p>
      </div>
    </div>
  );
}

/** `2026-08` → "August 2026", in the client's own locale. */
export function monthName(intl: { formatDate: (value: Date, options: Intl.DateTimeFormatOptions) => string }, period: string): string {
  return intl.formatDate(new Date(`${period}-01T12:00:00.000Z`), {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

function Stat({
  icon: Icon,
  label,
  value,
  tone,
}: {
  icon: ComponentType<{ size?: number; className?: string }>;
  label: string;
  value: number;
  tone: 'amber' | 'red' | 'zinc';
}) {
  const tones = { amber: 'text-amber-400', red: 'text-red-400', zinc: 'text-white' };
  return (
    <div className="p-4 rounded-2xl border border-white/5 bg-card">
      <Icon size={16} className="text-zinc-500" />
      <div className={`text-2xl font-bold mt-3 tracking-tight ${tones[tone]}`}>{value}</div>
      <div className="text-[11px] text-zinc-500 font-bold uppercase tracking-wider mt-1">{label}</div>
    </div>
  );
}

export function Panel({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: string;
  children: ReactNode;
}) {
  return (
    <section className="rounded-[28px] border border-white/5 bg-card p-5 md:p-6">
      <div className="mb-4">
        <h2 className="text-[15px] font-bold text-white tracking-tight">{title}</h2>
        {subtitle !== undefined && <p className="text-[12px] text-zinc-500 mt-1">{subtitle}</p>}
      </div>
      {children}
    </section>
  );
}

export function Empty({
  icon: Icon,
  message,
}: {
  icon: ComponentType<{ size?: number; className?: string }>;
  message: string;
}) {
  return (
    <div className="flex flex-col items-center justify-center py-10 text-center">
      <Icon size={24} className="text-zinc-700" />
      <p className="text-[13px] text-zinc-500 mt-3 font-medium">{message}</p>
    </div>
  );
}
