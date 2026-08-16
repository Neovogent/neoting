import {
  Settings as SettingsIcon, Link2, ScanLine, Wand2, Send, CheckCircle, Download,
  List, Sparkles, MessageSquare, ShieldCheck, Building2, Sun, Moon,
} from 'lucide-react';
import { motion } from 'motion/react';
import { useAppContext } from '../context/AppContext';
import { fromSlug, slug, useSegment } from '../lib/router';
import { Field, Toggle } from './ApprovalsView';
import { LinkTtlField } from './ChasesView';
import { Pill } from '../components/DynamicComponents/DataTable';
import { OPTIONAL_MANDATORY } from '../lib/selectors';

const SECTIONS = [
  { key: 'Profile', icon: Building2 },
  { key: 'Connections', icon: Link2 },
  { key: 'Extraction', icon: ScanLine },
  { key: 'Automation', icon: Wand2 },
  { key: 'Chasing', icon: Send },
  { key: 'Approvals', icon: CheckCircle },
  { key: 'Exports', icon: Download },
  { key: 'Lists', icon: List },
  { key: 'AI Guidance', icon: Sparkles },
  { key: 'Communication', icon: MessageSquare },
  { key: 'Security', icon: ShieldCheck },
] as const;

type Section = (typeof SECTIONS)[number]['key'];

export function SettingsView() {
  const {
    settings, updateSettings, clients, accounts, rules, chasePolicy, setChasePolicy,
    matchSettings, setMatchSettings, mandatoryFields, setMandatoryFields,
    approvalWorkflows, routingRules, setActiveTab, logAudit,
  } = useAppContext();

  // The sub-tab is the second path segment, so every one has a link.
  const [sectionSlug, setSectionSlug] = useSegment(1);
  const section: Section = fromSlug(sectionSlug, SECTIONS.map((x) => x.key)) ?? 'Profile';
  const setSection = (next: Section) => setSectionSlug(next === 'Profile' ? null : slug(next));

  const save = (patch: Parameters<typeof updateSettings>[0], label: string) => {
    updateSettings(patch);
    logAudit({ action: 'Changed setting', scope: label, reviewOpened: true });
  };

  return (
    <div className="flex-1 flex min-w-0 bg-ground h-full overflow-hidden">
      <aside className="w-64 shrink-0 border-r border-white/5 flex flex-col py-8 px-4 overflow-y-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        <div className="px-4 mb-6 flex items-center gap-3">
          <SettingsIcon size={20} className="text-zinc-400" />
          <h1 className="font-sans text-xl font-semibold text-white tracking-tight">Settings</h1>
        </div>
        <nav className="flex flex-col gap-1">
          {SECTIONS.map((s) => (
            <button
              key={s.key}
              onClick={() => setSection(s.key)}
              className={`px-4 py-2.5 rounded-xl text-left text-sm font-semibold transition-all flex items-center gap-3 ${
                section === s.key ? 'bg-card text-white border border-white/5' : 'text-zinc-400 hover:text-white hover:bg-card/50 border border-transparent'
              }`}
            >
              <s.icon size={15} className={section === s.key ? 'text-brand' : ''} />
              {s.key}
            </button>
          ))}
        </nav>
        <p className="px-4 mt-8 text-[11px] text-zinc-600 leading-relaxed">
          No mileage, no subscription pricing and no ledger Data Health — all out of scope for this edition.
        </p>
      </aside>

      <div className="flex-1 overflow-y-auto p-10 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        <motion.div key={section} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} className="max-w-2xl flex flex-col gap-6">
          {section === 'Profile' && (
            <>
              <Panel title="Practice profile" subtitle="Identity, tax details and year-end">
                <div className="grid grid-cols-2 gap-4">
                  <Field label="Practice name" value={settings.practiceName} onChange={(v) => save({ practiceName: v }, 'practice name')} />
                  <Field label="Country" value={settings.country} onChange={(v) => save({ country: v }, 'country')} />
                  <Field label="Base currency" value={settings.baseCurrency} onChange={(v) => save({ baseCurrency: v }, 'base currency')} />
                  <Field label="Year-end" value={settings.yearEnd} onChange={(v) => save({ yearEnd: v }, 'year-end')} />
                </div>
              </Panel>

              <Panel title="Appearance" subtitle="Applies to this device">
                <div className="flex items-center gap-2">
                  {([
                    { value: 'dark' as const, label: 'Dark', icon: Moon },
                    { value: 'light' as const, label: 'Light', icon: Sun },
                  ]).map((opt) => (
                    <button
                      key={opt.value}
                      onClick={() => save({ theme: opt.value }, `${opt.label.toLowerCase()} theme`)}
                      className={`flex-1 flex items-center justify-center gap-2 px-5 py-3 rounded-2xl border text-[13px] font-bold transition-all ${
                        settings.theme === opt.value
                          ? 'bg-brand/10 border-brand/40 text-brand'
                          : 'bg-ground border-white/5 text-zinc-400 hover:text-white hover:border-white/15'
                      }`}
                    >
                      <opt.icon size={15} />
                      {opt.label}
                    </button>
                  ))}
                </div>
                <p className="text-[12px] text-zinc-500 leading-relaxed mt-4">
                  Light mode is also on the sidebar, at the bottom. The business portal follows the same choice.
                </p>
              </Panel>
            </>
          )}

          {section === 'Connections' && (
            <>
              <Panel title="Accounting software" subtitle="Adapter priority: Xero → QuickBooks → Sage → FreeAgent">
                <div className="flex flex-col gap-2">
                  {clients.map((c) => (
                    <Row key={c.id} label={c.name} value={c.xeroConnected ? <Pill tone="green">Xero connected</Pill> : <Pill tone="red">Not connected</Pill>} />
                  ))}
                </div>
              </Panel>
              <Panel title="Bank feeds" subtitle="Consent expiry and fallback">
                <div className="flex flex-col gap-2">
                  {accounts.slice(0, 6).map((a) => (
                    <Row
                      key={a.id}
                      label={`${a.clientName} — ${a.bankName} ••${a.last4}`}
                      value={a.status === 'live' ? <Pill tone="green">{a.reauthDays}d left</Pill> : a.status === 'error' ? <Pill tone="red">Credential error</Pill> : <Pill tone="amber">Statements</Pill>}
                    />
                  ))}
                </div>
                {/* Bank data is always one client's, so the way in is the
                    client — there is no practice-wide Bank to send them to. */}
                <button onClick={() => setActiveTab('Clients')} className="mt-4 text-[13px] font-bold text-brand hover:underline">
                  Manage in the client's Bank tab →
                </button>
              </Panel>
              <Panel title="Not for us" subtitle="Deliberately excluded, not deferred">
                <p className="text-[13px] text-zinc-500 leading-relaxed">
                  E-commerce sales connectors — Square, eBay, Etsy, Shopify, PayPal, WooCommerce, Amazon — are excluded
                  from this product. Clients who sell online still get their sales documents in through email, upload or
                  WhatsApp.
                </p>
              </Panel>
            </>
          )}

          {section === 'Extraction' && (
            <>
              <Panel title="Email routing" subtitle="One address for the whole platform">
                <Field label="Document address" value={settings.docEmail} onChange={(v) => save({ docEmail: v }, 'document email')} />
                <div className="mt-4">
                  <SubLabel>Taught senders</SubLabel>
                  {routingRules.length === 0 ? (
                    <p className="text-[13px] text-zinc-600">
                      None yet. Move a document to a client and tick "always route this sender" to teach the router — until then, the addressee is read off each document.
                    </p>
                  ) : (
                    <div className="flex flex-wrap gap-2">
                      {routingRules.map((r, i) => <Pill key={i}>{r.sender} → {r.clientName}</Pill>)}
                    </div>
                  )}
                </div>
              </Panel>

              <Panel title="Duplicate detection" subtitle="Multi-signal, with cross-document-type matching">
                <div className="flex flex-wrap gap-2">
                  {(['automatic', 'review', 'off'] as const).map((m) => (
                    <Chip key={m} active={settings.duplicateMode === m} onClick={() => save({ duplicateMode: m }, `duplicate mode → ${m}`)}>
                      {m === 'automatic' ? 'Automatic (delete on sight)' : m === 'review' ? 'Review (amber flag)' : 'Off'}
                    </Chip>
                  ))}
                </div>
              </Panel>

              <Panel title="Fields" subtitle="Extraction and mandatory-field configuration">
                <div className="flex flex-col gap-3">
                  <Toggle label="Extract tax amounts" value={settings.extractTax} onChange={(v) => save({ extractTax: v }, 'tax extraction')} />
                  <Toggle label="Extract due dates" value={settings.extractDueDate} onChange={(v) => save({ extractDueDate: v }, 'due-date extraction')} />
                </div>
                <div className="mt-5">
                  <SubLabel>Required before publish — beyond Supplier, Total and Category</SubLabel>
                  <div className="flex flex-wrap gap-2">
                    {OPTIONAL_MANDATORY.map((f) => (
                      <Chip
                        key={f}
                        active={mandatoryFields.includes(f)}
                        onClick={() => setMandatoryFields(mandatoryFields.includes(f) ? mandatoryFields.filter((x) => x !== f) : [...mandatoryFields, f])}
                      >
                        {f}
                      </Chip>
                    ))}
                  </div>
                  <p className="text-[12px] text-zinc-600 mt-3">
                    Items missing these are held back from publishing and flagged in the inbox.
                  </p>
                </div>
              </Panel>
            </>
          )}

          {section === 'Automation' && (
            <>
              <Panel title="Auto-categorisation" subtitle="Fills Category only when no higher-tier rule set it">
                <div className="flex flex-wrap gap-2">
                  {(['always', 'supplier-rules-only', 'never'] as const).map((m) => (
                    <Chip key={m} active={settings.autoCategorisation === m} onClick={() => save({ autoCategorisation: m }, `auto-categorisation → ${m}`)}>
                      {m}
                    </Chip>
                  ))}
                </div>
              </Panel>
              <Panel title="AI suggestions" subtitle="Suggest, or apply automatically within guidance">
                <div className="flex flex-wrap gap-2">
                  {(['suggest', 'auto-apply'] as const).map((m) => (
                    <Chip key={m} active={settings.suggestionMode === m} onClick={() => save({ suggestionMode: m }, `suggestion mode → ${m}`)}>
                      {m}
                    </Chip>
                  ))}
                </div>
                <p className="text-[12px] text-zinc-600 mt-3">
                  Approval workflows and payment-method rules override every auto-publish setting, including this one.
                </p>
              </Panel>
              <Panel title="Archiving" subtitle="Inbox is work to do; archive is processed evidence">
                <div className="flex flex-col gap-3">
                  <Toggle label="Auto-archive after publish" value={settings.autoArchiveOnPublish} onChange={(v) => save({ autoArchiveOnPublish: v }, 'auto-archive on publish')} />
                  <Toggle label="Auto-archive after export" value={settings.autoArchiveOnExport} onChange={(v) => save({ autoArchiveOnExport: v }, 'auto-archive on export')} />
                </div>
              </Panel>
              <Panel title="Bank match tolerances" subtitle="Configurable, unlike Dext's fixed windows">
                <div className="grid grid-cols-2 gap-4">
                  <Num label="Days after document date" value={matchSettings.documentWindow} onChange={(v) => setMatchSettings({ ...matchSettings, documentWindow: v })} />
                  <Num label="Days around due date" value={matchSettings.dueWindow} onChange={(v) => setMatchSettings({ ...matchSettings, dueWindow: v })} />
                  <Num label="Lookback (months)" value={matchSettings.lookbackMonths} onChange={(v) => setMatchSettings({ ...matchSettings, lookbackMonths: v })} />
                </div>
              </Panel>
            </>
          )}

          {section === 'Chasing' && (
            <Panel title="Chase policy" subtitle="SMS only — no WhatsApp or email chases">
              <div className="grid grid-cols-2 gap-4">
                <Num label="First chase after (hours)" value={chasePolicy.firstChaseAfterHours} onChange={(v) => setChasePolicy({ ...chasePolicy, firstChaseAfterHours: v })} />
                <Num label="Reminder 1 (days)" value={chasePolicy.reminderOneDays} onChange={(v) => setChasePolicy({ ...chasePolicy, reminderOneDays: v })} />
                <Num label="Reminder 2 (days)" value={chasePolicy.reminderTwoDays} onChange={(v) => setChasePolicy({ ...chasePolicy, reminderTwoDays: v })} />
                <Num label="Escalate after (days)" value={chasePolicy.escalateAfterDays} onChange={(v) => setChasePolicy({ ...chasePolicy, escalateAfterDays: v })} />
                <Field label="Quiet hours from" value={chasePolicy.quietHoursStart} onChange={(v) => setChasePolicy({ ...chasePolicy, quietHoursStart: v })} />
                <Field label="Quiet hours to" value={chasePolicy.quietHoursEnd} onChange={(v) => setChasePolicy({ ...chasePolicy, quietHoursEnd: v })} />
                <Field label="SMS sender ID" value={chasePolicy.senderId} onChange={(v) => setChasePolicy({ ...chasePolicy, senderId: v })} />
                <Num
                  label="Resend allowed after (hours)"
                  value={chasePolicy.resendAfterHours}
                  onChange={(v) => setChasePolicy({ ...chasePolicy, resendAfterHours: v })}
                />
              </div>
              <p className="text-[12px] text-zinc-500 leading-relaxed mt-4 max-w-2xl">
                Resend stays disabled until that many hours have passed. A second text while the first link is still
                live says nothing new — it is how a chase turns into nagging.
              </p>
              <div className="mt-4">
                <LinkTtlField
                  value={chasePolicy.linkTtlHours}
                  onChange={(v) => setChasePolicy({ ...chasePolicy, linkTtlHours: v })}
                />
              </div>
              <div className="mt-5 flex flex-col gap-3">
                <Toggle
                  label="Auto-chase on schedule"
                  hint="Approving the policy approves its future executions; changes re-enter review."
                  value={chasePolicy.autoChase}
                  onChange={(v) => setChasePolicy({ ...chasePolicy, autoChase: v })}
                />
                <Toggle label="Notify me when a client uploads" value={chasePolicy.notifyOnUpload} onChange={(v) => setChasePolicy({ ...chasePolicy, notifyOnUpload: v })} />
              </div>
            </Panel>
          )}

          {section === 'Approvals' && (
            <Panel title="Approval workflows" subtitle="No workflow cap · conditional branching · practice-side approvers">
              <div className="flex flex-col gap-2">
                {approvalWorkflows.map((w) => (
                  <Row
                    key={w.id}
                    label={`${w.name} — ${w.stages.length} stage${w.stages.length === 1 ? '' : 's'}${w.branches.length ? `, ${w.branches.length} branch` : ''}`}
                    value={w.active ? <Pill tone="green">Active</Pill> : <Pill>Paused</Pill>}
                  />
                ))}
              </div>
              <button onClick={() => setActiveTab('Approvals')} className="mt-4 text-[13px] font-bold text-brand hover:underline">
                Edit in Approvals →
              </button>
            </Panel>
          )}

          {section === 'Exports' && (
            <Panel title="Export formats" subtitle="Custom CSV mapping and date formats">
              <SubLabel>Date format</SubLabel>
              <div className="flex flex-wrap gap-2 mb-5">
                {(['DD/MM/YYYY', 'MM/DD/YYYY', 'YYYY-MM-DD'] as const).map((f) => (
                  <Chip key={f} active={settings.dateFormat === f} onClick={() => save({ dateFormat: f }, `date format → ${f}`)}>
                    {f}
                    {f === 'MM/DD/YYYY' && ' (US)'}
                  </Chip>
                ))}
              </div>
              <Field label="CSV format" value={settings.csvFormat} onChange={(v) => save({ csvFormat: v }, 'CSV format')} />
              <p className="text-[12px] text-zinc-600 mt-3">
                CSV, custom CSV, XLSX, PDF and ZIP of originals — plus a public API and webhooks from v1.
              </p>
            </Panel>
          )}

          {section === 'Lists' && (
            <Panel title="Lists" subtitle="Synced two-way from the client's chart of accounts">
              <div className="flex flex-col gap-2">
                <Row label="Categories" value={<Pill>Synced from ledger</Pill>} />
                <Row label="Tax rates" value={<Pill>Synced from ledger</Pill>} />
                <Row label="Payment methods" value={<Pill>4 configured</Pill>} />
                <Row label="Projects / tracking" value={<Pill>Synced from ledger</Pill>} />
                <Row label="Supplier rules" value={<Pill>{rules.length} active</Pill>} />
              </div>
            </Panel>
          )}

          {section === 'AI Guidance' && (
            <Panel title="AI guidance" subtitle="Account-level and practice Core / Shared">
              <p className="text-[13px] text-zinc-400 leading-relaxed mb-4">
                Authority order is absolute and never silently violated:
              </p>
              <div className="flex flex-wrap items-center gap-2">
                {['Accountant rules', 'Practice defaults', 'Client context', 'Learned history', 'AI inference'].map((s, i, arr) => (
                  <span key={s} className="flex items-center gap-2">
                    <Pill tone={i === 0 ? 'blue' : 'neutral'}>{s}</Pill>
                    {i < arr.length - 1 && <span className="text-zinc-700">→</span>}
                  </span>
                ))}
              </div>
              <div className="mt-5 flex flex-col gap-2">
                <Row label="Active rules" value={<Pill>{rules.length}</Pill>} />
                <Row label="Coverage" value={<Pill tone="blue">Includes the Bank workspace</Pill>} />
              </div>
            </Panel>
          )}

          {section === 'Communication' && (
            <>
              <Panel title="Channels" subtitle="Inbound is broad; chasing is deliberately narrow">
                <div className="flex flex-col gap-4">
                  <Field label="SMS sender ID" value={chasePolicy.senderId} onChange={(v) => setChasePolicy({ ...chasePolicy, senderId: v })} />
                  <Field label="WhatsApp intake number" value={settings.whatsappNumber} onChange={(v) => save({ whatsappNumber: v }, 'WhatsApp number')} />
                </div>
                <p className="text-[12px] text-zinc-600 mt-3">
                  WhatsApp is inbound-only by design — that sidesteps Meta's approved-template requirement and
                  per-message fees entirely.
                </p>
              </Panel>
              <Panel title="Notifications" subtitle="Granular, because Dext's are wrong in both directions">
                <div className="flex flex-col gap-3">
                  <Toggle label="Publish failures" value={settings.notifyPublishFailure} onChange={(v) => save({ notifyPublishFailure: v }, 'publish-failure notifications')} />
                  <Toggle label="Extraction failures" value={settings.notifyExtractionFailure} onChange={(v) => save({ notifyExtractionFailure: v }, 'extraction-failure notifications')} />
                  <Toggle label="Client uploads" value={settings.notifyClientUpload} onChange={(v) => save({ notifyClientUpload: v }, 'client-upload notifications')} />
                </div>
              </Panel>
            </>
          )}

          {section === 'Security' && (
            <Panel title="Authentication" subtitle="SSO and enforced 2FA">
              <Toggle label="Enforce 2FA for all colleagues" value={settings.enforce2fa} onChange={(v) => save({ enforce2fa: v }, '2FA enforcement')} />
              <div className="mt-5">
                <SubLabel>Single sign-on</SubLabel>
                <div className="flex flex-wrap gap-2">
                  {(['off', 'Microsoft Entra ID', 'Okta'] as const).map((s) => (
                    <Chip key={s} active={settings.sso === s} onClick={() => save({ sso: s }, `SSO → ${s}`)}>{s}</Chip>
                  ))}
                </div>
              </div>
              <p className="text-[12px] text-zinc-600 mt-5 leading-relaxed">
                Client-side access needs none of this — clients re-enter through an SMS OTP link with no password and no
                app.
              </p>
            </Panel>
          )}
        </motion.div>
      </div>
    </div>
  );
}

function Panel({ title, subtitle, children }: { title: string; subtitle: string; children: React.ReactNode }) {
  return (
    <div className="border border-white/5 rounded-[32px] bg-card shadow-2xl overflow-hidden">
      <div className="p-6 pb-4 border-b border-white/5">
        <h3 className="font-sans font-bold text-lg text-white tracking-tight">{title}</h3>
        <p className="text-[12px] text-zinc-500 mt-0.5 font-semibold uppercase tracking-wider">{subtitle}</p>
      </div>
      <div className="p-6">{children}</div>
    </div>
  );
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex justify-between items-center gap-4 py-2 border-b border-white/5 last:border-0">
      <span className="text-[13px] text-zinc-400 font-medium">{label}</span>
      <span className="shrink-0">{value}</span>
    </div>
  );
}

function SubLabel({ children }: { children: React.ReactNode }) {
  return <div className="text-[11px] font-bold text-zinc-500 uppercase tracking-widest mb-2.5">{children}</div>;
}

function Chip({ children, active, onClick }: { children: React.ReactNode; active: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className={`px-3.5 py-2 rounded-full text-[13px] font-bold border transition-all capitalize ${
        active
          ? 'bg-brand text-white border-brand shadow-[0_0_12px_rgba(20,227,196,0.25)]'
          : 'bg-ground text-zinc-400 border-white/5 hover:text-white hover:border-white/15'
      }`}
    >
      {children}
    </button>
  );
}

function Num({ label, value, onChange }: { label: string; value: number; onChange: (v: number) => void }) {
  return (
    <div>
      <div className="text-[11px] font-bold text-zinc-500 uppercase tracking-widest mb-2">{label}</div>
      <input
        type="number"
        value={value}
        onChange={(e) => onChange(Math.max(0, Number(e.target.value)))}
        className="w-full bg-ground border border-white/5 rounded-xl px-4 py-2.5 text-sm text-white focus:outline-none focus:border-brand transition-colors"
      />
    </div>
  );
}
