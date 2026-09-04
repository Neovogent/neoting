import { useEffect, useRef, useState, type FormEvent } from 'react';
import { defineMessages, useIntl } from 'react-intl';
import { AlertTriangle, ArrowRight, Loader2, UserPlus } from 'lucide-react';
import { motion } from 'motion/react';
import {
  INVITE_PASSWORD_MIN_LENGTH,
  acceptInvite,
  type InvitationFault,
  type InvitationPreview,
  invitationFaultOf,
  readInvitation,
} from '../../api/invitation';
import { Wordmark } from '../../assets/Wordmark';
import { linkProps, useQueryParam } from '../../lib/router';
import { EnrolStep } from '../signup/SignupView';

/**
 * `/invite?token=…` — the invited colleague's way in (the other half of
 * `POST /v1/practice-members`).
 *
 * Before this route, an admin could not add a second person to their own firm:
 * the Team screen's "Invite colleague" button opened a local record editor whose
 * save evaporated on reload, and there was no operation behind it. This is the
 * screen the email now points at.
 *
 * The journey, and what each step may say:
 *
 *   preview   → POST /auth/invitation-preview     names the practice and the role
 *   password  → POST /auth/invitation-acceptance  creates the user, issues NO session
 *   enrol     → the SAME `EnrolStep` the founder walks
 *   done      → /signup/done, the same "you are all set" screen
 *
 * ⚠ **THIS IS A PUBLIC SURFACE AND FIRES NO SESSION PROBE.** `portal ===
 * 'invite'` in `AppContext` keeps `workspaceApiOn` false, exactly as 'signup'
 * and 'setup' do. The person opening this link has no account yet, so a `/me`
 * probe could only 401 and a login wall over the address would be a dead end for
 * exactly the person the email invited.
 *
 * ⚠ **NO SECRET REACHES THE ADDRESS BAR, A LOG OR AN ERROR.** The token arrives
 * in the URL because that is what an emailed link is, and it is scrubbed with
 * `replaceState` **before** the first request goes out — so it is never in the
 * history and never in the next outbound `Referer`. It then lives in this
 * component's state for the length of one setup and nowhere else: not
 * `localStorage`, not the query cache, not a URL. M9's rule, inherited verbatim.
 *
 * ⚠ **UNLIKE `/signup/check-email`, THIS SCREEN MAY NAME THINGS.** That one
 * answers an anonymous caller who typed an address, so saying anything would
 * answer *"is this address registered here"*. This one answers somebody holding
 * a token we emailed to the address it names, and every fact it prints — the
 * firm, the role, who invited them — is already in the message they are reading
 * it from. A screen that asked a stranger to choose a password for an unnamed
 * employer would be the phishing shape, not the safe one.
 */
const m = defineMessages({
  shellSubtitle: { id: 'invite.inviteView.shellSubtitle', defaultMessage: 'Join your practice' },
  wordmarkTitle: {
    id: 'invite.inviteView.wordmarkTitle',
    defaultMessage: 'Neo Accounting',
    description: 'Accessible name for the product wordmark. A product name — leave untranslated.',
  },

  /* ① checking the link */
  busyTitle: { id: 'invite.inviteView.busyTitle', defaultMessage: 'Checking your invitation' },

  missingTitle: { id: 'invite.inviteView.missingTitle', defaultMessage: 'That link is incomplete' },
  missingDetail: {
    id: 'invite.inviteView.missingDetail',
    defaultMessage:
      'The address has no invitation in it. Open the link from your email again — some mail apps shorten a long link when you copy it.',
  },

  invalidTitle: { id: 'invite.inviteView.invalidTitle', defaultMessage: 'That invitation is not valid' },
  invalidDetail: {
    id: 'invite.inviteView.invalidDetail',
    defaultMessage:
      'It may have been copied incompletely, it may already have been used, or the address may already have an account. Ask whoever invited you to send a new one.',
  },
  expiredTitle: { id: 'invite.inviteView.expiredTitle', defaultMessage: 'That invitation has expired' },
  expiredDetail: {
    id: 'invite.inviteView.expiredDetail',
    defaultMessage: 'Invitations last seven days. Ask whoever invited you to send another one.',
  },
  rateLimitedTitle: { id: 'invite.inviteView.rateLimitedTitle', defaultMessage: 'Too many attempts' },
  rateLimitedDetail: {
    id: 'invite.inviteView.rateLimitedDetail',
    defaultMessage: 'Wait a minute and open the link from your email again.',
  },
  unreachableTitle: { id: 'invite.inviteView.unreachableTitle', defaultMessage: 'We could not reach the server' },
  unreachableDetail: {
    id: 'invite.inviteView.unreachableDetail',
    defaultMessage: 'Check your connection and open the link from your email again.',
  },
  signIn: { id: 'invite.inviteView.signIn', defaultMessage: 'Go to sign in' },

  /* ② the account */
  formTitle: { id: 'invite.inviteView.formTitle', defaultMessage: 'Set up your account' },
  invitedBy: {
    id: 'invite.inviteView.invitedBy',
    defaultMessage: '{inviter} has invited you to join {practice}.',
  },
  invitedByPractice: {
    id: 'invite.inviteView.invitedByPractice',
    defaultMessage: 'You have been invited to join {practice}.',
  },
  addressLabel: { id: 'invite.inviteView.addressLabel', defaultMessage: 'Your sign-in address' },
  addressHint: {
    id: 'invite.inviteView.addressHint',
    defaultMessage: 'This is the address the invitation was sent to, and it is what you will sign in with.',
  },
  roleLabel: { id: 'invite.inviteView.roleLabel', defaultMessage: 'Your role' },
  roleStandard: { id: 'invite.inviteView.roleStandard', defaultMessage: 'Standard user' },
  roleStandardHint: {
    id: 'invite.inviteView.roleStandardHint',
    defaultMessage: 'You can review, code and correct work. Releasing documents for export stays with your practice owner.',
  },
  roleClientAdmin: { id: 'invite.inviteView.roleClientAdmin', defaultMessage: 'Client admin' },
  roleClientAdminHint: {
    id: 'invite.inviteView.roleClientAdminHint',
    defaultMessage: 'You can reach every client and manage their records. Releasing documents for export stays with your practice owner.',
  },
  expiresOn: { id: 'invite.inviteView.expiresOn', defaultMessage: 'This invitation works until {date}.' },

  firstName: { id: 'invite.inviteView.firstName', defaultMessage: 'First name' },
  lastName: { id: 'invite.inviteView.lastName', defaultMessage: 'Last name' },
  password: { id: 'invite.inviteView.password', defaultMessage: 'Choose a password' },
  passwordHint: {
    id: 'invite.inviteView.passwordHint',
    defaultMessage:
      'At least {min} characters. Length is the whole rule — a long phrase you can remember beats a short one with a symbol in it.',
  },
  passwordShort: {
    id: 'invite.inviteView.passwordShort',
    defaultMessage: '{count, plural, one {# more character} other {# more characters}}',
  },
  nextStep: {
    id: 'invite.inviteView.nextStep',
    defaultMessage: 'Next you will set up an authenticator app, so have your phone to hand.',
  },
  action: { id: 'invite.inviteView.action', defaultMessage: 'Create my account' },
  actionBusy: { id: 'invite.inviteView.actionBusy', defaultMessage: 'Creating…' },

  /* faults on the form */
  faultValidation: {
    id: 'invite.inviteView.faultValidation',
    defaultMessage: 'Some of those details were not accepted. Check the fields above and try again.',
  },
  faultInvalid: {
    id: 'invite.inviteView.faultInvalid',
    defaultMessage:
      'That invitation is no longer valid — it may already have been used, or the address may already have an account. Ask whoever invited you to send a new one.',
  },
  faultExpired: {
    id: 'invite.inviteView.faultExpired',
    defaultMessage: 'That invitation has expired. Ask whoever invited you to send another one.',
  },
  faultRateLimited: {
    id: 'invite.inviteView.faultRateLimited',
    defaultMessage: 'Too many attempts. Wait a minute and try again.',
  },
  faultServer: {
    id: 'invite.inviteView.faultServer',
    defaultMessage: 'The server refused that. Try again, and tell your practice if it keeps happening.',
  },
  faultUnreachable: {
    id: 'invite.inviteView.faultUnreachable',
    defaultMessage: 'We could not reach the server. Check your connection and try again.',
  },
  faultCode: { id: 'invite.inviteView.faultCode', defaultMessage: 'Reference: {code}' },
});

type Stage =
  | { kind: 'busy' }
  | { kind: 'missing' }
  | { kind: 'failed'; fault: InvitationFault }
  | { kind: 'form'; token: string; preview: InvitationPreview }
  | { kind: 'enrol'; email: string };

export function InviteView() {
  const [token, setToken] = useQueryParam('token');
  const [stage, setStage] = useState<Stage>({ kind: 'busy' });
  // The token is previewed exactly once. Without this, clearing it from the
  // address re-renders and a StrictMode double-mount asks twice — which the API
  // tolerates (the preview writes nothing) but which would still be this
  // component asking a question it already has the answer to.
  const asked = useRef(false);

  useEffect(() => {
    if (asked.current) return;
    if (!token) {
      setStage({ kind: 'missing' });
      return;
    }
    asked.current = true;
    const value = token;
    // ⚠ Scrub it from the address BEFORE the request, not after. It is a
    // credential; every moment it sits in `location.search` it is in the
    // history, in a `Referer` on the next outbound link, and in whatever the
    // browser syncs between devices. `replace` so Back does not restore it.
    setToken(null, { replace: true });
    void readInvitation(value)
      .then((preview) => setStage({ kind: 'form', token: value, preview }))
      .catch((error: unknown) => setStage({ kind: 'failed', fault: invitationFaultOf(error) }));
  }, [token, setToken]);

  if (stage.kind === 'enrol') return <EnrolStep initialEmail={stage.email} />;
  if (stage.kind === 'busy') return <Busy />;
  if (stage.kind === 'missing') return <Dead titleOf="missing" />;
  if (stage.kind === 'failed') return <Dead titleOf="failed" fault={stage.fault} />;

  return (
    <AcceptForm
      token={stage.token}
      preview={stage.preview}
      onAccepted={(email) => setStage({ kind: 'enrol', email })}
      onDead={(fault) => setStage({ kind: 'failed', fault })}
    />
  );
}

function Busy() {
  const intl = useIntl();
  return (
    <Shell title={intl.formatMessage(m.busyTitle)}>
      <Loader2 size={22} className="animate-spin text-brand" />
    </Shell>
  );
}

/**
 * The end of the road: no token, or one the server would not resolve.
 *
 * ⚠ **The "check your connection" sentence appears ONLY for `code === null`.**
 * A code means a reply came back over the very connection that sentence would
 * blame, so the two can never be on screen together — the rule
 * `faultMessageFor` enforces on both client portals, after an `NT-VAL-001` sent
 * an invited client to their wifi settings for a route that did not exist.
 */
function Dead({ titleOf, fault }: { titleOf: 'missing' | 'failed'; fault?: InvitationFault }) {
  const intl = useIntl();
  const code = fault?.code ?? null;

  const [title, detail] =
    titleOf === 'missing'
      ? [m.missingTitle, m.missingDetail]
      : code === 'NT-AUTH-005'
        ? [m.expiredTitle, m.expiredDetail]
        : code === 'NT-RATE-001'
          ? [m.rateLimitedTitle, m.rateLimitedDetail]
          : code === null
            ? [m.unreachableTitle, m.unreachableDetail]
            : [m.invalidTitle, m.invalidDetail];

  return (
    <Shell title={intl.formatMessage(title)}>
      <motion.div
        initial={{ opacity: 0, y: 6 }}
        animate={{ opacity: 1, y: 0 }}
        className="w-14 h-14 rounded-2xl flex items-center justify-center border bg-amber-500/10 border-amber-500/30 text-amber-400"
      >
        <AlertTriangle size={24} />
      </motion.div>
      <p className="text-[14px] text-zinc-400 leading-relaxed">{intl.formatMessage(detail)}</p>
      {code && (
        <p className="text-[11px] text-zinc-600 font-bold tracking-wide">
          {intl.formatMessage(m.faultCode, { code })}
        </p>
      )}
      {/* Somebody who already has an account lands here too, and sign in is the
          one action that helps them. */}
      <a {...linkProps('/app')} className="text-[13px] font-bold text-brand hover:underline">
        {intl.formatMessage(m.signIn)}
      </a>
    </Shell>
  );
}

function AcceptForm({
  token,
  preview,
  onAccepted,
  onDead,
}: {
  token: string;
  preview: InvitationPreview;
  onAccepted: (email: string) => void;
  onDead: (fault: InvitationFault) => void;
}) {
  const intl = useIntl();
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [fault, setFault] = useState<InvitationFault | null>(null);

  const shortBy = Math.max(0, INVITE_PASSWORD_MIN_LENGTH - password.length);
  const ready = firstName.trim() !== '' && lastName.trim() !== '' && shortBy === 0;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!ready || busy) return;
    setBusy(true);
    setFault(null);
    try {
      const created = await acceptInvite({ token, password, firstName, lastName });
      onAccepted(created.email);
    } catch (error) {
      const next = invitationFaultOf(error);
      // An invitation that stopped being spendable while this form was open has
      // nothing left to offer, so the form is replaced rather than decorated
      // with an error the user cannot act on. A validation failure IS
      // actionable, so it stays here.
      if (next.code === 'NT-AUTH-004' || next.code === 'NT-AUTH-005') onDead(next);
      else setFault(next);
      setBusy(false);
    }
  };

  const isClientAdmin = preview.role === 'CLIENT_ADMIN';

  return (
    <Shell title={intl.formatMessage(m.formTitle)} icon={UserPlus}>
      <p className="text-[14px] text-zinc-400 leading-relaxed">
        {preview.invitedByName
          ? intl.formatMessage(m.invitedBy, { inviter: preview.invitedByName, practice: preview.practiceName })
          : intl.formatMessage(m.invitedByPractice, { practice: preview.practiceName })}
      </p>

      <div className="rounded-3xl border border-white/5 bg-card p-5 flex flex-col gap-4">
        <Fact label={intl.formatMessage(m.addressLabel)} value={preview.email} hint={intl.formatMessage(m.addressHint)} />
        <Fact
          label={intl.formatMessage(m.roleLabel)}
          value={intl.formatMessage(isClientAdmin ? m.roleClientAdmin : m.roleStandard)}
          hint={intl.formatMessage(isClientAdmin ? m.roleClientAdminHint : m.roleStandardHint)}
        />
        <p className="text-[12px] text-zinc-600 leading-relaxed">
          {intl.formatMessage(m.expiresOn, {
            // Europe/London, because a UTC instant late in the evening names the
            // wrong UK day (Governance §12).
            date: intl.formatDate(preview.expiresAt, { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Europe/London' }),
          })}
        </p>
      </div>

      <form onSubmit={submit} className="flex flex-col gap-4">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <Field id="invite-first" label={intl.formatMessage(m.firstName)}>
            <input
              id="invite-first"
              value={firstName}
              onChange={(e) => setFirstName(e.target.value)}
              autoComplete="given-name"
              maxLength={100}
              disabled={busy}
              className={INPUT}
            />
          </Field>
          <Field id="invite-last" label={intl.formatMessage(m.lastName)}>
            <input
              id="invite-last"
              value={lastName}
              onChange={(e) => setLastName(e.target.value)}
              autoComplete="family-name"
              maxLength={100}
              disabled={busy}
              className={INPUT}
            />
          </Field>
        </div>

        <Field
          id="invite-password"
          label={intl.formatMessage(m.password)}
          hint={intl.formatMessage(m.passwordHint, { min: INVITE_PASSWORD_MIN_LENGTH })}
        >
          <input
            id="invite-password"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="new-password"
            minLength={INVITE_PASSWORD_MIN_LENGTH}
            maxLength={256}
            disabled={busy}
            className={INPUT}
          />
          {password.length > 0 && shortBy > 0 && (
            <p className="text-[12px] font-semibold text-amber-400 mt-2" role="status">
              {intl.formatMessage(m.passwordShort, { count: shortBy })}
            </p>
          )}
        </Field>

        <p className="text-[13px] text-zinc-500 leading-relaxed">{intl.formatMessage(m.nextStep)}</p>

        {fault && (
          <div role="alert" className="p-4 rounded-2xl border border-red-500/20 bg-red-500/5">
            <p className="flex items-start gap-2 text-[13px] font-semibold text-red-400 leading-relaxed">
              <AlertTriangle size={15} className="shrink-0 mt-0.5" />
              {intl.formatMessage(faultMessage(fault))}
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
          className="w-full flex items-center justify-center gap-2 px-6 py-3.5 rounded-full text-[14px] font-bold text-brand-on bg-brand hover:bg-brand-hover disabled:opacity-40 disabled:cursor-not-allowed transition-colors shadow-glow-cta"
        >
          {busy ? <Loader2 size={16} className="animate-spin" /> : <ArrowRight size={16} strokeWidth={2.5} />}
          {intl.formatMessage(busy ? m.actionBusy : m.action)}
        </button>
      </form>
    </Shell>
  );
}

/** Plain English first, the `NT-` reference after it (the frontend ten, item 5). */
function faultMessage(fault: InvitationFault) {
  if (fault.code === 'NT-VAL-001') return m.faultValidation;
  if (fault.code === 'NT-AUTH-004') return m.faultInvalid;
  if (fault.code === 'NT-AUTH-005') return m.faultExpired;
  if (fault.code === 'NT-RATE-001') return m.faultRateLimited;
  // ⚠ Only a null code may blame the connection — a code means the server
  // answered over it.
  return fault.code === null ? m.faultUnreachable : m.faultServer;
}

/* ── chrome ───────────────────────────────────────────────────────────────── */

const INPUT =
  'w-full bg-card border border-white/5 rounded-2xl px-4 py-3.5 text-[14px] text-white placeholder:text-zinc-600 focus:outline-none focus:border-brand transition-colors disabled:opacity-50';

/**
 * The signup shell's proportions, deliberately: this is opened by one person on
 * one device, often a phone, and it is the first surface of the product they
 * see. It is a local copy rather than an import because `SignupView`'s shell is
 * private to that file and its subtitle is signup's own words; only the
 * enrolment STEP is shared, which is the part where sharing prevents a bug.
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

function Fact({ label, value, hint }: { label: string; value: string; hint: string }) {
  return (
    <div>
      <div className="text-[11px] font-bold text-zinc-500 uppercase tracking-widest mb-1">{label}</div>
      <div className="text-[14px] font-bold text-white break-words">{value}</div>
      <p className="text-[12px] text-zinc-500 leading-relaxed mt-1">{hint}</p>
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
