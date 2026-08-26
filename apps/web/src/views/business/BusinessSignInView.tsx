import { useState } from 'react';
import { ArrowLeft, ArrowRight, LogIn, UserPlus, BadgeCheck, Mail, Smartphone } from 'lucide-react';
import logo from '../../assets/logo.png';
import { motion } from 'motion/react';
import { defineMessages, useIntl } from 'react-intl';
import { useAppContext } from '../../context/AppContext';
import { commonLabels, commonPlaceholders } from '../../i18n/common';
import { Pill } from '../../components/DynamicComponents/DataTable';
import { newBusinessAccount, newMember } from '../../lib/business';

// Not messages: the chosen value is written to `Client.industry` and read back
// as data on the practice side, so translating it here would make a stored
// record locale-dependent. See #65 notes.
const INDUSTRIES = ['Hospitality & Food', 'Software & IT', 'Architecture', 'Retail', 'Construction', 'Professional Services'];

const m = defineMessages({
  logoAlt: { id: 'portal.businessSignInView.logoAlt', defaultMessage: 'Migrate Properly' },
  title: { id: 'portal.businessSignInView.title', defaultMessage: 'Business portal' },
  subtitle: {
    id: 'portal.businessSignInView.subtitle',
    defaultMessage: 'Send paperwork to your accountant',
  },
  exitAction: { id: 'portal.businessSignInView.exitAction', defaultMessage: 'Accountant portal' },
  modeSignIn: { id: 'portal.businessSignInView.modeSignIn', defaultMessage: 'Sign in' },
  modeSignUp: { id: 'portal.businessSignInView.modeSignUp', defaultMessage: 'Create an account' },
  chooseHeading: { id: 'portal.businessSignInView.chooseHeading', defaultMessage: 'Choose your business' },
  chooseHint: {
    id: 'portal.businessSignInView.chooseHint',
    defaultMessage: 'Accounts your accountant created show an invite until the first sign-in.',
  },
  noAccounts: {
    id: 'portal.businessSignInView.noAccounts',
    defaultMessage: 'No portal accounts yet. Create one, or ask your accountant to invite you.',
  },
  inviteWaiting: { id: 'portal.businessSignInView.inviteWaiting', defaultMessage: 'Invite waiting' },
  activeStatus: { id: 'portal.businessSignInView.activeStatus', defaultMessage: 'Active' },
  aboutHeading: {
    id: 'portal.businessSignInView.aboutHeading',
    defaultMessage: 'Tell us about your business',
  },
  aboutHint: {
    id: 'portal.businessSignInView.aboutHint',
    defaultMessage: 'You can set this up yourself — your accountant does not need to do it for you.',
  },
  businessNameLabel: { id: 'portal.businessSignInView.businessNameLabel', defaultMessage: 'Business name' },
  businessNamePlaceholder: {
    id: 'portal.businessSignInView.businessNamePlaceholder',
    defaultMessage: 'American Burger Ltd',
  },
  contactNameLabel: { id: 'portal.businessSignInView.contactNameLabel', defaultMessage: 'Your name' },
  contactNamePlaceholder: { id: 'portal.businessSignInView.contactNamePlaceholder', defaultMessage: 'John Doe' },
  industryLabel: { id: 'portal.businessSignInView.industryLabel', defaultMessage: 'Industry' },
  continueAction: { id: 'portal.businessSignInView.continueAction', defaultMessage: 'Continue' },
  reachHeading: { id: 'portal.businessSignInView.reachHeading', defaultMessage: 'How we reach you' },
  reachHint: {
    id: 'portal.businessSignInView.reachHint',
    defaultMessage: 'The mobile number matters — missing paperwork is chased by text.',
  },
  mobileLabel: { id: 'portal.businessSignInView.mobileLabel', defaultMessage: 'Mobile number' },
  emailPlaceholder: {
    id: 'portal.businessSignInView.emailPlaceholder',
    defaultMessage: 'john@americanburger.co.uk',
  },
  practiceCodeLabel: {
    id: 'portal.businessSignInView.practiceCodeLabel',
    defaultMessage: "Accountant's practice code (optional)",
  },
  practiceCodePlaceholder: {
    id: 'portal.businessSignInView.practiceCodePlaceholder',
    defaultMessage: 'PRC-4417',
  },
  practiceCodeHint: {
    id: 'portal.businessSignInView.practiceCodeHint',
    defaultMessage: 'Links you to your accountant straight away. Without it they will claim your account manually.',
  },
  backAction: { id: 'portal.businessSignInView.backAction', defaultMessage: 'Back' },
  createAction: { id: 'portal.businessSignInView.createAction', defaultMessage: 'Create account' },

  // Audit entries. Unlike `INDUSTRIES` above, these are not written to a record
  // and read back — `AuditTable` renders `action` and `scope` straight to a
  // human, and the log is session-scoped React state that never reaches
  // storage. So they are copy, and the converted views extract them.
  //
  // Two whole messages rather than one with a `{code, select, ...}` clause, per
  // the reference conversion: a translator handed a conditional has to reason
  // about both branches at once, and the word order around an inserted clause
  // is exactly what differs between languages.
  auditAction: { id: 'portal.businessSignInView.auditAction', defaultMessage: 'Business signed itself up' },
  auditScopeWithCode: {
    id: 'portal.businessSignInView.auditScopeWithCode',
    defaultMessage: '{name} — practice code {code}',
  },
  auditScopeNoCode: {
    id: 'portal.businessSignInView.auditScopeNoCode',
    defaultMessage: '{name} — no practice code',
  },
});

/**
 * The way into the portal. A business either signs in to an account its
 * accountant created for it, or signs itself up — the second path also creates
 * the client record on the practice side, so the accountant sees them arrive.
 */
export function BusinessSignInView() {
  const {
    businessAccounts, openBusinessPortal, exitBusinessPortal, activateBusinessAccount,
    createBusinessAccount, addClient, logAudit,
  } = useAppContext();
  const intl = useIntl();

  const [mode, setMode] = useState<'sign-in' | 'sign-up'>('sign-in');
  const [step, setStep] = useState(0);
  const [form, setForm] = useState({
    businessName: '',
    contactName: '',
    email: '',
    mobile: '',
    // The list above is a literal and never empty, so the fallback is only
    // there to keep the field a plain string rather than a maybe.
    industry: INDUSTRIES[0] ?? '',
    practiceCode: '',
  });

  const set = <K extends keyof typeof form>(k: K, v: (typeof form)[K]) => setForm((f) => ({ ...f, [k]: v }));

  const signIn = (id: string, wasInvited: boolean) => {
    if (wasInvited) activateBusinessAccount(id);
    openBusinessPortal(id);
  };

  const create = () => {
    const name = form.businessName.trim() || 'New business';
    const practiceCode = form.practiceCode.trim();
    const clientId = `client-${Date.now()}`;

    // The practice gets a real client record, so a self-signup is not a
    // second, disconnected database.
    addClient({
      id: clientId,
      name,
      industry: form.industry,
      health: 100,
      missingDocs: 0,
      toReview: 0,
      deadline: '—',
      bankConnected: false,
      contactName: form.contactName.trim(),
      mobile: form.mobile.trim(),
    });

    const account = newBusinessAccount({
      clientId,
      businessName: name,
      contactName: form.contactName.trim() || 'Owner',
      email: form.email.trim(),
      mobile: form.mobile.trim(),
      origin: 'self-signup',
      createdBy: 'Signed up directly',
      practiceCode: practiceCode || undefined,
      members: [
        { ...newMember(form.contactName.trim() || 'Owner', form.email.trim()), role: 'Owner', canSeeTotals: true },
      ],
    });

    createBusinessAccount(account);
    logAudit({
      action: intl.formatMessage(m.auditAction),
      // `name` stays an interpolated value: `ClientDetailView` builds its
      // activity feed by matching the client name inside `scope`.
      scope: practiceCode
        ? intl.formatMessage(m.auditScopeWithCode, { name, code: practiceCode })
        : intl.formatMessage(m.auditScopeNoCode, { name }),
      reviewOpened: false,
    });
    openBusinessPortal(account.id);
  };

  const canContinue = form.businessName.trim().length > 0 && form.contactName.trim().length > 0;
  const canCreate = canContinue && form.mobile.trim().length > 0;

  return (
    <div className="flex-1 min-w-0 h-full overflow-y-auto bg-ground [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
      <div className="min-h-full flex flex-col items-center justify-center p-4 md:p-8">
        <div className="w-full max-w-lg flex flex-col gap-6">
          <div className="flex items-center justify-between gap-4">
            <div className="flex items-center gap-3">
              <img
                src={logo}
                alt={intl.formatMessage(m.logoAlt)}
                className="w-11 h-11 rounded-2xl object-cover shadow-glow-logo"
              />
              <div>
                <div className="font-sans font-bold text-[15px] text-white tracking-tight">
                  {intl.formatMessage(m.title)}
                </div>
                <div className="hidden sm:block text-[11px] text-zinc-500 font-semibold uppercase tracking-wider">
                  {intl.formatMessage(m.subtitle)}
                </div>
              </div>
            </div>
            <button
              onClick={exitBusinessPortal}
              className="flex items-center gap-2 px-4 py-2 rounded-full text-[13px] font-bold text-zinc-400 border border-white/5 hover:text-white hover:border-white/15 transition-colors"
            >
              <ArrowLeft size={14} strokeWidth={2.5} />
              {intl.formatMessage(m.exitAction)}
            </button>
          </div>

          <div className="flex items-center gap-2">
            <ModeTab active={mode === 'sign-in'} onClick={() => setMode('sign-in')} icon={LogIn} label={intl.formatMessage(m.modeSignIn)} />
            <ModeTab active={mode === 'sign-up'} onClick={() => { setMode('sign-up'); setStep(0); }} icon={UserPlus} label={intl.formatMessage(m.modeSignUp)} />
          </div>

          <motion.div key={mode} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }}>
            {mode === 'sign-in' ? (
              <div className="rounded-[28px] border border-white/5 bg-card p-6">
                <h2 className="text-[15px] font-bold text-white tracking-tight">
                  {intl.formatMessage(m.chooseHeading)}
                </h2>
                <p className="text-[12px] text-zinc-500 mt-1 mb-4">
                  {intl.formatMessage(m.chooseHint)}
                </p>

                {businessAccounts.length === 0 ? (
                  <p className="text-[13px] text-zinc-500 py-8 text-center">
                    {intl.formatMessage(m.noAccounts)}
                  </p>
                ) : (
                  <div className="flex flex-col gap-2">
                    {businessAccounts.map((a) => (
                      <button
                        key={a.id}
                        onClick={() => signIn(a.id, a.status === 'invited')}
                        className="w-full flex items-center justify-between gap-4 p-4 rounded-2xl bg-ground/60 border border-white/5 hover:border-brand/40 transition-colors text-left group"
                      >
                        <span className="min-w-0">
                          <span className="block text-sm font-bold text-white truncate">{a.businessName}</span>
                          <span className="block text-[12px] text-zinc-500 mt-0.5 truncate">
                            {a.contactName} · {a.email || a.mobile}
                          </span>
                        </span>
                        <span className="flex items-center gap-2 shrink-0">
                          {a.status === 'invited' ? (
                            <Pill tone="amber">{intl.formatMessage(m.inviteWaiting)}</Pill>
                          ) : (
                            <Pill tone="green">{intl.formatMessage(m.activeStatus)}</Pill>
                          )}
                          <ArrowRight size={16} className="text-zinc-600 group-hover:text-white transition-colors" />
                        </span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            ) : (
              <div className="rounded-[28px] border border-white/5 bg-card p-6 flex flex-col gap-4">
                {step === 0 ? (
                  <>
                    <div>
                      <h2 className="text-[15px] font-bold text-white tracking-tight">
                        {intl.formatMessage(m.aboutHeading)}
                      </h2>
                      <p className="text-[12px] text-zinc-500 mt-1">
                        {intl.formatMessage(m.aboutHint)}
                      </p>
                    </div>
                    <Field
                      label={intl.formatMessage(m.businessNameLabel)}
                      value={form.businessName}
                      onChange={(v) => set('businessName', v)}
                      placeholder={intl.formatMessage(m.businessNamePlaceholder)}
                    />
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                      <Field
                        label={intl.formatMessage(m.contactNameLabel)}
                        value={form.contactName}
                        onChange={(v) => set('contactName', v)}
                        placeholder={intl.formatMessage(m.contactNamePlaceholder)}
                      />
                      <Select
                        label={intl.formatMessage(m.industryLabel)}
                        value={form.industry}
                        onChange={(v) => set('industry', v)}
                        options={INDUSTRIES}
                      />
                    </div>
                    <button
                      onClick={() => setStep(1)}
                      disabled={!canContinue}
                      className="self-end flex items-center gap-2 px-6 py-2.5 rounded-full text-sm font-bold text-white bg-brand hover:bg-brand-hover disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                    >
                      {intl.formatMessage(m.continueAction)}
                      <ArrowRight size={16} strokeWidth={2.5} />
                    </button>
                  </>
                ) : (
                  <>
                    <div>
                      <h2 className="text-[15px] font-bold text-white tracking-tight">
                        {intl.formatMessage(m.reachHeading)}
                      </h2>
                      <p className="text-[12px] text-zinc-500 mt-1">
                        {intl.formatMessage(m.reachHint)}
                      </p>
                    </div>
                    <Field
                      label={intl.formatMessage(m.mobileLabel)}
                      value={form.mobile}
                      onChange={(v) => set('mobile', v)}
                      placeholder={intl.formatMessage(commonPlaceholders.ukMobile)}
                      icon={Smartphone}
                    />
                    <Field
                      label={intl.formatMessage(commonLabels.email)}
                      value={form.email}
                      onChange={(v) => set('email', v)}
                      placeholder={intl.formatMessage(m.emailPlaceholder)}
                      icon={Mail}
                    />
                    <Field
                      label={intl.formatMessage(m.practiceCodeLabel)}
                      value={form.practiceCode}
                      onChange={(v) => set('practiceCode', v)}
                      placeholder={intl.formatMessage(m.practiceCodePlaceholder)}
                      hint={intl.formatMessage(m.practiceCodeHint)}
                    />

                    <div className="flex items-center justify-between gap-3 pt-1">
                      <button
                        onClick={() => setStep(0)}
                        className="px-5 py-2.5 text-sm font-bold text-zinc-400 hover:text-white rounded-full transition-colors"
                      >
                        {intl.formatMessage(m.backAction)}
                      </button>
                      <button
                        onClick={create}
                        disabled={!canCreate}
                        className="flex items-center gap-2 px-6 py-2.5 rounded-full text-sm font-bold text-white bg-brand hover:bg-brand-hover disabled:opacity-40 disabled:cursor-not-allowed transition-colors shadow-glow-btn-strong"
                      >
                        <BadgeCheck size={16} strokeWidth={2.5} />
                        {intl.formatMessage(m.createAction)}
                      </button>
                    </div>
                  </>
                )}
              </div>
            )}
          </motion.div>
        </div>
      </div>
    </div>
  );
}

function ModeTab({
  active, onClick, icon: Icon, label,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ComponentType<{ size?: number }>;
  label: string;
}) {
  return (
    <button
      onClick={onClick}
      className={`flex-1 flex items-center justify-center gap-2 px-5 py-3 rounded-2xl border text-[13px] font-bold transition-colors ${
        active ? 'bg-brand/10 border-brand/40 text-brand' : 'bg-card border-white/5 text-zinc-400 hover:text-white'
      }`}
    >
      <Icon size={15} />
      {label}
    </button>
  );
}

function Field({
  label, value, onChange, placeholder, hint, icon: Icon,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  hint?: string;
  icon?: React.ComponentType<{ size?: number; className?: string }>;
}) {
  return (
    <div>
      <div className="text-[11px] font-bold text-zinc-500 uppercase tracking-widest mb-2">{label}</div>
      <div className="relative">
        {Icon && <Icon size={15} className="absolute left-4 top-1/2 -translate-y-1/2 text-zinc-600" />}
        <input
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          className={`w-full bg-ground border border-white/5 rounded-xl py-2.5 text-sm text-white placeholder:text-zinc-600 focus:outline-none focus:border-brand transition-colors ${
            Icon ? 'pl-11 pr-4' : 'px-4'
          }`}
        />
      </div>
      {hint && <div className="text-[11px] text-zinc-600 mt-1.5 font-medium leading-relaxed">{hint}</div>}
    </div>
  );
}

function Select({
  label, value, onChange, options,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: string[];
}) {
  return (
    <div>
      <div className="text-[11px] font-bold text-zinc-500 uppercase tracking-widest mb-2">{label}</div>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full bg-ground border border-white/5 rounded-xl px-4 py-2.5 text-sm text-white focus:outline-none focus:border-brand transition-colors appearance-none"
      >
        {options.map((o) => (
          <option key={o} value={o} className="bg-card">
            {o}
          </option>
        ))}
      </select>
    </div>
  );
}
