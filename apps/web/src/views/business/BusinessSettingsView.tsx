import { useState } from 'react';
import { Building2, Bell, Users, KeyRound, Link2, Camera, Plus, Trash2 } from 'lucide-react';
import { motion } from 'motion/react';
import { useAppContext } from '../../context/AppContext';
import { Pill } from '../../components/DynamicComponents/DataTable';
import { newMember } from '../../lib/business';
import { RolePicker } from '../../components/DynamicComponents/RolePicker';
import { useConfirm } from '../../components/DynamicComponents/ConfirmProvider';
import type { BusinessAccount, BusinessMember } from '../../lib/types';

const SECTIONS = [
  { key: 'Business', icon: Building2 },
  { key: 'Sending', icon: Camera },
  { key: 'Notifications', icon: Bell },
  { key: 'People', icon: Users },
  { key: 'Connections', icon: Link2 },
  { key: 'Security', icon: KeyRound },
] as const;

type Section = (typeof SECTIONS)[number]['key'];

/**
 * Settings the business owns. Anything the accountant controls — coding rules,
 * approval workflows, what gets published — is deliberately absent; this is the
 * client's side of the boundary.
 */
export function BusinessSettingsView({ account }: { account: BusinessAccount }) {
  const { updateBusinessAccount, clients, accounts, logAudit, completeOnboardingTask } = useAppContext();
  const [section, setSection] = useState<Section>('Business');
  const [editingMember, setEditingMember] = useState<BusinessMember | null>(null);
  const confirm = useConfirm();

  const client = clients.find((c) => c.id === account.clientId);
  const bank = accounts.filter((a) => a.clientId === account.clientId);

  const save = (patch: Partial<BusinessAccount>, label: string) => {
    updateBusinessAccount(account.id, patch);
    logAudit({ action: 'Business changed a portal setting', scope: `${account.businessName} — ${label}`, reviewOpened: false });
  };

  return (
    <div className="flex min-w-0 h-full">
      <aside className="w-56 shrink-0 border-r border-white/5 py-8 px-3 overflow-y-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        <nav className="flex flex-col gap-1">
          {SECTIONS.map((s) => (
            <button
              key={s.key}
              onClick={() => setSection(s.key)}
              className={`px-4 py-2.5 rounded-xl text-left text-sm font-semibold transition-all flex items-center gap-3 ${
                section === s.key
                  ? 'bg-[#16161a] text-white border border-white/5'
                  : 'text-zinc-400 hover:text-white hover:bg-[#16161a]/50 border border-transparent'
              }`}
            >
              <s.icon size={15} className={section === s.key ? 'text-[#14e3c4]' : ''} />
              {s.key}
            </button>
          ))}
        </nav>
      </aside>

      <div className="flex-1 min-w-0 overflow-y-auto p-8 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        <motion.div key={section} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} className="max-w-2xl flex flex-col gap-5">
          {section === 'Business' && (
            <>
              <BusinessDetailsPanel account={account} onSave={save} />
              <Panel title="Your accountant" subtitle="Managed by the practice — contact them to change it">
                <Row label="Practice" value={<span className="text-white font-semibold">Your accounting practice</span>} />
                <Row label="Industry on file" value={client?.industry ?? '—'} />
                <Row label="VAT number" value={client?.vatNumber || 'Not registered'} />
                <Row label="Next deadline" value={client?.deadline ?? '—'} />
                <Row
                  label="Account created"
                  value={
                    <span className="flex items-center gap-2">
                      {account.createdAt}
                      <Pill tone={account.origin === 'self-signup' ? 'blue' : 'neutral'}>
                        {account.origin === 'self-signup' ? 'Signed up directly' : 'Created by accountant'}
                      </Pill>
                    </span>
                  }
                />
              </Panel>
            </>
          )}

          {section === 'Sending' && (
            <Panel title="How documents are sent" subtitle="Defaults for upload and camera capture">
              <div className="flex flex-col gap-3">
                {/* No money-in / money-out choice: sorting paperwork is
                    bookkeeping, and it is not the business's job. Extraction
                    reads the bill-to block and files it. */}
                <div className="p-4 rounded-2xl bg-[#0a0a0c]/60 border border-white/5 shadow-inner">
                  <div className="text-sm font-bold text-white">We work out what each document is</div>
                  <div className="text-[12px] text-zinc-500 mt-1 leading-relaxed">
                    Bills, receipts and sales invoices can all go in together — you never have to sort them. Your
                    accountant sees what we decided, and can correct it.
                  </div>
                </div>
                <Toggle
                  label="Multi-page capture"
                  hint="Shoot several sheets and send them as one document."
                  value={account.multiPageCapture}
                  onChange={(v) => save({ multiPageCapture: v }, 'multi-page capture')}
                />
                <Toggle
                  label="Send as I shoot"
                  hint="Skips the review step — each photo goes straight to your accountant."
                  value={account.autoSubmitOnCapture}
                  onChange={(v) => save({ autoSubmitOnCapture: v }, 'send as I shoot')}
                />
              </div>
            </Panel>
          )}

          {section === 'Notifications' && (
            <Panel title="When we contact you" subtitle="Chases always come by SMS — the rest is up to you">
              <div className="flex flex-col gap-3">
                <Toggle
                  label="Text me when something is missing"
                  hint={`Sent to ${account.mobile || 'your mobile'}`}
                  value={account.notifyBySms}
                  onChange={(v) => save({ notifyBySms: v }, 'SMS notifications')}
                />
                <Toggle
                  label="Email me too"
                  hint={account.email || 'No email on file'}
                  value={account.notifyByEmail}
                  onChange={(v) => save({ notifyByEmail: v }, 'email notifications')}
                />
                <Toggle
                  label="Weekly summary"
                  hint="One message a week with anything still outstanding."
                  value={account.weeklySummary}
                  onChange={(v) => save({ weeklySummary: v }, 'weekly summary')}
                />
              </div>
            </Panel>
          )}

          {section === 'People' && (
            <Panel
              title="Who can send documents"
              subtitle="Staff can photograph receipts without ever seeing your figures"
            >
              <div className="flex flex-col gap-2">
                {account.members.length === 0 && (
                  <p className="text-[13px] text-zinc-500 py-4 text-center">
                    Nobody added yet. Invite the people who handle paperwork.
                  </p>
                )}
                {account.members.map((m) => (
                  <button
                    key={m.id}
                    onClick={() => setEditingMember(m)}
                    className="p-4 rounded-2xl bg-[#0a0a0c]/60 border border-white/5 hover:border-white/15 transition-colors text-left flex items-center gap-4"
                  >
                    <div className="w-10 h-10 rounded-xl bg-[#202026] border border-white/5 flex items-center justify-center font-bold text-white shrink-0">
                      {m.name.trim().charAt(0).toUpperCase() || '?'}
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="text-sm font-bold text-white truncate">{m.name || 'Unnamed'}</div>
                      <div className="text-[12px] text-zinc-500 truncate">{m.email || 'No email'}</div>
                    </div>
                    <div className="flex items-center gap-2 shrink-0 flex-wrap justify-end">
                      <Pill tone={m.role === 'Owner' ? 'blue' : 'neutral'}>{m.role}</Pill>
                      {m.canUpload && <Pill tone="green">Can send</Pill>}
                      {m.canSeeTotals && <Pill tone="amber">Sees totals</Pill>}
                    </div>
                  </button>
                ))}
                <button
                  onClick={() => setEditingMember(newMember())}
                  className="flex items-center justify-center gap-2 p-3.5 rounded-2xl border border-dashed border-white/10 text-[13px] font-bold text-zinc-400 hover:text-white hover:border-white/25 transition-colors"
                >
                  <Plus size={15} />
                  Invite someone
                </button>
              </div>
              <p className="text-[12px] text-zinc-500 leading-relaxed mt-4">
                Everyone here signs in the same way you do — a code by SMS or email, no password to share. Removing
                someone stops their access immediately; the documents they already sent stay with your accountant.
              </p>
            </Panel>
          )}

          {section === 'Connections' && (
            <>
              <Panel
                title="Connections your accountant asked for"
                subtitle="Only you can do these — they need your own login, which your accountant never sees"
              >
                <div className="flex flex-col gap-2">
                  {/* Only on records the accountant opened with an invite —
                      elsewhere they keyed the company in themselves. */}
                  {client?.awaitingRegistration && (
                    <ConnectRow
                      name="Company details"
                      detail="Legal name, VAT, year-end and what the business sells"
                      connected={false}
                      onConnect={() => completeOnboardingTask(account.clientId, 'profile')}
                      actionLabel="Register"
                      doneLabel="Registered"
                    />
                  )}
                  <ConnectRow
                    name="Accounting software"
                    detail="Xero, QuickBooks, Sage or FreeAgent"
                    connected={client?.xeroConnected ?? false}
                    onConnect={() => completeOnboardingTask(account.clientId, 'ledger')}
                  />
                  <ConnectRow
                    name="Bank feed"
                    detail="Read-only open banking — no payments can be made"
                    connected={client?.bankConnected ?? false}
                    onConnect={() => completeOnboardingTask(account.clientId, 'bank')}
                  />
                </div>
                <p className="text-[12px] text-zinc-500 leading-relaxed mt-4">
                  A live bank feed is what lets your accountant spot a payment with no receipt — it is the reason most
                  chases exist. Connecting it means fewer texts asking you for paperwork.
                </p>
              </Panel>

              {bank.length > 0 && (
                <Panel title="Bank accounts on file" subtitle="Kept in sync once the feed is connected">
                  <div className="flex flex-col gap-2">
                    {bank.map((a) => (
                      <Row
                        key={a.id}
                        label={`${a.bankName} ••${a.last4}`}
                        value={
                          a.status === 'live' ? (
                            <Pill tone="green">Live · {a.reauthDays}d left</Pill>
                          ) : a.status === 'error' ? (
                            <Pill tone="red">Needs reconnecting</Pill>
                          ) : (
                            <Pill tone="amber">Disconnected</Pill>
                          )
                        }
                      />
                    ))}
                  </div>
                </Panel>
              )}
            </>
          )}

          {section === 'Security' && (
            <>
              <Panel title="Sign-in" subtitle="Protects everything you send from this portal">
                <Toggle
                  label="Two-factor authentication"
                  hint="A code by SMS each time you sign in on a new device."
                  value={account.twoFactor}
                  onChange={(v) => save({ twoFactor: v }, 'two-factor authentication')}
                />
              </Panel>
              <Panel title="Access" subtitle="What your accountant can and cannot do">
                <p className="text-[13px] text-zinc-500 leading-relaxed">
                  Your accountant sees the documents you send and the figures extracted from them. They cannot sign in
                  as you, and they cannot change your notification settings or the people listed above.
                </p>
              </Panel>
            </>
          )}
        </motion.div>
      </div>

      {editingMember && (
        <MemberEditor
          member={editingMember}
          existing={account.members}
          onSave={(m) => {
            const isNew = !account.members.some((x) => x.id === m.id);
            save(
              { members: isNew ? [...account.members, m] : account.members.map((x) => (x.id === m.id ? m : x)) },
              isNew ? `invited ${m.name}` : `updated ${m.name}`,
            );
            setEditingMember(null);
          }}
          onRemove={async () => {
            const ok = await confirm({
              tone: 'red',
              title: `Remove ${editingMember.name}?`,
              detail: `${editingMember.role} at ${account.businessName}.`,
              consequence: 'They stop being able to send documents immediately. Anything they already sent stays with your accountant.',
              confirmLabel: 'Yes, remove them',
            });
            if (!ok) return;
            save({ members: account.members.filter((x) => x.id !== editingMember.id) }, `removed ${editingMember.name}`);
            setEditingMember(null);
          }}
          onClose={() => setEditingMember(null)}
        />
      )}
    </div>
  );
}

/**
 * Inviting and editing a person, matching the shape of the practice-side
 * colleague editor: a real form with a save gate rather than a blank row you
 * type into and hope. Nothing is written until the fields are valid, so the
 * member list never fills with half-finished entries.
 */
function MemberEditor({ member, existing, onSave, onRemove, onClose }: {
  member: BusinessMember;
  existing: BusinessMember[];
  onSave: (m: BusinessMember) => void;
  onRemove: () => void;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState(member);
  const set = <K extends keyof BusinessMember>(k: K, v: BusinessMember[K]) => setDraft({ ...draft, [k]: v });

  const isNew = !existing.some((x) => x.id === member.id);
  const name = draft.name.trim();
  const email = draft.email.trim();

  // One email is one person — the address is how they receive their sign-in
  // code, so two people sharing one would collide on every send.
  const duplicate = existing.some((x) => x.id !== draft.id && x.email.trim().toLowerCase() === email.toLowerCase() && email !== '');
  const emailLooksWrong = email !== '' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
  const owners = existing.filter((x) => x.role === 'Owner');
  const lastOwner = !isNew && member.role === 'Owner' && owners.length === 1;

  const problem = !name
    ? 'Add their name.'
    : !email
    ? 'Add an email — it is how they receive their sign-in code.'
    : emailLooksWrong
    ? 'That email does not look right.'
    : duplicate
    ? 'Someone here already uses that email.'
    : draft.role === 'Owner' || !lastOwner || draft.role === member.role
    ? ''
    : 'This is your only Owner — make someone else an Owner first.';

  return (
    <div
      className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm flex items-start justify-center overflow-y-auto p-8 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      onClick={onClose}
    >
      <motion.div
        initial={{ opacity: 0, y: 20, scale: 0.97 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-lg border border-white/5 rounded-[32px] bg-[#16161a] shadow-2xl overflow-hidden my-auto"
      >
        <div className="p-6 border-b border-white/5">
          <h3 className="font-sans font-bold text-xl text-white tracking-tight">
            {isNew ? 'Invite someone' : draft.name || 'Edit person'}
          </h3>
          <p className="text-[12px] text-zinc-500 mt-1 font-semibold uppercase tracking-wider">
            What they can do, and what they can see
          </p>
        </div>

        <div className="p-6 flex flex-col gap-5">
          <div className="grid grid-cols-2 gap-4">
            <Field label="Name" value={draft.name} onChange={(v) => set('name', v)} placeholder="Tom Whyte" />
            <Field label="Email" value={draft.email} onChange={(v) => set('email', v)} placeholder="tom@yourbusiness.co.uk" />
          </div>

          <RolePicker
            value={draft.role}
            onChange={(r) => set('role', r)}
            hint={
              draft.role === 'Owner'
                ? 'Full access, including these settings and your figures.'
                : draft.role === 'Manager'
                ? 'Sends documents and sees what is outstanding.'
                : draft.role === 'Staff'
                ? 'Sends documents only — the day-to-day receipt handler.'
                : 'A role of your own. Set what they can do below.'
            }
          />

          <div className="flex flex-col gap-2">
            <Toggle
              label="Can send documents"
              hint="Upload and photograph paperwork for the business."
              value={draft.canUpload}
              onChange={(v) => set('canUpload', v)}
            />
            <Toggle
              label="Can see totals"
              hint="Amounts and what is outstanding. Leave off for staff photographing receipts."
              value={draft.canSeeTotals}
              onChange={(v) => set('canSeeTotals', v)}
            />
          </div>

          {problem && <p className="text-[13px] text-amber-400 font-semibold">{problem}</p>}
        </div>

        <div className="p-4 bg-[#202026]/50 flex items-center gap-3 justify-end flex-wrap">
          {!isNew && (
            <button
              onClick={onRemove}
              disabled={lastOwner}
              title={lastOwner ? 'Make someone else an Owner first' : 'Remove this person'}
              className="mr-auto flex items-center gap-2 px-4 py-2.5 rounded-full text-[13px] font-bold text-zinc-400 hover:text-red-400 disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:text-zinc-400 transition-colors"
            >
              <Trash2 size={14} />
              Remove
            </button>
          )}
          <button
            onClick={onClose}
            className="px-5 py-2.5 rounded-full text-[13px] font-bold text-zinc-400 hover:text-white transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={() => onSave({ ...draft, name, email })}
            disabled={!!problem}
            className="flex items-center gap-2 px-6 py-2.5 rounded-full text-[13px] font-bold text-white bg-[#14e3c4] hover:bg-[#0fcbaf] disabled:opacity-40 disabled:cursor-not-allowed transition-colors shadow-[0_0_15px_rgba(20,227,196,0.25)]"
          >
            {isNew ? 'Send invite' : 'Save'}
          </button>
        </div>
      </motion.div>
    </div>
  );
}

/**
 * The business's own details. Held as a draft with an explicit Save rather
 * than written on every keystroke: these four fields are how the accountant
 * addresses the business and how chases and sign-in codes reach it, so a
 * half-typed mobile should never be the live value — and an audit entry per
 * character is noise, not a record.
 */
function BusinessDetailsPanel({ account, onSave }: {
  account: BusinessAccount;
  onSave: (patch: Partial<BusinessAccount>, label: string) => void;
}) {
  const [draft, setDraft] = useState({
    businessName: account.businessName,
    contactName: account.contactName,
    email: account.email,
    mobile: account.mobile,
  });
  const [saved, setSaved] = useState(false);

  const set = <K extends keyof typeof draft>(k: K, v: (typeof draft)[K]) => {
    setDraft({ ...draft, [k]: v });
    setSaved(false);
  };

  const changed = (Object.keys(draft) as (keyof typeof draft)[]).filter((k) => draft[k].trim() !== account[k]);
  const dirty = changed.length > 0;

  const problem = !draft.businessName.trim()
    ? 'Your business needs a name — it is what your accountant sees on everything you send.'
    : !draft.mobile.trim()
    ? 'A mobile is required. It is where document requests and sign-in codes go.'
    : draft.email.trim() && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(draft.email.trim())
    ? 'That email does not look right.'
    : '';

  return (
    <Panel title="Your business" subtitle="Shown to your accountant on everything you send">
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <Field label="Business name" value={draft.businessName} onChange={(v) => set('businessName', v)} placeholder="American Burger Ltd" />
        <Field label="Main contact" value={draft.contactName} onChange={(v) => set('contactName', v)} placeholder="John Doe" />
        <Field label="Email" value={draft.email} onChange={(v) => set('email', v)} placeholder="john@americanburger.co.uk" />
        <Field label="Mobile" value={draft.mobile} onChange={(v) => set('mobile', v)} placeholder="+44 7700 900123" />
      </div>

      <p className="text-[12px] text-zinc-500 leading-relaxed mt-4">
        Your mobile is the one that matters — document requests and your sign-in codes both go there, and neither
        needs an app or a password.
      </p>

      {problem && <p className="text-[13px] text-amber-400 font-semibold mt-3">{problem}</p>}

      <div className="flex items-center gap-3 mt-5 flex-wrap">
        <button
          onClick={() => {
            onSave(
              {
                businessName: draft.businessName.trim(),
                contactName: draft.contactName.trim(),
                email: draft.email.trim(),
                mobile: draft.mobile.trim(),
              },
              changed.join(', '),
            );
            setSaved(true);
          }}
          disabled={!dirty || !!problem}
          className="px-6 py-2.5 rounded-full text-[13px] font-bold text-white bg-[#14e3c4] hover:bg-[#0fcbaf] disabled:opacity-40 disabled:cursor-not-allowed transition-colors shadow-[0_0_15px_rgba(20,227,196,0.25)]"
        >
          Save changes
        </button>
        {dirty && (
          <button
            onClick={() => { setDraft({ businessName: account.businessName, contactName: account.contactName, email: account.email, mobile: account.mobile }); setSaved(false); }}
            className="px-5 py-2.5 rounded-full text-[13px] font-bold text-zinc-400 hover:text-white transition-colors"
          >
            Discard
          </button>
        )}
        {/* Say which fields are pending, so Save is never a guess. */}
        {dirty ? (
          <span className="text-[12px] text-zinc-500 font-semibold">
            Unsaved: {changed.join(', ')}
          </span>
        ) : saved ? (
          <span className="text-[12px] text-[#14e3c4] font-semibold">Saved.</span>
        ) : null}
      </div>
    </Panel>
  );
}

function Panel({ title, subtitle, children }: { title: string; subtitle?: string; children: React.ReactNode }) {
  return (
    <section className="rounded-[28px] border border-white/5 bg-[#16161a] p-6">
      <div className="mb-4">
        <h2 className="text-[15px] font-bold text-white tracking-tight">{title}</h2>
        {subtitle && <p className="text-[12px] text-zinc-500 mt-1">{subtitle}</p>}
      </div>
      {children}
    </section>
  );
}

/** The client's side of a connection: this is the only place it can be made. */
function ConnectRow({
  name,
  detail,
  connected,
  onConnect,
  actionLabel = 'Connect',
  doneLabel = 'Connected',
}: {
  name: string;
  detail: string;
  connected: boolean;
  onConnect: () => void;
  /** Registering the company record is not a "connect", so both words vary. */
  actionLabel?: string;
  doneLabel?: string;
}) {
  return (
    <div className="flex items-center justify-between gap-4 p-4 border border-white/5 rounded-2xl bg-[#0a0a0c]/60 shadow-inner">
      <div className="min-w-0">
        <div className="text-sm font-bold text-white">{name}</div>
        <div className="text-[12px] text-zinc-500">{detail}</div>
      </div>
      {connected ? (
        <Pill tone="green">{doneLabel}</Pill>
      ) : (
        <button
          onClick={onConnect}
          className="shrink-0 px-4 py-2 rounded-full text-[13px] font-bold text-white bg-[#14e3c4] hover:bg-[#0fcbaf] transition-colors shadow-[0_0_12px_rgba(20,227,196,0.25)]"
        >
          {actionLabel}
        </button>
      )}
    </div>
  );
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4 py-2.5 border-b border-white/5 last:border-0">
      <span className="text-[13px] text-zinc-400">{label}</span>
      <span className="text-[13px] text-zinc-200 text-right">{value}</span>
    </div>
  );
}

function Field({ label, value, onChange, placeholder }: { label: string; value: string; onChange: (v: string) => void; placeholder?: string }) {
  return (
    <div>
      <div className="text-[11px] font-bold text-zinc-500 uppercase tracking-widest mb-2">{label}</div>
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="w-full bg-[#0a0a0c] border border-white/5 rounded-xl px-4 py-2.5 text-sm text-white placeholder:text-zinc-600 focus:outline-none focus:border-[#14e3c4] transition-colors"
      />
    </div>
  );
}

function Toggle({ label, hint, value, onChange }: { label: string; hint?: string; value: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      onClick={() => onChange(!value)}
      className="bg-[#0a0a0c]/60 border border-white/5 rounded-2xl p-4 flex items-center justify-between gap-4 shadow-inner hover:border-white/10 transition-colors text-left"
    >
      <span>
        <span className="block text-sm font-bold text-white">{label}</span>
        {hint && <span className="block text-[12px] text-zinc-500 mt-0.5">{hint}</span>}
      </span>
      <span className={`w-11 h-6 rounded-full shrink-0 transition-colors relative ${value ? 'bg-[#14e3c4]' : 'bg-white/10'}`}>
        <span className={`absolute top-1 w-4 h-4 rounded-full bg-white transition-all ${value ? 'left-6' : 'left-1'}`} />
      </span>
    </button>
  );
}

