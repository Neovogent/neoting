import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { defineMessages, useIntl } from 'react-intl';
import {
  AlertTriangle,
  ArrowRight,
  BadgeCheck,
  Copy,
  KeyRound,
  Loader2,
  LogIn,
  Mail,
  ShieldCheck,
  UserPlus,
} from 'lucide-react';
import { motion } from 'motion/react';
import {
  PASSWORD_MIN_LENGTH,
  TERMS_VERSION,
  TOTP_LENGTH,
  beginEnrolment,
  confirmEnrolment,
  faultOf,
  requestPasswordReset,
  resetPassword,
  signUpPractice,
  verifyEmail,
  type EnrolmentOffer,
  type SignupFault,
} from '../../api/signup';
import { Wordmark } from '../../assets/Wordmark';
import { linkProps, navigate, usePath, useQueryParam } from '../../lib/router';
import { legalPath } from '../legal/documents';
import { QrCode } from './QrCode';

/**
 * Signing up (launch stage M9) — the four screens that did not exist.
 *
 * A1 shipped `POST /v1/practices` and A14 shipped the three that follow it, and
 * until this stage nothing in `apps/web/src` called any of them: the product
 * had a login page and no way to reach one. The journey, and the address each
 * step lives at:
 *
 *   /signup              the form            → POST /practices
 *   /signup/check-email  what happens next   (no request; says nothing about what happened)
 *   /signup/verify       the emailed link    → POST /auth/email-verification
 *   /signup/enrol        the authenticator   → POST /auth/totp-enrolment (+ /confirm)
 *   /signup/done         sign in
 *   /signup/reset        forgotten password  → POST /auth/password-resets, then /auth/password
 *                        (both halves at one address: no ?token= asks, ?token= sets)
 *
 * ⚠ **THIS IS A PUBLIC SURFACE AND FIRES NO SESSION PROBE.** `portal ===
 * 'signup'` in `AppContext` keeps `workspaceApiOn` false, exactly as 'landing'
 * and 'legal' do. Someone who does not have an account yet must not have their
 * browser ask `/me` who they are.
 *
 * ⚠ **NO SECRET REACHES THE ADDRESS BAR, A LOG OR AN ERROR MESSAGE.** The
 * verification token arrives in the URL because that is what an emailed link
 * is, and it is scrubbed from the address the moment it is spent — see
 * `VerifyStep`. The seed, the enrolment token and the ten recovery codes live
 * in this component's state for the length of one setup and are never written
 * anywhere else.
 *
 * ⚠ **M8, THE HONEST-COPY PASS, RAN BEFORE THESE SCREENS EXISTED (#194) AND
 * NOTHING WILL SWEEP AFTER THEM.** Its rules are applied here as written: no
 * SMS anywhere (every code on this journey is emailed or comes from an
 * authenticator app), nothing invented rendered as real, no vocabulary
 * implying anything was transmitted to a ledger, and every string through
 * react-intl.
 */
const m = defineMessages({
  shellSubtitle: { id: 'signup.signupView.shellSubtitle', defaultMessage: 'Create your practice account' },
  wordmarkTitle: {
    id: 'signup.signupView.wordmarkTitle',
    defaultMessage: 'Neo Accounting',
    description: 'Accessible name for the product wordmark. A product name — leave untranslated.',
  },

  /* ① the form */
  formTitle: { id: 'signup.form.title', defaultMessage: 'Create your account' },
  formDetail: {
    id: 'signup.form.detail',
    defaultMessage:
      'Your practice, and you as its first user. You will be the super admin — the person who releases work for export.',
  },
  formPracticeName: { id: 'signup.form.practiceName', defaultMessage: 'Practice name' },
  formPracticeNamePlaceholder: { id: 'signup.form.practiceNamePlaceholder', defaultMessage: 'Northgate Accounts Ltd' },
  formFirstName: { id: 'signup.form.firstName', defaultMessage: 'First name' },
  formLastName: { id: 'signup.form.lastName', defaultMessage: 'Last name' },
  formEmail: { id: 'signup.form.email', defaultMessage: 'Work email' },
  formEmailPlaceholder: { id: 'signup.form.emailPlaceholder', defaultMessage: 'you@practice.co.uk' },
  formEmailHint: {
    id: 'signup.form.emailHint',
    defaultMessage: 'This is your sign-in, and where we send the link that activates the account.',
  },
  formPassword: { id: 'signup.form.password', defaultMessage: 'Password' },
  formPasswordHint: {
    id: 'signup.form.passwordHint',
    defaultMessage:
      'At least {min} characters. Length is the whole rule — a long phrase you can remember beats a short one with a symbol in it.',
  },
  formPasswordShort: {
    id: 'signup.form.passwordShort',
    defaultMessage: '{count, plural, one {# more character} other {# more characters}}',
  },
  formTermsLabel: {
    id: 'signup.form.termsLabel',
    defaultMessage: 'I accept the terms of service and have read the privacy notice.',
  },
  formTermsLink: { id: 'signup.form.termsLink', defaultMessage: 'Read the terms of service' },
  formPrivacyLink: { id: 'signup.form.privacyLink', defaultMessage: 'Read the privacy notice' },
  formAction: { id: 'signup.form.action', defaultMessage: 'Create account' },
  formActionBusy: { id: 'signup.form.actionBusy', defaultMessage: 'Creating…' },
  formHaveAccount: { id: 'signup.form.haveAccount', defaultMessage: 'Already have an account? Sign in' },

  /* ② check your email */
  sentTitle: { id: 'signup.sent.title', defaultMessage: 'Check your email' },
  /**
   * ⚠ THE HARDEST COPY ON THIS STAGE. The API answers the same empty `202`
   * whether or not an account was created, so that it never answers "is this
   * address registered here" for whoever asks. This screen therefore says what
   * happens NEXT and nothing at all about what just happened — no "account
   * created", no "that address is already registered".
   */
  sentDetail: {
    id: 'signup.sent.detail',
    defaultMessage:
      'If that address can be used to open an account, a link is on its way to it. Open the link to activate the account and set up your authenticator app.',
  },
  sentDetailWithAddress: {
    id: 'signup.sent.detailWithAddress',
    defaultMessage:
      'If {email} can be used to open an account, a link is on its way to it. Open the link to activate the account and set up your authenticator app.',
  },
  sentExpiry: {
    id: 'signup.sent.expiry',
    defaultMessage: 'The link works for 48 hours. If it expires, start again from this page and a new one is sent.',
  },
  sentNothing: {
    id: 'signup.sent.nothing',
    defaultMessage:
      'Nothing arrived? Check your spam folder, and check the address. For your security we cannot confirm here whether an address is registered.',
  },
  sentBack: { id: 'signup.sent.back', defaultMessage: 'Use a different address' },

  /* ③ the verification link */
  verifyBusyTitle: { id: 'signup.verify.busyTitle', defaultMessage: 'Checking your link' },
  verifyMissingTitle: { id: 'signup.verify.missingTitle', defaultMessage: 'That link is incomplete' },
  verifyMissingDetail: {
    id: 'signup.verify.missingDetail',
    defaultMessage:
      'The address has no verification link in it. Open the link from your email again — some mail apps shorten a long link when you copy it.',
  },
  verifyDoneTitle: { id: 'signup.verify.doneTitle', defaultMessage: 'Email address confirmed' },
  verifyDoneDetail: {
    id: 'signup.verify.doneDetail',
    defaultMessage: '{email} is confirmed. One thing left: set up the authenticator app you will sign in with.',
  },
  verifyAlreadyDetail: {
    id: 'signup.verify.alreadyDetail',
    defaultMessage:
      '{email} was already confirmed, so there is nothing to do here. If you have not set up an authenticator app yet, do that now.',
  },
  verifyAction: { id: 'signup.verify.action', defaultMessage: 'Set up your authenticator' },
  verifyInvalidTitle: { id: 'signup.verify.invalidTitle', defaultMessage: 'That link is not valid' },
  verifyInvalidDetail: {
    id: 'signup.verify.invalidDetail',
    defaultMessage:
      'It may have been copied incompletely, or it may already have been replaced by a newer one. Sign up again to get a fresh link.',
  },
  verifyExpiredTitle: { id: 'signup.verify.expiredTitle', defaultMessage: 'That link has expired' },
  verifyExpiredDetail: {
    id: 'signup.verify.expiredDetail',
    defaultMessage: 'Verification links last 48 hours. Sign up again with the same address to get a new one.',
  },
  verifyRestart: { id: 'signup.verify.restart', defaultMessage: 'Request another link' },

  /* ④ the authenticator */
  enrolCredentialsTitle: { id: 'signup.enrol.credentialsTitle', defaultMessage: 'Set up your authenticator' },
  enrolCredentialsDetail: {
    id: 'signup.enrol.credentialsDetail',
    defaultMessage:
      'Signing in needs your password and a six-digit code from an authenticator app on your phone. Confirm who you are and we will set one up.',
  },
  enrolEmail: { id: 'signup.enrol.email', defaultMessage: 'Email' },
  enrolPassword: { id: 'signup.enrol.password', defaultMessage: 'Password' },
  enrolCredentialsAction: { id: 'signup.enrol.credentialsAction', defaultMessage: 'Continue' },

  enrolScanTitle: { id: 'signup.enrol.scanTitle', defaultMessage: 'Scan this with your authenticator' },
  enrolScanDetail: {
    id: 'signup.enrol.scanDetail',
    defaultMessage:
      'Open an authenticator app — Google Authenticator, Authy, 1Password, whichever you use — and scan the code. Nothing is switched on until you confirm on the next step.',
  },
  enrolQrLabel: {
    id: 'signup.enrol.qrLabel',
    defaultMessage: 'Setup code for your authenticator app. If you cannot scan it, use the setup key printed below.',
  },
  enrolSecretLabel: { id: 'signup.enrol.secretLabel', defaultMessage: 'Cannot scan? Enter this setup key by hand' },
  enrolSecretCopy: { id: 'signup.enrol.secretCopy', defaultMessage: 'Copy the setup key' },
  enrolCopied: { id: 'signup.enrol.copied', defaultMessage: 'Copied' },

  enrolRecoveryTitle: { id: 'signup.enrol.recoveryTitle', defaultMessage: 'Your recovery codes' },
  enrolRecoveryDetail: {
    id: 'signup.enrol.recoveryDetail',
    defaultMessage:
      'Ten single-use codes. Each one signs you in once if you lose your phone. This is the only time they are shown — they cannot be retrieved later, and without one a lost phone means asking us to reset the account by hand.',
  },
  enrolRecoveryCopy: { id: 'signup.enrol.recoveryCopy', defaultMessage: 'Copy all ten codes' },
  enrolRecoveryConfirm: {
    id: 'signup.enrol.recoveryConfirm',
    defaultMessage: 'I have saved these ten codes somewhere I can get to without my phone.',
  },
  enrolScanAction: { id: 'signup.enrol.scanAction', defaultMessage: 'Continue' },

  enrolConfirmTitle: { id: 'signup.enrol.confirmTitle', defaultMessage: 'Enter a code from the app' },
  enrolConfirmDetail: {
    id: 'signup.enrol.confirmDetail',
    defaultMessage:
      'Type the six digits your authenticator is showing now. This is what proves the app really received the setup code — until it succeeds, nothing has been switched on.',
  },
  enrolTotpLabel: { id: 'signup.enrol.totpLabel', defaultMessage: 'Six-digit code' },
  enrolTotpPlaceholder: { id: 'signup.enrol.totpPlaceholder', defaultMessage: '000000' },
  enrolTotpHint: {
    id: 'signup.enrol.totpHint',
    defaultMessage: 'A recovery code will not work here — only the app can prove it received the setup code.',
  },
  enrolConfirmAction: { id: 'signup.enrol.confirmAction', defaultMessage: 'Finish setup' },
  enrolConfirmBusy: { id: 'signup.enrol.confirmBusy', defaultMessage: 'Finishing…' },
  enrolBackToCode: { id: 'signup.enrol.backToCode', defaultMessage: 'Show the setup code again' },

  /* the forgotten-password flow (/signup/reset) */
  resetAskTitle: { id: 'signup.reset.askTitle', defaultMessage: 'Reset your password' },
  resetAskDetail: {
    id: 'signup.reset.askDetail',
    defaultMessage:
      'Tell us the email you sign in with and we will send it a link to set a new password. Your authenticator app stays as it is.',
  },
  resetAskEmail: { id: 'signup.reset.askEmail', defaultMessage: 'Your sign-in email' },
  resetAskAction: { id: 'signup.reset.askAction', defaultMessage: 'Email me a reset link' },
  resetAskActionBusy: { id: 'signup.reset.askActionBusy', defaultMessage: 'Sending…' },
  resetAskBackToSignIn: { id: 'signup.reset.askBackToSignIn', defaultMessage: 'Back to sign in' },
  resetSentTitle: { id: 'signup.reset.sentTitle', defaultMessage: 'Check your email' },
  /**
   * ⚠ The same rule as the signup 202: the API answers identically whether or
   * not the address has an account, so this screen says only what happens
   * next, conditionally — never "we sent it", never "no account found".
   */
  resetSentDetail: {
    id: 'signup.reset.sentDetail',
    defaultMessage:
      'If {email} can be used to sign in here, a link to set a new password is on its way to it. The link works once, and stops working after 30 minutes.',
  },
  resetSentNothing: {
    id: 'signup.reset.sentNothing',
    defaultMessage:
      'Nothing arrived? Check your spam folder, and check the address. For your security we cannot confirm here whether an address is registered.',
  },
  resetFormTitle: { id: 'signup.reset.formTitle', defaultMessage: 'Set a new password' },
  resetFormDetail: {
    id: 'signup.reset.formDetail',
    defaultMessage: 'Choose the password you will sign in with from now on. Your authenticator app is unchanged.',
  },
  resetFormPassword: { id: 'signup.reset.formPassword', defaultMessage: 'New password' },
  resetFormAction: { id: 'signup.reset.formAction', defaultMessage: 'Set new password' },
  resetFormActionBusy: { id: 'signup.reset.formActionBusy', defaultMessage: 'Setting…' },
  resetDoneTitle: { id: 'signup.reset.doneTitle', defaultMessage: 'Password changed' },
  resetDoneDetail: {
    id: 'signup.reset.doneDetail',
    defaultMessage:
      'Sign in with your new password and a code from your authenticator app. Any older reset links stopped working the moment this one was used.',
  },
  resetInvalidTitle: { id: 'signup.reset.invalidTitle', defaultMessage: 'That link is not valid' },
  resetInvalidDetail: {
    id: 'signup.reset.invalidDetail',
    defaultMessage:
      'It may have been used already, copied incompletely, or replaced by a newer one. Request a fresh link and use that instead.',
  },
  resetExpiredTitle: { id: 'signup.reset.expiredTitle', defaultMessage: 'That link has expired' },
  resetExpiredDetail: {
    id: 'signup.reset.expiredDetail',
    defaultMessage: 'Reset links last 30 minutes. Request a fresh one and use it straight away.',
  },
  resetRequestAnother: { id: 'signup.reset.requestAnother', defaultMessage: 'Request another link' },

  /* done */
  doneTitle: { id: 'signup.done.title', defaultMessage: 'You are all set' },
  doneDetail: {
    id: 'signup.done.detail',
    defaultMessage:
      'Your authenticator is now the second factor for this account. Sign in with your email, your password and a code from the app.',
  },
  doneAction: { id: 'signup.done.action', defaultMessage: 'Sign in' },

  /* faults */
  faultValidation: {
    id: 'signup.fault.validation',
    defaultMessage: 'Some of those details were not accepted. Check the fields above and try again.',
  },
  faultPasswordShort: {
    id: 'signup.fault.passwordShort',
    defaultMessage: 'That password is too short — it needs at least {min} characters.',
  },
  faultCredentials: {
    id: 'signup.fault.credentials',
    defaultMessage: 'That email and password did not match an account. Both have to be right.',
  },
  faultCodeWrong: {
    id: 'signup.fault.codeWrong',
    defaultMessage:
      'That did not match. Check your password, and check the app is showing a fresh code — they change every 30 seconds.',
  },
  faultNotVerified: {
    id: 'signup.fault.notVerified',
    defaultMessage: 'Confirm your email address first — open the link we sent you, then come back here.',
  },
  faultAlreadyEnrolled: {
    id: 'signup.fault.alreadyEnrolled',
    defaultMessage:
      'This account already has an authenticator set up, so there is nothing to do here. Sign in with a code from it, or use one of your recovery codes.',
  },
  faultEnrolmentExpired: {
    id: 'signup.fault.enrolmentExpired',
    defaultMessage:
      'This setup ran out of time and nothing was saved. Start again — you will get a new code to scan and a new set of recovery codes, and the ones on the last screen stop being relevant.',
  },
  faultRateLimited: {
    id: 'signup.fault.rateLimited',
    defaultMessage: 'Too many attempts. Wait a minute and try again.',
  },
  faultServer: {
    id: 'signup.fault.server',
    defaultMessage: 'The server refused that. Try again, and tell us if it keeps happening.',
  },
  faultUnreachable: {
    id: 'signup.fault.unreachable',
    defaultMessage: 'We could not reach the server. Check your connection and try again.',
  },
  faultCode: { id: 'signup.fault.code', defaultMessage: 'Reference: {code}' },
});

/* ── the shell and the step router ───────────────────────────────────────── */

export function SignupView() {
  const segments = usePath();
  const step = segments[1];

  /**
   * What survives between the steps, and nothing more.
   *
   * `sentTo` is only used to render the address back on the check-your-email
   * screen, and `verifiedEmail` only to prefill enrolment — the contract's own
   * reason for returning the address at all is that a mistyped one there reads
   * to the user like a broken password. Neither is a credential, and neither is
   * persisted: a refresh loses them, which is correct, because the journey
   * resumes from the email rather than from this tab.
   */
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [verifiedEmail, setVerifiedEmail] = useState<string | null>(null);

  if (step === 'check-email') return <CheckEmailStep email={sentTo} />;
  if (step === 'verify') return <VerifyStep onVerified={setVerifiedEmail} />;
  if (step === 'enrol') return <EnrolStep initialEmail={verifiedEmail} />;
  if (step === 'reset') return <ResetStep />;
  if (step === 'done') return <DoneStep />;

  return (
    <SignupForm
      onSent={(email) => {
        setSentTo(email);
        navigate('/signup/check-email');
      }}
    />
  );
}

/* ── ① the form ──────────────────────────────────────────────────────────── */

function SignupForm({ onSent }: { onSent: (email: string) => void }) {
  const intl = useIntl();
  const [practiceName, setPracticeName] = useState('');
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [accepted, setAccepted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [fault, setFault] = useState<SignupFault | null>(null);

  const shortBy = Math.max(0, PASSWORD_MIN_LENGTH - password.length);
  const ready =
    practiceName.trim().length > 0 &&
    firstName.trim().length > 0 &&
    lastName.trim().length > 0 &&
    email.trim().includes('@') &&
    shortBy === 0 &&
    accepted;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!ready || busy) return;
    setBusy(true);
    setFault(null);
    try {
      await signUpPractice({ practiceName, firstName, lastName, email, password });
      onSent(email.trim().toLowerCase());
    } catch (error) {
      setFault(faultOf(error));
      setBusy(false);
    }
  };

  return (
    <Shell title={intl.formatMessage(m.formTitle)}>
      <p className="text-[14px] text-zinc-400 leading-relaxed">{intl.formatMessage(m.formDetail)}</p>

      <form onSubmit={submit} className="flex flex-col gap-4">
        <Field id="signup-practice" label={intl.formatMessage(m.formPracticeName)}>
          <input
            id="signup-practice"
            value={practiceName}
            onChange={(e) => setPracticeName(e.target.value)}
            autoComplete="organization"
            maxLength={200}
            disabled={busy}
            placeholder={intl.formatMessage(m.formPracticeNamePlaceholder)}
            className={INPUT}
          />
        </Field>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <Field id="signup-first" label={intl.formatMessage(m.formFirstName)}>
            <input
              id="signup-first"
              value={firstName}
              onChange={(e) => setFirstName(e.target.value)}
              autoComplete="given-name"
              maxLength={100}
              disabled={busy}
              className={INPUT}
            />
          </Field>
          <Field id="signup-last" label={intl.formatMessage(m.formLastName)}>
            <input
              id="signup-last"
              value={lastName}
              onChange={(e) => setLastName(e.target.value)}
              autoComplete="family-name"
              maxLength={100}
              disabled={busy}
              className={INPUT}
            />
          </Field>
        </div>

        <Field id="signup-email" label={intl.formatMessage(m.formEmail)} hint={intl.formatMessage(m.formEmailHint)}>
          <input
            id="signup-email"
            type="email"
            inputMode="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            autoComplete="email"
            disabled={busy}
            placeholder={intl.formatMessage(m.formEmailPlaceholder)}
            className={INPUT}
          />
        </Field>

        <Field
          id="signup-password"
          label={intl.formatMessage(m.formPassword)}
          hint={intl.formatMessage(m.formPasswordHint, { min: PASSWORD_MIN_LENGTH })}
        >
          <input
            id="signup-password"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="new-password"
            minLength={PASSWORD_MIN_LENGTH}
            maxLength={256}
            disabled={busy}
            className={INPUT}
          />
          {password.length > 0 && shortBy > 0 && (
            <p className="text-[12px] font-semibold text-amber-400 mt-2" role="status">
              {intl.formatMessage(m.formPasswordShort, { count: shortBy })}
            </p>
          )}
        </Field>

        {/* The terms version is not a user choice: the server refuses a signup
            naming any version but the one in force, and what a person accepted
            is recorded as an audit event. So the checkbox records acceptance of
            exactly TERMS_VERSION and the link goes to that document. */}
        <div className="flex items-start gap-3 rounded-2xl border border-white/5 bg-card p-4">
          <input
            id="signup-terms"
            type="checkbox"
            checked={accepted}
            onChange={(e) => setAccepted(e.target.checked)}
            disabled={busy}
            className="mt-0.5 w-4 h-4 shrink-0 accent-brand hit-area"
          />
          <div className="min-w-0 flex flex-col gap-1.5">
            <label htmlFor="signup-terms" className="text-[13px] text-zinc-300 leading-relaxed">
              {intl.formatMessage(m.formTermsLabel)}
            </label>
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
              <a
                {...linkProps(legalPath('terms-of-service'))}
                target="_blank"
                rel="noreferrer"
                className="text-[12px] font-bold text-brand hover:underline"
              >
                {intl.formatMessage(m.formTermsLink)}
              </a>
              <a
                {...linkProps(legalPath('privacy-notice'))}
                target="_blank"
                rel="noreferrer"
                className="text-[12px] font-bold text-brand hover:underline"
              >
                {intl.formatMessage(m.formPrivacyLink)}
              </a>
            </div>
          </div>
        </div>

        <Fault fault={fault} passwordMin={shortBy > 0} />

        <PrimaryButton
          type="submit"
          disabled={!ready}
          busy={busy}
          icon={UserPlus}
          label={intl.formatMessage(busy ? m.formActionBusy : m.formAction)}
        />
      </form>

      <a {...linkProps('/app')} className="text-[13px] font-bold text-zinc-500 hover:text-white transition-colors">
        {intl.formatMessage(m.formHaveAccount)}
      </a>
    </Shell>
  );
}

/* ── ② check your email ──────────────────────────────────────────────────── */

/**
 * The screen that must not say what happened.
 *
 * `POST /practices` answers `202` with an empty body whether or not an account
 * was created — deliberately, because saying so would answer "is this address
 * registered here" for whoever asks. So there is no "account created" here and
 * no "that address is already registered": only what happens next, which is
 * true in both cases.
 *
 * `email` is what the visitor typed a moment ago, held in this tab. Rendering
 * it back is not a disclosure — they wrote it — and it is null on a refresh, in
 * which case the same sentence is written without it.
 */
function CheckEmailStep({ email }: { email: string | null }) {
  const intl = useIntl();
  return (
    <Shell title={intl.formatMessage(m.sentTitle)} icon={Mail}>
      <OutcomeBadge good />
      <p className="text-[14px] text-zinc-400 leading-relaxed">
        {email
          ? intl.formatMessage(m.sentDetailWithAddress, { email })
          : intl.formatMessage(m.sentDetail)}
      </p>
      <p className="text-[13px] text-zinc-500 leading-relaxed">{intl.formatMessage(m.sentExpiry)}</p>
      <p className="text-[12px] text-zinc-600 leading-relaxed">{intl.formatMessage(m.sentNothing)}</p>
      <a {...linkProps('/signup')} className="text-[13px] font-bold text-zinc-500 hover:text-white transition-colors">
        {intl.formatMessage(m.sentBack)}
      </a>
    </Shell>
  );
}

/* ── ③ the verification link ─────────────────────────────────────────────── */

type VerifyState =
  | { kind: 'busy' }
  | { kind: 'missing' }
  | { kind: 'done'; email: string; alreadyVerified: boolean }
  | { kind: 'failed'; fault: SignupFault };

/**
 * The landing spot for the link in the signup email.
 *
 * Invalid and expired are the only two outcomes the API distinguishes, and it
 * distinguishes them for a reason worth keeping in the copy: an expiry is a
 * fact about a token its holder already had, so "ask for another" is safe to
 * say, while everything else collapses into one verdict that discloses
 * nothing.
 */
function VerifyStep({ onVerified }: { onVerified: (email: string) => void }) {
  const intl = useIntl();
  const [token, setToken] = useQueryParam('token');
  const [state, setState] = useState<VerifyState>({ kind: 'busy' });
  // The token is spent exactly once. Without this, clearing it from the
  // address re-renders and a StrictMode double-mount posts it twice — which
  // the API tolerates (verification is idempotent) but which would still be
  // this component asking a question it already has the answer to.
  const spent = useRef(false);

  useEffect(() => {
    if (spent.current) return;
    if (!token) {
      setState({ kind: 'missing' });
      return;
    }
    spent.current = true;
    const value = token;
    // ⚠ Scrub it from the address before the request, not after. It is a
    // credential; every moment it sits in `location.search` it is in the
    // history, in a `Referer` on the next outbound link, and in whatever the
    // browser syncs between devices. `replace` so Back does not restore it.
    setToken(null, { replace: true });
    void verifyEmail(value)
      .then((result) => {
        setState({ kind: 'done', email: result.email, alreadyVerified: result.alreadyVerified });
        onVerified(result.email);
      })
      .catch((error: unknown) => setState({ kind: 'failed', fault: faultOf(error) }));
  }, [token, setToken, onVerified]);

  if (state.kind === 'busy') {
    return (
      <Shell title={intl.formatMessage(m.verifyBusyTitle)}>
        <Loader2 size={22} className="animate-spin text-brand" />
      </Shell>
    );
  }

  if (state.kind === 'missing') {
    return (
      <Shell title={intl.formatMessage(m.verifyMissingTitle)}>
        <OutcomeBadge />
        <p className="text-[14px] text-zinc-400 leading-relaxed">{intl.formatMessage(m.verifyMissingDetail)}</p>
        <a {...linkProps('/signup')} className="text-[13px] font-bold text-brand hover:underline">
          {intl.formatMessage(m.verifyRestart)}
        </a>
      </Shell>
    );
  }

  if (state.kind === 'failed') {
    const expired = state.fault.code === 'NT-AUTH-005';
    return (
      <Shell title={intl.formatMessage(expired ? m.verifyExpiredTitle : m.verifyInvalidTitle)}>
        <OutcomeBadge />
        <p className="text-[14px] text-zinc-400 leading-relaxed">
          {intl.formatMessage(expired ? m.verifyExpiredDetail : m.verifyInvalidDetail)}
        </p>
        {state.fault.code && (
          <p className="text-[11px] text-zinc-600 font-bold tracking-wide">
            {intl.formatMessage(m.faultCode, { code: state.fault.code })}
          </p>
        )}
        <a {...linkProps('/signup')} className="text-[13px] font-bold text-brand hover:underline">
          {intl.formatMessage(m.verifyRestart)}
        </a>
      </Shell>
    );
  }

  return (
    <Shell title={intl.formatMessage(m.verifyDoneTitle)}>
      <OutcomeBadge good />
      <p className="text-[14px] text-zinc-400 leading-relaxed">
        {intl.formatMessage(state.alreadyVerified ? m.verifyAlreadyDetail : m.verifyDoneDetail, { email: state.email })}
      </p>
      <PrimaryButton
        onClick={() => navigate('/signup/enrol')}
        icon={ShieldCheck}
        label={intl.formatMessage(m.verifyAction)}
      />
    </Shell>
  );
}

/* ── ④ the authenticator ─────────────────────────────────────────────────── */

type EnrolStage = 'credentials' | 'save' | 'confirm';

/**
 * Enrolment, in the three parts A14's two-step makes possible.
 *
 * ⚠ **EXPORTED, and reused UNCHANGED by the invited colleague's journey**
 * (`views/invite/InviteView.tsx`). A second enrolment screen would be a second
 * place the two-step could be got wrong — and getting it wrong costs the
 * account, because this release has no re-enrolment or reset flow. The two
 * journeys differ in how the account came to exist and are identical from the
 * moment it does, so they share this step and the `/signup/done` screen after
 * it. Do not fork it: change it here, for both.
 *
 * ⚠ **`begin` WRITES NOTHING; `confirm` IS WHAT SWITCHES THE FACTOR ON.** That
 * is why the user is made to type a real code before this finishes, and it is
 * the difference between a mis-scanned QR costing thirty seconds and costing
 * the account: this release has no re-enrolment flow, so an enrolment written
 * at step one and never producing a valid code would be a permanent lockout.
 *
 * ⚠ **The password is held in state across all three parts because both calls
 * need it** — `begin` and `confirm` are each authenticated by password alone,
 * being the one pair of routes that cannot require a second factor. It is never
 * written anywhere else, and it dies with the tab.
 */
export function EnrolStep({ initialEmail }: { initialEmail: string | null }) {
  const intl = useIntl();
  const [stage, setStage] = useState<EnrolStage>('credentials');
  const [email, setEmail] = useState(initialEmail ?? '');
  const [password, setPassword] = useState('');
  const [offer, setOffer] = useState<EnrolmentOffer | null>(null);
  const [saved, setSaved] = useState(false);
  const [totp, setTotp] = useState('');
  const [busy, setBusy] = useState(false);
  const [fault, setFault] = useState<SignupFault | null>(null);

  /** Back to the start, discarding a candidate that was never written. */
  const restart = useCallback(() => {
    setOffer(null);
    setSaved(false);
    setTotp('');
    setStage('credentials');
  }, []);

  const begin = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setFault(null);
    try {
      setOffer(await beginEnrolment(email, password));
      setStage('save');
    } catch (error) {
      setFault(faultOf(error));
    } finally {
      setBusy(false);
    }
  };

  const confirm = async (event: FormEvent) => {
    event.preventDefault();
    if (busy || !offer || totp.length !== TOTP_LENGTH) return;
    setBusy(true);
    setFault(null);
    try {
      await confirmEnrolment({ email, password, enrolmentToken: offer.enrolmentToken, totp });
      navigate('/signup/done');
    } catch (error) {
      const next = faultOf(error);
      setFault(next);
      setTotp('');
      // NT-AUTH-008 means the fifteen-minute candidate expired. Nothing was
      // written, so the only honest move is to start over — and the recovery
      // codes on the previous screen belong to a candidate that no longer
      // exists, which the fault copy says in as many words.
      if (next.code === 'NT-AUTH-008') restart();
      setBusy(false);
    }
  };

  if (stage === 'credentials') {
    return (
      <Shell title={intl.formatMessage(m.enrolCredentialsTitle)} icon={ShieldCheck}>
        <p className="text-[14px] text-zinc-400 leading-relaxed">{intl.formatMessage(m.enrolCredentialsDetail)}</p>
        <form onSubmit={begin} className="flex flex-col gap-4">
          <Field id="enrol-email" label={intl.formatMessage(m.enrolEmail)}>
            <input
              id="enrol-email"
              type="email"
              inputMode="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              autoComplete="email"
              disabled={busy}
              className={INPUT}
            />
          </Field>
          <Field id="enrol-password" label={intl.formatMessage(m.enrolPassword)}>
            <input
              id="enrol-password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
              disabled={busy}
              className={INPUT}
            />
          </Field>
          <Fault fault={fault} />
          <PrimaryButton
            type="submit"
            disabled={!email.includes('@') || password.length === 0}
            busy={busy}
            icon={ArrowRight}
            label={intl.formatMessage(m.enrolCredentialsAction)}
          />
        </form>
      </Shell>
    );
  }

  if (stage === 'save' && offer) {
    return (
      <Shell title={intl.formatMessage(m.enrolScanTitle)} icon={ShieldCheck}>
        <p className="text-[14px] text-zinc-400 leading-relaxed">{intl.formatMessage(m.enrolScanDetail)}</p>

        {/* The white card is the QR's own ground — see QrCode.tsx: a symbol
            rendered light-on-dark is read by some phones and not others. */}
        <div className="self-center rounded-3xl bg-white p-4">
          <QrCode value={offer.uri} label={intl.formatMessage(m.enrolQrLabel)} />
        </div>

        <div>
          <p className="text-[11px] font-bold text-zinc-500 uppercase tracking-widest mb-2">
            {intl.formatMessage(m.enrolSecretLabel)}
          </p>
          <div className="flex items-center gap-2">
            <code className="flex-1 min-w-0 break-all rounded-2xl border border-white/5 bg-card px-4 py-3 text-[13px] font-bold tracking-wider text-white">
              {offer.secret}
            </code>
            <CopyButton value={offer.secret} label={intl.formatMessage(m.enrolSecretCopy)} />
          </div>
        </div>

        <div className="rounded-3xl border border-amber-500/25 bg-amber-500/5 p-5 flex flex-col gap-3">
          <p className="flex items-center gap-2 text-[13px] font-bold text-amber-300">
            <KeyRound size={15} className="shrink-0" />
            {intl.formatMessage(m.enrolRecoveryTitle)}
          </p>
          <p className="text-[13px] text-zinc-400 leading-relaxed">{intl.formatMessage(m.enrolRecoveryDetail)}</p>
          <ul className="grid grid-cols-2 gap-x-4 gap-y-1.5">
            {offer.recoveryCodes.map((code) => (
              <li key={code} className="font-mono text-[13px] font-bold tracking-wide text-white tabular-nums">
                {code}
              </li>
            ))}
          </ul>
          <CopyButton value={offer.recoveryCodes.join('\n')} label={intl.formatMessage(m.enrolRecoveryCopy)} wide />
          <label className="flex items-start gap-3 text-[13px] text-zinc-300 leading-relaxed">
            <input
              type="checkbox"
              checked={saved}
              onChange={(e) => setSaved(e.target.checked)}
              className="mt-0.5 w-4 h-4 shrink-0 accent-brand hit-area"
            />
            {intl.formatMessage(m.enrolRecoveryConfirm)}
          </label>
        </div>

        <PrimaryButton
          onClick={() => setStage('confirm')}
          disabled={!saved}
          icon={ArrowRight}
          label={intl.formatMessage(m.enrolScanAction)}
        />
      </Shell>
    );
  }

  return (
    <Shell title={intl.formatMessage(m.enrolConfirmTitle)} icon={ShieldCheck}>
      <p className="text-[14px] text-zinc-400 leading-relaxed">{intl.formatMessage(m.enrolConfirmDetail)}</p>
      <form onSubmit={confirm} className="flex flex-col gap-4">
        <Field id="enrol-totp" label={intl.formatMessage(m.enrolTotpLabel)} hint={intl.formatMessage(m.enrolTotpHint)}>
          <input
            id="enrol-totp"
            value={totp}
            onChange={(e) => setTotp(e.target.value.replace(/\D/g, '').slice(0, TOTP_LENGTH))}
            inputMode="numeric"
            autoComplete="one-time-code"
            disabled={busy}
            placeholder={intl.formatMessage(m.enrolTotpPlaceholder)}
            className="w-full bg-card border border-white/5 rounded-2xl px-5 py-4 text-2xl font-bold tracking-[0.4em] text-center text-white placeholder:text-zinc-700 focus:outline-none focus:border-brand transition-colors tabular-nums disabled:opacity-50"
          />
        </Field>
        <Fault fault={fault} enrolling />
        <PrimaryButton
          type="submit"
          disabled={totp.length !== TOTP_LENGTH}
          busy={busy}
          icon={BadgeCheck}
          label={intl.formatMessage(busy ? m.enrolConfirmBusy : m.enrolConfirmAction)}
        />
      </form>
      {offer && (
        <button
          onClick={() => setStage('save')}
          className="self-start text-[13px] font-bold text-zinc-500 hover:text-white transition-colors"
        >
          {intl.formatMessage(m.enrolBackToCode)}
        </button>
      )}
    </Shell>
  );
}

/* ── the forgotten-password flow (/signup/reset) ─────────────────────────── */

type ResetPhase =
  | { kind: 'ask' }
  | { kind: 'sent'; email: string }
  | { kind: 'form' }
  | { kind: 'done' }
  | { kind: 'dead'; expired: boolean; code: string | null };

/**
 * Both halves of the forgotten-password journey live at one address, exactly
 * as the emailed link demands: with no `?token=` this is the "email me a
 * link" form, and with one it is the set-a-new-password form. The mail's side
 * of the address is `RESET_PASSWORD_PATH` in the API's
 * `notifications-signup-mailer.ts` — the SPA drift trap the verify path
 * already fell into once, so the pinning test covers this pair too.
 *
 * ⚠ The ask half is under the same rule as `/signup/check-email`: the API
 * answers the identical `202` whatever happened, so the sent screen says only
 * what happens next, conditionally. And the token is scrubbed from the
 * address bar the moment it is read, before any request — it is a credential,
 * and it must not sit in the history or ride a `Referer`.
 */
function ResetStep() {
  const intl = useIntl();
  const [urlToken, setUrlToken] = useQueryParam('token');
  const [token, setToken] = useState<string | null>(null);
  const [phase, setPhase] = useState<ResetPhase>({ kind: 'ask' });
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [fault, setFault] = useState<SignupFault | null>(null);
  const claimed = useRef(false);

  useEffect(() => {
    if (claimed.current || !urlToken) return;
    claimed.current = true;
    const value = urlToken;
    setUrlToken(null, { replace: true });
    setToken(value);
    setPhase({ kind: 'form' });
  }, [urlToken, setUrlToken]);

  const ask = async (event: FormEvent) => {
    event.preventDefault();
    if (busy || !email.includes('@')) return;
    setBusy(true);
    setFault(null);
    const wanted = email.trim().toLowerCase();
    try {
      await requestPasswordReset(wanted);
      setPhase({ kind: 'sent', email: wanted });
    } catch (error) {
      // Only the caller's own failures can land here — a 400, a 429, or no
      // answer at all. Never "no such account": the 202 is uniform.
      setFault(faultOf(error));
    } finally {
      setBusy(false);
    }
  };

  const shortBy = Math.max(0, PASSWORD_MIN_LENGTH - password.length);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy || token === null || shortBy > 0) return;
    setBusy(true);
    setFault(null);
    try {
      await resetPassword(token, password);
      setPassword('');
      setPhase({ kind: 'done' });
    } catch (error) {
      const next = faultOf(error);
      // A dead link is a dead end for THIS screen — the only remedy is a
      // fresh one, so the form gives way to the say-so rather than inviting
      // retries against a verdict that cannot change.
      if (next.code === 'NT-AUTH-004' || next.code === 'NT-AUTH-005') {
        setPhase({ kind: 'dead', expired: next.code === 'NT-AUTH-005', code: next.code });
      } else {
        setFault(next);
      }
      setBusy(false);
    }
  };

  if (phase.kind === 'sent') {
    return (
      <Shell title={intl.formatMessage(m.resetSentTitle)} icon={Mail}>
        <OutcomeBadge good />
        <p className="text-[14px] text-zinc-400 leading-relaxed">
          {intl.formatMessage(m.resetSentDetail, { email: phase.email })}
        </p>
        <p className="text-[12px] text-zinc-600 leading-relaxed">{intl.formatMessage(m.resetSentNothing)}</p>
        <a {...linkProps('/app')} className="text-[13px] font-bold text-zinc-500 hover:text-white transition-colors">
          {intl.formatMessage(m.resetAskBackToSignIn)}
        </a>
      </Shell>
    );
  }

  if (phase.kind === 'done') {
    return (
      <Shell title={intl.formatMessage(m.resetDoneTitle)} icon={BadgeCheck}>
        <OutcomeBadge good />
        <p className="text-[14px] text-zinc-400 leading-relaxed">{intl.formatMessage(m.resetDoneDetail)}</p>
        <a
          {...linkProps('/app')}
          className="w-full flex items-center justify-center gap-2 px-6 py-3.5 rounded-full text-[14px] font-bold text-brand-on bg-brand hover:bg-brand-hover transition-colors shadow-glow-cta"
        >
          <LogIn size={16} strokeWidth={2.5} aria-hidden="true" />
          {intl.formatMessage(m.doneAction)}
        </a>
      </Shell>
    );
  }

  if (phase.kind === 'dead') {
    return (
      <Shell title={intl.formatMessage(phase.expired ? m.resetExpiredTitle : m.resetInvalidTitle)}>
        <OutcomeBadge />
        <p className="text-[14px] text-zinc-400 leading-relaxed">
          {intl.formatMessage(phase.expired ? m.resetExpiredDetail : m.resetInvalidDetail)}
        </p>
        {phase.code && (
          <p className="text-[11px] text-zinc-600 font-bold tracking-wide">
            {intl.formatMessage(m.faultCode, { code: phase.code })}
          </p>
        )}
        <a {...linkProps('/signup/reset')} className="text-[13px] font-bold text-brand hover:underline">
          {intl.formatMessage(m.resetRequestAnother)}
        </a>
      </Shell>
    );
  }

  if (phase.kind === 'form') {
    return (
      <Shell title={intl.formatMessage(m.resetFormTitle)} icon={KeyRound}>
        <p className="text-[14px] text-zinc-400 leading-relaxed">{intl.formatMessage(m.resetFormDetail)}</p>
        <form onSubmit={submit} className="flex flex-col gap-4">
          <Field
            id="reset-password"
            label={intl.formatMessage(m.resetFormPassword)}
            hint={intl.formatMessage(m.formPasswordHint, { min: PASSWORD_MIN_LENGTH })}
          >
            <input
              id="reset-password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="new-password"
              minLength={PASSWORD_MIN_LENGTH}
              maxLength={200}
              disabled={busy}
              className={INPUT}
            />
            {password.length > 0 && shortBy > 0 && (
              <p className="text-[12px] font-semibold text-amber-400 mt-2" role="status">
                {intl.formatMessage(m.formPasswordShort, { count: shortBy })}
              </p>
            )}
          </Field>
          <Fault fault={fault} passwordMin={shortBy > 0} />
          <PrimaryButton
            type="submit"
            disabled={shortBy > 0}
            busy={busy}
            icon={KeyRound}
            label={intl.formatMessage(busy ? m.resetFormActionBusy : m.resetFormAction)}
          />
        </form>
      </Shell>
    );
  }

  return (
    <Shell title={intl.formatMessage(m.resetAskTitle)} icon={KeyRound}>
      <p className="text-[14px] text-zinc-400 leading-relaxed">{intl.formatMessage(m.resetAskDetail)}</p>
      <form onSubmit={ask} className="flex flex-col gap-4">
        <Field id="reset-email" label={intl.formatMessage(m.resetAskEmail)}>
          <input
            id="reset-email"
            type="email"
            inputMode="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            autoComplete="email"
            disabled={busy}
            placeholder={intl.formatMessage(m.formEmailPlaceholder)}
            className={INPUT}
          />
        </Field>
        <Fault fault={fault} />
        <PrimaryButton
          type="submit"
          disabled={!email.includes('@')}
          busy={busy}
          icon={Mail}
          label={intl.formatMessage(busy ? m.resetAskActionBusy : m.resetAskAction)}
        />
      </form>
      <a {...linkProps('/app')} className="text-[13px] font-bold text-zinc-500 hover:text-white transition-colors">
        {intl.formatMessage(m.resetAskBackToSignIn)}
      </a>
    </Shell>
  );
}

/* ── done ────────────────────────────────────────────────────────────────── */

function DoneStep() {
  const intl = useIntl();
  return (
    <Shell title={intl.formatMessage(m.doneTitle)} icon={BadgeCheck}>
      <OutcomeBadge good />
      <p className="text-[14px] text-zinc-400 leading-relaxed">{intl.formatMessage(m.doneDetail)}</p>
      <a
        {...linkProps('/app')}
        className="w-full flex items-center justify-center gap-2 px-6 py-3.5 rounded-full text-[14px] font-bold text-brand-on bg-brand hover:bg-brand-hover transition-colors shadow-glow-cta"
      >
        <LogIn size={16} strokeWidth={2.5} aria-hidden="true" />
        {intl.formatMessage(m.doneAction)}
      </a>
    </Shell>
  );
}

/* ── shared chrome ───────────────────────────────────────────────────────── */

const INPUT =
  'w-full bg-card border border-white/5 rounded-2xl px-4 py-3.5 text-[14px] text-white placeholder:text-zinc-600 focus:outline-none focus:border-brand transition-colors disabled:opacity-50';

/**
 * The signup shell: the wordmark, a title, and a narrow column.
 *
 * Deliberately the login screen's proportions rather than the workspace's —
 * this is opened by one person on one device, often a phone, and it is the
 * first surface of the product anybody sees.
 */
function Shell({
  title,
  icon: Icon,
  children,
}: {
  title: string;
  icon?: React.ComponentType<{ size?: number; className?: string }>;
  children: React.ReactNode;
}) {
  const intl = useIntl();
  return (
    <div className="flex-1 flex flex-col min-w-0 h-vv bg-ground overflow-y-auto px-safe">
      <div className="w-full max-w-md mx-auto px-5 pt-10 pb-safe-6 my-auto flex flex-col gap-5">
        <div className="flex flex-col gap-4">
          <a {...linkProps('/')} className="self-start rounded-full focus:outline-none focus-visible:ring-2 ring-brand">
            <Wordmark title={intl.formatMessage(m.wordmarkTitle)} size={22} className="text-white" />
          </a>
          <div className="flex items-center gap-3 min-w-0">
            {Icon && (
              <div className="w-11 h-11 rounded-2xl bg-brand flex items-center justify-center text-brand-on shrink-0 shadow-glow-tile">
                <Icon size={19} />
              </div>
            )}
            <div className="min-w-0">
              <h1 className="font-sans font-bold text-xl text-white tracking-tight">{title}</h1>
              <p className="text-[11px] text-zinc-500 font-semibold uppercase tracking-wider truncate">
                {intl.formatMessage(m.shellSubtitle)}
              </p>
            </div>
          </div>
        </div>
        {children}
      </div>
    </div>
  );
}

function Field({
  id,
  label,
  hint,
  children,
}: {
  id: string;
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <label htmlFor={id} className="block text-[11px] font-bold text-zinc-500 uppercase tracking-widest mb-2">
        {label}
      </label>
      {children}
      {hint && <p className="text-[12px] text-zinc-600 leading-relaxed mt-2">{hint}</p>}
    </div>
  );
}

function PrimaryButton({
  onClick,
  label,
  icon: Icon,
  disabled = false,
  busy = false,
  type = 'button',
}: {
  onClick?: () => void;
  label: string;
  icon: React.ComponentType<{ size?: number; strokeWidth?: number; className?: string }>;
  disabled?: boolean;
  busy?: boolean;
  type?: 'button' | 'submit';
}) {
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled || busy}
      className="w-full flex items-center justify-center gap-2 px-6 py-3.5 rounded-full text-[14px] font-bold text-brand-on bg-brand hover:bg-brand-hover disabled:opacity-40 disabled:cursor-not-allowed transition-colors shadow-glow-cta"
    >
      {busy ? <Loader2 size={16} className="animate-spin" /> : <Icon size={16} strokeWidth={2.5} />}
      {label}
    </button>
  );
}

/**
 * Copy to the clipboard, saying so for two seconds.
 *
 * Failure is silent on purpose: the clipboard is denied outright in some
 * browsers and every value this button offers is also rendered on screen, so
 * the fallback — read it and type it — is already in front of the user. An
 * error toast here would be noise about a thing that did not stop them.
 */
function CopyButton({ value, label, wide = false }: { value: string; label: string; wide?: boolean }) {
  const intl = useIntl();
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 2000);
    return () => window.clearTimeout(timer);
  }, [copied]);

  return (
    <button
      type="button"
      onClick={() => void navigator.clipboard?.writeText(value).then(() => setCopied(true)).catch(() => undefined)}
      className={`${wide ? 'w-full justify-center' : 'shrink-0'} flex items-center gap-2 px-4 py-3 rounded-2xl border border-white/10 text-[12px] font-bold text-zinc-300 hover:text-white hover:border-brand/40 transition-colors`}
    >
      {copied ? <BadgeCheck size={14} className="text-brand" /> : <Copy size={14} />}
      {copied ? intl.formatMessage(m.enrolCopied) : label}
    </button>
  );
}

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
 * Plain English first, the `NT-` reference after it (the frontend ten, item 5).
 *
 * Every code named here is one a person on this journey can actually reach, and
 * each gets the sentence that tells them what to do next rather than what the
 * server called it. `NT-AUTH-003` says different things on the two screens it
 * can appear on — on enrolment's first step only the password can be wrong, and
 * on its last one the code can be too — which is why `enrolling` exists.
 */
function Fault({
  fault,
  enrolling = false,
  passwordMin = false,
}: {
  fault: SignupFault | null;
  enrolling?: boolean;
  passwordMin?: boolean;
}) {
  const intl = useIntl();
  if (!fault) return null;

  const message =
    fault.code === 'NT-AUTH-003'
      ? intl.formatMessage(enrolling ? m.faultCodeWrong : m.faultCredentials)
      : fault.code === 'NT-AUTH-006'
        ? intl.formatMessage(m.faultNotVerified)
        : fault.code === 'NT-AUTH-007'
          ? intl.formatMessage(m.faultAlreadyEnrolled)
          : fault.code === 'NT-AUTH-008'
            ? intl.formatMessage(m.faultEnrolmentExpired)
            : fault.code === 'NT-RATE-001'
              ? intl.formatMessage(m.faultRateLimited)
              : fault.code === 'NT-VAL-001'
                ? intl.formatMessage(
                    passwordMin || fault.fields.includes('password') ? m.faultPasswordShort : m.faultValidation,
                    { min: PASSWORD_MIN_LENGTH },
                  )
                : fault.code
                  ? intl.formatMessage(m.faultServer)
                  : intl.formatMessage(m.faultUnreachable);

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

// The terms version this form accepts is a fact about the server, not a choice
// made here — re-exported so a test can assert the form sends the one in force
// rather than a copy that has drifted.
export { TERMS_VERSION };
