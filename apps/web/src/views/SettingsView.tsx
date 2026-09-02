import {
  Settings as SettingsIcon, ScanLine, Wand2, Send, CheckCircle, Download,
  List, Sparkles, MessageSquare, ShieldCheck, Building2, Sun, Moon,
} from 'lucide-react';
import { motion } from 'motion/react';
import { defineMessages, useIntl } from 'react-intl';
import { useAppContext } from '../context/AppContext';
import { SectionStrip } from '../components/DynamicComponents/SectionStrip';
import { fromSlug, slug, useSegment } from '../lib/router';
import { Field, Toggle } from '../components/DynamicComponents/FormControls';
import { LinkTtlField } from './ChasesView';
import { Pill } from '../components/DynamicComponents/DataTable';
import { OPTIONAL_MANDATORY } from '../lib/selectors';

const m = defineMessages({
  title: { id: 'settings.settingsView.title', defaultMessage: 'Settings' },
  sectionProfile: { id: 'settings.settingsView.sectionProfile', defaultMessage: 'Profile' },
  sectionExtraction: { id: 'settings.settingsView.sectionExtraction', defaultMessage: 'Extraction' },
  sectionAutomation: { id: 'settings.settingsView.sectionAutomation', defaultMessage: 'Automation' },
  sectionChasing: { id: 'settings.settingsView.sectionChasing', defaultMessage: 'Chasing' },
  sectionApprovals: { id: 'settings.settingsView.sectionApprovals', defaultMessage: 'Approvals' },
  sectionExports: { id: 'settings.settingsView.sectionExports', defaultMessage: 'Exports' },
  sectionLists: { id: 'settings.settingsView.sectionLists', defaultMessage: 'Lists' },
  sectionAiGuidance: { id: 'settings.settingsView.sectionAiGuidance', defaultMessage: 'AI Guidance' },
  sectionCommunication: { id: 'settings.settingsView.sectionCommunication', defaultMessage: 'Communication' },
  sectionSecurity: { id: 'settings.settingsView.sectionSecurity', defaultMessage: 'Security' },
  scopeNote: {
    id: 'settings.settingsView.scopeNote',
    defaultMessage: 'No mileage, no subscription pricing and no accounts Data Health — all out of scope for this edition.',
  },

  practiceProfileTitle: { id: 'settings.settingsView.practiceProfileTitle', defaultMessage: 'Practice profile' },
  practiceProfileSubtitle: {
    id: 'settings.settingsView.practiceProfileSubtitle',
    defaultMessage: 'Identity, tax details and year-end',
  },
  practiceNameLabel: { id: 'settings.settingsView.practiceNameLabel', defaultMessage: 'Practice name' },
  countryLabel: { id: 'settings.settingsView.countryLabel', defaultMessage: 'Country' },
  baseCurrencyLabel: { id: 'settings.settingsView.baseCurrencyLabel', defaultMessage: 'Base currency' },
  yearEndLabel: { id: 'settings.settingsView.yearEndLabel', defaultMessage: 'Year-end' },
  appearanceTitle: { id: 'settings.settingsView.appearanceTitle', defaultMessage: 'Appearance' },
  appearanceSubtitle: { id: 'settings.settingsView.appearanceSubtitle', defaultMessage: 'Applies to this device' },
  themeDark: { id: 'settings.settingsView.themeDark', defaultMessage: 'Dark' },
  themeLight: { id: 'settings.settingsView.themeLight', defaultMessage: 'Light' },
  appearanceNote: {
    id: 'settings.settingsView.appearanceNote',
    defaultMessage: 'Light mode is also on the sidebar, at the bottom. The business portal follows the same choice.',
  },

  emailRoutingTitle: { id: 'settings.settingsView.emailRoutingTitle', defaultMessage: 'Email routing' },
  emailRoutingSubtitle: {
    id: 'settings.settingsView.emailRoutingSubtitle',
    defaultMessage: 'One address for the whole platform',
  },
  docEmailLabel: { id: 'settings.settingsView.docEmailLabel', defaultMessage: 'Document address' },
  taughtSenders: { id: 'settings.settingsView.taughtSenders', defaultMessage: 'Taught senders' },
  noTaughtSenders: {
    id: 'settings.settingsView.noTaughtSenders',
    defaultMessage:
      'None yet. Move a document to a client and tick "always route this sender" to teach the router — until then, the addressee is read off each document.',
  },
  routingRule: { id: 'settings.settingsView.routingRule', defaultMessage: '{sender} → {client}' },
  duplicateTitle: { id: 'settings.settingsView.duplicateTitle', defaultMessage: 'Duplicate detection' },
  duplicateSubtitle: {
    id: 'settings.settingsView.duplicateSubtitle',
    defaultMessage: 'Multi-signal, with cross-document-type matching',
  },
  duplicateAutomatic: {
    id: 'settings.settingsView.duplicateAutomatic',
    defaultMessage: 'Automatic (delete on sight)',
  },
  duplicateReview: { id: 'settings.settingsView.duplicateReview', defaultMessage: 'Review (amber flag)' },
  duplicateOff: { id: 'settings.settingsView.duplicateOff', defaultMessage: 'Off' },
  fieldsTitle: { id: 'settings.settingsView.fieldsTitle', defaultMessage: 'Fields' },
  fieldsSubtitle: {
    id: 'settings.settingsView.fieldsSubtitle',
    defaultMessage: 'Extraction and mandatory-field configuration',
  },
  extractTax: { id: 'settings.settingsView.extractTax', defaultMessage: 'Extract tax amounts' },
  extractDueDate: { id: 'settings.settingsView.extractDueDate', defaultMessage: 'Extract due dates' },
  mandatoryHeading: {
    id: 'settings.settingsView.mandatoryHeading',
    defaultMessage: 'Required before publish — beyond Supplier, Total and Category',
  },
  mandatoryNote: {
    id: 'settings.settingsView.mandatoryNote',
    defaultMessage: 'Items missing these are held back from publishing and flagged in the inbox.',
  },

  autoCategorisationTitle: {
    id: 'settings.settingsView.autoCategorisationTitle',
    defaultMessage: 'Auto-categorisation',
  },
  autoCategorisationSubtitle: {
    id: 'settings.settingsView.autoCategorisationSubtitle',
    defaultMessage: 'Fills Category only when no higher-tier rule set it',
  },
  suggestionsTitle: { id: 'settings.settingsView.suggestionsTitle', defaultMessage: 'AI suggestions' },
  suggestionsSubtitle: {
    id: 'settings.settingsView.suggestionsSubtitle',
    defaultMessage: 'Suggest, or apply automatically within guidance',
  },
  suggestionsNote: {
    id: 'settings.settingsView.suggestionsNote',
    defaultMessage:
      'Approval workflows and payment-method rules override every auto-publish setting, including this one.',
  },
  archivingTitle: { id: 'settings.settingsView.archivingTitle', defaultMessage: 'Archiving' },
  archivingSubtitle: {
    id: 'settings.settingsView.archivingSubtitle',
    defaultMessage: 'Inbox is work to do; archive is processed evidence',
  },
  autoArchivePublish: {
    id: 'settings.settingsView.autoArchivePublish',
    defaultMessage: 'Auto-archive after publish',
  },
  autoArchiveExport: { id: 'settings.settingsView.autoArchiveExport', defaultMessage: 'Auto-archive after export' },
  tolerancesTitle: { id: 'settings.settingsView.tolerancesTitle', defaultMessage: 'Bank match tolerances' },
  tolerancesSubtitle: {
    id: 'settings.settingsView.tolerancesSubtitle',
    defaultMessage: "Configurable, unlike Dext's fixed windows",
  },
  documentWindow: { id: 'settings.settingsView.documentWindow', defaultMessage: 'Days after document date' },
  dueWindow: { id: 'settings.settingsView.dueWindow', defaultMessage: 'Days around due date' },
  lookbackMonths: { id: 'settings.settingsView.lookbackMonths', defaultMessage: 'Lookback (months)' },

  chasePolicyTitle: { id: 'settings.settingsView.chasePolicyTitle', defaultMessage: 'Chase policy' },
  chasePolicySubtitle: {
    id: 'settings.settingsView.chasePolicySubtitle',
    defaultMessage: 'Email only — no SMS or WhatsApp chases',
  },
  firstChaseAfter: { id: 'settings.settingsView.firstChaseAfter', defaultMessage: 'First chase after (hours)' },
  reminderOne: { id: 'settings.settingsView.reminderOne', defaultMessage: 'Reminder 1 (days)' },
  reminderTwo: { id: 'settings.settingsView.reminderTwo', defaultMessage: 'Reminder 2 (days)' },
  escalateAfter: { id: 'settings.settingsView.escalateAfter', defaultMessage: 'Escalate after (days)' },
  quietHoursFrom: { id: 'settings.settingsView.quietHoursFrom', defaultMessage: 'Quiet hours from' },
  quietHoursTo: { id: 'settings.settingsView.quietHoursTo', defaultMessage: 'Quiet hours to' },
  smsSenderId: { id: 'settings.settingsView.smsSenderId', defaultMessage: 'Sender name' },
  resendAfter: { id: 'settings.settingsView.resendAfter', defaultMessage: 'Resend allowed after (hours)' },
  resendNote: {
    id: 'settings.settingsView.resendNote',
    defaultMessage:
      'Resend stays disabled until that many hours have passed. A second text while the first link is still live says nothing new — it is how a chase turns into nagging.',
  },
  autoChase: { id: 'settings.settingsView.autoChase', defaultMessage: 'Auto-chase on schedule' },
  autoChaseHint: {
    id: 'settings.settingsView.autoChaseHint',
    defaultMessage: 'Approving the policy approves its future executions; changes re-enter review.',
  },
  notifyOnUpload: { id: 'settings.settingsView.notifyOnUpload', defaultMessage: 'Notify me when a client uploads' },

  workflowsTitle: { id: 'settings.settingsView.workflowsTitle', defaultMessage: 'Approval workflows' },
  workflowsSubtitle: {
    id: 'settings.settingsView.workflowsSubtitle',
    defaultMessage: 'No workflow cap · conditional branching · practice-side approvers',
  },
  workflowRow: {
    id: 'settings.settingsView.workflowRow',
    defaultMessage: '{name} — {stages, plural, one {# stage} other {# stages}}',
  },
  // The `other` arm said "# branch" too, so a two-branch workflow rendered
  // "2 branch". Both arms being identical is a broken plural, not copy to be
  // preserved faithfully — corrected here rather than carried into the
  // catalogue where every future locale would inherit it.
  workflowRowWithBranches: {
    id: 'settings.settingsView.workflowRowWithBranches',
    defaultMessage:
      '{name} — {stages, plural, one {# stage} other {# stages}}, {branches, plural, one {# branch} other {# branches}}',
  },
  workflowActive: { id: 'settings.settingsView.workflowActive', defaultMessage: 'Active' },
  workflowPaused: { id: 'settings.settingsView.workflowPaused', defaultMessage: 'Paused' },
  editInApprovals: { id: 'settings.settingsView.editInApprovals', defaultMessage: 'Edit in Approvals →' },

  exportsTitle: { id: 'settings.settingsView.exportsTitle', defaultMessage: 'Export formats' },
  exportsSubtitle: {
    id: 'settings.settingsView.exportsSubtitle',
    defaultMessage: 'Custom CSV mapping and date formats',
  },
  dateFormatHeading: { id: 'settings.settingsView.dateFormatHeading', defaultMessage: 'Date format' },
  dateFormatUs: { id: 'settings.settingsView.dateFormatUs', defaultMessage: '{format} (US)' },
  csvFormatLabel: { id: 'settings.settingsView.csvFormatLabel', defaultMessage: 'CSV format' },
  exportsNote: {
    id: 'settings.settingsView.exportsNote',
    defaultMessage: 'CSV, custom CSV, XLSX, PDF and ZIP of originals — plus a public API and webhooks from v1.',
  },

  listsTitle: { id: 'settings.settingsView.listsTitle', defaultMessage: 'Lists' },
  listsSubtitle: {
    id: 'settings.settingsView.listsSubtitle',
    defaultMessage: "From the client's chart of accounts, seeded at intake",
  },
  listCategories: { id: 'settings.settingsView.listCategories', defaultMessage: 'Categories' },
  listTaxRates: { id: 'settings.settingsView.listTaxRates', defaultMessage: 'Tax rates' },
  listProjects: { id: 'settings.settingsView.listProjects', defaultMessage: 'Projects / tracking' },
  listSupplierRules: { id: 'settings.settingsView.listSupplierRules', defaultMessage: 'Supplier rules' },
  fromChartOfAccounts: { id: 'settings.settingsView.fromChartOfAccounts', defaultMessage: 'From the chart of accounts' },
  activeCount: { id: 'settings.settingsView.activeCount', defaultMessage: '{count} active' },

  guidanceTitle: { id: 'settings.settingsView.guidanceTitle', defaultMessage: 'AI guidance' },
  guidanceSubtitle: {
    id: 'settings.settingsView.guidanceSubtitle',
    defaultMessage: 'Account-level and practice Core / Shared',
  },
  authorityIntro: {
    id: 'settings.settingsView.authorityIntro',
    defaultMessage: 'Authority order is absolute and never silently violated:',
  },
  authorityAccountantRules: {
    id: 'settings.settingsView.authorityAccountantRules',
    defaultMessage: 'Accountant rules',
  },
  authorityPracticeDefaults: {
    id: 'settings.settingsView.authorityPracticeDefaults',
    defaultMessage: 'Practice defaults',
  },
  authorityClientContext: { id: 'settings.settingsView.authorityClientContext', defaultMessage: 'Client context' },
  authorityLearnedHistory: { id: 'settings.settingsView.authorityLearnedHistory', defaultMessage: 'Learned history' },
  authorityAiInference: { id: 'settings.settingsView.authorityAiInference', defaultMessage: 'AI inference' },
  activeRules: { id: 'settings.settingsView.activeRules', defaultMessage: 'Active rules' },
  coverage: { id: 'settings.settingsView.coverage', defaultMessage: 'Coverage' },
  coverageValue: { id: 'settings.settingsView.coverageValue', defaultMessage: 'Includes the Bank workspace' },

  channelsTitle: { id: 'settings.settingsView.channelsTitle', defaultMessage: 'Channels' },
  channelsSubtitle: {
    id: 'settings.settingsView.channelsSubtitle',
    defaultMessage: 'Inbound is broad; chasing is deliberately narrow',
  },
  whatsappNumber: { id: 'settings.settingsView.whatsappNumber', defaultMessage: 'WhatsApp intake number' },
  whatsappNote: {
    id: 'settings.settingsView.whatsappNote',
    defaultMessage:
      "WhatsApp is inbound-only by design — that sidesteps Meta's approved-template requirement and per-message fees entirely.",
  },
  notificationsTitle: { id: 'settings.settingsView.notificationsTitle', defaultMessage: 'Notifications' },
  notificationsSubtitle: {
    id: 'settings.settingsView.notificationsSubtitle',
    defaultMessage: "Granular, because Dext's are wrong in both directions",
  },
  notifyPublishFailures: { id: 'settings.settingsView.notifyPublishFailures', defaultMessage: 'Publish failures' },
  notifyExtractionFailures: {
    id: 'settings.settingsView.notifyExtractionFailures',
    defaultMessage: 'Extraction failures',
  },
  notifyClientUploads: { id: 'settings.settingsView.notifyClientUploads', defaultMessage: 'Client uploads' },

  authenticationTitle: { id: 'settings.settingsView.authenticationTitle', defaultMessage: 'Authentication' },
  authenticationSubtitle: {
    id: 'settings.settingsView.authenticationSubtitle',
    defaultMessage: 'SSO and enforced 2FA',
  },
  enforce2fa: { id: 'settings.settingsView.enforce2fa', defaultMessage: 'Enforce 2FA for all colleagues' },
  ssoHeading: { id: 'settings.settingsView.ssoHeading', defaultMessage: 'Single sign-on' },
  securityNote: {
    id: 'settings.settingsView.securityNote',
    defaultMessage:
      'Client-side access needs none of this — clients re-enter through an emailed link and one-time code, with no password and no app.',
  },

  // Audit entries. `AuditTable` renders `action` and `scope` straight to a
  // human, in a table whose every other column is already catalogued, and the
  // log is session-scoped React state — `useState<AuditEntry[]>([])`, never
  // written to storage or an API — so nothing here is a stored record whose
  // locale could be baked in. They are copy, and the converted views treat
  // them as copy.
  //
  // Each `save()` scope is a whole noun phrase rather than a fragment glued to
  // 'Changed setting': the two are separate columns, so they are never
  // concatenated, and a phrase a translator can read whole is the point.
  auditChangedSetting: { id: 'settings.settingsView.auditChangedSetting', defaultMessage: 'Changed setting' },
  auditScopePracticeName: { id: 'settings.settingsView.auditScopePracticeName', defaultMessage: 'practice name' },
  auditScopeCountry: { id: 'settings.settingsView.auditScopeCountry', defaultMessage: 'country' },
  auditScopeBaseCurrency: { id: 'settings.settingsView.auditScopeBaseCurrency', defaultMessage: 'base currency' },
  auditScopeYearEnd: { id: 'settings.settingsView.auditScopeYearEnd', defaultMessage: 'year-end' },
  // One message per theme rather than '{theme} theme': the placeholder would
  // be the machine value, so the interpolated word would stay English while
  // the noun around it translated.
  auditScopeThemeDark: { id: 'settings.settingsView.auditScopeThemeDark', defaultMessage: 'dark theme' },
  auditScopeThemeLight: { id: 'settings.settingsView.auditScopeThemeLight', defaultMessage: 'light theme' },
  auditScopeDocumentEmail: { id: 'settings.settingsView.auditScopeDocumentEmail', defaultMessage: 'document email' },
  auditScopeDuplicateMode: {
    id: 'settings.settingsView.auditScopeDuplicateMode',
    defaultMessage: 'duplicate mode → {mode}',
  },
  auditScopeTaxExtraction: { id: 'settings.settingsView.auditScopeTaxExtraction', defaultMessage: 'tax extraction' },
  auditScopeDueDateExtraction: {
    id: 'settings.settingsView.auditScopeDueDateExtraction',
    defaultMessage: 'due-date extraction',
  },
  auditScopeAutoCategorisation: {
    id: 'settings.settingsView.auditScopeAutoCategorisation',
    defaultMessage: 'auto-categorisation → {mode}',
  },
  auditScopeSuggestionMode: {
    id: 'settings.settingsView.auditScopeSuggestionMode',
    defaultMessage: 'suggestion mode → {mode}',
  },
  auditScopeAutoArchivePublish: {
    id: 'settings.settingsView.auditScopeAutoArchivePublish',
    defaultMessage: 'auto-archive on publish',
  },
  auditScopeAutoArchiveExport: {
    id: 'settings.settingsView.auditScopeAutoArchiveExport',
    defaultMessage: 'auto-archive on export',
  },
  auditScopeDateFormat: { id: 'settings.settingsView.auditScopeDateFormat', defaultMessage: 'date format → {format}' },
  auditScopeCsvFormat: { id: 'settings.settingsView.auditScopeCsvFormat', defaultMessage: 'CSV format' },
  auditScopeWhatsappNumber: { id: 'settings.settingsView.auditScopeWhatsappNumber', defaultMessage: 'WhatsApp number' },
  auditScopePublishFailureNotifications: {
    id: 'settings.settingsView.auditScopePublishFailureNotifications',
    defaultMessage: 'publish-failure notifications',
  },
  auditScopeExtractionFailureNotifications: {
    id: 'settings.settingsView.auditScopeExtractionFailureNotifications',
    defaultMessage: 'extraction-failure notifications',
  },
  auditScopeClientUploadNotifications: {
    id: 'settings.settingsView.auditScopeClientUploadNotifications',
    defaultMessage: 'client-upload notifications',
  },
  auditScopeTwoFactor: { id: 'settings.settingsView.auditScopeTwoFactor', defaultMessage: '2FA enforcement' },
  auditScopeSso: { id: 'settings.settingsView.auditScopeSso', defaultMessage: 'SSO → {provider}' },
});

// `key` stays the machine value — it is the URL slug, the discriminant and the
// audit scope. `label` is the copy, held as a descriptor and formatted at the
// call site, because a hook cannot run at module scope.
const SECTIONS = [
  { key: 'Profile', icon: Building2, label: m.sectionProfile },
  { key: 'Extraction', icon: ScanLine, label: m.sectionExtraction },
  { key: 'Automation', icon: Wand2, label: m.sectionAutomation },
  { key: 'Chasing', icon: Send, label: m.sectionChasing },
  { key: 'Approvals', icon: CheckCircle, label: m.sectionApprovals },
  { key: 'Exports', icon: Download, label: m.sectionExports },
  { key: 'Lists', icon: List, label: m.sectionLists },
  { key: 'AI Guidance', icon: Sparkles, label: m.sectionAiGuidance },
  { key: 'Communication', icon: MessageSquare, label: m.sectionCommunication },
  { key: 'Security', icon: ShieldCheck, label: m.sectionSecurity },
] as const;

type Section = (typeof SECTIONS)[number]['key'];

const AUTHORITY_ORDER = [
  m.authorityAccountantRules,
  m.authorityPracticeDefaults,
  m.authorityClientContext,
  m.authorityLearnedHistory,
  m.authorityAiInference,
] as const;

export function SettingsView() {
  const {
    settings, updateSettings, rules, chasePolicy, setChasePolicy,
    matchSettings, setMatchSettings, mandatoryFields, setMandatoryFields,
    approvalWorkflows, routingRules, setActiveTab, logAudit,
  } = useAppContext();
  const intl = useIntl();

  // The sub-tab is the second path segment, so every one has a link.
  const [sectionSlug, setSectionSlug] = useSegment(1);
  const section: Section = fromSlug(sectionSlug, SECTIONS.map((x) => x.key)) ?? 'Profile';
  const setSection = (next: Section) => setSectionSlug(next === 'Profile' ? null : slug(next));

  // `label` stays a plain string: every caller formats its own descriptor,
  // because several of them interpolate a machine value (`duplicate mode →
  // review`) and a helper taking a bare descriptor could not carry the values.
  const save = (patch: Parameters<typeof updateSettings>[0], label: string) => {
    updateSettings(patch);
    logAudit({ action: intl.formatMessage(m.auditChangedSetting), scope: label, reviewOpened: true });
  };

  return (
    <div className="flex-1 flex flex-col md:flex-row min-w-0 bg-ground h-full overflow-hidden">
      <aside data-tour="settings-nav" className="hidden md:flex w-64 shrink-0 border-r border-white/5 flex-col py-8 px-4 overflow-y-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        <div className="px-4 mb-6 flex items-center gap-3">
          <SettingsIcon size={20} className="text-zinc-400" />
          <h1 className="font-sans text-xl font-semibold text-white tracking-tight">{intl.formatMessage(m.title)}</h1>
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
              {intl.formatMessage(s.label)}
            </button>
          ))}
        </nav>
      </aside>

      {/* Under 768px the side list has no room; the same sections run as a
          strip the thumb can flick through, with the active one kept in view. */}
      <div className="md:hidden shrink-0 border-b border-white/5">
        <div className="px-4 pt-4 pb-2 flex items-center gap-3">
          <SettingsIcon size={18} className="text-zinc-400" />
          <h1 className="font-sans text-lg font-semibold text-white tracking-tight">{intl.formatMessage(m.title)}</h1>
        </div>
        <SectionStrip
          tourKey="settings-nav"
          items={SECTIONS.map((s) => ({ key: s.key, icon: s.icon, label: intl.formatMessage(s.label) }))}
          active={section}
          onSelect={(k) => setSection(k as Section)}
        />
      </div>

      <div className="flex-1 overflow-y-auto p-4 md:p-10 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        <motion.div key={section} data-tour="settings-panel" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} className="max-w-2xl flex flex-col gap-6">
          {section === 'Profile' && (
            <>
              <Panel title={intl.formatMessage(m.practiceProfileTitle)} subtitle={intl.formatMessage(m.practiceProfileSubtitle)}>
                <div className="grid grid-cols-2 gap-4">
                  <Field label={intl.formatMessage(m.practiceNameLabel)} value={settings.practiceName} onChange={(v) => save({ practiceName: v }, intl.formatMessage(m.auditScopePracticeName))} />
                  <Field label={intl.formatMessage(m.countryLabel)} value={settings.country} onChange={(v) => save({ country: v }, intl.formatMessage(m.auditScopeCountry))} />
                  <Field label={intl.formatMessage(m.baseCurrencyLabel)} value={settings.baseCurrency} onChange={(v) => save({ baseCurrency: v }, intl.formatMessage(m.auditScopeBaseCurrency))} />
                  <Field label={intl.formatMessage(m.yearEndLabel)} value={settings.yearEnd} onChange={(v) => save({ yearEnd: v }, intl.formatMessage(m.auditScopeYearEnd))} />
                </div>
              </Panel>

              <Panel title={intl.formatMessage(m.appearanceTitle)} subtitle={intl.formatMessage(m.appearanceSubtitle)}>
                <div className="flex items-center gap-2">
                  {([
                    // `value` is the machine discriminant — it is what `theme`
                    // is set to and what the active check compares. The button
                    // label and the audit scope are both copy, and each gets
                    // its own descriptor: the scope is a different phrase from
                    // the label ('dark theme', not 'Dark'), so it cannot be
                    // derived from either the label or the value.
                    { value: 'dark' as const, label: m.themeDark, auditScope: m.auditScopeThemeDark, icon: Moon },
                    { value: 'light' as const, label: m.themeLight, auditScope: m.auditScopeThemeLight, icon: Sun },
                  ]).map((opt) => (
                    <button
                      key={opt.value}
                      onClick={() => save({ theme: opt.value }, intl.formatMessage(opt.auditScope))}
                      className={`flex-1 flex items-center justify-center gap-2 px-5 py-3 rounded-2xl border text-[13px] font-bold transition-all ${
                        settings.theme === opt.value
                          ? 'bg-brand/10 border-brand/40 text-brand'
                          : 'bg-ground border-white/5 text-zinc-400 hover:text-white hover:border-white/15'
                      }`}
                    >
                      <opt.icon size={15} />
                      {intl.formatMessage(opt.label)}
                    </button>
                  ))}
                </div>
                <p className="text-[12px] text-zinc-500 leading-relaxed mt-4">
                  {intl.formatMessage(m.appearanceNote)}
                </p>
              </Panel>
            </>
          )}

          {section === 'Extraction' && (
            <>
              <Panel title={intl.formatMessage(m.emailRoutingTitle)} subtitle={intl.formatMessage(m.emailRoutingSubtitle)}>
                <Field label={intl.formatMessage(m.docEmailLabel)} value={settings.docEmail} onChange={(v) => save({ docEmail: v }, intl.formatMessage(m.auditScopeDocumentEmail))} />
                <div className="mt-4">
                  <SubLabel>{intl.formatMessage(m.taughtSenders)}</SubLabel>
                  {routingRules.length === 0 ? (
                    <p className="text-[13px] text-zinc-600">
                      {intl.formatMessage(m.noTaughtSenders)}
                    </p>
                  ) : (
                    <div className="flex flex-wrap gap-2">
                      {routingRules.map((r, i) => <Pill key={i}>{intl.formatMessage(m.routingRule, { sender: r.sender, client: r.clientName })}</Pill>)}
                    </div>
                  )}
                </div>
              </Panel>

              <Panel title={intl.formatMessage(m.duplicateTitle)} subtitle={intl.formatMessage(m.duplicateSubtitle)}>
                <div className="flex flex-wrap gap-2">
                  {(['automatic', 'review', 'off'] as const).map((mode) => (
                    <Chip key={mode} active={settings.duplicateMode === mode} onClick={() => save({ duplicateMode: mode }, intl.formatMessage(m.auditScopeDuplicateMode, { mode }))}>
                      {intl.formatMessage(mode === 'automatic' ? m.duplicateAutomatic : mode === 'review' ? m.duplicateReview : m.duplicateOff)}
                    </Chip>
                  ))}
                </div>
              </Panel>

              <Panel title={intl.formatMessage(m.fieldsTitle)} subtitle={intl.formatMessage(m.fieldsSubtitle)}>
                <div className="flex flex-col gap-3">
                  <Toggle label={intl.formatMessage(m.extractTax)} value={settings.extractTax} onChange={(v) => save({ extractTax: v }, intl.formatMessage(m.auditScopeTaxExtraction))} />
                  <Toggle label={intl.formatMessage(m.extractDueDate)} value={settings.extractDueDate} onChange={(v) => save({ extractDueDate: v }, intl.formatMessage(m.auditScopeDueDateExtraction))} />
                </div>
                <div className="mt-5">
                  <SubLabel>{intl.formatMessage(m.mandatoryHeading)}</SubLabel>
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
                    {intl.formatMessage(m.mandatoryNote)}
                  </p>
                </div>
              </Panel>
            </>
          )}

          {section === 'Automation' && (
            <>
              <Panel title={intl.formatMessage(m.autoCategorisationTitle)} subtitle={intl.formatMessage(m.autoCategorisationSubtitle)}>
                <div className="flex flex-wrap gap-2">
                  {(['always', 'supplier-rules-only', 'never'] as const).map((mode) => (
                    <Chip key={mode} active={settings.autoCategorisation === mode} onClick={() => save({ autoCategorisation: mode }, intl.formatMessage(m.auditScopeAutoCategorisation, { mode }))}>
                      {mode}
                    </Chip>
                  ))}
                </div>
              </Panel>
              <Panel title={intl.formatMessage(m.suggestionsTitle)} subtitle={intl.formatMessage(m.suggestionsSubtitle)}>
                <div className="flex flex-wrap gap-2">
                  {(['suggest', 'auto-apply'] as const).map((mode) => (
                    <Chip key={mode} active={settings.suggestionMode === mode} onClick={() => save({ suggestionMode: mode }, intl.formatMessage(m.auditScopeSuggestionMode, { mode }))}>
                      {mode}
                    </Chip>
                  ))}
                </div>
                <p className="text-[12px] text-zinc-600 mt-3">
                  {intl.formatMessage(m.suggestionsNote)}
                </p>
              </Panel>
              <Panel title={intl.formatMessage(m.archivingTitle)} subtitle={intl.formatMessage(m.archivingSubtitle)}>
                <div className="flex flex-col gap-3">
                  <Toggle label={intl.formatMessage(m.autoArchivePublish)} value={settings.autoArchiveOnPublish} onChange={(v) => save({ autoArchiveOnPublish: v }, intl.formatMessage(m.auditScopeAutoArchivePublish))} />
                  <Toggle label={intl.formatMessage(m.autoArchiveExport)} value={settings.autoArchiveOnExport} onChange={(v) => save({ autoArchiveOnExport: v }, intl.formatMessage(m.auditScopeAutoArchiveExport))} />
                </div>
              </Panel>
              <Panel title={intl.formatMessage(m.tolerancesTitle)} subtitle={intl.formatMessage(m.tolerancesSubtitle)}>
                <div className="grid grid-cols-2 gap-4">
                  <Num label={intl.formatMessage(m.documentWindow)} value={matchSettings.documentWindow} onChange={(v) => setMatchSettings({ ...matchSettings, documentWindow: v })} />
                  <Num label={intl.formatMessage(m.dueWindow)} value={matchSettings.dueWindow} onChange={(v) => setMatchSettings({ ...matchSettings, dueWindow: v })} />
                  <Num label={intl.formatMessage(m.lookbackMonths)} value={matchSettings.lookbackMonths} onChange={(v) => setMatchSettings({ ...matchSettings, lookbackMonths: v })} />
                </div>
              </Panel>
            </>
          )}

          {section === 'Chasing' && (
            <Panel title={intl.formatMessage(m.chasePolicyTitle)} subtitle={intl.formatMessage(m.chasePolicySubtitle)}>
              <div className="grid grid-cols-2 gap-4">
                <Num label={intl.formatMessage(m.firstChaseAfter)} value={chasePolicy.firstChaseAfterHours} onChange={(v) => setChasePolicy({ ...chasePolicy, firstChaseAfterHours: v })} />
                <Num label={intl.formatMessage(m.reminderOne)} value={chasePolicy.reminderOneDays} onChange={(v) => setChasePolicy({ ...chasePolicy, reminderOneDays: v })} />
                <Num label={intl.formatMessage(m.reminderTwo)} value={chasePolicy.reminderTwoDays} onChange={(v) => setChasePolicy({ ...chasePolicy, reminderTwoDays: v })} />
                <Num label={intl.formatMessage(m.escalateAfter)} value={chasePolicy.escalateAfterDays} onChange={(v) => setChasePolicy({ ...chasePolicy, escalateAfterDays: v })} />
                <Field label={intl.formatMessage(m.quietHoursFrom)} value={chasePolicy.quietHoursStart} onChange={(v) => setChasePolicy({ ...chasePolicy, quietHoursStart: v })} />
                <Field label={intl.formatMessage(m.quietHoursTo)} value={chasePolicy.quietHoursEnd} onChange={(v) => setChasePolicy({ ...chasePolicy, quietHoursEnd: v })} />
                <Field label={intl.formatMessage(m.smsSenderId)} value={chasePolicy.senderId} onChange={(v) => setChasePolicy({ ...chasePolicy, senderId: v })} />
                <Num
                  label={intl.formatMessage(m.resendAfter)}
                  value={chasePolicy.resendAfterHours}
                  onChange={(v) => setChasePolicy({ ...chasePolicy, resendAfterHours: v })}
                />
              </div>
              <p className="text-[12px] text-zinc-500 leading-relaxed mt-4 max-w-2xl">
                {intl.formatMessage(m.resendNote)}
              </p>
              <div className="mt-4">
                <LinkTtlField
                  value={chasePolicy.linkTtlHours}
                  onChange={(v) => setChasePolicy({ ...chasePolicy, linkTtlHours: v })}
                />
              </div>
              <div className="mt-5 flex flex-col gap-3">
                <Toggle
                  label={intl.formatMessage(m.autoChase)}
                  hint={intl.formatMessage(m.autoChaseHint)}
                  value={chasePolicy.autoChase}
                  onChange={(v) => setChasePolicy({ ...chasePolicy, autoChase: v })}
                />
                <Toggle label={intl.formatMessage(m.notifyOnUpload)} value={chasePolicy.notifyOnUpload} onChange={(v) => setChasePolicy({ ...chasePolicy, notifyOnUpload: v })} />
              </div>
            </Panel>
          )}

          {section === 'Approvals' && (
            <Panel title={intl.formatMessage(m.workflowsTitle)} subtitle={intl.formatMessage(m.workflowsSubtitle)}>
              <div className="flex flex-col gap-2">
                {approvalWorkflows.map((w) => (
                  <Row
                    key={w.id}
                    label={
                      w.branches.length
                        ? intl.formatMessage(m.workflowRowWithBranches, { name: w.name, stages: w.stages.length, branches: w.branches.length })
                        : intl.formatMessage(m.workflowRow, { name: w.name, stages: w.stages.length })
                    }
                    value={w.active ? <Pill tone="green">{intl.formatMessage(m.workflowActive)}</Pill> : <Pill>{intl.formatMessage(m.workflowPaused)}</Pill>}
                  />
                ))}
              </div>
              <button onClick={() => setActiveTab('Approvals')} className="mt-4 text-[13px] font-bold text-brand hover:underline">
                {intl.formatMessage(m.editInApprovals)}
              </button>
            </Panel>
          )}

          {section === 'Exports' && (
            <Panel title={intl.formatMessage(m.exportsTitle)} subtitle={intl.formatMessage(m.exportsSubtitle)}>
              <SubLabel>{intl.formatMessage(m.dateFormatHeading)}</SubLabel>
              <div className="flex flex-wrap gap-2 mb-5">
                {(['DD/MM/YYYY', 'MM/DD/YYYY', 'YYYY-MM-DD'] as const).map((f) => (
                  <Chip key={f} active={settings.dateFormat === f} onClick={() => save({ dateFormat: f }, intl.formatMessage(m.auditScopeDateFormat, { format: f }))}>
                    {f === 'MM/DD/YYYY' ? intl.formatMessage(m.dateFormatUs, { format: f }) : f}
                  </Chip>
                ))}
              </div>
              <Field label={intl.formatMessage(m.csvFormatLabel)} value={settings.csvFormat} onChange={(v) => save({ csvFormat: v }, intl.formatMessage(m.auditScopeCsvFormat))} />
              <p className="text-[12px] text-zinc-600 mt-3">
                {intl.formatMessage(m.exportsNote)}
              </p>
            </Panel>
          )}

          {section === 'Lists' && (
            <Panel title={intl.formatMessage(m.listsTitle)} subtitle={intl.formatMessage(m.listsSubtitle)}>
              <div className="flex flex-col gap-2">
                <Row label={intl.formatMessage(m.listCategories)} value={<Pill>{intl.formatMessage(m.fromChartOfAccounts)}</Pill>} />
                <Row label={intl.formatMessage(m.listTaxRates)} value={<Pill>{intl.formatMessage(m.fromChartOfAccounts)}</Pill>} />
                <Row label={intl.formatMessage(m.listProjects)} value={<Pill>{intl.formatMessage(m.fromChartOfAccounts)}</Pill>} />
                <Row label={intl.formatMessage(m.listSupplierRules)} value={<Pill>{intl.formatMessage(m.activeCount, { count: rules.length })}</Pill>} />
              </div>
            </Panel>
          )}

          {section === 'AI Guidance' && (
            <Panel title={intl.formatMessage(m.guidanceTitle)} subtitle={intl.formatMessage(m.guidanceSubtitle)}>
              <p className="text-[13px] text-zinc-400 leading-relaxed mb-4">
                {intl.formatMessage(m.authorityIntro)}
              </p>
              <div className="flex flex-wrap items-center gap-2">
                {AUTHORITY_ORDER.map((s, i, arr) => (
                  <span key={s.id} className="flex items-center gap-2">
                    <Pill tone={i === 0 ? 'blue' : 'neutral'}>{intl.formatMessage(s)}</Pill>
                    {i < arr.length - 1 && <span className="text-zinc-700">→</span>}
                  </span>
                ))}
              </div>
              <div className="mt-5 flex flex-col gap-2">
                <Row label={intl.formatMessage(m.activeRules)} value={<Pill>{rules.length}</Pill>} />
                <Row label={intl.formatMessage(m.coverage)} value={<Pill tone="blue">{intl.formatMessage(m.coverageValue)}</Pill>} />
              </div>
            </Panel>
          )}

          {section === 'Communication' && (
            <>
              <Panel title={intl.formatMessage(m.channelsTitle)} subtitle={intl.formatMessage(m.channelsSubtitle)}>
                <div className="flex flex-col gap-4">
                  <Field label={intl.formatMessage(m.smsSenderId)} value={chasePolicy.senderId} onChange={(v) => setChasePolicy({ ...chasePolicy, senderId: v })} />
                  <Field label={intl.formatMessage(m.whatsappNumber)} value={settings.whatsappNumber} onChange={(v) => save({ whatsappNumber: v }, intl.formatMessage(m.auditScopeWhatsappNumber))} />
                </div>
                <p className="text-[12px] text-zinc-600 mt-3">
                  {intl.formatMessage(m.whatsappNote)}
                </p>
              </Panel>
              <Panel title={intl.formatMessage(m.notificationsTitle)} subtitle={intl.formatMessage(m.notificationsSubtitle)}>
                <div className="flex flex-col gap-3">
                  <Toggle label={intl.formatMessage(m.notifyPublishFailures)} value={settings.notifyPublishFailure} onChange={(v) => save({ notifyPublishFailure: v }, intl.formatMessage(m.auditScopePublishFailureNotifications))} />
                  <Toggle label={intl.formatMessage(m.notifyExtractionFailures)} value={settings.notifyExtractionFailure} onChange={(v) => save({ notifyExtractionFailure: v }, intl.formatMessage(m.auditScopeExtractionFailureNotifications))} />
                  <Toggle label={intl.formatMessage(m.notifyClientUploads)} value={settings.notifyClientUpload} onChange={(v) => save({ notifyClientUpload: v }, intl.formatMessage(m.auditScopeClientUploadNotifications))} />
                </div>
              </Panel>
            </>
          )}

          {section === 'Security' && (
            <Panel title={intl.formatMessage(m.authenticationTitle)} subtitle={intl.formatMessage(m.authenticationSubtitle)}>
              <Toggle label={intl.formatMessage(m.enforce2fa)} value={settings.enforce2fa} onChange={(v) => save({ enforce2fa: v }, intl.formatMessage(m.auditScopeTwoFactor))} />
              <div className="mt-5">
                <SubLabel>{intl.formatMessage(m.ssoHeading)}</SubLabel>
                <div className="flex flex-wrap gap-2">
                  {(['off', 'Microsoft Entra ID', 'Okta'] as const).map((s) => (
                    <Chip key={s} active={settings.sso === s} onClick={() => save({ sso: s }, intl.formatMessage(m.auditScopeSso, { provider: s }))}>{s}</Chip>
                  ))}
                </div>
              </div>
              <p className="text-[12px] text-zinc-600 mt-5 leading-relaxed">
                {intl.formatMessage(m.securityNote)}
              </p>
            </Panel>
          )}

          {/* Moved out of the side list: the horizontal strip has no room for
              a paragraph, and on a phone this scope note would simply vanish. */}
          <p className="text-[11px] text-zinc-600 leading-relaxed">
            {intl.formatMessage(m.scopeNote)}
          </p>
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
          ? 'bg-brand text-white border-brand shadow-glow-pill'
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
