import { useState } from 'react';
import { Building2, Bell, CreditCard, Users, KeyRound, Link2, Camera, Loader2, Plus, Trash2 } from 'lucide-react';
import { motion } from 'motion/react';
import { defineMessages, useIntl } from 'react-intl';
import { commonActions, commonLabels, commonPlaceholders } from '../../i18n/common';
import { API_ENABLED } from '../../api/config';
import { openBillingPortal } from '../../api/onboarding';
import { errorLabel } from '../../api/slices';
import { useAppContext } from '../../context/AppContext';
import { Pill } from '../../components/DynamicComponents/DataTable';
import { newMember } from '../../lib/business';
import { RolePicker } from '../../components/DynamicComponents/RolePicker';
import { SectionStrip } from '../../components/DynamicComponents/SectionStrip';
import { useConfirm } from '../../components/DynamicComponents/ConfirmProvider';
import { Panel } from './Panel';
import { useEscape } from '../../lib/useEscape';
import type { BusinessAccount, BusinessMember } from '../../lib/types';

const m = defineMessages({
  sectionBusiness: { id: 'portal.businessSettingsView.sectionBusiness', defaultMessage: 'Business' },
  sectionPlan: { id: 'portal.businessSettingsView.sectionPlan', defaultMessage: 'Plan' },
  sectionSending: { id: 'portal.businessSettingsView.sectionSending', defaultMessage: 'Sending' },
  sectionNotifications: { id: 'portal.businessSettingsView.sectionNotifications', defaultMessage: 'Notifications' },
  sectionPeople: { id: 'portal.businessSettingsView.sectionPeople', defaultMessage: 'People' },
  sectionConnections: { id: 'portal.businessSettingsView.sectionSetup', defaultMessage: 'Setup' },
  sectionSecurity: { id: 'portal.businessSettingsView.sectionSecurity', defaultMessage: 'Security' },

  accountantTitle: { id: 'portal.businessSettingsView.accountantTitle', defaultMessage: 'Your accountant' },
  accountantSubtitle: {
    id: 'portal.businessSettingsView.accountantSubtitle',
    defaultMessage: 'Managed by the practice — contact them to change it',
  },
  practiceLabel: { id: 'portal.businessSettingsView.practiceLabel', defaultMessage: 'Practice' },
  practiceValue: { id: 'portal.businessSettingsView.practiceValue', defaultMessage: 'Your accounting practice' },
  industryLabel: { id: 'portal.businessSettingsView.industryLabel', defaultMessage: 'Industry on file' },
  vatNotRegistered: { id: 'portal.businessSettingsView.vatNotRegistered', defaultMessage: 'Not registered' },
  deadlineLabel: { id: 'portal.businessSettingsView.deadlineLabel', defaultMessage: 'Next deadline' },
  createdLabel: { id: 'portal.businessSettingsView.createdLabel', defaultMessage: 'Account created' },
  originSelfSignup: { id: 'portal.businessSettingsView.originSelfSignup', defaultMessage: 'Signed up directly' },
  originAccountant: { id: 'portal.businessSettingsView.originAccountant', defaultMessage: 'Created by accountant' },

  sendingTitle: { id: 'portal.businessSettingsView.sendingTitle', defaultMessage: 'How documents are sent' },
  sendingSubtitle: {
    id: 'portal.businessSettingsView.sendingSubtitle',
    defaultMessage: 'Defaults for upload and camera capture',
  },
  sendingClassifyTitle: {
    id: 'portal.businessSettingsView.sendingClassifyTitle',
    defaultMessage: 'We work out what each document is',
  },
  sendingClassifyBody: {
    id: 'portal.businessSettingsView.sendingClassifyBody',
    defaultMessage:
      'Bills, receipts and sales invoices can all go in together — you never have to sort them. Your accountant sees what we decided, and can correct it.',
  },
  multiPageLabel: { id: 'portal.businessSettingsView.multiPageLabel', defaultMessage: 'Multi-page capture' },
  multiPageHint: {
    id: 'portal.businessSettingsView.multiPageHint',
    defaultMessage: 'Shoot several sheets and send them as one document.',
  },
  autoSubmitLabel: { id: 'portal.businessSettingsView.autoSubmitLabel', defaultMessage: 'Send as I shoot' },
  autoSubmitHint: {
    id: 'portal.businessSettingsView.autoSubmitHint',
    defaultMessage: 'Skips the review step — each photo goes straight to your accountant.',
  },

  notificationsTitle: { id: 'portal.businessSettingsView.notificationsTitle', defaultMessage: 'When we contact you' },
  notificationsSubtitle: {
    id: 'portal.businessSettingsView.notificationsSubtitle',
    defaultMessage: 'Chases always come by email — the rest is up to you',
  },
  smsLabel: {
    id: 'portal.businessSettingsView.smsLabel',
    defaultMessage: 'Tell me when something is missing',
  },
  smsHint: { id: 'portal.businessSettingsView.smsHint', defaultMessage: 'Sent by email' },
  smsHintNoMobile: { id: 'portal.businessSettingsView.smsHintNoMobile', defaultMessage: 'Sent by email' },
  emailLabel: { id: 'portal.businessSettingsView.emailLabel', defaultMessage: 'Email me too' },
  emailHintNone: { id: 'portal.businessSettingsView.emailHintNone', defaultMessage: 'No email on file' },
  weeklyLabel: { id: 'portal.businessSettingsView.weeklyLabel', defaultMessage: 'Weekly summary' },
  weeklyHint: {
    id: 'portal.businessSettingsView.weeklyHint',
    defaultMessage: 'One message a week with anything still outstanding.',
  },

  peopleTitle: { id: 'portal.businessSettingsView.peopleTitle', defaultMessage: 'Who can send documents' },
  peopleSubtitle: {
    id: 'portal.businessSettingsView.peopleSubtitle',
    defaultMessage: 'Staff can photograph receipts without ever seeing your figures',
  },
  peopleEmpty: {
    id: 'portal.businessSettingsView.peopleEmpty',
    defaultMessage: 'Nobody added yet. Invite the people who handle paperwork.',
  },
  memberUnnamed: { id: 'portal.businessSettingsView.memberUnnamed', defaultMessage: 'Unnamed' },
  memberNoEmail: { id: 'portal.businessSettingsView.memberNoEmail', defaultMessage: 'No email' },
  memberCanSend: { id: 'portal.businessSettingsView.memberCanSend', defaultMessage: 'Can send' },
  memberSeesTotals: { id: 'portal.businessSettingsView.memberSeesTotals', defaultMessage: 'Sees totals' },
  inviteAction: { id: 'portal.businessSettingsView.inviteAction', defaultMessage: 'Invite someone' },
  peopleNote: {
    id: 'portal.businessSettingsView.peopleNote',
    defaultMessage:
      'Everyone here signs in the same way you do — a six-digit code emailed to them, no password to share. Removing someone stops their access immediately; the documents they already sent stay with your accountant.',
  },

  connectionsTitle: {
    id: 'portal.businessSettingsView.setupTitle',
    defaultMessage: 'Setup your accountant asked for',
  },
  connectionsSubtitle: {
    id: 'portal.businessSettingsView.setupSubtitle',
    defaultMessage: 'Only you can do this — your accountant cannot register your details for you',
  },
  companyDetailsName: { id: 'portal.businessSettingsView.companyDetailsName', defaultMessage: 'Company details' },
  companyDetailsDetail: {
    id: 'portal.businessSettingsView.companyDetailsDetail',
    defaultMessage: 'Legal name, VAT, year-end and what the business sells',
  },
  companyDetailsAction: { id: 'portal.businessSettingsView.companyDetailsAction', defaultMessage: 'Register' },
  companyDetailsDone: { id: 'portal.businessSettingsView.companyDetailsDone', defaultMessage: 'Registered' },

  bankTitle: { id: 'portal.businessSettingsView.bankTitle', defaultMessage: 'Bank accounts on file' },
  bankSubtitle: {
    id: 'portal.businessSettingsView.bankSubtitle',
    defaultMessage: 'From the statements you upload',
  },
  bankAccountLabel: { id: 'portal.businessSettingsView.bankAccountLabel', defaultMessage: '{bankName} ••{last4}' },
  bankLive: { id: 'portal.businessSettingsView.bankLive', defaultMessage: 'Live · {days}d left' },
  bankError: { id: 'portal.businessSettingsView.bankError', defaultMessage: 'Needs reconnecting' },
  bankDisconnected: { id: 'portal.businessSettingsView.bankDisconnected', defaultMessage: 'Disconnected' },

  // The Plan section (launch stage M6, D48). One plan, so there is no picker
  // here — status, the renewal date, and the door to Stripe, which hosts the
  // card change, the invoices and the cancellation flow. Deliberately nothing
  // else: a plan-change screen, a cancellation flow and an invoice renderer
  // are three things Stripe already does correctly.
  planTitle: { id: 'portal.businessSettingsView.planTitle', defaultMessage: 'Your plan' },
  planSubtitle: {
    id: 'portal.businessSettingsView.planSubtitle',
    defaultMessage: 'One plan — everything your accountant set up here is included',
  },
  planStatusLabel: { id: 'portal.businessSettingsView.planStatusLabel', defaultMessage: 'Status' },
  planStatusActive: { id: 'portal.businessSettingsView.planStatusActive', defaultMessage: 'Active' },
  planStatusPastDue: { id: 'portal.businessSettingsView.planStatusPastDue', defaultMessage: 'Payment overdue' },
  planStatusCanceled: { id: 'portal.businessSettingsView.planStatusCanceled', defaultMessage: 'Cancelled' },
  planStatusNone: { id: 'portal.businessSettingsView.planStatusNone', defaultMessage: 'Not subscribed yet' },
  planRenewsLabel: { id: 'portal.businessSettingsView.planRenewsLabel', defaultMessage: 'Renews on' },
  planPriceLabel: { id: 'portal.businessSettingsView.planPriceLabel', defaultMessage: 'Price' },
  // Never a bare figure: prices are stored exclusive of VAT and displayed as
  // such (§24.5). The VAT amount and the gross total are Stripe's to show.
  planPriceValue: { id: 'portal.businessSettingsView.planPriceValue', defaultMessage: '£8.50 + VAT per month' },
  planPriceNote: {
    id: 'portal.businessSettingsView.planPriceNote',
    defaultMessage: 'Shown excluding VAT. The VAT and the total are on your Stripe invoice, in sterling.',
  },
  planManageAction: { id: 'portal.businessSettingsView.planManageAction', defaultMessage: 'Manage billing in Stripe' },
  planManageNote: {
    id: 'portal.businessSettingsView.planManageNote',
    defaultMessage:
      'Card changes, invoices and cancellation are all handled on Stripe’s own billing pages — nothing about your card is stored here.',
  },
  planManageSynthetic: {
    id: 'portal.businessSettingsView.planManageSynthetic',
    defaultMessage: 'Demo data — this build is not talking to a server, so there is no Stripe billing page to open.',
  },
  planManageFault: {
    id: 'portal.businessSettingsView.planManageFault',
    defaultMessage: 'We could not open Stripe’s billing page. Try again in a moment — if it keeps failing, tell your accountant.',
  },
  planNotSubscribedNote: {
    id: 'portal.businessSettingsView.planNotSubscribedNote',
    defaultMessage:
      'Subscribing happens at the end of setup — open the setup link from your registration email. Your accountant can send a fresh one if it has expired.',
  },

  securityTitle: { id: 'portal.businessSettingsView.securityTitle', defaultMessage: 'Sign-in' },
  securitySubtitle: {
    id: 'portal.businessSettingsView.securitySubtitle',
    defaultMessage: 'Protects everything you send from this portal',
  },
  twoFactorLabel: { id: 'portal.businessSettingsView.twoFactorLabel', defaultMessage: 'Two-factor authentication' },
  // Emailed, never texted — the portal's sign-in codes have no SMS behind
  // them (launch stage M6, D47).
  twoFactorHint: {
    id: 'portal.businessSettingsView.twoFactorHint',
    defaultMessage: 'A code by email each time you sign in on a new device.',
  },
  accessTitle: { id: 'portal.businessSettingsView.accessTitle', defaultMessage: 'Access' },
  accessSubtitle: {
    id: 'portal.businessSettingsView.accessSubtitle',
    defaultMessage: 'What your accountant can and cannot do',
  },
  accessBody: {
    id: 'portal.businessSettingsView.accessBody',
    defaultMessage:
      'Your accountant sees the documents you send and the figures extracted from them. They cannot sign in as you, and they cannot change your notification settings or the people listed above.',
  },

  removeConfirmTitle: { id: 'portal.businessSettingsView.removeConfirmTitle', defaultMessage: 'Remove {name}?' },
  removeConfirmDetail: { id: 'portal.businessSettingsView.removeConfirmDetail', defaultMessage: '{role} at {business}.' },
  removeConfirmConsequence: {
    id: 'portal.businessSettingsView.removeConfirmConsequence',
    defaultMessage:
      'They stop being able to send documents immediately. Anything they already sent stays with your accountant.',
  },
  removeConfirmAction: { id: 'portal.businessSettingsView.removeConfirmAction', defaultMessage: 'Yes, remove them' },

  editorHeadingNew: { id: 'portal.memberEditor.headingNew', defaultMessage: 'Invite someone' },
  editorHeadingFallback: { id: 'portal.memberEditor.headingFallback', defaultMessage: 'Edit person' },
  editorSubtitle: {
    id: 'portal.memberEditor.subtitle',
    defaultMessage: 'What they can do, and what they can see',
  },
  editorNameLabel: { id: 'portal.memberEditor.nameLabel', defaultMessage: 'Name' },
  editorNamePlaceholder: { id: 'portal.memberEditor.namePlaceholder', defaultMessage: 'Tom Whyte' },
  editorEmailPlaceholder: { id: 'portal.memberEditor.emailPlaceholder', defaultMessage: 'tom@yourbusiness.co.uk' },
  editorRoleHintOwner: {
    id: 'portal.memberEditor.roleHintOwner',
    defaultMessage: 'Full access, including these settings and your figures.',
  },
  editorRoleHintManager: {
    id: 'portal.memberEditor.roleHintManager',
    defaultMessage: 'Sends documents and sees what is outstanding.',
  },
  editorRoleHintStaff: {
    id: 'portal.memberEditor.roleHintStaff',
    defaultMessage: 'Sends documents only — the day-to-day receipt handler.',
  },
  editorRoleHintCustom: {
    id: 'portal.memberEditor.roleHintCustom',
    defaultMessage: 'A role of your own. Set what they can do below.',
  },
  editorCanUploadLabel: { id: 'portal.memberEditor.canUploadLabel', defaultMessage: 'Can send documents' },
  editorCanUploadHint: {
    id: 'portal.memberEditor.canUploadHint',
    defaultMessage: 'Upload and photograph paperwork for the business.',
  },
  editorCanSeeTotalsLabel: { id: 'portal.memberEditor.canSeeTotalsLabel', defaultMessage: 'Can see totals' },
  editorCanSeeTotalsHint: {
    id: 'portal.memberEditor.canSeeTotalsHint',
    defaultMessage: 'Amounts and what is outstanding. Leave off for staff photographing receipts.',
  },
  editorProblemName: { id: 'portal.memberEditor.problemName', defaultMessage: 'Add their name.' },
  editorProblemEmailMissing: {
    id: 'portal.memberEditor.problemEmailMissing',
    defaultMessage: 'Add an email — it is how they receive their sign-in code.',
  },
  editorProblemEmailInvalid: {
    id: 'portal.memberEditor.problemEmailInvalid',
    defaultMessage: 'That email does not look right.',
  },
  editorProblemEmailDuplicate: {
    id: 'portal.memberEditor.problemEmailDuplicate',
    defaultMessage: 'Someone here already uses that email.',
  },
  editorProblemLastOwner: {
    id: 'portal.memberEditor.problemLastOwner',
    defaultMessage: 'This is your only Owner — make someone else an Owner first.',
  },
  editorRemoveBlockedTitle: {
    id: 'portal.memberEditor.removeBlockedTitle',
    defaultMessage: 'Make someone else an Owner first',
  },
  editorRemoveTitle: { id: 'portal.memberEditor.removeTitle', defaultMessage: 'Remove this person' },
  editorRemoveAction: { id: 'portal.memberEditor.removeAction', defaultMessage: 'Remove' },
  editorSendInviteAction: { id: 'portal.memberEditor.sendInviteAction', defaultMessage: 'Send invite' },
  editorSaveAction: { id: 'portal.memberEditor.saveAction', defaultMessage: 'Save' },

  detailsTitle: { id: 'portal.businessDetailsPanel.title', defaultMessage: 'Your business' },
  detailsSubtitle: {
    id: 'portal.businessDetailsPanel.subtitle',
    defaultMessage: 'Shown to your accountant on everything you send',
  },
  detailsBusinessNameLabel: { id: 'portal.businessDetailsPanel.businessNameLabel', defaultMessage: 'Business name' },
  detailsBusinessNamePlaceholder: {
    id: 'portal.businessDetailsPanel.businessNamePlaceholder',
    defaultMessage: 'American Burger Ltd',
  },
  detailsContactLabel: { id: 'portal.businessDetailsPanel.contactLabel', defaultMessage: 'Main contact' },
  detailsEmailPlaceholder: {
    id: 'portal.businessDetailsPanel.emailPlaceholder',
    defaultMessage: 'john@americanburger.co.uk',
  },
  detailsNote: {
    id: 'portal.businessDetailsPanel.note',
    defaultMessage:
      'Your sign-in codes are emailed to this address — no app, no password. Keep the mobile up to date too, so your accountant can reach you.',
  },
  detailsProblemName: {
    id: 'portal.businessDetailsPanel.problemName',
    defaultMessage: 'Your business needs a name — it is what your accountant sees on everything you send.',
  },
  detailsProblemMobile: {
    id: 'portal.businessDetailsPanel.problemMobile',
    defaultMessage: 'A mobile is required — it is how your accountant reaches you about paperwork.',
  },
  detailsProblemEmail: {
    id: 'portal.businessDetailsPanel.problemEmail',
    defaultMessage: 'That email does not look right.',
  },
  detailsSaveAction: { id: 'portal.businessDetailsPanel.saveAction', defaultMessage: 'Save changes' },
  detailsDiscardAction: { id: 'portal.businessDetailsPanel.discardAction', defaultMessage: 'Discard' },
  detailsUnsaved: { id: 'portal.businessDetailsPanel.unsaved', defaultMessage: 'Unsaved: {fields}' },
  detailsSaved: { id: 'portal.businessDetailsPanel.saved', defaultMessage: 'Saved.' },

  connectRowAction: { id: 'portal.connectRow.connectAction', defaultMessage: 'Connect' },
  connectRowDone: { id: 'portal.connectRow.connectedLabel', defaultMessage: 'Connected' },

  // Audit entries. `AuditTable` renders `action` and `scope` straight to a
  // human, and the log is session-scoped React state that is never persisted,
  // so these are copy — the same call the converted views make.
  //
  // The business name stays an interpolated value, not translated text:
  // `ClientDetailView` builds its activity feed by matching the client name
  // inside `scope`, so it has to survive translation intact.
  auditAction: {
    id: 'portal.businessSettingsView.auditAction',
    defaultMessage: 'Business changed a portal setting',
  },
  auditScope: { id: 'portal.businessSettingsView.auditScope', defaultMessage: '{business} — {label}' },
  auditScopeMultiPage: { id: 'portal.businessSettingsView.auditScopeMultiPage', defaultMessage: 'multi-page capture' },
  auditScopeAutoSubmit: { id: 'portal.businessSettingsView.auditScopeAutoSubmit', defaultMessage: 'send as I shoot' },
  auditScopeSmsNotifications: {
    id: 'portal.businessSettingsView.auditScopeSmsNotifications',
    defaultMessage: 'missing-item notifications',
  },
  auditScopeEmailNotifications: {
    id: 'portal.businessSettingsView.auditScopeEmailNotifications',
    defaultMessage: 'email notifications',
  },
  auditScopeWeeklySummary: {
    id: 'portal.businessSettingsView.auditScopeWeeklySummary',
    defaultMessage: 'weekly summary',
  },
  auditScopeTwoFactor: {
    id: 'portal.businessSettingsView.auditScopeTwoFactor',
    defaultMessage: 'two-factor authentication',
  },
  auditScopeMemberInvited: {
    id: 'portal.businessSettingsView.auditScopeMemberInvited',
    defaultMessage: 'invited {name}',
  },
  auditScopeMemberUpdated: {
    id: 'portal.businessSettingsView.auditScopeMemberUpdated',
    defaultMessage: 'updated {name}',
  },
  auditScopeMemberRemoved: {
    id: 'portal.businessSettingsView.auditScopeMemberRemoved',
    defaultMessage: 'removed {name}',
  },
});

// `key` stays the machine value the switch and the `Section` type are built
// from; the label beside it is the descriptor, formatted at the call site —
// a hook cannot be called out here.
const SECTIONS = [
  { key: 'Business', icon: Building2, label: m.sectionBusiness },
  { key: 'Plan', icon: CreditCard, label: m.sectionPlan },
  { key: 'Sending', icon: Camera, label: m.sectionSending },
  { key: 'Notifications', icon: Bell, label: m.sectionNotifications },
  { key: 'People', icon: Users, label: m.sectionPeople },
  { key: 'Connections', icon: Link2, label: m.sectionConnections },
  { key: 'Security', icon: KeyRound, label: m.sectionSecurity },
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
  const intl = useIntl();

  const client = clients.find((c) => c.id === account.clientId);
  const bank = accounts.filter((a) => a.clientId === account.clientId);

  // `label` is a formatted string rather than a descriptor: several callers
  // interpolate a member name into it, which a bare descriptor could not carry.
  const save = (patch: Partial<BusinessAccount>, label: string) => {
    updateBusinessAccount(account.id, patch);
    logAudit({
      action: intl.formatMessage(m.auditAction),
      scope: intl.formatMessage(m.auditScope, { business: account.businessName, label }),
      reviewOpened: false,
    });
  };

  return (
    <div className="flex flex-col md:flex-row min-w-0 h-full">
      <aside
        data-tour="portal-settings"
        className="hidden md:block w-56 shrink-0 border-r border-white/5 py-8 px-3 overflow-y-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      >
        <nav className="flex flex-col gap-1">
          {SECTIONS.map((s) => (
            <button
              key={s.key}
              onClick={() => setSection(s.key)}
              className={`px-4 py-2.5 rounded-xl text-left text-sm font-semibold transition-all flex items-center gap-3 ${
                section === s.key
                  ? 'bg-card text-white border border-white/5'
                  : 'text-zinc-400 hover:text-white hover:bg-card/50 border border-transparent'
              }`}
            >
              <s.icon size={15} className={section === s.key ? 'text-brand' : ''} />
              {intl.formatMessage(s.label)}
            </button>
          ))}
        </nav>
      </aside>

      <div className="md:hidden shrink-0 border-b border-white/5 pt-2">
        <SectionStrip
          tourKey="portal-settings"
          items={SECTIONS.map((sec) => ({ key: sec.key, icon: sec.icon, label: intl.formatMessage(sec.label) }))}
          active={section}
          onSelect={(k) => setSection(k as Section)}
        />
      </div>

      <div className="flex-1 min-w-0 overflow-y-auto p-4 md:p-8 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        <motion.div key={section} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} className="max-w-2xl flex flex-col gap-5">
          {section === 'Business' && (
            <>
              <BusinessDetailsPanel account={account} onSave={save} />
              <Panel title={intl.formatMessage(m.accountantTitle)} subtitle={intl.formatMessage(m.accountantSubtitle)}>
                <Row
                  label={intl.formatMessage(m.practiceLabel)}
                  value={<span className="text-white font-semibold">{intl.formatMessage(m.practiceValue)}</span>}
                />
                <Row label={intl.formatMessage(m.industryLabel)} value={client?.industry ?? '—'} />
                <Row label={intl.formatMessage(commonLabels.vatNumber)} value={client?.vatNumber || intl.formatMessage(m.vatNotRegistered)} />
                <Row label={intl.formatMessage(m.deadlineLabel)} value={client?.deadline ?? '—'} />
                <Row
                  label={intl.formatMessage(m.createdLabel)}
                  value={
                    <span className="flex items-center gap-2">
                      {account.createdAt}
                      <Pill tone={account.origin === 'self-signup' ? 'blue' : 'neutral'}>
                        {account.origin === 'self-signup'
                          ? intl.formatMessage(m.originSelfSignup)
                          : intl.formatMessage(m.originAccountant)}
                      </Pill>
                    </span>
                  }
                />
              </Panel>
            </>
          )}

          {section === 'Plan' && <PlanPanel account={account} />}

          {section === 'Sending' && (
            <Panel title={intl.formatMessage(m.sendingTitle)} subtitle={intl.formatMessage(m.sendingSubtitle)}>
              <div className="flex flex-col gap-3">
                {/* No money-in / money-out choice: sorting paperwork is
                    bookkeeping, and it is not the business's job. Extraction
                    reads the bill-to block and files it. */}
                <div className="p-4 rounded-2xl bg-ground/60 border border-white/5 shadow-inner">
                  <div className="text-sm font-bold text-white">{intl.formatMessage(m.sendingClassifyTitle)}</div>
                  <div className="text-[12px] text-zinc-500 mt-1 leading-relaxed">
                    {intl.formatMessage(m.sendingClassifyBody)}
                  </div>
                </div>
                <Toggle
                  label={intl.formatMessage(m.multiPageLabel)}
                  hint={intl.formatMessage(m.multiPageHint)}
                  value={account.multiPageCapture}
                  onChange={(v) => save({ multiPageCapture: v }, intl.formatMessage(m.auditScopeMultiPage))}
                />
                <Toggle
                  label={intl.formatMessage(m.autoSubmitLabel)}
                  hint={intl.formatMessage(m.autoSubmitHint)}
                  value={account.autoSubmitOnCapture}
                  onChange={(v) => save({ autoSubmitOnCapture: v }, intl.formatMessage(m.auditScopeAutoSubmit))}
                />
              </div>
            </Panel>
          )}

          {section === 'Notifications' && (
            <Panel title={intl.formatMessage(m.notificationsTitle)} subtitle={intl.formatMessage(m.notificationsSubtitle)}>
              <div className="flex flex-col gap-3">
                <Toggle
                  label={intl.formatMessage(m.smsLabel)}
                  hint={
                    account.mobile
                      ? intl.formatMessage(m.smsHint, { mobile: account.mobile })
                      : intl.formatMessage(m.smsHintNoMobile)
                  }
                  value={account.notifyBySms}
                  onChange={(v) => save({ notifyBySms: v }, intl.formatMessage(m.auditScopeSmsNotifications))}
                />
                <Toggle
                  label={intl.formatMessage(m.emailLabel)}
                  hint={account.email || intl.formatMessage(m.emailHintNone)}
                  value={account.notifyByEmail}
                  onChange={(v) => save({ notifyByEmail: v }, intl.formatMessage(m.auditScopeEmailNotifications))}
                />
                <Toggle
                  label={intl.formatMessage(m.weeklyLabel)}
                  hint={intl.formatMessage(m.weeklyHint)}
                  value={account.weeklySummary}
                  onChange={(v) => save({ weeklySummary: v }, intl.formatMessage(m.auditScopeWeeklySummary))}
                />
              </div>
            </Panel>
          )}

          {section === 'People' && (
            <Panel
              title={intl.formatMessage(m.peopleTitle)}
              subtitle={intl.formatMessage(m.peopleSubtitle)}
            >
              <div className="flex flex-col gap-2">
                {account.members.length === 0 && (
                  <p className="text-[13px] text-zinc-500 py-4 text-center">
                    {intl.formatMessage(m.peopleEmpty)}
                  </p>
                )}
                {account.members.map((member) => (
                  <button
                    key={member.id}
                    onClick={() => setEditingMember(member)}
                    className="p-4 rounded-2xl bg-ground/60 border border-white/5 hover:border-white/15 transition-colors text-left flex items-center gap-4"
                  >
                    <div className="w-10 h-10 rounded-xl bg-raised border border-white/5 flex items-center justify-center font-bold text-white shrink-0">
                      {member.name.trim().charAt(0).toUpperCase() || '?'}
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="text-sm font-bold text-white truncate">{member.name || intl.formatMessage(m.memberUnnamed)}</div>
                      <div className="text-[12px] text-zinc-500 truncate">{member.email || intl.formatMessage(m.memberNoEmail)}</div>
                    </div>
                    <div className="flex items-center gap-2 shrink-0 flex-wrap justify-end">
                      <Pill tone={member.role === 'Owner' ? 'blue' : 'neutral'}>{member.role}</Pill>
                      {member.canUpload && <Pill tone="green">{intl.formatMessage(m.memberCanSend)}</Pill>}
                      {member.canSeeTotals && <Pill tone="amber">{intl.formatMessage(m.memberSeesTotals)}</Pill>}
                    </div>
                  </button>
                ))}
                <button
                  onClick={() => setEditingMember(newMember())}
                  className="flex items-center justify-center gap-2 p-3.5 rounded-2xl border border-dashed border-white/10 text-[13px] font-bold text-zinc-400 hover:text-white hover:border-white/25 transition-colors"
                >
                  <Plus size={15} />
                  {intl.formatMessage(m.inviteAction)}
                </button>
              </div>
              <p className="text-[12px] text-zinc-500 leading-relaxed mt-4">
                {intl.formatMessage(m.peopleNote)}
              </p>
            </Panel>
          )}

          {section === 'Connections' && (
            <>
              {/* Only on records the accountant opened with an invite —
                  elsewhere they keyed the company in themselves. D47: nothing
                  here ever asks for a connection. */}
              {client?.awaitingRegistration && (
                <Panel
                  title={intl.formatMessage(m.connectionsTitle)}
                  subtitle={intl.formatMessage(m.connectionsSubtitle)}
                >
                  <div className="flex flex-col gap-2">
                    <ConnectRow
                      name={intl.formatMessage(m.companyDetailsName)}
                      detail={intl.formatMessage(m.companyDetailsDetail)}
                      connected={false}
                      onConnect={() => completeOnboardingTask(account.clientId, 'profile')}
                      actionLabel={intl.formatMessage(m.companyDetailsAction)}
                      doneLabel={intl.formatMessage(m.companyDetailsDone)}
                    />
                  </div>
                </Panel>
              )}

              {bank.length > 0 && (
                <Panel title={intl.formatMessage(m.bankTitle)} subtitle={intl.formatMessage(m.bankSubtitle)}>
                  <div className="flex flex-col gap-2">
                    {bank.map((a) => (
                      <Row
                        key={a.id}
                        label={intl.formatMessage(m.bankAccountLabel, { bankName: a.bankName, last4: a.last4 })}
                        value={
                          a.status === 'live' ? (
                            <Pill tone="green">{intl.formatMessage(m.bankLive, { days: a.reauthDays })}</Pill>
                          ) : a.status === 'error' ? (
                            <Pill tone="red">{intl.formatMessage(m.bankError)}</Pill>
                          ) : (
                            <Pill tone="amber">{intl.formatMessage(m.bankDisconnected)}</Pill>
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
              <Panel title={intl.formatMessage(m.securityTitle)} subtitle={intl.formatMessage(m.securitySubtitle)}>
                <Toggle
                  label={intl.formatMessage(m.twoFactorLabel)}
                  hint={intl.formatMessage(m.twoFactorHint)}
                  value={account.twoFactor}
                  onChange={(v) => save({ twoFactor: v }, intl.formatMessage(m.auditScopeTwoFactor))}
                />
              </Panel>
              <Panel title={intl.formatMessage(m.accessTitle)} subtitle={intl.formatMessage(m.accessSubtitle)}>
                <p className="text-[13px] text-zinc-500 leading-relaxed">
                  {intl.formatMessage(m.accessBody)}
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
          onSave={(next) => {
            const isNew = !account.members.some((x) => x.id === next.id);
            save(
              { members: isNew ? [...account.members, next] : account.members.map((x) => (x.id === next.id ? next : x)) },
              intl.formatMessage(isNew ? m.auditScopeMemberInvited : m.auditScopeMemberUpdated, { name: next.name }),
            );
            setEditingMember(null);
          }}
          onRemove={async () => {
            const ok = await confirm({
              tone: 'red',
              title: intl.formatMessage(m.removeConfirmTitle, { name: editingMember.name }),
              detail: intl.formatMessage(m.removeConfirmDetail, { role: editingMember.role, business: account.businessName }),
              consequence: intl.formatMessage(m.removeConfirmConsequence),
              confirmLabel: intl.formatMessage(m.removeConfirmAction),
            });
            if (!ok) return;
            save(
              { members: account.members.filter((x) => x.id !== editingMember.id) },
              intl.formatMessage(m.auditScopeMemberRemoved, { name: editingMember.name }),
            );
            setEditingMember(null);
          }}
          onClose={() => setEditingMember(null)}
        />
      )}
    </div>
  );
}

/**
 * The Plan section (launch stage M6, D48): status, the renewal date, the
 * price as copy, and the door to Stripe's hosted customer portal — which IS
 * the billing UI. Card changes, invoices, cancellation: all Stripe's pages,
 * deliberately none of ours.
 *
 * The button is real only when the API is on; on seed data it is disabled
 * with the demo note underneath, because a link that opens nothing is worse
 * than a disabled one that says why (the S12 rule). The business id it sends
 * live goes through the seed↔server bridge (`serverClientIdFor`), the same
 * join every other live write from a seed-keyed screen makes.
 */
function PlanPanel({ account }: { account: BusinessAccount }) {
  const { serverClientIdFor } = useAppContext();
  const intl = useIntl();
  const [opening, setOpening] = useState(false);
  const [fault, setFault] = useState<string | null>(null);

  const plan = account.subscription ?? null;

  const manage = async () => {
    setOpening(true);
    setFault(null);
    try {
      const url = await openBillingPortal(serverClientIdFor(account.clientId));
      // The whole tab goes to Stripe; its `returnUrl` brings the client back
      // to this screen when they are done.
      window.location.assign(url);
    } catch (error) {
      // The server's own problem with its NT- code in front (`errorLabel`,
      // frontend ten item 5 — review item 45): the generic line hid four
      // different failures behind one sentence, and this failure's commonest
      // causes are dashboard-side facts only the code can point at.
      setFault(errorLabel(error) ?? intl.formatMessage(m.planManageFault));
      setOpening(false);
    }
  };

  return (
    <Panel title={intl.formatMessage(m.planTitle)} subtitle={intl.formatMessage(m.planSubtitle)}>
      <Row
        label={intl.formatMessage(m.planStatusLabel)}
        value={
          plan === null ? (
            <Pill tone="neutral">{intl.formatMessage(m.planStatusNone)}</Pill>
          ) : plan.status === 'active' ? (
            <Pill tone="green">{intl.formatMessage(m.planStatusActive)}</Pill>
          ) : plan.status === 'past_due' ? (
            <Pill tone="amber">{intl.formatMessage(m.planStatusPastDue)}</Pill>
          ) : (
            <Pill tone="red">{intl.formatMessage(m.planStatusCanceled)}</Pill>
          )
        }
      />
      {plan?.renewsOn && <Row label={intl.formatMessage(m.planRenewsLabel)} value={plan.renewsOn} />}
      <Row
        label={intl.formatMessage(m.planPriceLabel)}
        value={<span className="text-white font-semibold">{intl.formatMessage(m.planPriceValue)}</span>}
      />
      <p className="text-[12px] text-zinc-600 leading-relaxed mt-1">{intl.formatMessage(m.planPriceNote)}</p>

      {plan === null ? (
        <p className="text-[13px] text-zinc-500 leading-relaxed mt-3">{intl.formatMessage(m.planNotSubscribedNote)}</p>
      ) : (
        <div className="flex flex-col gap-2 mt-3">
          <button
            onClick={() => void manage()}
            disabled={!API_ENABLED || opening}
            title={API_ENABLED ? undefined : intl.formatMessage(m.planManageSynthetic)}
            className="self-start flex items-center gap-2 px-5 py-2.5 rounded-full text-[13px] font-bold text-white bg-brand hover:bg-brand-hover disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          >
            {opening ? <Loader2 size={15} className="animate-spin" /> : <CreditCard size={15} strokeWidth={2.5} />}
            {intl.formatMessage(m.planManageAction)}
          </button>
          {fault !== null && (
            <p role="alert" className="text-[13px] font-semibold text-red-400 leading-relaxed">
              {fault}
            </p>
          )}
          <p className="text-[12px] text-zinc-600 leading-relaxed">
            {intl.formatMessage(API_ENABLED ? m.planManageNote : m.planManageSynthetic)}
          </p>
        </div>
      )}
    </Panel>
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
  onSave: (next: BusinessMember) => void;
  onRemove: () => void;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState(member);
  const intl = useIntl();
  useEscape(onClose);
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
    ? intl.formatMessage(m.editorProblemName)
    : !email
    ? intl.formatMessage(m.editorProblemEmailMissing)
    : emailLooksWrong
    ? intl.formatMessage(m.editorProblemEmailInvalid)
    : duplicate
    ? intl.formatMessage(m.editorProblemEmailDuplicate)
    : draft.role === 'Owner' || !lastOwner || draft.role === member.role
    ? ''
    : intl.formatMessage(m.editorProblemLastOwner);

  return (
    // The backdrop is not a button — role="presentation" says so; keyboard
    // dismissal is Escape (useEscape above). The dialog is named by its own
    // heading rather than a duplicated label expression.
    <div
      className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm flex items-start justify-center overflow-y-auto p-4 md:p-8 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      onClick={onClose}
      role="presentation"
    >
      <motion.div
        initial={{ opacity: 0, y: 20, scale: 0.97 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="member-editor-heading"
        className="w-full max-w-lg border border-white/5 rounded-[32px] bg-card shadow-2xl overflow-hidden my-auto"
      >
        <div className="p-6 border-b border-white/5">
          <h3 id="member-editor-heading" className="font-sans font-bold text-xl text-white tracking-tight">
            {isNew ? intl.formatMessage(m.editorHeadingNew) : draft.name || intl.formatMessage(m.editorHeadingFallback)}
          </h3>
          <p className="text-[12px] text-zinc-500 mt-1 font-semibold uppercase tracking-wider">
            {intl.formatMessage(m.editorSubtitle)}
          </p>
        </div>

        <div className="p-6 flex flex-col gap-5">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <Field
              label={intl.formatMessage(m.editorNameLabel)}
              value={draft.name}
              onChange={(v) => set('name', v)}
              placeholder={intl.formatMessage(m.editorNamePlaceholder)}
            />
            <Field
              label={intl.formatMessage(commonLabels.email)}
              value={draft.email}
              onChange={(v) => set('email', v)}
              placeholder={intl.formatMessage(m.editorEmailPlaceholder)}
            />
          </div>

          <RolePicker
            value={draft.role}
            onChange={(r) => set('role', r)}
            hint={
              draft.role === 'Owner'
                ? intl.formatMessage(m.editorRoleHintOwner)
                : draft.role === 'Manager'
                ? intl.formatMessage(m.editorRoleHintManager)
                : draft.role === 'Staff'
                ? intl.formatMessage(m.editorRoleHintStaff)
                : intl.formatMessage(m.editorRoleHintCustom)
            }
          />

          <div className="flex flex-col gap-2">
            <Toggle
              label={intl.formatMessage(m.editorCanUploadLabel)}
              hint={intl.formatMessage(m.editorCanUploadHint)}
              value={draft.canUpload}
              onChange={(v) => set('canUpload', v)}
            />
            <Toggle
              label={intl.formatMessage(m.editorCanSeeTotalsLabel)}
              hint={intl.formatMessage(m.editorCanSeeTotalsHint)}
              value={draft.canSeeTotals}
              onChange={(v) => set('canSeeTotals', v)}
            />
          </div>

          {problem && <p className="text-[13px] text-amber-400 font-semibold">{problem}</p>}
        </div>

        <div className="p-4 bg-raised/50 flex items-center gap-2 sm:gap-3 justify-end flex-wrap [&>button]:flex-1 [&>button]:basis-[8rem] sm:[&>button]:flex-none sm:[&>button]:basis-auto [&>button]:justify-center">
          {!isNew && (
            <button
              onClick={onRemove}
              disabled={lastOwner}
              title={lastOwner ? intl.formatMessage(m.editorRemoveBlockedTitle) : intl.formatMessage(m.editorRemoveTitle)}
              className="mr-auto flex items-center gap-2 px-4 py-2.5 rounded-full text-[13px] font-bold text-zinc-400 hover:text-red-400 disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:text-zinc-400 transition-colors"
            >
              <Trash2 size={14} />
              {intl.formatMessage(m.editorRemoveAction)}
            </button>
          )}
          <button
            onClick={onClose}
            className="px-5 py-2.5 rounded-full text-[13px] font-bold text-zinc-400 hover:text-white transition-colors"
          >
            {intl.formatMessage(commonActions.cancel)}
          </button>
          <button
            onClick={() => onSave({ ...draft, name, email })}
            disabled={!!problem}
            className="flex items-center gap-2 px-6 py-2.5 rounded-full text-[13px] font-bold text-white bg-brand hover:bg-brand-hover disabled:opacity-40 disabled:cursor-not-allowed transition-colors shadow-glow-btn"
          >
            {isNew ? intl.formatMessage(m.editorSendInviteAction) : intl.formatMessage(m.editorSaveAction)}
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
  const intl = useIntl();

  const set = <K extends keyof typeof draft>(k: K, v: (typeof draft)[K]) => {
    setDraft({ ...draft, [k]: v });
    setSaved(false);
  };

  const changed = (Object.keys(draft) as (keyof typeof draft)[]).filter((k) => draft[k].trim() !== account[k]);
  const dirty = changed.length > 0;

  const problem = !draft.businessName.trim()
    ? intl.formatMessage(m.detailsProblemName)
    : !draft.mobile.trim()
    ? intl.formatMessage(m.detailsProblemMobile)
    : draft.email.trim() && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(draft.email.trim())
    ? intl.formatMessage(m.detailsProblemEmail)
    : '';

  return (
    <Panel title={intl.formatMessage(m.detailsTitle)} subtitle={intl.formatMessage(m.detailsSubtitle)}>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <Field
          label={intl.formatMessage(m.detailsBusinessNameLabel)}
          value={draft.businessName}
          onChange={(v) => set('businessName', v)}
          placeholder={intl.formatMessage(m.detailsBusinessNamePlaceholder)}
        />
        <Field
          label={intl.formatMessage(m.detailsContactLabel)}
          value={draft.contactName}
          onChange={(v) => set('contactName', v)}
          placeholder={intl.formatMessage(commonPlaceholders.personName)}
        />
        <Field
          label={intl.formatMessage(commonLabels.email)}
          value={draft.email}
          onChange={(v) => set('email', v)}
          placeholder={intl.formatMessage(m.detailsEmailPlaceholder)}
        />
        <Field
          label={intl.formatMessage(commonLabels.mobile)}
          value={draft.mobile}
          onChange={(v) => set('mobile', v)}
          placeholder={intl.formatMessage(commonPlaceholders.ukMobile)}
        />
      </div>

      <p className="text-[12px] text-zinc-500 leading-relaxed mt-4">
        {intl.formatMessage(m.detailsNote)}
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
          className="px-6 py-2.5 rounded-full text-[13px] font-bold text-white bg-brand hover:bg-brand-hover disabled:opacity-40 disabled:cursor-not-allowed transition-colors shadow-glow-btn"
        >
          {intl.formatMessage(m.detailsSaveAction)}
        </button>
        {dirty && (
          <button
            onClick={() => { setDraft({ businessName: account.businessName, contactName: account.contactName, email: account.email, mobile: account.mobile }); setSaved(false); }}
            className="px-5 py-2.5 rounded-full text-[13px] font-bold text-zinc-400 hover:text-white transition-colors"
          >
            {intl.formatMessage(m.detailsDiscardAction)}
          </button>
        )}
        {/* Say which fields are pending, so Save is never a guess. */}
        {dirty ? (
          <span className="text-[12px] text-zinc-500 font-semibold">
            {intl.formatMessage(m.detailsUnsaved, { fields: changed.join(', ') })}
          </span>
        ) : saved ? (
          <span className="text-[12px] text-brand font-semibold">{intl.formatMessage(m.detailsSaved)}</span>
        ) : null}
      </div>
    </Panel>
  );
}

/** The client's side of a connection: this is the only place it can be made. */
function ConnectRow({
  name,
  detail,
  connected,
  onConnect,
  actionLabel,
  doneLabel,
}: {
  name: string;
  detail: string;
  connected: boolean;
  onConnect: () => void;
  /** Registering the company record is not a "connect", so both words vary. */
  actionLabel?: string;
  doneLabel?: string;
}) {
  const intl = useIntl();

  return (
    <div className="flex items-center justify-between gap-4 p-4 border border-white/5 rounded-2xl bg-ground/60 shadow-inner">
      <div className="min-w-0">
        <div className="text-sm font-bold text-white">{name}</div>
        <div className="text-[12px] text-zinc-500">{detail}</div>
      </div>
      {connected ? (
        <Pill tone="green">{doneLabel ?? intl.formatMessage(m.connectRowDone)}</Pill>
      ) : (
        <button
          onClick={onConnect}
          className="shrink-0 px-4 py-2 rounded-full text-[13px] font-bold text-white bg-brand hover:bg-brand-hover transition-colors shadow-glow-pill"
        >
          {actionLabel ?? intl.formatMessage(m.connectRowAction)}
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
        className="w-full bg-ground border border-white/5 rounded-xl px-4 py-2.5 text-sm text-white placeholder:text-zinc-600 focus:outline-none focus:border-brand transition-colors"
      />
    </div>
  );
}

function Toggle({ label, hint, value, onChange }: { label: string; hint?: string; value: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      onClick={() => onChange(!value)}
      className="bg-ground/60 border border-white/5 rounded-2xl p-4 flex items-center justify-between gap-4 shadow-inner hover:border-white/10 transition-colors text-left"
    >
      <span>
        <span className="block text-sm font-bold text-white">{label}</span>
        {hint && <span className="block text-[12px] text-zinc-500 mt-0.5">{hint}</span>}
      </span>
      <span className={`w-11 h-6 rounded-full shrink-0 transition-colors relative ${value ? 'bg-brand' : 'bg-white/10'}`}>
        <span className={`absolute top-1 w-4 h-4 rounded-full bg-white transition-all ${value ? 'left-6' : 'left-1'}`} />
      </span>
    </button>
  );
}
