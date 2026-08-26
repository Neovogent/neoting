import { useState, type FormEvent } from 'react';
import { defineMessages, useIntl } from 'react-intl';
import { AlertTriangle, Loader2, LogIn } from 'lucide-react';
import { NtProblemError } from '@neoting/contracts';
import { login } from '../api/auth';
import { queryClient } from '../api/queryClient';
import logo from '../assets/logo.png';

/**
 * The front door (METH Stage 6). Email + password + TOTP against
 * `POST /v1/auth/sessions`; a 204 sets the httpOnly session cookie and the
 * refetched /me swaps this screen for the workspace — success is the app
 * itself appearing, not a message here.
 *
 * The TOTP field accepts any six digits on the client — the server is the
 * verifier (`000000` under OTP_MODE=demo), and a client that knew the real
 * rule would be holding a secret it must not have.
 *
 * Every credential failure is the same `NT-AUTH-003` by design (the server
 * refuses to say WHICH of the three was wrong — an enumeration oracle
 * otherwise), so the error copy names all three and wears the code.
 */
const m = defineMessages({
  title: { id: 'auth.loginView.title', defaultMessage: 'Sign in to Neoting' },
  subtitle: {
    id: 'auth.loginView.subtitle',
    defaultMessage: 'Your practice workspace',
  },
  detail: {
    id: 'auth.loginView.detail',
    defaultMessage: 'Use your practice email, your password, and the six-digit code from your authenticator.',
  },
  emailLabel: { id: 'auth.loginView.emailLabel', defaultMessage: 'Email' },
  emailPlaceholder: { id: 'auth.loginView.emailPlaceholder', defaultMessage: 'you@practice.co.uk' },
  passwordLabel: { id: 'auth.loginView.passwordLabel', defaultMessage: 'Password' },
  totpLabel: { id: 'auth.loginView.totpLabel', defaultMessage: 'Verification code' },
  totpPlaceholder: { id: 'auth.loginView.totpPlaceholder', defaultMessage: '000000' },
  totpHint: {
    id: 'auth.loginView.totpHint',
    defaultMessage: 'Six digits. The server checks it — not this page.',
  },
  action: { id: 'auth.loginView.action', defaultMessage: 'Sign in' },
  actionBusy: { id: 'auth.loginView.actionBusy', defaultMessage: 'Signing in…' },
  faultCredentials: {
    id: 'auth.loginView.faultCredentials',
    defaultMessage: 'That email, password or verification code did not match. All three have to be right.',
  },
  faultRefused: {
    id: 'auth.loginView.faultRefused',
    defaultMessage: 'The server refused the sign-in. Try again, and tell your administrator if it keeps happening.',
  },
  faultUnreachable: {
    id: 'auth.loginView.faultUnreachable',
    defaultMessage: 'We could not reach the server. Check your connection and try again.',
  },
  faultCode: { id: 'auth.loginView.faultCode', defaultMessage: 'Reference: {code}' },
  audit: {
    id: 'auth.loginView.audit',
    defaultMessage: 'Every sign-in is audited. Nothing in this product changes state without a named human.',
  },
  logoAlt: {
    id: 'auth.loginView.logoAlt',
    defaultMessage: 'Neoting',
    description: 'Alt text for the product mark on the login screen. A product name — leave untranslated.',
  },
});

const TOTP_LENGTH = 6;

interface LoginFault {
  kind: 'credentials' | 'refused' | 'unreachable';
  code: string | null;
}

function faultOf(error: unknown): LoginFault {
  if (error instanceof NtProblemError) {
    return { kind: error.status === 401 ? 'credentials' : 'refused', code: error.code };
  }
  return { kind: 'unreachable', code: null };
}

export function LoginView() {
  const intl = useIntl();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [totp, setTotp] = useState('');
  const [busy, setBusy] = useState(false);
  const [fault, setFault] = useState<LoginFault | null>(null);

  const ready = email.trim().includes('@') && password.length > 0 && totp.length === TOTP_LENGTH;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!ready || busy) return;
    setBusy(true);
    setFault(null);
    try {
      await login({ email: email.trim(), password, totp });
      // The cookie is set; the refetched /me is what swaps this screen for
      // the workspace. Everything is invalidated so the slices that were
      // gated on the session fire against the new identity, not a stale one.
      await queryClient.invalidateQueries();
    } catch (error) {
      setFault(faultOf(error));
      setBusy(false);
    }
  };

  const faultMessage =
    fault?.kind === 'credentials'
      ? intl.formatMessage(m.faultCredentials)
      : fault?.kind === 'refused'
        ? intl.formatMessage(m.faultRefused)
        : intl.formatMessage(m.faultUnreachable);

  // h-vv, not min-h-vv: index.css registers `@utility h-vv` and
  // `@utility max-h-vv` only, so `min-h-vv` compiled to nothing and this column
  // collapsed to content height on a phone with the URL bar showing.
  return (
    <div className="flex-1 flex flex-col min-w-0 h-vv bg-ground overflow-y-auto px-safe">
      <div className="w-full max-w-sm mx-auto px-5 pt-10 pb-safe-6 my-auto flex flex-col gap-5">
        <div className="flex items-center gap-3">
          <img
            src={logo}
            alt={intl.formatMessage(m.logoAlt)}
            className="w-11 h-11 rounded-2xl shrink-0 object-cover shadow-glow-logo"
          />
          <div className="min-w-0">
            <h1 className="font-sans font-bold text-xl text-white tracking-tight truncate">
              {intl.formatMessage(m.title)}
            </h1>
            <p className="text-[11px] text-zinc-500 font-semibold uppercase tracking-wider truncate">
              {intl.formatMessage(m.subtitle)}
            </p>
          </div>
        </div>

        <p className="text-[14px] text-zinc-400 leading-relaxed">{intl.formatMessage(m.detail)}</p>

        <form onSubmit={submit} className="flex flex-col gap-4">
          <div>
            <label
              htmlFor="login-email"
              className="block text-[11px] font-bold text-zinc-500 uppercase tracking-widest mb-2"
            >
              {intl.formatMessage(m.emailLabel)}
            </label>
            <input
              id="login-email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              autoComplete="email"
              disabled={busy}
              placeholder={intl.formatMessage(m.emailPlaceholder)}
              className="w-full bg-card border border-white/5 rounded-2xl px-4 py-3.5 text-[14px] text-white placeholder:text-zinc-600 focus:outline-none focus:border-brand transition-colors disabled:opacity-50"
            />
          </div>

          <div>
            <label
              htmlFor="login-password"
              className="block text-[11px] font-bold text-zinc-500 uppercase tracking-widest mb-2"
            >
              {intl.formatMessage(m.passwordLabel)}
            </label>
            <input
              id="login-password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
              disabled={busy}
              className="w-full bg-card border border-white/5 rounded-2xl px-4 py-3.5 text-[14px] text-white placeholder:text-zinc-600 focus:outline-none focus:border-brand transition-colors disabled:opacity-50"
            />
          </div>

          <div>
            <label
              htmlFor="login-totp"
              className="block text-[11px] font-bold text-zinc-500 uppercase tracking-widest mb-2"
            >
              {intl.formatMessage(m.totpLabel)}
            </label>
            <input
              id="login-totp"
              value={totp}
              onChange={(e) => setTotp(e.target.value.replace(/\D/g, '').slice(0, TOTP_LENGTH))}
              inputMode="numeric"
              autoComplete="one-time-code"
              disabled={busy}
              placeholder={intl.formatMessage(m.totpPlaceholder)}
              className="w-full bg-card border border-white/5 rounded-2xl px-5 py-3.5 text-xl font-bold tracking-[0.4em] text-center text-white placeholder:text-zinc-700 focus:outline-none focus:border-brand transition-colors tabular-nums disabled:opacity-50"
            />
            <p className="text-[12px] text-zinc-600 leading-relaxed mt-2">{intl.formatMessage(m.totpHint)}</p>
          </div>

          {fault && (
            <div role="alert" className="p-4 rounded-2xl border border-red-500/20 bg-red-500/5">
              <p className="flex items-start gap-2 text-[13px] font-semibold text-red-400 leading-relaxed">
                <AlertTriangle size={15} className="shrink-0 mt-0.5" />
                {faultMessage}
              </p>
              {fault.code && (
                <p className="text-[11px] text-zinc-600 font-bold mt-2 ml-[23px] tracking-wide">
                  {intl.formatMessage(m.faultCode, { code: fault.code })}
                </p>
              )}
            </div>
          )}

          <button
            type="submit"
            disabled={!ready || busy}
            className="w-full flex items-center justify-center gap-2 px-6 py-3.5 rounded-full text-[14px] font-bold text-white bg-brand hover:bg-brand-hover disabled:opacity-40 disabled:cursor-not-allowed transition-colors shadow-glow-cta"
          >
            {busy ? <Loader2 size={16} className="animate-spin" /> : <LogIn size={16} strokeWidth={2.5} />}
            {intl.formatMessage(busy ? m.actionBusy : m.action)}
          </button>
        </form>

        <p className="text-[12px] text-zinc-600 leading-relaxed">{intl.formatMessage(m.audit)}</p>
      </div>
    </div>
  );
}
