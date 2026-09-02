import { useState } from 'react';
import { Building2, Clock, LogIn, Mail } from 'lucide-react';
import { defineMessages, useIntl } from 'react-intl';

import { navigate, useQueryParam, usePath } from '../../lib/router';
import { PrivacyNoticeLink } from '../legal/PrivacyNoticeLink';
import { BusinessPortalShell } from './BusinessPortalShell';
import { LivePortalCapture } from './LivePortalCapture';
import { LivePortalHome } from './LivePortalHome';
import { LivePortalSettings } from './LivePortalSettings';
import { LivePortalUpload } from './LivePortalUpload';
import type { PortalAsk } from './portalAsk';
import { pathForSection, pathForTab, sectionFromPath, tabFromPath, type PortalTab } from './portalTabs';
import { useBusinessPortalSession } from './useBusinessPortalSession';

/**
 * The business portal, against the real API — and, since 2 Sep 2026, the same
 * FOUR-TAB product the prototype describes (D49) rather than one scrolling page
 * of three cards.
 *
 * ## What this is, and what the surface beside it is
 *
 * `SyntheticBusinessPortal` is the same shell driven by
 * `AppContext.businessAccounts` — a seeded array that is EMPTY when the API is
 * on. So with a live session that surface rendered a sign-in screen which
 * created an account in local React state and vanished on reload: there was no
 * business portal at all, only a drawing of one. Both now wear
 * `BusinessPortalShell`, so the live product and the design cannot drift apart
 * by accident.
 *
 * ## Four rules this screen may not break
 *
 * - **It may not say whether an account exists.** `POST /portal/sign-in-codes`
 *   answers `202` whatever happened, so the code step is reached even for an
 *   address nothing was sent to. Every phrasing here is conditional.
 * - **It may not imply a ledger** (D42). Nothing is "posted", "synced" or "sent
 *   to VT" — a client sends paperwork to their accountant, and that is all this
 *   says.
 * - **It says "emailed", never "texted"** (D45/§24.5). There is no SMS here.
 * - **The lapsed-subscription state comes BEFORE the upload control** (D48),
 *   never as a refusal after a receipt has been photographed — and it now
 *   carries a working Stripe checkout rather than an instruction to telephone
 *   the accountant.
 *
 * ## The tabs are addresses
 *
 * `/portal`, `/portal/upload`, `/portal/capture`, `/portal/settings` — so every
 * tab is linkable and Back does what it looks like it does. The mapping is
 * `portalTabs.ts`, shared with the synthetic shell and tested there.
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
    defaultMessage: 'If {email} can be used to sign in, a six-digit code is on its way. It expires in ten minutes.',
  },
  codeLabel: { id: 'portal.liveBusinessPortal.codeLabel', defaultMessage: 'Six-digit code' },
  codePlaceholder: { id: 'portal.liveBusinessPortal.codePlaceholder', defaultMessage: '000000' },
  signInAction: { id: 'portal.liveBusinessPortal.signInAction', defaultMessage: 'Sign in' },
  startOverAction: { id: 'portal.liveBusinessPortal.startOverAction', defaultMessage: 'Use a different address' },
  workingLabel: { id: 'portal.liveBusinessPortal.workingLabel', defaultMessage: 'Working…' },

  signOutAction: { id: 'portal.liveBusinessPortal.signOutAction', defaultMessage: 'Sign out' },

  // ⚠ The session expiry gets its own sentence, and it blames the session.
  // Before this, the sixty-minute bearer simply began failing and the copy on
  // whatever the client happened to be doing said "That did not send" — so the
  // honest reading was that the upload had failed, and clients re-photographed
  // receipts to fix a sign-in problem.
  expiredTitle: { id: 'portal.liveBusinessPortal.expiredTitle', defaultMessage: 'Your sign-in has ended' },
  expiredBody: {
    id: 'portal.liveBusinessPortal.expiredBody',
    defaultMessage:
      'Sign-ins here last about an hour, then stop. Nothing you sent is affected — ask for a new code and carry on.',
  },

  // Stripe's return leg. The bearer died with the redirect BY DESIGN, so this
  // resumes nothing and claims nothing: reaching this address is not proof of
  // payment (the contract's own words on `successUrl`).
  checkoutSuccessTitle: {
    id: 'portal.liveBusinessPortal.checkoutSuccessTitle',
    defaultMessage: 'Stripe is confirming your payment',
  },
  checkoutSuccessBody: {
    id: 'portal.liveBusinessPortal.checkoutSuccessBody',
    defaultMessage:
      'Sign in again in a moment and your plan will show as running. If it does not, your accountant can see the same thing you can.',
  },
  checkoutCancelledTitle: {
    id: 'portal.liveBusinessPortal.checkoutCancelledTitle',
    defaultMessage: 'Nothing has been charged',
  },
  checkoutCancelledBody: {
    id: 'portal.liveBusinessPortal.checkoutCancelledBody',
    defaultMessage: 'You left the payment page before finishing. Sign in again whenever you are ready.',
  },
});

export function LiveBusinessPortal() {
  const intl = useIntl();
  const session = useBusinessPortalSession();
  const [address, setAddress] = useState('');
  const [otp, setOtp] = useState('');
  const [ask, setAsk] = useState<PortalAsk | null>(null);
  const [checkoutParam, setCheckout] = useQueryParam('checkout');
  // Only the two outcomes Stripe is sent back with. An address bar carrying
  // anything else says nothing, so nothing is claimed.
  const checkout = checkoutParam === 'success' || checkoutParam === 'cancelled' ? checkoutParam : null;

  const segments = usePath();
  const tab = tabFromPath(segments);
  const goTo = (next: PortalTab) => navigate(pathForTab(segments, next));
  // The Settings section is an address too, so `/portal/settings/people` is a
  // link a client can be sent and can send on. An unrecognised one falls back to
  // the first section rather than opening a blank panel — `portalTabs.ts` owns
  // that rule, one level down from the tab's own.
  const section = sectionFromPath(segments) ?? 'Business';
  const goToSection = (next: string) => navigate(pathForSection(segments, 'Settings', next));

  if (session.step !== 'in' || session.home === null) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center bg-ground px-4 py-10 pt-safe pb-safe overflow-y-auto">
        <div className="w-full max-w-md">
          <div className="w-12 h-12 rounded-2xl bg-brand flex items-center justify-center text-brand-on mb-5">
            <Building2 size={22} />
          </div>
          <h1 className="font-sans font-bold text-2xl text-white tracking-tight">
            {intl.formatMessage(m.signInTitle)}
          </h1>
          <p className="text-[13px] text-zinc-400 mt-2 leading-relaxed">{intl.formatMessage(m.signInSubtitle)}</p>

          {checkout !== null && (
            <div
              role="status"
              className={`mt-5 rounded-2xl border p-4 ${
                checkout === 'success'
                  ? 'border-emerald-500/25 bg-emerald-500/[0.06]'
                  : 'border-white/10 bg-card'
              }`}
            >
              <div className="font-bold text-[14px] text-white">
                {intl.formatMessage(checkout === 'success' ? m.checkoutSuccessTitle : m.checkoutCancelledTitle)}
              </div>
              <p className="text-[13px] text-zinc-400 mt-1 leading-relaxed">
                {intl.formatMessage(checkout === 'success' ? m.checkoutSuccessBody : m.checkoutCancelledBody)}
              </p>
            </div>
          )}

          {session.expired && (
            <div role="status" className="mt-5 rounded-2xl border border-amber-500/25 bg-amber-500/[0.06] p-4">
              <div className="flex items-center gap-2 font-bold text-[14px] text-amber-300">
                <Clock size={15} />
                {intl.formatMessage(m.expiredTitle)}
              </div>
              <p className="text-[13px] text-zinc-300 mt-1 leading-relaxed">{intl.formatMessage(m.expiredBody)}</p>
            </div>
          )}

          {session.step === 'address' ? (
            <form
              className="mt-7 space-y-3"
              onSubmit={(e) => {
                e.preventDefault();
                // The banner belongs to the visit that came back from Stripe,
                // not to the next attempt at signing in.
                if (checkout !== null) setCheckout(null, { replace: true });
                void session.requestCode(address.trim());
              }}
            >
              <label
                htmlFor="portal-email"
                className="block text-[11px] font-bold uppercase tracking-wider text-zinc-500"
              >
                {intl.formatMessage(m.emailLabel)}
              </label>
              <input
                id="portal-email"
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
              <label htmlFor="portal-otp" className="block text-[11px] font-bold uppercase tracking-wider text-zinc-500">
                {intl.formatMessage(m.codeLabel)}
              </label>
              <input
                id="portal-otp"
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

  const sendFor = (next: PortalAsk) => {
    setAsk(next);
    goTo('Capture');
  };

  return (
    <BusinessPortalShell
      businessName={home.businessName}
      tab={tab}
      onTab={goTo}
      actions={
        <button
          onClick={session.signOut}
          className="px-3 md:px-4 py-2 rounded-full text-[13px] font-bold text-zinc-400 border border-white/5 bg-ground hover:text-white hover:border-white/15 transition-colors"
        >
          {intl.formatMessage(m.signOutAction)}
        </button>
      }
    >
      {tab === 'Home' && (
        <LivePortalHome
          home={home}
          documents={session.documents}
          documentsFault={session.documentsFault}
          onGoCapture={() => goTo('Capture')}
          onGoUpload={() => goTo('Upload')}
          onSendFor={sendFor}
        />
      )}
      {tab === 'Upload' && (
        <LivePortalUpload
          subscriptionActive={home.subscriptionActive}
          documents={session.documents}
          documentsFault={session.documentsFault}
          busy={session.busy}
          onUpload={(file) => session.upload(file, null)}
          onSubscribe={() => void session.startCheckout()}
        />
      )}
      {tab === 'Capture' && (
        <LivePortalCapture
          ask={ask}
          subscriptionActive={home.subscriptionActive}
          busy={session.busy}
          onSend={(page, transactionId) =>
            session.send({ filename: page.filename, mimeType: page.blob.type, bytes: page.blob }, transactionId)
          }
          onClearAsk={() => setAsk(null)}
          onSubscribe={() => void session.startCheckout()}
        />
      )}
      {tab === 'Settings' && (
        <LivePortalSettings
          home={home}
          email={session.email}
          busy={session.busy}
          fault={session.error}
          section={section}
          onSection={goToSection}
          // The bearer, for the People list. React state only — never
          // `localStorage`, never a cookie; it dies with the tab.
          sessionToken={session.token}
          onSubscribe={() => void session.startCheckout()}
          onManageBilling={() => void session.manageBilling()}
          onSignOut={session.signOut}
        />
      )}
    </BusinessPortalShell>
  );
}
