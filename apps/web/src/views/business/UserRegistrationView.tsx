import { useRef, useState } from 'react';
import { Smartphone, ArrowLeft, ImagePlus, X, Check, ShieldCheck } from 'lucide-react';
import { motion } from 'motion/react';
import { useAppContext } from '../../context/AppContext';
import { Pill } from '../../components/DynamicComponents/DataTable';

/**
 * What an invited business user sees when they open their SMS link. The
 * practice set who they are and what they may do; everything on this screen is
 * theirs to supply — their photo, their email, and a check that the details
 * held about them are right.
 *
 * Same app-free mechanism as chasing and approvals: a link, a code, no
 * password and nothing installed.
 */
export function UserRegistrationView() {
  const {
    businessAccounts, openRegistrationFor, completeBusinessUserRegistration, exitBusinessPortal,
  } = useAppContext();

  const account = businessAccounts.find((a) => a.id === openRegistrationFor?.accountId);
  const member = account?.members.find((m) => m.id === openRegistrationFor?.memberId);

  const [verified, setVerified] = useState(false);
  const [code, setCode] = useState('');
  const [draft, setDraft] = useState({
    name: member?.name ?? '',
    email: member?.email ?? '',
    avatarDataUrl: member?.avatarDataUrl ?? '',
  });
  const [done, setDone] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  if (!account || !member) {
    return (
      <Shell title="Link not found">
        <p className="text-[14px] text-zinc-400 leading-relaxed">
          This registration link is no longer valid. Ask whoever invited you to send a new one.
        </p>
        <Back onClick={exitBusinessPortal} />
      </Shell>
    );
  }

  if (done || member.status === 'active') {
    return (
      <Shell title="You're set up">
        <div className="w-14 h-14 rounded-2xl bg-brand/15 border border-brand/30 flex items-center justify-center text-brand">
          <Check size={26} strokeWidth={3} />
        </div>
        <p className="text-[14px] text-zinc-400 leading-relaxed">
          You can now send paperwork for {account.businessName}. There is nothing to install — every time you come
          back, you get a code by text.
        </p>
        <Back onClick={exitBusinessPortal} />
      </Shell>
    );
  }

  /* ── the OTP challenge ─────────────────────────────────────────────────── */
  if (!verified) {
    const masked = (member.mobile ?? '').replace(/(\+\d{2}\s?\d)(.*)(\d{2})$/, '$1••• •••$3');
    return (
      <Shell title={`Join ${account.businessName}`}>
        <div className="p-4 rounded-2xl bg-ground border border-white/5 shadow-inner">
          <p className="text-[13.5px] text-zinc-300 leading-relaxed">
            {account.businessName} added you as {article(member.role)} <strong className="text-white">{member.role}</strong>.
            Confirm it is you and add your details — it takes a minute.
          </p>
        </div>

        <div>
          <div className="text-[11px] font-bold text-zinc-500 uppercase tracking-widest mb-2">
            Code sent to {masked || 'your mobile'}
          </div>
          <input
            value={code}
            onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 4))}
            onKeyDown={(e) => e.key === 'Enter' && setVerified(true)}
            inputMode="numeric"
            placeholder="0000"
            aria-label="One-time code"
            className="w-full bg-ground border border-white/5 rounded-2xl px-5 py-4 text-2xl font-bold tracking-[0.4em] text-center text-white placeholder:text-zinc-700 focus:outline-none focus:border-brand transition-colors tabular-nums"
          />
          <p className="text-[12px] text-zinc-600 mt-3">
            Codes are issued and checked server-side — Verify continues without one here.
          </p>
        </div>

        <button
          onClick={() => setVerified(true)}
          className="w-full flex items-center justify-center gap-2 px-6 py-3.5 rounded-full text-[14px] font-bold text-white bg-brand hover:bg-brand-hover transition-colors shadow-[0_0_20px_rgba(20,227,196,0.25)]"
        >
          <ShieldCheck size={16} strokeWidth={2.5} />
          Verify
        </button>
        <Back onClick={exitBusinessPortal} />
      </Shell>
    );
  }

  /* ── the details only they can give ────────────────────────────────────── */
  const emailLooksWrong = draft.email.trim() !== '' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(draft.email.trim());
  const problem = !draft.name.trim()
    ? 'Add your name.'
    : !draft.email.trim()
    ? 'Add an email — it is where copies of anything you send go.'
    : emailLooksWrong
    ? 'That email does not look right.'
    : '';

  return (
    <Shell title="Add your details">
      <div className="flex items-center gap-4">
        <div className="w-16 h-16 rounded-2xl bg-ground border border-white/5 flex items-center justify-center overflow-hidden shrink-0 shadow-inner">
          {draft.avatarDataUrl ? (
            <img src={draft.avatarDataUrl} alt="" className="w-full h-full object-cover" />
          ) : (
            <span className="font-sans text-2xl font-bold text-zinc-600">
              {draft.name.trim().charAt(0).toUpperCase() || '?'}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => fileRef.current?.click()}
            className="flex items-center gap-2 px-4 py-2 rounded-full text-[13px] font-bold text-zinc-300 border border-white/10 hover:text-white hover:border-white/25 transition-colors"
          >
            <ImagePlus size={15} />
            {draft.avatarDataUrl ? 'Replace photo' : 'Add a photo'}
          </button>
          {draft.avatarDataUrl && (
            <button
              onClick={() => setDraft({ ...draft, avatarDataUrl: '' })}
              className="flex items-center gap-1.5 px-3 py-2 rounded-full text-[13px] font-bold text-zinc-500 hover:text-white transition-colors"
            >
              <X size={14} />
              Remove
            </button>
          )}
        </div>
        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file && file.type.startsWith('image/') && file.size <= 2 * 1024 * 1024) {
              const reader = new FileReader();
              reader.onload = () => setDraft({ ...draft, avatarDataUrl: String(reader.result) });
              reader.readAsDataURL(file);
            }
            e.target.value = '';
          }}
        />
      </div>

      <Field label="Your name" value={draft.name} onChange={(v) => setDraft({ ...draft, name: v })} placeholder="Tom Whyte" />
      <Field label="Your email" value={draft.email} onChange={(v) => setDraft({ ...draft, email: v })} placeholder="tom@yourbusiness.co.uk" />

      {/* Set by the business, shown so it can be queried rather than silently
          wrong — but not editable here. */}
      <div className="p-4 rounded-2xl bg-ground border border-white/5 shadow-inner flex flex-col gap-2">
        <div className="text-[11px] font-bold text-zinc-500 uppercase tracking-widest">Set by {account.businessName}</div>
        <div className="flex items-center gap-2 flex-wrap">
          <Pill tone="blue">{member.role}</Pill>
          {member.canUpload && <Pill tone="green">Can send documents</Pill>}
          {member.canSeeTotals ? <Pill tone="amber">Can see totals</Pill> : <Pill>Totals hidden</Pill>}
        </div>
        <p className="text-[12px] text-zinc-500 leading-relaxed">
          Ask {account.contactName || 'whoever invited you'} if any of this is wrong — only they can change it.
        </p>
      </div>

      {problem && <p className="text-[13px] text-amber-400 font-semibold">{problem}</p>}

      <button
        onClick={() => {
          completeBusinessUserRegistration(account.id, member.id, {
            name: draft.name.trim(),
            email: draft.email.trim(),
            avatarDataUrl: draft.avatarDataUrl || undefined,
          });
          setDone(true);
        }}
        disabled={!!problem}
        className="w-full px-6 py-3.5 rounded-full text-[14px] font-bold text-white bg-brand hover:bg-brand-hover disabled:opacity-40 disabled:cursor-not-allowed transition-colors shadow-[0_0_20px_rgba(20,227,196,0.25)]"
      >
        Finish
      </button>
      <Back onClick={exitBusinessPortal} />
    </Shell>
  );
}

const article = (role: string) => (/^[AEIOU]/i.test(role) ? 'an' : 'a');

function Shell({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="flex-1 flex flex-col min-w-0 h-full bg-ground overflow-y-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
      <motion.div
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        className="w-full max-w-md mx-auto px-5 py-10 flex flex-col gap-5"
      >
        <div className="flex items-center gap-3">
          <div className="w-11 h-11 rounded-2xl bg-brand flex items-center justify-center text-white shrink-0 shadow-[0_0_15px_rgba(20,227,196,0.3)]">
            <Smartphone size={19} />
          </div>
          <div>
            <h1 className="font-sans font-bold text-xl text-white tracking-tight">{title}</h1>
            <p className="text-[11px] text-zinc-500 font-semibold uppercase tracking-wider">No app · no password</p>
          </div>
        </div>
        {children}
      </motion.div>
    </div>
  );
}

function Field({ label, value, onChange, placeholder }: {
  label: string; value: string; onChange: (v: string) => void; placeholder?: string;
}) {
  return (
    <div>
      <div className="text-[11px] font-bold text-zinc-500 uppercase tracking-widest mb-2">{label}</div>
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="w-full bg-ground border border-white/5 rounded-xl px-4 py-3 text-sm text-white placeholder:text-zinc-600 focus:outline-none focus:border-brand transition-colors"
      />
    </div>
  );
}

function Back({ onClick }: { onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="self-start flex items-center gap-2 px-4 py-2 rounded-full text-[13px] font-bold text-zinc-500 hover:text-white transition-colors"
    >
      <ArrowLeft size={14} />
      Back to the practice app
    </button>
  );
}
