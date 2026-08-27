import { useRef, useState } from 'react';
import { Smartphone, ArrowLeft, ImagePlus, X, Check, ShieldCheck } from 'lucide-react';
import { motion } from 'motion/react';
import { defineMessages, useIntl } from 'react-intl';
import { useAppContext } from '../../context/AppContext';
import { Pill } from '../../components/DynamicComponents/DataTable';

const m = defineMessages({
  linkNotFoundTitle: { id: 'portal.userRegistrationView.linkNotFoundTitle', defaultMessage: 'Link not found' },
  linkNotFoundDetail: {
    id: 'portal.userRegistrationView.linkNotFoundDetail',
    defaultMessage: 'This registration link is no longer valid. Ask whoever invited you to send a new one.',
  },
  doneTitle: { id: 'portal.userRegistrationView.doneTitle', defaultMessage: "You're set up" },
  doneDetail: {
    id: 'portal.userRegistrationView.doneDetail',
    defaultMessage:
      'You can now send paperwork for {business}. There is nothing to install — every time you come back, you get a code by email.',
  },

  joinTitle: { id: 'portal.userRegistrationView.joinTitle', defaultMessage: 'Join {business}' },
  joinIntro: {
    id: 'portal.userRegistrationView.joinIntro',
    defaultMessage:
      '{business} added you as {article} <strong>{role}</strong>. Confirm it is you and add your details — it takes a minute.',
  },
  codeSentTo: { id: 'portal.userRegistrationView.codeSentTo', defaultMessage: 'Code sent to {mobile}' },
  codeSentToFallback: {
    id: 'portal.userRegistrationView.codeSentToFallback',
    defaultMessage: 'Code sent to your mobile',
  },
  codeAriaLabel: { id: 'portal.userRegistrationView.codeAriaLabel', defaultMessage: 'One-time code' },
  // See the same placeholder on the approval screen: a numeral, so it is
  // translated rather than hard-coded.
  codePlaceholder: { id: 'portal.userRegistrationView.codePlaceholder', defaultMessage: '0000' },
  serverSideNote: {
    id: 'portal.userRegistrationView.serverSideNote',
    defaultMessage: 'Codes are issued and checked server-side — Verify continues without one here.',
  },
  verifyAction: { id: 'portal.userRegistrationView.verifyAction', defaultMessage: 'Verify' },

  detailsTitle: { id: 'portal.userRegistrationView.detailsTitle', defaultMessage: 'Add your details' },
  replacePhotoAction: { id: 'portal.userRegistrationView.replacePhotoAction', defaultMessage: 'Replace photo' },
  addPhotoAction: { id: 'portal.userRegistrationView.addPhotoAction', defaultMessage: 'Add a photo' },
  removePhotoAction: { id: 'portal.userRegistrationView.removePhotoAction', defaultMessage: 'Remove' },
  nameLabel: { id: 'portal.userRegistrationView.nameLabel', defaultMessage: 'Your name' },
  namePlaceholder: { id: 'portal.userRegistrationView.namePlaceholder', defaultMessage: 'Tom Whyte' },
  emailLabel: { id: 'portal.userRegistrationView.emailLabel', defaultMessage: 'Your email' },
  emailPlaceholder: {
    id: 'portal.userRegistrationView.emailPlaceholder',
    defaultMessage: 'tom@yourbusiness.co.uk',
  },
  setByLabel: { id: 'portal.userRegistrationView.setByLabel', defaultMessage: 'Set by {business}' },
  canUpload: { id: 'portal.userRegistrationView.canUpload', defaultMessage: 'Can send documents' },
  canSeeTotals: { id: 'portal.userRegistrationView.canSeeTotals', defaultMessage: 'Can see totals' },
  totalsHidden: { id: 'portal.userRegistrationView.totalsHidden', defaultMessage: 'Totals hidden' },
  askOwner: {
    id: 'portal.userRegistrationView.askOwner',
    defaultMessage: 'Ask {who} if any of this is wrong — only they can change it.',
  },
  askOwnerFallback: {
    id: 'portal.userRegistrationView.askOwnerFallback',
    defaultMessage: 'Ask whoever invited you if any of this is wrong — only they can change it.',
  },
  problemNoName: { id: 'portal.userRegistrationView.problemNoName', defaultMessage: 'Add your name.' },
  problemNoEmail: {
    id: 'portal.userRegistrationView.problemNoEmail',
    defaultMessage: 'Add an email — it is where copies of anything you send go.',
  },
  problemBadEmail: {
    id: 'portal.userRegistrationView.problemBadEmail',
    defaultMessage: 'That email does not look right.',
  },
  finishAction: { id: 'portal.userRegistrationView.finishAction', defaultMessage: 'Finish' },

  shellSubtitle: { id: 'portal.shell.subtitle', defaultMessage: 'No app · no password' },
  backLabel: { id: 'portal.back.label', defaultMessage: 'Back to the practice app' },
});

/**
 * What an invited business user sees when they open their invite link. The
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
  const intl = useIntl();

  const account = businessAccounts.find((a) => a.id === openRegistrationFor?.accountId);
  const member = account?.members.find((x) => x.id === openRegistrationFor?.memberId);

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
      <Shell title={intl.formatMessage(m.linkNotFoundTitle)}>
        <p className="text-[14px] text-zinc-400 leading-relaxed">
          {intl.formatMessage(m.linkNotFoundDetail)}
        </p>
        <Back onClick={exitBusinessPortal} />
      </Shell>
    );
  }

  if (done || member.status === 'active') {
    return (
      <Shell title={intl.formatMessage(m.doneTitle)}>
        <div className="w-14 h-14 rounded-2xl bg-brand/15 border border-brand/30 flex items-center justify-center text-brand">
          <Check size={26} strokeWidth={3} />
        </div>
        <p className="text-[14px] text-zinc-400 leading-relaxed">
          {intl.formatMessage(m.doneDetail, { business: account.businessName })}
        </p>
        <Back onClick={exitBusinessPortal} />
      </Shell>
    );
  }

  /* ── the OTP challenge ─────────────────────────────────────────────────── */
  if (!verified) {
    const masked = (member.mobile ?? '').replace(/(\+\d{2}\s?\d)(.*)(\d{2})$/, '$1••• •••$3');
    return (
      <Shell title={intl.formatMessage(m.joinTitle, { business: account.businessName })}>
        <div className="p-4 rounded-2xl bg-ground border border-white/5 shadow-inner">
          <p className="text-[13.5px] text-zinc-300 leading-relaxed">
            {intl.formatMessage(m.joinIntro, {
              business: account.businessName,
              article: article(member.role),
              role: member.role,
              strong: (chunks: React.ReactNode[]) => <strong className="text-white">{chunks}</strong>,
            })}
          </p>
        </div>

        <div>
          <div className="text-[11px] font-bold text-zinc-500 uppercase tracking-widest mb-2">
            {masked
              ? intl.formatMessage(m.codeSentTo, { mobile: masked })
              : intl.formatMessage(m.codeSentToFallback)}
          </div>
          <input
            value={code}
            onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 4))}
            onKeyDown={(e) => e.key === 'Enter' && setVerified(true)}
            inputMode="numeric"
            placeholder={intl.formatMessage(m.codePlaceholder)}
            aria-label={intl.formatMessage(m.codeAriaLabel)}
            className="w-full bg-ground border border-white/5 rounded-2xl px-5 py-4 text-2xl font-bold tracking-[0.4em] text-center text-white placeholder:text-zinc-700 focus:outline-none focus:border-brand transition-colors tabular-nums"
          />
          <p className="text-[12px] text-zinc-600 mt-3">
            {intl.formatMessage(m.serverSideNote)}
          </p>
        </div>

        <button
          onClick={() => setVerified(true)}
          className="w-full flex items-center justify-center gap-2 px-6 py-3.5 rounded-full text-[14px] font-bold text-white bg-brand hover:bg-brand-hover transition-colors shadow-glow-cta"
        >
          <ShieldCheck size={16} strokeWidth={2.5} />
          {intl.formatMessage(m.verifyAction)}
        </button>
        <Back onClick={exitBusinessPortal} />
      </Shell>
    );
  }

  /* ── the details only they can give ────────────────────────────────────── */
  const emailLooksWrong = draft.email.trim() !== '' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(draft.email.trim());
  const problem = !draft.name.trim()
    ? intl.formatMessage(m.problemNoName)
    : !draft.email.trim()
    ? intl.formatMessage(m.problemNoEmail)
    : emailLooksWrong
    ? intl.formatMessage(m.problemBadEmail)
    : '';

  return (
    <Shell title={intl.formatMessage(m.detailsTitle)}>
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
            {draft.avatarDataUrl
              ? intl.formatMessage(m.replacePhotoAction)
              : intl.formatMessage(m.addPhotoAction)}
          </button>
          {draft.avatarDataUrl && (
            <button
              onClick={() => setDraft({ ...draft, avatarDataUrl: '' })}
              className="flex items-center gap-1.5 px-3 py-2 rounded-full text-[13px] font-bold text-zinc-500 hover:text-white transition-colors"
            >
              <X size={14} />
              {intl.formatMessage(m.removePhotoAction)}
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

      <Field
        label={intl.formatMessage(m.nameLabel)}
        value={draft.name}
        onChange={(v) => setDraft({ ...draft, name: v })}
        placeholder={intl.formatMessage(m.namePlaceholder)}
      />
      <Field
        label={intl.formatMessage(m.emailLabel)}
        value={draft.email}
        onChange={(v) => setDraft({ ...draft, email: v })}
        placeholder={intl.formatMessage(m.emailPlaceholder)}
      />

      {/* Set by the business, shown so it can be queried rather than silently
          wrong — but not editable here. */}
      <div className="p-4 rounded-2xl bg-ground border border-white/5 shadow-inner flex flex-col gap-2">
        <div className="text-[11px] font-bold text-zinc-500 uppercase tracking-widest">
          {intl.formatMessage(m.setByLabel, { business: account.businessName })}
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <Pill tone="blue">{member.role}</Pill>
          {member.canUpload && <Pill tone="green">{intl.formatMessage(m.canUpload)}</Pill>}
          {member.canSeeTotals ? (
            <Pill tone="amber">{intl.formatMessage(m.canSeeTotals)}</Pill>
          ) : (
            <Pill>{intl.formatMessage(m.totalsHidden)}</Pill>
          )}
        </div>
        <p className="text-[12px] text-zinc-500 leading-relaxed">
          {account.contactName
            ? intl.formatMessage(m.askOwner, { who: account.contactName })
            : intl.formatMessage(m.askOwnerFallback)}
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
        className="w-full px-6 py-3.5 rounded-full text-[14px] font-bold text-white bg-brand hover:bg-brand-hover disabled:opacity-40 disabled:cursor-not-allowed transition-colors shadow-glow-cta"
      >
        {intl.formatMessage(m.finishAction)}
      </button>
      <Back onClick={exitBusinessPortal} />
    </Shell>
  );
}

const article = (role: string) => (/^[AEIOU]/i.test(role) ? 'an' : 'a');

function Shell({ title, children }: { title: string; children: React.ReactNode }) {
  const intl = useIntl();
  return (
    <div className="flex-1 flex flex-col min-w-0 h-full bg-ground overflow-y-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
      <motion.div
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        className="w-full max-w-md mx-auto px-5 py-10 flex flex-col gap-5"
      >
        <div className="flex items-center gap-3">
          <div className="w-11 h-11 rounded-2xl bg-brand flex items-center justify-center text-white shrink-0 shadow-glow-tile">
            <Smartphone size={19} />
          </div>
          <div>
            <h1 className="font-sans font-bold text-xl text-white tracking-tight">{title}</h1>
            <p className="text-[11px] text-zinc-500 font-semibold uppercase tracking-wider">
              {intl.formatMessage(m.shellSubtitle)}
            </p>
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
  const intl = useIntl();
  return (
    <button
      onClick={onClick}
      className="self-start flex items-center gap-2 px-4 py-2 rounded-full text-[13px] font-bold text-zinc-500 hover:text-white transition-colors"
    >
      <ArrowLeft size={14} />
      {intl.formatMessage(m.backLabel)}
    </button>
  );
}
