import { useRef, useState } from 'react';
import { Building2, ChevronRight, Link2, Smartphone, ImagePlus, X, ArrowLeft, Send, PencilLine, Check } from 'lucide-react';
import { motion } from 'motion/react';
import { useAppContext } from '../../context/AppContext';
import { ReviewGate, ReviewRows, ReviewSection } from './ReviewGate';
import { Pill } from './DataTable';
import type { SetupTask } from '../../lib/types';

const STEPS = ['Identity', 'Tax', 'Contact', 'Bookkeeping', 'Context', 'Client setup'];

/**
 * Who fills the record in. Either way the client connects the accounting
 * software and the bank themselves — those need their own login at the
 * provider, which the practice never holds.
 */
type IntakeMode = 'invite' | 'practice';

/** Both paths send the same link; the invite path just asks for more on it. */
const PRACTICE_TASKS: SetupTask[] = ['ledger', 'bank'];
const INVITE_TASKS: SetupTask[] = ['profile', 'ledger', 'bank'];

/**
 * A picker's options. Typed non-empty because the form takes its defaults off
 * the head of each list, and these lists are literals a few lines below —
 * emptiness is not a state the form can ever be handed.
 */
type Options = [string, ...string[]];

const INDUSTRIES: Options = ['Hospitality & Food', 'Software & IT', 'Architecture', 'Retail', 'Construction', 'Professional Services'];
const COMPANY_TYPES: Options = [
  'Private limited company (Ltd)',
  'Limited liability partnership (LLP)',
  'Partnership',
  'Sole trader',
  'Public limited company (PLC)',
  'Charity / CIC',
];
const VAT_SCHEMES: Options = ['Standard', 'Flat rate', 'Cash accounting', 'Not registered'];
/** Fixed at three, and the form opens on the last of them. */
const FREQUENCIES: [string, string, string] = ['Weekly', 'Monthly', 'Quarterly'];

/**
 * Consolidated client intake (PRD section 5.1) — the same component the sidebar
 * uses, rendered inline in chat. Creation goes through Review -> Approve.
 */
export function ClientIntakeForm({ defaultName = '' }: { defaultName?: string }) {
  const [mode, setMode] = useState<IntakeMode | null>(null);

  if (mode === null) return <ModeChooser onPick={setMode} />;
  if (mode === 'invite') return <InviteIntake defaultName={defaultName} onBack={() => setMode(null)} />;
  return <PracticeIntake defaultName={defaultName} onBack={() => setMode(null)} />;
}

/** The card chrome all three screens share. */
function Shell({
  title,
  subtitle,
  onBack,
  children,
}: {
  title: string;
  subtitle: string;
  onBack?: () => void;
  children: React.ReactNode;
}) {
  return (
    <div className="w-full max-w-xl border border-white/5 rounded-[32px] bg-card shadow-2xl overflow-hidden flex flex-col">
      <div className="p-6 flex items-center gap-4 border-b border-white/5">
        <div className="w-12 h-12 rounded-2xl bg-raised flex items-center justify-center text-white shrink-0 border border-white/5 shadow-inner">
          <Building2 size={20} />
        </div>
        <div className="min-w-0 flex-1">
          <h3 className="font-sans font-bold text-xl text-white tracking-tight truncate">{title}</h3>
          <p className="text-[12px] text-zinc-500 mt-1 font-semibold uppercase tracking-wider">{subtitle}</p>
        </div>
        {onBack && (
          <button
            onClick={onBack}
            title="Choose a different way to add this client"
            className="shrink-0 flex items-center gap-1.5 px-3.5 py-2 rounded-full text-[12px] font-bold text-zinc-500 hover:text-white hover:bg-white/5 transition-colors"
          >
            <ArrowLeft size={14} />
            Change
          </button>
        )}
      </div>
      {children}
    </div>
  );
}

/**
 * The fork this whole form now opens on. The difference is only ever who types
 * the company record — the two connections below sit with the client either
 * way, so they are stated here rather than offered as a choice.
 */
function ModeChooser({ onPick }: { onPick: (m: IntakeMode) => void }) {
  return (
    <Shell title="Add new client" subtitle="Step 1 — how is this client set up?">
      <div className="p-6 flex flex-col gap-3">
        <ModeOption
          icon={Send}
          name="Send the client a link"
          detail="They register the company themselves. You give three things now — company, who is responsible, and their mobile — and the link asks them for the rest."
          bullets={['Three fields to send', 'Client fills in their own record', 'Fastest for you']}
          onClick={() => onPick('invite')}
        />
        <ModeOption
          icon={PencilLine}
          name="Register on their behalf"
          detail="You key the full record in now — identity, tax, contact, bookkeeping and trading context. Nothing is asked of the client except the two connections."
          bullets={['Six steps', 'You control every field', 'Best when you already hold the paperwork']}
          onClick={() => onPick('practice')}
        />

        <div className="flex items-start gap-3 p-4 rounded-2xl border border-white/5 bg-ground/60 shadow-inner mt-1">
          <Link2 size={16} className="text-zinc-500 mt-0.5 shrink-0" />
          <div className="min-w-0">
            <div className="text-[13px] font-bold text-white">
              Either way, the client connects the accounting software and the bank
            </div>
            <p className="text-[12px] text-zinc-500 mt-1 leading-relaxed">
              Both need their own login at the provider, which the practice never holds. One SMS link covers whatever
              is outstanding.
            </p>
          </div>
        </div>
      </div>
    </Shell>
  );
}

function ModeOption({
  icon: Icon,
  name,
  detail,
  bullets,
  onClick,
}: {
  icon: typeof Send;
  name: string;
  detail: string;
  bullets: string[];
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className="group text-left p-5 rounded-2xl border border-white/5 bg-ground/60 shadow-inner hover:border-brand/40 hover:bg-ground transition-all"
    >
      <div className="flex items-start gap-4">
        <div className="w-10 h-10 rounded-xl bg-raised border border-white/5 flex items-center justify-center text-zinc-400 shrink-0 group-hover:text-brand transition-colors">
          <Icon size={17} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <div className="text-sm font-bold text-white">{name}</div>
            <ChevronRight
              size={15}
              strokeWidth={2.5}
              className="text-zinc-600 group-hover:text-brand group-hover:translate-x-0.5 transition-all"
            />
          </div>
          <p className="text-[12px] text-zinc-500 mt-1.5 leading-relaxed">{detail}</p>
          <div className="flex flex-wrap gap-x-4 gap-y-1 mt-3">
            {bullets.map((b) => (
              <span key={b} className="flex items-center gap-1.5 text-[11px] font-semibold text-zinc-600">
                <Check size={12} strokeWidth={3} className="text-brand/70 shrink-0" />
                {b}
              </span>
            ))}
          </div>
        </div>
      </div>
    </button>
  );
}

/**
 * The invite path: the three things needed to address an SMS, and nothing else.
 * Everything the practice would otherwise key in is asked of the client on the
 * link, so asking for it here as well would only be a second guess at it.
 */
function InviteIntake({ defaultName, onBack }: { defaultName: string; onBack: () => void }) {
  const { addClient, sendOnboardingLink } = useAppContext();
  const [form, setForm] = useState({ name: defaultName, contactName: '', mobile: '' });

  const set = <K extends keyof typeof form>(key: K, value: (typeof form)[K]) =>
    setForm((f) => ({ ...f, [key]: value }));

  const name = form.name.trim();
  const contactName = form.contactName.trim();
  const mobile = form.mobile.trim();
  const missing = [
    ...(name ? [] : ['company name']),
    ...(contactName ? [] : ['responsible person']),
    ...(mobile ? [] : ['mobile number']),
  ];
  const ready = missing.length === 0;

  return (
    <Shell title={name || 'Add new client'} subtitle="Invite — the client registers themselves" onBack={onBack}>
      <div className="p-6">
        <motion.div initial={{ opacity: 0, x: 10 }} animate={{ opacity: 1, x: 0 }} className="flex flex-col gap-4">
          <p className="text-[13px] text-zinc-500 leading-relaxed">
            Three things — enough to address the SMS and know whose record it is. The client supplies their own
            identity, tax and trading detail on the link, so nothing here is a guess you would have to correct later.
          </p>
          <Field label="Company name" value={form.name} onChange={(v) => set('name', v)} placeholder="American Burger Ltd" />
          <Field
            label="Responsible person"
            value={form.contactName}
            onChange={(v) => set('contactName', v)}
            placeholder="John Doe"
            hint="Whoever signs off — the link and every later chase go to them"
          />
          <Field label="Mobile number" value={form.mobile} onChange={(v) => set('mobile', v)} placeholder="+44 7700 900123" />

          <div className="flex items-start gap-3 p-4 rounded-2xl border border-white/5 bg-ground/60 shadow-inner">
            <Smartphone size={16} className="text-zinc-500 mt-0.5 shrink-0" />
            <div className="min-w-0">
              <div className="text-[13px] font-bold text-white">
                {ready ? `One SMS link to ${mobile}` : 'One SMS link once the three fields are in'}
              </div>
              <p className="text-[12px] text-zinc-500 mt-1 leading-relaxed">
                It asks them to register the company, then connect their accounting software and bank. Opens in any
                phone browser, expires in 72 hours, and never shares their credentials with you.
              </p>
            </div>
          </div>

          {!ready && (
            <p className="text-[13px] text-amber-400 font-semibold">
              Still needed before the link can go: {missing.join(', ')}.
            </p>
          )}
        </motion.div>
      </div>

      <div className="p-4 bg-raised/50">
        {/* No review card until the link is actually sendable — approving a
            half-filled invite would create a record and queue an SMS to
            nobody. The three fields are the whole form, so this is not a
            hidden gate. */}
        {!ready ? (
          <div className="flex items-center gap-3 px-5 py-3.5 rounded-full bg-ground/60 border border-white/5 text-[13px] font-bold text-zinc-500">
            <Send size={15} className="shrink-0" />
            Add the {missing.join(', ')} to review this invite
          </div>
        ) : (
          <ReviewGate
            icon={Send}
            title={`Invite ${name} to register`}
            subtitle="Client-registered • nothing keyed in by the practice"
            detail={
              <>
                <ReviewSection title="What you are sending">
                  <ReviewRows
                    rows={[
                      { label: 'Company name', value: name },
                      { label: 'Responsible person', value: contactName },
                      { label: 'Goes to', value: mobile },
                      { label: 'Link expires', value: 'in 72 hours' },
                    ]}
                  />
                </ReviewSection>
                <ReviewSection title="What the client does on the link">
                  <ReviewRows
                    rows={[
                      { label: 'Company details', value: <Pill tone="amber">Client registers</Pill> },
                      { label: 'Accounting software', value: <Pill tone="amber">Client connects</Pill> },
                      { label: 'Bank feed', value: <Pill tone="amber">Client connects</Pill> },
                    ]}
                  />
                  <p className="text-[12px] text-zinc-500 leading-relaxed mt-3">
                    Approving creates the record and queues the SMS — it does not register or connect anything. The
                    client shows as awaiting registration until they finish.
                  </p>
                </ReviewSection>
              </>
            }
            approveLabel="Approve & send link"
            successMessage={`${name} created and one setup SMS queued to ${mobile} — they register the company and connect their accounting software and bank themselves.`}
            auditAction="Invited client to register"
            auditScope={name}
            onApprove={() => {
              const client = {
                id: `client-${Date.now()}`,
                name,
                // Everything below comes back from the client on the link.
                industry: '—',
                health: 100,
                missingDocs: 0,
                toReview: 0,
                deadline: '—',
                xeroConnected: false,
                bankConnected: false,
                contactName,
                mobile,
                awaitingRegistration: true,
              };
              addClient(client);
              sendOnboardingLink(client, INVITE_TASKS);
            }}
          />
        )}
      </div>
    </Shell>
  );
}

/** The full six-step record, keyed in by the practice. */
function PracticeIntake({ defaultName, onBack }: { defaultName: string; onBack: () => void }) {
  const { addClient, sendOnboardingLink } = useAppContext();
  const [step, setStep] = useState(0);

  const [form, setForm] = useState({
    name: defaultName,
    tradingName: '',
    crn: '',
    industry: INDUSTRIES[0],
    companyType: COMPANY_TYPES[0],
    logoDataUrl: '',
    country: 'United Kingdom',
    currency: 'GBP',
    yearEnd: '31 March',
    vatRegistered: true,
    vatNumber: '',
    vatScheme: VAT_SCHEMES[0],
    contactName: '',
    contactRole: 'Director',
    mobile: '',
    email: '',
    whatsappIntake: true,
    managedBy: 'Practice',
    frequency: FREQUENCIES[2],
    deadline: '',
    assignee: 'You',
    sells: '',
    suppliers: '',
    cards: '',
    unusual: '',
  });

  const set = <K extends keyof typeof form>(key: K, value: (typeof form)[K]) => setForm((f) => ({ ...f, [key]: value }));

  const isLast = step === STEPS.length - 1;

  const hasMobile = form.mobile.trim().length > 0;

  return (
    <Shell
      title={form.name.trim() || 'Add new client'}
      subtitle={`Step ${step + 1} of ${STEPS.length} — ${STEPS[step]}`}
      onBack={onBack}
    >
      {/* Step rail */}
      <div className="px-6 pt-5 flex items-center gap-1.5">
        {STEPS.map((s, i) => (
          <button
            key={s}
            onClick={() => setStep(i)}
            title={s}
            className={`h-1 flex-1 rounded-full transition-all ${i <= step ? 'bg-brand' : 'bg-white/10 hover:bg-white/20'}`}
          />
        ))}
      </div>

      <div className="p-6">
        <motion.div key={step} initial={{ opacity: 0, x: 10 }} animate={{ opacity: 1, x: 0 }} className="flex flex-col gap-4">
          {step === 0 && (
            <>
              <LogoPicker value={form.logoDataUrl} onChange={(v) => set('logoDataUrl', v)} name={form.name} />
              <Field label="Legal name" value={form.name} onChange={(v) => set('name', v)} placeholder="American Burger Ltd" />
              <div className="grid grid-cols-2 gap-4">
                <Field label="Trading name" value={form.tradingName} onChange={(v) => set('tradingName', v)} placeholder="American Burger" />
                <Field
                  label="CRN"
                  value={form.crn}
                  onChange={(v) => set('crn', v)}
                  placeholder="12345678"
                  hint="Auto-fetched from Companies House"
                />
              </div>
              <Select label="Company type" value={form.companyType} onChange={(v) => set('companyType', v)} options={COMPANY_TYPES} />
              <div className="grid grid-cols-2 gap-4">
                <Select label="Industry" value={form.industry} onChange={(v) => set('industry', v)} options={INDUSTRIES} />
                <Field label="Year-end" value={form.yearEnd} onChange={(v) => set('yearEnd', v)} placeholder="31 March" />
              </div>
              <div className="grid grid-cols-2 gap-4">
                <Field label="Country" value={form.country} onChange={(v) => set('country', v)} placeholder="United Kingdom" />
                <Field label="Base currency" value={form.currency} onChange={(v) => set('currency', v)} placeholder="GBP" />
              </div>
            </>
          )}

          {step === 1 && (
            <>
              <Toggle
                label="VAT registered"
                hint="VAT numbers are validated against HMRC."
                value={form.vatRegistered}
                onChange={(v) => set('vatRegistered', v)}
              />
              {form.vatRegistered && (
                <div className="grid grid-cols-2 gap-4">
                  <Field label="VAT number" value={form.vatNumber} onChange={(v) => set('vatNumber', v)} placeholder="GB 412 8875 21" />
                  <Select label="VAT scheme" value={form.vatScheme} onChange={(v) => set('vatScheme', v)} options={VAT_SCHEMES} />
                </div>
              )}
              <Select label="Reporting frequency" value={form.frequency} onChange={(v) => set('frequency', v)} options={FREQUENCIES} />
            </>
          )}

          {step === 2 && (
            <>
              <p className="text-[13px] text-zinc-500 leading-relaxed">
                The mobile number is required — it drives SMS chasing and OTP onboarding. The client never installs an app.
              </p>
              <div className="grid grid-cols-2 gap-4">
                <Field label="Contact name" value={form.contactName} onChange={(v) => set('contactName', v)} placeholder="John Doe" />
                <Field label="Role" value={form.contactRole} onChange={(v) => set('contactRole', v)} placeholder="Director" />
              </div>
              <Field label="Mobile number (required)" value={form.mobile} onChange={(v) => set('mobile', v)} placeholder="+44 7700 900123" />
              <Field label="Email" value={form.email} onChange={(v) => set('email', v)} placeholder="john@americanburger.co.uk" />
              <Toggle
                label="Submits documents via WhatsApp"
                hint="Intake only — chasing is always SMS."
                value={form.whatsappIntake}
                onChange={(v) => set('whatsappIntake', v)}
              />
            </>
          )}

          {step === 3 && (
            <>
              <div className="grid grid-cols-2 gap-4">
                <Select label="Managed by" value={form.managedBy} onChange={(v) => set('managedBy', v)} options={['Practice', 'Client']} />
                <Select label="Frequency" value={form.frequency} onChange={(v) => set('frequency', v)} options={FREQUENCIES} />
              </div>
              <div className="grid grid-cols-2 gap-4">
                <Field label="Next deadline" value={form.deadline} onChange={(v) => set('deadline', v)} placeholder="12 Aug 2026" />
                <Field label="Assignee" value={form.assignee} onChange={(v) => set('assignee', v)} placeholder="You" />
              </div>
            </>
          )}

          {step === 4 && (
            <>
              <p className="text-[13px] text-zinc-500 leading-relaxed">
                This feeds the AI directly — it is what stops new-vendor guesses going wrong.
              </p>
              <Field label="What the business sells" value={form.sells} onChange={(v) => set('sells', v)} placeholder="Burgers, fries, shakes — dine-in and delivery" />
              <Field label="Typical suppliers" value={form.suppliers} onChange={(v) => set('suppliers', v)} placeholder="Bidfood, Brakes, Uber Eats, Costco" />
              <Field label="Company cards / employee spending" value={form.cards} onChange={(v) => set('cards', v)} placeholder="2 Amex cards held by managers" />
              <Field label="Expected unusual transactions" value={form.unusual} onChange={(v) => set('unusual', v)} placeholder="Quarterly equipment leases" />
            </>
          )}

          {step === 5 && (
            <>
              <p className="text-[13px] text-zinc-500 leading-relaxed">
                You can key in everything above yourself. These two you cannot — both need the client's own login at
                the provider, which the practice never holds. They go out on one SMS link.
              </p>
              <SetupRequest
                name="Accounting software"
                detail="Xero, QuickBooks, Sage or FreeAgent — chart of accounts and tax rates sync both ways"
              />
              <SetupRequest
                name="Bank feed (open banking)"
                detail="Read-only — until it is live the client is on the statement-upload fallback"
              />

              <div className="flex items-start gap-3 p-4 rounded-2xl border border-white/5 bg-ground/60 shadow-inner">
                <Smartphone size={16} className="text-zinc-500 mt-0.5 shrink-0" />
                <div className="min-w-0">
                  <div className="text-[13px] font-bold text-white">
                    One SMS link to {form.mobile.trim() || 'the client'}
                  </div>
                  <p className="text-[12px] text-zinc-500 mt-1 leading-relaxed">
                    Opens in any phone browser, expires in 72 hours, and never shares their credentials with you.
                  </p>
                </div>
              </div>

              {!hasMobile && (
                <p className="text-[13px] text-amber-400 font-semibold">
                  No mobile number yet — add one on the Contact step or the setup link cannot be sent.
                </p>
              )}
            </>
          )}
        </motion.div>
      </div>

      {!isLast ? (
        <div className="p-4 bg-raised/50 flex justify-between items-center">
          <button
            onClick={() => setStep((s) => Math.max(s - 1, 0))}
            className={`px-5 py-2.5 text-sm font-bold text-zinc-400 hover:text-white hover:bg-white/5 rounded-full transition-colors ${
              step === 0 ? 'invisible' : ''
            }`}
          >
            Back
          </button>
          <button
            onClick={() => setStep((s) => Math.min(s + 1, STEPS.length - 1))}
            className="flex items-center gap-2 px-6 py-2.5 text-sm font-bold text-white bg-brand hover:bg-brand-hover rounded-full transition-all shadow-[0_0_15px_rgba(20,227,196,0.3)]"
          >
            Continue
            <ChevronRight size={16} strokeWidth={2.5} />
          </button>
        </div>
      ) : (
        <div className="p-4 bg-raised/50 flex flex-col gap-3">
          <button
            onClick={() => setStep((s) => Math.max(s - 1, 0))}
            className="self-start px-5 py-2.5 text-sm font-bold text-zinc-400 hover:text-white hover:bg-white/5 rounded-full transition-colors"
          >
            Back
          </button>
          <ReviewGate
            icon={Building2}
            title={`Create ${form.name.trim() || 'new client'}`}
            subtitle={`${form.industry} • ${form.managedBy}-managed`}
            detail={
              <>
                <ReviewSection title="Identity">
                  <ReviewRows
                    rows={[
                      { label: 'Legal name', value: form.name.trim() || '—' },
                      { label: 'Trading name', value: form.tradingName.trim() || '—' },
                      { label: 'CRN', value: form.crn.trim() || '—' },
                      { label: 'Company type', value: form.companyType },
                      { label: 'Industry', value: form.industry },
                      { label: 'Logo', value: form.logoDataUrl ? <Pill tone="blue">Uploaded</Pill> : 'None' },
                      { label: 'Year-end', value: form.yearEnd },
                      { label: 'Base currency', value: form.currency },
                    ]}
                  />
                </ReviewSection>
                <ReviewSection title="Tax">
                  <ReviewRows
                    rows={[
                      { label: 'VAT registered', value: form.vatRegistered ? 'Yes' : 'No' },
                      { label: 'VAT number', value: form.vatNumber.trim() || '—' },
                      { label: 'Scheme', value: form.vatScheme },
                      { label: 'Frequency', value: form.frequency },
                    ]}
                  />
                </ReviewSection>
                <ReviewSection title="Primary contact">
                  <ReviewRows
                    rows={[
                      { label: 'Name', value: `${form.contactName.trim() || '—'} (${form.contactRole})` },
                      { label: 'Mobile', value: form.mobile.trim() || '—' },
                      { label: 'Email', value: form.email.trim() || '—' },
                      { label: 'WhatsApp intake', value: form.whatsappIntake ? <Pill tone="blue">On</Pill> : 'Off' },
                    ]}
                  />
                </ReviewSection>
                <ReviewSection title="Client setup — one SMS link">
                  <ReviewRows
                    rows={[
                      { label: 'Accounting software', value: <Pill tone="amber">Client connects</Pill> },
                      { label: 'Bank feed', value: <Pill tone="amber">Client connects</Pill> },
                      { label: 'Link goes to', value: form.mobile.trim() || '—' },
                      { label: 'Link expires', value: 'in 72 hours' },
                    ]}
                  />
                  <p className="text-[12px] text-zinc-500 leading-relaxed mt-3">
                    Nothing is connected on approval. Both connections need the client's own login at the provider, so
                    they stay disconnected until the client completes the link.
                  </p>
                </ReviewSection>
                {!form.mobile.trim() && (
                  <p className="text-[13px] text-amber-400 font-semibold">
                    No mobile number — the setup link and SMS chasing will not work until one is added.
                  </p>
                )}
              </>
            }
            approveLabel="Approve & create"
            successMessage={`${form.name.trim() || 'Client'} created. One setup SMS queued to ${
              form.mobile.trim() || 'their mobile'
            } — they connect the accounting software and bank themselves.`}
            auditAction="Created client"
            auditScope={form.name.trim() || 'unnamed client'}
            onApprove={() => {
              const client = {
                id: `client-${Date.now()}`,
                name: form.name.trim() || 'New client',
                industry: form.industry,
                health: 100,
                missingDocs: 0,
                toReview: 0,
                deadline: form.deadline.trim() || '—',
                // Always false at creation: the practice cannot connect these.
                xeroConnected: false,
                bankConnected: false,
                contactName: form.contactName.trim(),
                mobile: form.mobile.trim(),
                vatNumber: form.vatNumber.trim(),
                companyType: form.companyType,
                logoDataUrl: form.logoDataUrl || undefined,
              };
              addClient(client);
              sendOnboardingLink(client, PRACTICE_TASKS);
            }}
          />
        </div>
      )}
    </Shell>
  );
}

function Field({
  label,
  value,
  onChange,
  placeholder,
  hint,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  hint?: string;
}) {
  return (
    <div>
      <div className="text-[11px] font-bold text-zinc-500 uppercase tracking-widest mb-2">{label}</div>
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="w-full bg-ground border border-white/5 rounded-xl px-4 py-2.5 text-sm text-white placeholder:text-zinc-600 focus:outline-none focus:border-brand transition-colors"
      />
      {hint && <div className="text-[11px] text-zinc-600 mt-1.5 font-medium">{hint}</div>}
    </div>
  );
}

function Select({
  label,
  value,
  onChange,
  options,
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

function Toggle({
  label,
  hint,
  value,
  onChange,
}: {
  label: string;
  hint?: string;
  value: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <button
      onClick={() => onChange(!value)}
      className="bg-ground/60 border border-white/5 rounded-2xl p-4 flex items-center justify-between gap-4 shadow-inner hover:border-white/10 transition-colors text-left"
    >
      <div>
        <div className="text-sm font-bold text-white">{label}</div>
        {hint && <div className="text-[12px] text-zinc-500 mt-0.5">{hint}</div>}
      </div>
      <div className={`w-11 h-6 rounded-full shrink-0 transition-colors relative ${value ? 'bg-brand' : 'bg-white/10'}`}>
        <div className={`absolute top-1 w-4 h-4 rounded-full bg-white transition-all ${value ? 'left-6' : 'left-1'}`} />
      </div>
    </button>
  );
}

/**
 * A connection only the client can make. Deliberately not a toggle: the
 * practice has no credentials at either provider, so "skip" would only ever
 * mean "ask later" — and the record would still be unusable until it happened.
 */
function SetupRequest({ name, detail }: { name: string; detail: string }) {
  return (
    <div className="flex items-center justify-between gap-4 p-4 border border-white/5 rounded-2xl bg-ground/60 shadow-inner">
      <div className="flex items-center gap-3 min-w-0">
        <div className="w-9 h-9 rounded-xl bg-raised border border-white/5 flex items-center justify-center text-zinc-400 shrink-0">
          <Link2 size={16} />
        </div>
        <div className="min-w-0">
          <div className="text-sm font-bold text-white">{name}</div>
          <div className="text-[12px] text-zinc-500 truncate">{detail}</div>
        </div>
      </div>
      <span className="shrink-0 px-4 py-2 rounded-full text-[12px] font-bold text-brand bg-brand/10 border border-brand/20">
        Client connects
      </span>
    </div>
  );
}

/** Logo upload — held as a data URI so it survives without a file server. */
function LogoPicker({ value, onChange, name }: { value: string; onChange: (v: string) => void; name: string }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [error, setError] = useState('');

  const pick = (file?: File) => {
    if (!file) return;
    if (!file.type.startsWith('image/')) {
      setError('That is not an image file.');
      return;
    }
    if (file.size > 2 * 1024 * 1024) {
      setError('Logos must be under 2MB.');
      return;
    }
    setError('');
    const reader = new FileReader();
    reader.onload = () => onChange(String(reader.result));
    reader.readAsDataURL(file);
  };

  return (
    <div>
      <div className="text-[11px] font-bold text-zinc-500 uppercase tracking-widest mb-2">Logo</div>
      <div className="flex items-center gap-4">
        <div className="w-16 h-16 rounded-2xl bg-ground border border-white/5 flex items-center justify-center overflow-hidden shrink-0 shadow-inner">
          {value ? (
            <img src={value} alt="" className="w-full h-full object-cover" />
          ) : (
            <span className="font-sans text-2xl font-bold text-zinc-600">{name.trim().charAt(0) || '—'}</span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => inputRef.current?.click()}
            className="flex items-center gap-2 px-4 py-2 rounded-full text-[13px] font-bold text-zinc-300 border border-white/10 hover:text-white hover:border-white/25 transition-colors"
          >
            <ImagePlus size={15} />
            {value ? 'Replace' : 'Upload'}
          </button>
          {value && (
            <button
              onClick={() => onChange('')}
              className="flex items-center gap-1.5 px-3 py-2 rounded-full text-[13px] font-bold text-zinc-500 hover:text-white transition-colors"
            >
              <X size={14} />
              Remove
            </button>
          )}
        </div>
        <input
          ref={inputRef}
          type="file"
          accept="image/*"
          className="hidden"
          onChange={(e) => {
            pick(e.target.files?.[0]);
            e.target.value = '';
          }}
        />
      </div>
      {error && <div className="text-[11px] text-amber-400 mt-2 font-semibold">{error}</div>}
    </div>
  );
}
