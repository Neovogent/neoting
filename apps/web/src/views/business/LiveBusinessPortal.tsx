import { useRef, useState } from 'react';
import { ArrowLeft, Building2, CheckCircle2, Clock, FileText, LogIn, Mail, UploadCloud } from 'lucide-react';
import { defineMessages, useIntl } from 'react-intl';

import { currency } from '../../lib/resolver';
import { PrivacyNoticeLink } from '../legal/PrivacyNoticeLink';
import { useBusinessPortalSession } from './useBusinessPortalSession';

/**
 * The business portal, against the real API.
 *
 * ## What this is, and what the surface beside it is
 *
 * `BusinessPortal` (synthetic) is the prototype's four-tab shell driven by
 * `AppContext.businessAccounts` — a seeded array that is EMPTY when the API is
 * on. So with a live session that surface rendered a sign-in screen which
 * created an account in local React state and vanished on reload: there was no
 * business portal at all, only a drawing of one.
 *
 * This is the same journey against the contract: sign in by email and a
 * six-digit code, see what your accountant is waiting for, and send paperwork.
 *
 * ## Three rules this screen may not break
 *
 * - **It may not say whether an account exists.** `POST /portal/sign-in-codes`
 *   answers `202` whatever happened, so the code step is reached even for an
 *   address nothing was sent to. Every phrasing here is conditional.
 * - **It may not imply a ledger** (D42). Nothing is "posted", "synced" or "sent
 *   to VT" — a client sends paperwork to their accountant, and that is all this
 *   says.
 * - **It says "emailed", never "texted"** (D45/§24.5). There is no SMS on this
 *   journey.
 */

const m = defineMessages({
  signInTitle: { id: 'portal.liveBusinessPortal.signInTitle', defaultMessage: 'Your business portal' },
  signInSubtitle: {
    id: 'portal.liveBusinessPortal.signInSubtitle',
    defaultMessage: 'Send paperwork to your accountant, and see what they are still waiting for.',
  },
  emailLabel: { id: 'portal.liveBusinessPortal.emailLabel', defaultMessage: 'Your email address' },
  emailPlaceholder: { id: 'portal.liveBusinessPortal.emailPlaceholder', defaultMessage: 'you@yourbusiness.co.uk' },
  emailHint: {
    id: 'portal.liveBusinessPortal.emailHint',
    defaultMessage: 'Use the address your accountant registered for you.',
  },
  sendCodeAction: { id: 'portal.liveBusinessPortal.sendCodeAction', defaultMessage: 'Email me a code' },
  // ⚠ CONDITIONAL, and it must stay conditional. The server answers the same
  // 202 for a registered address and an unknown one, so saying "we have sent"
  // would answer "is this address registered here" for anyone who typed one.
  codeSentTitle: { id: 'portal.liveBusinessPortal.codeSentTitle', defaultMessage: 'Check your email' },
  codeSentBody: {
    id: 'portal.liveBusinessPortal.codeSentBody',
    defaultMessage:
      'If {email} can be used to sign in, a six-digit code is on its way. It expires in ten minutes.',
  },
  codeLabel: { id: 'portal.liveBusinessPortal.codeLabel', defaultMessage: 'Six-digit code' },
  codePlaceholder: { id: 'portal.liveBusinessPortal.codePlaceholder', defaultMessage: '000000' },
  signInAction: { id: 'portal.liveBusinessPortal.signInAction', defaultMessage: 'Sign in' },
  startOverAction: { id: 'portal.liveBusinessPortal.startOverAction', defaultMessage: 'Use a different address' },
  workingLabel: { id: 'portal.liveBusinessPortal.workingLabel', defaultMessage: 'Working…' },

  subtitle: { id: 'portal.liveBusinessPortal.subtitle', defaultMessage: 'Business portal' },
  signOutAction: { id: 'portal.liveBusinessPortal.signOutAction', defaultMessage: 'Sign out' },

  awaitingTitle: { id: 'portal.liveBusinessPortal.awaitingTitle', defaultMessage: 'Your accountant is waiting for' },
  awaitingCount: {
    id: 'portal.liveBusinessPortal.awaitingCount',
    defaultMessage: '{count, plural, one {# document} other {# documents}}',
  },
  askStatement: { id: 'portal.liveBusinessPortal.askStatement', defaultMessage: '{month} bank statement' },
  askItem: { id: 'portal.liveBusinessPortal.askItem', defaultMessage: 'Receipt for {label} · {amount} · {date}' },
  askUnnamed: { id: 'portal.liveBusinessPortal.askUnnamed', defaultMessage: 'a card payment' },
  askWaiting: { id: 'portal.liveBusinessPortal.askWaiting', defaultMessage: 'Waiting' },
  askReceived: { id: 'portal.liveBusinessPortal.askReceived', defaultMessage: 'Got it' },
  awaitingNone: {
    id: 'portal.liveBusinessPortal.awaitingNone',
    defaultMessage: 'Nothing right now — you are up to date.',
  },
  sentTitle: { id: 'portal.liveBusinessPortal.sentTitle', defaultMessage: 'Documents you have sent' },
  lastSent: { id: 'portal.liveBusinessPortal.lastSent', defaultMessage: 'Last one {when}' },
  lastSentNever: { id: 'portal.liveBusinessPortal.lastSentNever', defaultMessage: 'Nothing sent yet' },

  uploadTitle: { id: 'portal.liveBusinessPortal.uploadTitle', defaultMessage: 'Send a document' },
  uploadBody: {
    id: 'portal.liveBusinessPortal.uploadBody',
    defaultMessage: 'A receipt, an invoice or a bank statement. Photograph it or choose a file.',
  },
  uploadAction: { id: 'portal.liveBusinessPortal.uploadAction', defaultMessage: 'Choose a file' },
  uploadDone: { id: 'portal.liveBusinessPortal.uploadDone', defaultMessage: 'Sent. Your accountant has it.' },

  // D48 — an upload is refused without a live subscription, so this says so
  // BEFORE the client photographs a receipt rather than after.
  subscriptionLapsed: {
    id: 'portal.liveBusinessPortal.subscriptionLapsed',
    defaultMessage:
      'Your subscription is not active, so new documents cannot be sent. Your accountant can help you restart it.',
  },
});

export function LiveBusinessPortal({ onExit }: { readonly onExit?: (() => void) | undefined }) {
  const intl = useIntl();
  const session = useBusinessPortalSession();
  const [address, setAddress] = useState('');
  const [otp, setOtp] = useState('');
  const [justSent, setJustSent] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  if (session.step !== 'in' || session.home === null) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center bg-ground px-4 py-10 pt-safe pb-safe">
        <div className="w-full max-w-md">
          <div className="w-12 h-12 rounded-2xl bg-brand flex items-center justify-center text-brand-on mb-5">
            <Building2 size={22} />
          </div>
          <h1 className="font-sans font-bold text-2xl text-white tracking-tight">
            {intl.formatMessage(m.signInTitle)}
          </h1>
          <p className="text-[13px] text-zinc-400 mt-2 leading-relaxed">
            {intl.formatMessage(m.signInSubtitle)}
          </p>

          {session.step === 'address' ? (
            <form
              className="mt-7 space-y-3"
              onSubmit={(e) => {
                e.preventDefault();
                void session.requestCode(address.trim());
              }}
            >
              <label className="block text-[11px] font-bold uppercase tracking-wider text-zinc-500">
                {intl.formatMessage(m.emailLabel)}
              </label>
              <input
                type="email"
                required
                value={address}
                onChange={(e) => setAddress(e.target.value)}
                placeholder={intl.formatMessage(m.emailPlaceholder)}
                className="w-full px-4 py-3 rounded-2xl bg-card border border-white/10 text-[15px] text-white placeholder:text-zinc-600 focus:border-brand focus:outline-none"
              />
              <p className="text-[12px] text-zinc-500">{intl.formatMessage(m.emailHint)}</p>
              <button
                type="submit"
                disabled={session.busy || address.trim() === ''}
                className="w-full flex items-center justify-center gap-2 px-5 py-3 rounded-full bg-brand text-brand-on text-[14px] font-bold disabled:opacity-50"
              >
                <Mail size={16} />
                {session.busy ? intl.formatMessage(m.workingLabel) : intl.formatMessage(m.sendCodeAction)}
              </button>
            </form>
          ) : (
            <form
              className="mt-7 space-y-3"
              onSubmit={(e) => {
                e.preventDefault();
                void session.submitCode(otp.trim());
              }}
            >
              <div className="rounded-2xl bg-card border border-white/10 p-4">
                <div className="font-bold text-[14px] text-white">{intl.formatMessage(m.codeSentTitle)}</div>
                <p className="text-[13px] text-zinc-400 mt-1 leading-relaxed">
                  {intl.formatMessage(m.codeSentBody, { email: session.email })}
                </p>
              </div>
              <label className="block text-[11px] font-bold uppercase tracking-wider text-zinc-500">
                {intl.formatMessage(m.codeLabel)}
              </label>
              <input
                inputMode="numeric"
                pattern="[0-9]{6}"
                maxLength={6}
                required
                value={otp}
                onChange={(e) => setOtp(e.target.value.replace(/\D/g, ''))}
                placeholder={intl.formatMessage(m.codePlaceholder)}
                className="w-full px-4 py-3 rounded-2xl bg-card border border-white/10 text-[20px] tracking-[0.4em] text-white placeholder:text-zinc-700 focus:border-brand focus:outline-none"
              />
              <button
                type="submit"
                disabled={session.busy || otp.length !== 6}
                className="w-full flex items-center justify-center gap-2 px-5 py-3 rounded-full bg-brand text-brand-on text-[14px] font-bold disabled:opacity-50"
              >
                <LogIn size={16} />
                {session.busy ? intl.formatMessage(m.workingLabel) : intl.formatMessage(m.signInAction)}
              </button>
              <button
                type="button"
                onClick={session.signOut}
                className="w-full px-5 py-2 text-[13px] font-semibold text-zinc-500 hover:text-zinc-300"
              >
                {intl.formatMessage(m.startOverAction)}
              </button>
            </form>
          )}

          {session.error !== null && (
            <p role="alert" className="mt-4 text-[13px] text-rose-400">
              {session.error}
            </p>
          )}

          <div className="mt-6">
            <PrivacyNoticeLink />
          </div>
        </div>
      </div>
    );
  }

  const home = session.home;

  return (
    <div className="flex-1 flex flex-col min-w-0 h-full bg-ground overflow-hidden">
      <header className="shrink-0 border-b border-white/5 bg-card px-4 md:px-6 py-3 md:py-4 pt-safe flex items-center justify-between gap-3">
        <div className="flex items-center gap-3 min-w-0">
          <div className="w-10 h-10 rounded-2xl bg-brand flex items-center justify-center text-brand-on shrink-0">
            <Building2 size={18} />
          </div>
          <div className="min-w-0">
            <div className="font-sans font-bold text-[15px] text-white tracking-tight truncate">
              {home.businessName}
            </div>
            <div className="text-[11px] text-zinc-500 font-semibold uppercase tracking-wider">
              {intl.formatMessage(m.subtitle)}
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={session.signOut}
            className="px-3 md:px-4 py-2 rounded-full text-[13px] font-bold text-zinc-400 border border-white/5 bg-ground hover:text-white hover:border-white/15 transition-colors"
          >
            {intl.formatMessage(m.signOutAction)}
          </button>
          {onExit !== undefined && (
            <button
              onClick={onExit}
              aria-label={intl.formatMessage(m.signOutAction)}
              className="p-2 rounded-full text-zinc-500 hover:text-white"
            >
              <ArrowLeft size={16} strokeWidth={2.5} />
            </button>
          )}
        </div>
      </header>

      <div className="flex-1 overflow-y-auto px-4 md:px-6 py-6 pb-safe-6 space-y-4 max-w-2xl w-full mx-auto">
        <section className="rounded-3xl bg-card border border-white/5 p-5">
          <div className="flex items-center gap-2 text-[11px] font-bold uppercase tracking-wider text-zinc-500">
            <Clock size={13} />
            {intl.formatMessage(m.awaitingTitle)}
          </div>
          <div className="mt-2 font-sans font-bold text-3xl text-white tracking-tight">
            {home.awaitingYou === 0
              ? intl.formatMessage(m.awaitingNone)
              : intl.formatMessage(m.awaitingCount, { count: home.awaitingYou })}
          </div>
          {/* The itemised asks (Phase 5): the count now NAMES what is wanted —
              each outstanding line and statement month, so "3 documents" stops
              being a number the client has to telephone about. Sending any of
              them goes through the same upload button below. */}
          {(home.statementRequests.length > 0 || home.items.length > 0) && (
            <ul className="mt-4 flex flex-col gap-2">
              {home.statementRequests.map((request) => (
                <li
                  key={`stmt-${request.period}`}
                  className="flex items-center justify-between gap-3 rounded-2xl bg-raised/50 border border-white/5 px-4 py-3"
                >
                  <span className="text-[13px] font-semibold text-white">
                    {intl.formatMessage(m.askStatement, {
                      month: intl.formatDate(new Date(`${request.period}-01T12:00:00.000Z`), {
                        month: 'long',
                        year: 'numeric',
                        timeZone: 'UTC',
                      }),
                    })}
                  </span>
                  <span className={`text-[11px] font-bold uppercase tracking-wider ${request.received ? 'text-emerald-400' : 'text-brand'}`}>
                    {intl.formatMessage(request.received ? m.askReceived : m.askWaiting)}
                  </span>
                </li>
              ))}
              {home.items.map((ask) => (
                <li
                  key={ask.transactionId}
                  className="flex items-center justify-between gap-3 rounded-2xl bg-raised/50 border border-white/5 px-4 py-3"
                >
                  <span className="min-w-0 text-[13px] font-semibold text-white truncate">
                    {intl.formatMessage(m.askItem, {
                      label: ask.label ?? intl.formatMessage(m.askUnnamed),
                      amount: currency(Math.abs(ask.amount)),
                      date: ask.date,
                    })}
                  </span>
                  <span className={`shrink-0 text-[11px] font-bold uppercase tracking-wider ${ask.received ? 'text-emerald-400' : 'text-brand'}`}>
                    {intl.formatMessage(ask.received ? m.askReceived : m.askWaiting)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="rounded-3xl bg-card border border-white/5 p-5">
          <div className="flex items-center gap-2 text-[11px] font-bold uppercase tracking-wider text-zinc-500">
            <FileText size={13} />
            {intl.formatMessage(m.sentTitle)}
          </div>
          <div className="mt-2 font-sans font-bold text-3xl text-white tracking-tight">{home.documentsSent}</div>
          <p className="text-[12px] text-zinc-500 mt-1">
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
        </section>

        <section className="rounded-3xl bg-card border border-white/5 p-5">
          <div className="font-bold text-[15px] text-white">{intl.formatMessage(m.uploadTitle)}</div>
          <p className="text-[13px] text-zinc-400 mt-1 leading-relaxed">{intl.formatMessage(m.uploadBody)}</p>

          {home.subscriptionActive ? (
            <>
              <button
                onClick={() => fileRef.current?.click()}
                disabled={session.busy}
                className="mt-4 flex items-center gap-2 px-5 py-3 rounded-full bg-brand text-brand-on text-[14px] font-bold disabled:opacity-50"
              >
                <UploadCloud size={16} />
                {session.busy ? intl.formatMessage(m.workingLabel) : intl.formatMessage(m.uploadAction)}
              </button>
              <input
                ref={fileRef}
                type="file"
                className="hidden"
                // The same set the practice-side statement upload takes: a
                // photograph is the commonest thing a client actually sends.
                accept=".pdf,.csv,.xlsx,.jpg,.jpeg,.png,.tif,.tiff"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  e.target.value = '';
                  if (file === undefined) return;
                  setJustSent(false);
                  void session.upload(file).then((ok) => setJustSent(ok));
                }}
              />
            </>
          ) : (
            <p role="alert" className="mt-4 text-[13px] text-amber-400 leading-relaxed">
              {intl.formatMessage(m.subscriptionLapsed)}
            </p>
          )}

          {justSent && (
            <p className="mt-3 flex items-center gap-2 text-[13px] text-emerald-400">
              <CheckCircle2 size={14} />
              {intl.formatMessage(m.uploadDone)}
            </p>
          )}
          {session.error !== null && (
            <p role="alert" className="mt-3 text-[13px] text-rose-400">
              {session.error}
            </p>
          )}
        </section>

        <PrivacyNoticeLink />
      </div>
    </div>
  );
}
