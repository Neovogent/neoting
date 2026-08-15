import { useState } from 'react';
import { ArrowLeft, ArrowRight, LogIn, UserPlus, BadgeCheck, Mail, Smartphone } from 'lucide-react';
import logo from '../../assets/logo.png';
import { motion } from 'motion/react';
import { useAppContext } from '../../context/AppContext';
import { Pill } from '../../components/DynamicComponents/DataTable';
import { newBusinessAccount, newMember } from '../../lib/business';

const INDUSTRIES = ['Hospitality & Food', 'Software & IT', 'Architecture', 'Retail', 'Construction', 'Professional Services'];

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
      xeroConnected: false,
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
      practiceCode: form.practiceCode.trim() || undefined,
      members: [
        { ...newMember(form.contactName.trim() || 'Owner', form.email.trim()), role: 'Owner', canSeeTotals: true },
      ],
    });

    createBusinessAccount(account);
    logAudit({
      action: 'Business signed itself up',
      scope: `${name}${form.practiceCode.trim() ? ` — practice code ${form.practiceCode.trim()}` : ' — no practice code'}`,
      reviewOpened: false,
    });
    openBusinessPortal(account.id);
  };

  const canContinue = form.businessName.trim().length > 0 && form.contactName.trim().length > 0;
  const canCreate = canContinue && form.mobile.trim().length > 0;

  return (
    <div className="flex-1 min-w-0 h-full overflow-y-auto bg-[#0a0a0c] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
      <div className="min-h-full flex flex-col items-center justify-center p-8">
        <div className="w-full max-w-lg flex flex-col gap-6">
          <div className="flex items-center justify-between gap-4">
            <div className="flex items-center gap-3">
              <img
                src={logo}
                alt="Migrate Properly"
                className="w-11 h-11 rounded-2xl object-cover shadow-[0_0_18px_rgba(20,227,196,0.25)]"
              />
              <div>
                <div className="font-sans font-bold text-[15px] text-white tracking-tight">Business portal</div>
                <div className="text-[11px] text-zinc-500 font-semibold uppercase tracking-wider">Send paperwork to your accountant</div>
              </div>
            </div>
            <button
              onClick={exitBusinessPortal}
              className="flex items-center gap-2 px-4 py-2 rounded-full text-[13px] font-bold text-zinc-400 border border-white/5 hover:text-white hover:border-white/15 transition-colors"
            >
              <ArrowLeft size={14} strokeWidth={2.5} />
              Accountant portal
            </button>
          </div>

          <div className="flex items-center gap-2">
            <ModeTab active={mode === 'sign-in'} onClick={() => setMode('sign-in')} icon={LogIn} label="Sign in" />
            <ModeTab active={mode === 'sign-up'} onClick={() => { setMode('sign-up'); setStep(0); }} icon={UserPlus} label="Create an account" />
          </div>

          <motion.div key={mode} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }}>
            {mode === 'sign-in' ? (
              <div className="rounded-[28px] border border-white/5 bg-[#16161a] p-6">
                <h2 className="text-[15px] font-bold text-white tracking-tight">Choose your business</h2>
                <p className="text-[12px] text-zinc-500 mt-1 mb-4">
                  Accounts your accountant created show an invite until the first sign-in.
                </p>

                {businessAccounts.length === 0 ? (
                  <p className="text-[13px] text-zinc-500 py-8 text-center">
                    No portal accounts yet. Create one, or ask your accountant to invite you.
                  </p>
                ) : (
                  <div className="flex flex-col gap-2">
                    {businessAccounts.map((a) => (
                      <button
                        key={a.id}
                        onClick={() => signIn(a.id, a.status === 'invited')}
                        className="w-full flex items-center justify-between gap-4 p-4 rounded-2xl bg-[#0a0a0c]/60 border border-white/5 hover:border-[#14e3c4]/40 transition-colors text-left group"
                      >
                        <span className="min-w-0">
                          <span className="block text-sm font-bold text-white truncate">{a.businessName}</span>
                          <span className="block text-[12px] text-zinc-500 mt-0.5 truncate">
                            {a.contactName} · {a.email || a.mobile}
                          </span>
                        </span>
                        <span className="flex items-center gap-2 shrink-0">
                          {a.status === 'invited' ? <Pill tone="amber">Invite waiting</Pill> : <Pill tone="green">Active</Pill>}
                          <ArrowRight size={16} className="text-zinc-600 group-hover:text-white transition-colors" />
                        </span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            ) : (
              <div className="rounded-[28px] border border-white/5 bg-[#16161a] p-6 flex flex-col gap-4">
                {step === 0 ? (
                  <>
                    <div>
                      <h2 className="text-[15px] font-bold text-white tracking-tight">Tell us about your business</h2>
                      <p className="text-[12px] text-zinc-500 mt-1">
                        You can set this up yourself — your accountant does not need to do it for you.
                      </p>
                    </div>
                    <Field label="Business name" value={form.businessName} onChange={(v) => set('businessName', v)} placeholder="American Burger Ltd" />
                    <div className="grid grid-cols-2 gap-4">
                      <Field label="Your name" value={form.contactName} onChange={(v) => set('contactName', v)} placeholder="John Doe" />
                      <Select label="Industry" value={form.industry} onChange={(v) => set('industry', v)} options={INDUSTRIES} />
                    </div>
                    <button
                      onClick={() => setStep(1)}
                      disabled={!canContinue}
                      className="self-end flex items-center gap-2 px-6 py-2.5 rounded-full text-sm font-bold text-white bg-[#14e3c4] hover:bg-[#0fcbaf] disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                    >
                      Continue
                      <ArrowRight size={16} strokeWidth={2.5} />
                    </button>
                  </>
                ) : (
                  <>
                    <div>
                      <h2 className="text-[15px] font-bold text-white tracking-tight">How we reach you</h2>
                      <p className="text-[12px] text-zinc-500 mt-1">
                        The mobile number matters — missing paperwork is chased by text.
                      </p>
                    </div>
                    <Field label="Mobile number" value={form.mobile} onChange={(v) => set('mobile', v)} placeholder="+44 7700 900123" icon={Smartphone} />
                    <Field label="Email" value={form.email} onChange={(v) => set('email', v)} placeholder="john@americanburger.co.uk" icon={Mail} />
                    <Field
                      label="Accountant's practice code (optional)"
                      value={form.practiceCode}
                      onChange={(v) => set('practiceCode', v)}
                      placeholder="PRC-4417"
                      hint="Links you to your accountant straight away. Without it they will claim your account manually."
                    />

                    <div className="flex items-center justify-between gap-3 pt-1">
                      <button
                        onClick={() => setStep(0)}
                        className="px-5 py-2.5 text-sm font-bold text-zinc-400 hover:text-white rounded-full transition-colors"
                      >
                        Back
                      </button>
                      <button
                        onClick={create}
                        disabled={!canCreate}
                        className="flex items-center gap-2 px-6 py-2.5 rounded-full text-sm font-bold text-white bg-[#14e3c4] hover:bg-[#0fcbaf] disabled:opacity-40 disabled:cursor-not-allowed transition-colors shadow-[0_0_15px_rgba(20,227,196,0.3)]"
                      >
                        <BadgeCheck size={16} strokeWidth={2.5} />
                        Create account
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
        active ? 'bg-[#14e3c4]/10 border-[#14e3c4]/40 text-[#14e3c4]' : 'bg-[#16161a] border-white/5 text-zinc-400 hover:text-white'
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
          className={`w-full bg-[#0a0a0c] border border-white/5 rounded-xl py-2.5 text-sm text-white placeholder:text-zinc-600 focus:outline-none focus:border-[#14e3c4] transition-colors ${
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
        className="w-full bg-[#0a0a0c] border border-white/5 rounded-xl px-4 py-2.5 text-sm text-white focus:outline-none focus:border-[#14e3c4] transition-colors appearance-none"
      >
        {options.map((o) => (
          <option key={o} value={o} className="bg-[#16161a]">
            {o}
          </option>
        ))}
      </select>
    </div>
  );
}
