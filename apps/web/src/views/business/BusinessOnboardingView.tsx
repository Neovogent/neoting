import { useCallback, useState } from 'react';
import { AlertTriangle, ArrowLeft, ArrowRight, BadgeCheck, CreditCard, Loader2, Mail, ShieldCheck } from 'lucide-react';
import { motion } from 'motion/react';
import { defineMessages, useIntl } from 'react-intl';
import type { MessageDescriptor } from 'react-intl';
import { OTP_LENGTH } from '../../api/onboarding';
import { useAppContext } from '../../context/AppContext';
import { navigate, useQueryParam } from '../../lib/router';
import { PrivacyNoticeLink } from '../legal/PrivacyNoticeLink';
import { useOnboardingJourney } from './useOnboardingJourney';
import type { OnboardingJourney, SubscribeOutcome } from './useOnboardingJourney';
import type { PortalFault } from './usePortalJourney';

const m = defineMessages({
  shellSubtitle: { id: 'portal.onboarding.shellSubtitle', defaultMessage: 'No app · no password' },

  linkTitle: { id: 'portal.onboarding.linkTitle', defaultMessage: 'Open your setup link' },
  linkDetail: {
    id: 'portal.onboarding.linkDetail',
    defaultMessage:
      'Your accountant emailed you a link to set up your business. Open it on this device — or paste the whole link here.',
  },
  linkLabel: { id: 'portal.onboarding.linkLabel', defaultMessage: 'Link from the email' },
  linkPlaceholder: { id: 'portal.onboarding.linkPlaceholder', defaultMessage: 'Paste the setup link' },
  linkAction: { id: 'portal.onboarding.linkAction', defaultMessage: 'Continue' },

  emailTitle: { id: 'portal.onboarding.emailTitle', defaultMessage: 'Sign in to get set up' },
  emailDetail: {
    id: 'portal.onboarding.emailDetail',
    defaultMessage:
      'Your accountant has registered your business. Enter the email address they registered you with, and we will email you a six-digit code.',
  },
  emailLabel: { id: 'portal.onboarding.emailLabel', defaultMessage: 'Email address' },
  emailPlaceholder: { id: 'portal.onboarding.emailPlaceholder', defaultMessage: 'you@yourbusiness.co.uk' },
  emailAction: { id: 'portal.onboarding.emailAction', defaultMessage: 'Email me a code' },

  codeTitle: { id: 'portal.onboarding.codeTitle', defaultMessage: 'Check your email' },
  codeDetail: {
    id: 'portal.onboarding.codeDetail',
    defaultMessage: 'We’ve emailed a six-digit code to {email}. Enter it below to sign in.',
  },
  codeLabel: { id: 'portal.onboarding.codeLabel', defaultMessage: 'Six-digit code' },
  codePlaceholder: { id: 'portal.onboarding.codePlaceholder', defaultMessage: '000000' },
  codeAction: { id: 'portal.onboarding.codeAction', defaultMessage: 'Sign in' },
  codeResendAction: { id: 'portal.onboarding.codeResendAction', defaultMessage: 'Send a new code' },
  codeResent: { id: 'portal.onboarding.codeResent', defaultMessage: 'Sent — check your email again.' },
  codeChangeEmailAction: { id: 'portal.onboarding.codeChangeEmailAction', defaultMessage: 'Use a different address' },
  codeNothingArrived: {
    id: 'portal.onboarding.codeNothingArrived',
    defaultMessage:
      'Nothing arrived? Check your spam folder, and check this is the address your accountant registered — for your security we cannot confirm that here.',
  },

  welcomeTitle: { id: 'portal.onboarding.welcomeTitle', defaultMessage: 'You’re signed in' },
  welcomeDetail: {
    id: 'portal.onboarding.welcomeDetail',
    defaultMessage:
      'This portal is where you send paperwork to your accountant: photograph a receipt or upload a file, and it is read and coded automatically. A person reviews everything before it counts.',
  },
  welcomeNext: {
    id: 'portal.onboarding.welcomeNext',
    defaultMessage: 'One thing left to do: set up your subscription.',
  },
  welcomeAction: { id: 'portal.onboarding.welcomeAction', defaultMessage: 'Continue' },

  subscribeTitle: { id: 'portal.onboarding.subscribeTitle', defaultMessage: 'Your subscription' },
  subscribePrice: { id: 'portal.onboarding.subscribePrice', defaultMessage: '£8.50 + VAT' },
  subscribePriceUnit: { id: 'portal.onboarding.subscribePriceUnit', defaultMessage: 'per month, per business' },
  subscribeVatNote: {
    id: 'portal.onboarding.subscribeVatNote',
    defaultMessage: 'The price is shown excluding VAT. The checkout shows the VAT and the total before you confirm anything.',
  },
  subscribeDetail: {
    id: 'portal.onboarding.subscribeDetail',
    defaultMessage:
      'One plan, and this is it — no tiers to compare. It covers sending paperwork from this portal, the automatic reading and coding, and your accountant’s review.',
  },
  subscribeAction: { id: 'portal.onboarding.subscribeAction', defaultMessage: 'Continue to secure checkout' },
  subscribeStripeNote: {
    id: 'portal.onboarding.subscribeStripeNote',
    defaultMessage:
      'Checkout, invoices and receipts are handled by Stripe. Your card details never touch our servers.',
  },

  subscribedTitle: { id: 'portal.onboarding.subscribedTitle', defaultMessage: 'Subscription active' },
  subscribedDetail: {
    id: 'portal.onboarding.subscribedDetail',
    defaultMessage:
      'Your plan renews on {date}. Card changes, invoices and cancellation are all handled by Stripe — the link is in your portal settings, under Plan.',
  },
  subscribedDetailNoDate: {
    id: 'portal.onboarding.subscribedDetailNoDate',
    defaultMessage:
      'Card changes, invoices and cancellation are all handled by Stripe — the link is in your portal settings, under Plan.',
  },
  alreadySubscribedDetail: {
    id: 'portal.onboarding.alreadySubscribedDetail',
    defaultMessage: 'This business is already subscribed — there is nothing to pay twice. You can close this page.',
  },
  enterPortalAction: { id: 'portal.onboarding.enterPortalAction', defaultMessage: 'Open your portal' },

  checkoutSuccessTitle: { id: 'portal.onboarding.checkoutSuccessTitle', defaultMessage: 'Thanks — your payment is with Stripe' },
  checkoutSuccessDetail: {
    id: 'portal.onboarding.checkoutSuccessDetail',
    defaultMessage:
      'Stripe is confirming your payment, and your subscription becomes active the moment it does — your accountant can see it from their side. Your VAT invoice comes from Stripe by email. You can close this page.',
  },
  checkoutCancelledTitle: { id: 'portal.onboarding.checkoutCancelledTitle', defaultMessage: 'Checkout cancelled' },
  checkoutCancelledDetail: {
    id: 'portal.onboarding.checkoutCancelledDetail',
    defaultMessage:
      'Nothing has been charged. To try again, open the setup link from your email and sign in — it brings you straight back to this step.',
  },

  faultOtp: {
    id: 'portal.onboarding.faultOtp',
    defaultMessage: 'That code did not work. Check the six digits in the email, or send yourself a new one.',
  },
  faultSession: {
    id: 'portal.onboarding.faultSession',
    defaultMessage: 'This page has been open too long. Open the setup link from your email again.',
  },
  faultRateLimited: {
    id: 'portal.onboarding.faultRateLimited',
    defaultMessage: 'Too many attempts for now. Wait a few minutes, then try again.',
  },
  faultCheckout: {
    id: 'portal.onboarding.faultCheckout',
    defaultMessage:
      'We could not open the checkout, and nothing has been charged. Try again in a moment — if it keeps failing, tell your accountant.',
  },
  faultUnreachable: {
    id: 'portal.onboarding.faultUnreachable',
    defaultMessage: 'We could not reach your accountant’s system. Check your connection and try again.',
  },
  faultRefused: {
    id: 'portal.onboarding.faultRefused',
    defaultMessage:
      'Your accountant’s system answered with an error we did not expect. Try again in a moment — if it keeps happening, tell your accountant and quote the reference below.',
  },
  faultCode: { id: 'portal.onboarding.faultCode', defaultMessage: 'Reference {code}' },

  syntheticNote: {
    id: 'portal.onboarding.syntheticNote',
    defaultMessage: 'Demo data — this build is not talking to a server.',
  },
  exitAction: { id: 'portal.onboarding.exitAction', defaultMessage: 'Back to the practice app' },
});

/** Enough of an email to be worth sending to the server, which re-checks it. */
const looksLikeEmail = (value: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());

/**
 * The invited client's way in (launch stage M6, SoT §24.5): the setup link
 * from the registration EMAIL, the address they were registered with, a
 * six-digit code — then their own onboarding, then the subscription.
 *
 * This is the third client-facing entrance, and it is neither of the other
 * two on purpose. `ChasePortalView` (`/p/:linkToken`) is the consequence of a
 * chase — no account, sees one chase's items only. `BusinessSignInView` is
 * the seed-data portal's front door. This one exists because an invited
 * client has no chase yet — nobody has asked them for anything; they are
 * being asked to set themselves up — which is exactly the gap
 * `POST /portal/sign-in-codes` + `POST /portal/onboarding-sessions` were
 * contracted to close.
 *
 * There is no SMS anywhere on this journey, and no copy here may say "text"
 * — the code is EMAILED (D47; the contract says so in as many words).
 */
export function BusinessOnboardingView() {
  const { exitBusinessPortal } = useAppContext();
  const intl = useIntl();
  const [setupToken] = useQueryParam('setupToken');
  const [checkout] = useQueryParam('checkout');
  const journey = useOnboardingJourney(setupToken);
  const [outcome, setOutcome] = useState<SubscribeOutcome | null>(null);

  const subscribe = useCallback(async () => {
    setOutcome(await journey.subscribe());
  }, [journey]);

  // Stripe's return leg. The session died with the redirect, deliberately —
  // the bearer lives in React state and nowhere else — so these two screens
  // stand on their own rather than resuming a journey that no longer exists.
  if (checkout === 'success') {
    return (
      <Shell title={intl.formatMessage(m.checkoutSuccessTitle)}>
        <OutcomeBadge good />
        <p className="text-[14px] text-zinc-400 leading-relaxed">{intl.formatMessage(m.checkoutSuccessDetail)}</p>
      </Shell>
    );
  }
  if (checkout === 'cancelled') {
    return (
      <Shell title={intl.formatMessage(m.checkoutCancelledTitle)}>
        <OutcomeBadge />
        <p className="text-[14px] text-zinc-400 leading-relaxed">{intl.formatMessage(m.checkoutCancelledDetail)}</p>
      </Shell>
    );
  }

  // A live visit with no token — a mangled email, usually. Ask for the link
  // rather than guessing. Seed data carries on without one, so the demo and
  // the tests can walk the journey from a bare address.
  if (journey.live && !setupToken) return <LinkEntry />;

  if (journey.step === 'email') return <EmailStep journey={journey} />;
  if (journey.step === 'code') return <CodeStep journey={journey} />;

  if (journey.step === 'welcome') {
    return (
      <Shell title={intl.formatMessage(m.welcomeTitle)} subtitle={journey.businessName ?? undefined}>
        <OutcomeBadge good />
        <p className="text-[14px] text-zinc-400 leading-relaxed">{intl.formatMessage(m.welcomeDetail)}</p>
        <p className="text-[14px] font-semibold text-white leading-relaxed">{intl.formatMessage(m.welcomeNext)}</p>
        <PrimaryButton onClick={journey.beginSubscription} label={intl.formatMessage(m.welcomeAction)} icon={ArrowRight} />
        <SyntheticNote live={journey.live} onExit={exitBusinessPortal} />
      </Shell>
    );
  }

  if (journey.step === 'subscribe') {
    return (
      <Shell title={intl.formatMessage(m.subscribeTitle)} subtitle={journey.businessName ?? undefined}>
        {/* One price, no tier picker, no comparison table (D48). Displayed
            exclusive of VAT and labelled as such — prices are stored
            exclusive, and the gross total is Stripe's to show (§24.5). */}
        <div className="rounded-[28px] border border-white/5 bg-card p-6">
          <div className="flex items-baseline gap-2">
            <span className="font-sans text-3xl font-bold text-white tracking-tight">
              {intl.formatMessage(m.subscribePrice)}
            </span>
            <span className="text-[13px] font-semibold text-zinc-500">{intl.formatMessage(m.subscribePriceUnit)}</span>
          </div>
          <p className="text-[12px] text-zinc-500 mt-2 leading-relaxed">{intl.formatMessage(m.subscribeVatNote)}</p>
        </div>
        <p className="text-[14px] text-zinc-400 leading-relaxed">{intl.formatMessage(m.subscribeDetail)}</p>
        <Fault fault={journey.fault} subscribing />
        <PrimaryButton
          onClick={() => void subscribe()}
          busy={journey.busy}
          label={intl.formatMessage(m.subscribeAction)}
          icon={CreditCard}
        />
        <p className="text-[12px] text-zinc-600 leading-relaxed">{intl.formatMessage(m.subscribeStripeNote)}</p>
        <SyntheticNote live={journey.live} onExit={exitBusinessPortal} />
      </Shell>
    );
  }

  // step === 'subscribed'
  return (
    <Shell title={intl.formatMessage(m.subscribedTitle)} subtitle={journey.businessName ?? undefined}>
      <OutcomeBadge good />
      <p className="text-[14px] text-zinc-400 leading-relaxed">
        {outcome?.kind === 'already'
          ? intl.formatMessage(m.alreadySubscribedDetail)
          : journey.renewsOn
            ? intl.formatMessage(m.subscribedDetail, { date: journey.renewsOn })
            : intl.formatMessage(m.subscribedDetailNoDate)}
      </p>
      {/* Live, there is no browsable shell behind this screen — the journey's
          job is done. On seed data the demo continues into the portal. */}
      {!journey.live && (
        <PrimaryButton onClick={journey.enterPortal} label={intl.formatMessage(m.enterPortalAction)} icon={ArrowRight} />
      )}
      <SyntheticNote live={journey.live} onExit={exitBusinessPortal} />
    </Shell>
  );
}

/* ── ① the link, when the email did not survive the journey ──────────────── */

function LinkEntry() {
  const intl = useIntl();
  const [value, setValue] = useState('');

  // The whole pasted link, or just the token off the end of it — the query
  // parameter's name is the contract's own (`setupToken`).
  const token = (() => {
    const raw = value.trim();
    if (!raw) return '';
    const fromQuery = /[?&]setupToken=([^&#\s]+)/.exec(raw)?.[1];
    if (fromQuery) {
      try {
        return decodeURIComponent(fromQuery);
      } catch {
        return fromQuery;
      }
    }
    return raw.includes('/') || raw.includes('?') ? '' : raw;
  })();

  const go = () => token && navigate(`/app/setup?setupToken=${encodeURIComponent(token)}`, { replace: true });

  return (
    <Shell title={intl.formatMessage(m.linkTitle)}>
      <p className="text-[14px] text-zinc-400 leading-relaxed">{intl.formatMessage(m.linkDetail)}</p>
      <div>
        <label htmlFor="onboarding-link" className="block text-[11px] font-bold text-zinc-500 uppercase tracking-widest mb-2">
          {intl.formatMessage(m.linkLabel)}
        </label>
        <input
          id="onboarding-link"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && go()}
          placeholder={intl.formatMessage(m.linkPlaceholder)}
          className="w-full bg-ground border border-white/5 rounded-2xl px-4 py-3.5 text-[14px] text-white placeholder:text-zinc-600 focus:outline-none focus:border-brand transition-colors"
        />
      </div>
      <PrimaryButton onClick={go} disabled={!token} label={intl.formatMessage(m.linkAction)} icon={ArrowRight} />
    </Shell>
  );
}

/* ── ② the address ────────────────────────────────────────────────────────── */

function EmailStep({ journey }: { journey: OnboardingJourney }) {
  const intl = useIntl();
  const [address, setAddress] = useState(journey.email);
  const ready = looksLikeEmail(address);

  return (
    <Shell title={intl.formatMessage(m.emailTitle)} subtitle={journey.businessName ?? undefined}>
      <p className="text-[14px] text-zinc-400 leading-relaxed">{intl.formatMessage(m.emailDetail)}</p>
      <div>
        <label htmlFor="onboarding-email" className="block text-[11px] font-bold text-zinc-500 uppercase tracking-widest mb-2">
          {intl.formatMessage(m.emailLabel)}
        </label>
        <div className="relative">
          <Mail size={15} className="absolute left-4 top-1/2 -translate-y-1/2 text-zinc-600" />
          <input
            id="onboarding-email"
            type="email"
            inputMode="email"
            autoComplete="email"
            value={address}
            onChange={(e) => setAddress(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && ready && void journey.sendCode(address.trim())}
            placeholder={intl.formatMessage(m.emailPlaceholder)}
            className="w-full bg-ground border border-white/5 rounded-2xl py-3.5 pl-11 pr-4 text-[14px] text-white placeholder:text-zinc-600 focus:outline-none focus:border-brand transition-colors"
          />
        </div>
      </div>
      <Fault fault={journey.fault} />
      <PrimaryButton
        onClick={() => void journey.sendCode(address.trim())}
        disabled={!ready}
        busy={journey.busy}
        label={intl.formatMessage(m.emailAction)}
        icon={Mail}
      />
    </Shell>
  );
}

/* ── ③ the code ───────────────────────────────────────────────────────────── */

function CodeStep({ journey }: { journey: OnboardingJourney }) {
  const intl = useIntl();
  const [code, setCode] = useState('');
  const [resent, setResent] = useState(false);

  const resend = async () => {
    setResent(false);
    setResent(await journey.resendCode());
  };

  return (
    <Shell title={intl.formatMessage(m.codeTitle)} subtitle={journey.businessName ?? undefined}>
      <p className="text-[14px] text-zinc-400 leading-relaxed">
        {intl.formatMessage(m.codeDetail, { email: journey.email })}
      </p>
      <div>
        <label htmlFor="onboarding-otp" className="block text-[11px] font-bold text-zinc-500 uppercase tracking-widest mb-2">
          {intl.formatMessage(m.codeLabel)}
        </label>
        <input
          id="onboarding-otp"
          value={code}
          onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, OTP_LENGTH))}
          onKeyDown={(e) => e.key === 'Enter' && code.length === OTP_LENGTH && void journey.verify(code)}
          inputMode="numeric"
          autoComplete="one-time-code"
          placeholder={intl.formatMessage(m.codePlaceholder)}
          className="w-full bg-ground border border-white/5 rounded-2xl px-5 py-4 text-2xl font-bold tracking-[0.4em] text-center text-white placeholder:text-zinc-700 focus:outline-none focus:border-brand transition-colors tabular-nums"
        />
      </div>
      <Fault fault={journey.fault} />
      {resent && !journey.fault && (
        <p role="status" className="text-[13px] font-semibold text-emerald-400">{intl.formatMessage(m.codeResent)}</p>
      )}
      <PrimaryButton
        onClick={() => void journey.verify(code)}
        disabled={code.length !== OTP_LENGTH}
        busy={journey.busy}
        label={intl.formatMessage(m.codeAction)}
        icon={ShieldCheck}
      />
      <div className="flex items-center gap-2">
        <SecondaryButton onClick={() => void resend()} label={intl.formatMessage(m.codeResendAction)} />
        <SecondaryButton onClick={journey.changeEmail} label={intl.formatMessage(m.codeChangeEmailAction)} />
      </div>
      <p className="text-[12px] text-zinc-600 leading-relaxed">{intl.formatMessage(m.codeNothingArrived)}</p>
    </Shell>
  );
}

/* ── shared chrome ────────────────────────────────────────────────────────── */

function Shell({ title, subtitle, children }: { title: string; subtitle?: string | undefined; children: React.ReactNode }) {
  const intl = useIntl();
  return (
    // The chase portal's shell, for the chase portal's reasons: this screen is
    // opened from an email, usually on a phone. Safe-area insets on the scroll
    // container; the 16px input floor arrives from index.css.
    <div className="flex-1 flex flex-col min-w-0 h-full bg-ground overflow-y-auto pt-safe pb-safe px-safe [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
      <div className="w-full max-w-md mx-auto px-5 py-10 flex flex-col gap-5">
        <div className="flex items-center gap-3">
          <div className="w-11 h-11 rounded-2xl bg-brand flex items-center justify-center text-white shrink-0 shadow-glow-tile">
            <Mail size={19} />
          </div>
          <div className="min-w-0">
            <h1 className="font-sans font-bold text-xl text-white tracking-tight truncate">{title}</h1>
            <p className="text-[11px] text-zinc-500 font-semibold uppercase tracking-wider truncate">
              {subtitle ?? intl.formatMessage(m.shellSubtitle)}
            </p>
          </div>
        </div>
        {children}
        {/* On the shell rather than per-step: UK GDPR Art. 13 wants the privacy
            notice AT the point of collection, and every step of this journey —
            the link, the address, the code — collects. New tab, because the
            session lives in React state and an in-app navigation would end it
            (launch stage M4). */}
        <PrivacyNoticeLink />
      </div>
    </div>
  );
}

function PrimaryButton({
  onClick,
  label,
  icon: Icon,
  disabled = false,
  busy = false,
}: {
  onClick: () => void;
  label: string;
  icon: React.ComponentType<{ size?: number; strokeWidth?: number; className?: string }>;
  disabled?: boolean;
  busy?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled || busy}
      className="w-full flex items-center justify-center gap-2 px-6 py-3.5 rounded-full text-[14px] font-bold text-white bg-brand hover:bg-brand-hover disabled:opacity-40 disabled:cursor-not-allowed transition-colors shadow-glow-cta"
    >
      {busy ? <Loader2 size={16} className="animate-spin" /> : <Icon size={16} strokeWidth={2.5} />}
      {label}
    </button>
  );
}

function SecondaryButton({ onClick, label }: { onClick: () => void; label: string }) {
  return (
    <button
      onClick={onClick}
      className="px-4 py-2 rounded-full text-[13px] font-bold text-zinc-400 hover:text-white transition-colors"
    >
      {label}
    </button>
  );
}

/** The green tick or the amber pause — the same badge the chase portal wears. */
function OutcomeBadge({ good = false }: { good?: boolean }) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      className={`w-14 h-14 rounded-2xl flex items-center justify-center border ${
        good ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-400' : 'bg-amber-500/10 border-amber-500/30 text-amber-400'
      }`}
    >
      {good ? <BadgeCheck size={26} strokeWidth={2.5} /> : <AlertTriangle size={24} />}
    </motion.div>
  );
}

/**
 * Plain English first, the `NT-` reference after it (frontend ten, item 5).
 * `subscribing` swaps the no-code fallback: on the subscribe step the only
 * honest sentence is about the checkout and the fact nothing was charged.
 *
 * ⚠ **A code means the server ANSWERED, so the fallback splits on it.** An
 * `NT-` reference and "check your connection" cannot both be true: the
 * reference came back over the connection being blamed. This screen shipped
 * saying it anyway, and S7 walked into the consequence — the two onboarding
 * routes were unimplemented, the 404 arrived as `NT-VAL-001`, and an invited
 * client was sent to their wifi settings for a route that did not exist.
 */
export function faultMessageFor(fault: PortalFault, subscribing: boolean): MessageDescriptor {
  if (fault.code === 'NT-OTP-001') return m.faultOtp;
  if (fault.code === 'NT-OTP-002') return m.faultSession;
  if (fault.code === 'NT-RATE-001') return m.faultRateLimited;
  if (subscribing) return m.faultCheckout;
  return fault.code === null ? m.faultUnreachable : m.faultRefused;
}

function Fault({ fault, subscribing = false }: { fault: PortalFault | null; subscribing?: boolean }) {
  const intl = useIntl();
  if (!fault) return null;

  const message = intl.formatMessage(faultMessageFor(fault, subscribing));

  return (
    <div role="alert" className="p-4 rounded-2xl border border-red-500/20 bg-red-500/5">
      <p className="flex items-start gap-2 text-[13px] font-semibold text-red-400 leading-relaxed">
        <AlertTriangle size={15} className="shrink-0 mt-0.5" />
        {message}
      </p>
      {fault.code && (
        <p className="text-[11px] text-zinc-600 font-bold mt-2 ml-[23px] tracking-wide">
          {intl.formatMessage(m.faultCode, { code: fault.code })}
        </p>
      )}
    </div>
  );
}

/**
 * The seed-data footer: the demo marker, and the hop back to the practice
 * shell the demo came from. Live it renders nothing — a real client has no
 * business behind the practice login wall, so the door is not offered.
 */
function SyntheticNote({ live, onExit }: { live: boolean; onExit: () => void }) {
  const intl = useIntl();
  if (live) return null;
  return (
    <div className="flex flex-col gap-1">
      <p className="text-[12px] text-zinc-600 leading-relaxed">{intl.formatMessage(m.syntheticNote)}</p>
      <button
        onClick={onExit}
        className="self-start flex items-center gap-2 px-0 py-1 rounded-full text-[12px] font-bold text-zinc-600 hover:text-zinc-400 transition-colors"
      >
        <ArrowLeft size={13} />
        {intl.formatMessage(m.exitAction)}
      </button>
    </div>
  );
}
