import { useRef, useState } from 'react';
import { Building2, ChevronRight, Link2, Smartphone, ImagePlus, X, ArrowLeft, Send, PencilLine, Check, Mail, CheckCircle2 } from 'lucide-react';
import { motion } from 'motion/react';
import { defineMessages, useIntl } from 'react-intl';
import type { MessageDescriptor } from 'react-intl';
import { useAppContext } from '../../context/AppContext';
import { commonLabels, commonPlaceholders } from '../../i18n/common';
import { ReviewGate, ReviewRows, ReviewSection } from './ReviewGate';
import { Pill } from './DataTable';
import type { SetupTask } from '../../lib/types';
import { API_ENABLED } from '../../api/config';
import { errorLabel } from '../../api/slices';
import {
  buildIntakeRequest,
  submitClientIntake,
  type CreatedBusiness,
  type IntakeDraft,
  type TriState,
} from '../../api/intake';

/**
 * Copy for all five components in this file — #65, following ActionCard.
 *
 * What is deliberately NOT in here: `INDUSTRIES`, `COMPANY_TYPES`,
 * `VAT_SCHEMES`, `FREQUENCIES`, the inline `['Practice', 'Client']` options and
 * the initial `useState` values ('United Kingdom', 'GBP', 'Director', 'You',
 * '31 March'). Those are picker *values*, not labels: each one is written
 * straight onto the client record on approve and read back as data, so
 * translating them would translate the record. Splitting label from value is a
 * schema change, not an extraction — see the report on #65.
 */
const m = defineMessages({
  // Shell — the chrome all three screens share.
  shellStepLabel: {
    id: 'clients.shell.stepLabel',
    defaultMessage: 'Step {number}: {name}',
  },
  shellChangeTitle: {
    id: 'clients.shell.changeTitle',
    defaultMessage: 'Choose a different way to add this client',
  },
  shellChange: {
    id: 'clients.shell.change',
    defaultMessage: 'Change',
  },

  // ModeChooser — the invite/practice fork.
  modeChooserTitle: {
    id: 'clients.modeChooser.title',
    defaultMessage: 'Add new client',
  },
  modeChooserSubtitle: {
    id: 'clients.modeChooser.subtitle',
    defaultMessage: 'Step 1 — how is this client set up?',
  },
  modeChooserInviteName: {
    id: 'clients.modeChooser.inviteName',
    defaultMessage: 'Send the client a link',
  },
  modeChooserInviteDetail: {
    id: 'clients.modeChooser.inviteDetail',
    defaultMessage:
      'They register the company themselves. You give three things now — company, who is responsible, and their mobile — and the link asks them for the rest.',
  },
  modeChooserInviteBulletFields: {
    id: 'clients.modeChooser.inviteBulletFields',
    defaultMessage: 'Three fields to send',
  },
  modeChooserInviteBulletOwnRecord: {
    id: 'clients.modeChooser.inviteBulletOwnRecord',
    defaultMessage: 'Client fills in their own record',
  },
  modeChooserInviteBulletFastest: {
    id: 'clients.modeChooser.inviteBulletFastest',
    defaultMessage: 'Fastest for you',
  },
  modeChooserPracticeName: {
    id: 'clients.modeChooser.practiceName',
    defaultMessage: 'Register on their behalf',
  },
  modeChooserPracticeDetail: {
    id: 'clients.modeChooser.practiceDetail',
    defaultMessage:
      'You key the full record in now — identity, tax, contact, bookkeeping and trading context. Nothing is asked of the client except the two connections.',
  },
  modeChooserPracticeBulletSteps: {
    id: 'clients.modeChooser.practiceBulletSteps',
    defaultMessage: 'Six steps',
  },
  modeChooserPracticeBulletControl: {
    id: 'clients.modeChooser.practiceBulletControl',
    defaultMessage: 'You control every field',
  },
  modeChooserPracticeBulletPaperwork: {
    id: 'clients.modeChooser.practiceBulletPaperwork',
    defaultMessage: 'Best when you already hold the paperwork',
  },
  modeChooserConnectionsHeading: {
    id: 'clients.modeChooser.noConnectionsHeading',
    defaultMessage: 'No connections are asked for, either way',
  },
  modeChooserConnectionsBody: {
    id: 'clients.modeChooser.noConnectionsBody',
    defaultMessage:
      'Intake asks for no bank connection and no accounting-software connection. Documents come in by upload, email and the portal.',
  },

  // InviteIntake — three fields and a setup link.
  inviteTitle: {
    id: 'clients.inviteIntake.title',
    defaultMessage: 'Add new client',
  },
  inviteSubtitle: {
    id: 'clients.inviteIntake.subtitle',
    defaultMessage: 'Invite — the client registers themselves',
  },
  inviteIntro: {
    id: 'clients.inviteIntake.intro',
    defaultMessage:
      'Three things — enough to address the setup link and know whose record it is. The client supplies their own identity, tax and trading detail on the link, so nothing here is a guess you would have to correct later.',
  },
  inviteCompanyNameLabel: {
    id: 'clients.inviteIntake.companyNameLabel',
    defaultMessage: 'Company name',
  },
  inviteCompanyNamePlaceholder: {
    id: 'clients.inviteIntake.companyNamePlaceholder',
    defaultMessage: 'American Burger Ltd',
  },
  inviteContactNameLabel: {
    id: 'clients.inviteIntake.contactNameLabel',
    defaultMessage: 'Responsible person',
  },
  inviteContactNameHint: {
    id: 'clients.inviteIntake.contactNameHint',
    defaultMessage: 'Whoever signs off — the link and every later chase go to them',
  },
  inviteMobileLabel: {
    id: 'clients.inviteIntake.mobileLabel',
    defaultMessage: 'Mobile number',
  },
  // Two whole sentences rather than one with an inserted clause: the two states
  // say different things, and only one of them has a number to address.
  inviteSmsLinkTo: {
    id: 'clients.inviteIntake.smsLinkTo',
    defaultMessage: 'One setup link to {mobile}',
  },
  inviteSmsLinkPending: {
    id: 'clients.inviteIntake.smsLinkPending',
    defaultMessage: 'One setup link once the three fields are in',
  },
  inviteSmsLinkBody: {
    id: 'clients.inviteIntake.smsLinkBody',
    defaultMessage:
      'It asks them to register the company details — no connections and no logins. Opens in any phone browser and expires in 72 hours.',
  },
  // The three names of what is still empty. They are joined with ', ' at the
  // call site, exactly as before — `formatList` would render "a, b and c" and
  // this is an extraction, not a rewrite.
  inviteMissingCompanyName: {
    id: 'clients.inviteIntake.missingCompanyName',
    defaultMessage: 'company name',
  },
  inviteMissingContactName: {
    id: 'clients.inviteIntake.missingContactName',
    defaultMessage: 'responsible person',
  },
  inviteMissingMobile: {
    id: 'clients.inviteIntake.missingMobile',
    defaultMessage: 'mobile number',
  },
  inviteStillNeeded: {
    id: 'clients.inviteIntake.stillNeeded',
    defaultMessage: 'Still needed before the link can go: {missing}.',
  },
  inviteAddToReview: {
    id: 'clients.inviteIntake.addToReview',
    defaultMessage: 'Add the {missing} to review this invite',
  },
  inviteReviewTitle: {
    id: 'clients.inviteIntake.reviewTitle',
    defaultMessage: 'Invite {name} to register',
  },
  inviteReviewSubtitle: {
    id: 'clients.inviteIntake.reviewSubtitle',
    defaultMessage: 'Client-registered • nothing keyed in by the practice',
  },
  inviteSendingSection: {
    id: 'clients.inviteIntake.sendingSection',
    defaultMessage: 'What you are sending',
  },
  inviteGoesToLabel: {
    id: 'clients.inviteIntake.goesToLabel',
    defaultMessage: 'Goes to',
  },
  inviteLinkExpiresLabel: {
    id: 'clients.inviteIntake.linkExpiresLabel',
    defaultMessage: 'Link expires',
  },
  inviteLinkExpiresValue: {
    id: 'clients.inviteIntake.linkExpiresValue',
    defaultMessage: 'in 72 hours',
  },
  inviteClientDoesSection: {
    id: 'clients.inviteIntake.clientDoesSection',
    defaultMessage: 'What the client does on the link',
  },
  inviteCompanyDetailsLabel: {
    id: 'clients.inviteIntake.companyDetailsLabel',
    defaultMessage: 'Company details',
  },
  inviteClientRegisters: {
    id: 'clients.inviteIntake.clientRegisters',
    defaultMessage: 'Client registers',
  },
  inviteApprovalNote: {
    id: 'clients.inviteIntake.approvalNote',
    defaultMessage:
      'Approving creates the record and queues the setup link — it does not register anything. The client shows as awaiting registration until they finish.',
  },
  inviteApproveLabel: {
    id: 'clients.inviteIntake.approveLabel',
    defaultMessage: 'Approve & send link',
  },
  inviteSuccessMessage: {
    id: 'clients.inviteIntake.successMessage',
    defaultMessage:
      '{name} created and one setup link queued to {mobile} — they register the company details themselves.',
  },
  inviteAuditAction: {
    id: 'clients.inviteIntake.auditAction',
    defaultMessage: 'Invited client to register',
  },

  // PracticeIntake — the six-step record.
  practiceTitle: {
    id: 'clients.practiceIntake.title',
    defaultMessage: 'Add new client',
  },
  practiceStepSubtitle: {
    id: 'clients.practiceIntake.stepSubtitle',
    defaultMessage: 'Step {current} of {total} — {step}',
  },
  practiceStepIdentity: {
    id: 'clients.practiceIntake.stepIdentity',
    defaultMessage: 'Identity',
  },
  practiceStepTax: {
    id: 'clients.practiceIntake.stepTax',
    defaultMessage: 'Tax',
  },
  practiceStepContact: {
    id: 'clients.practiceIntake.stepContact',
    defaultMessage: 'Contact',
  },
  practiceStepBookkeeping: {
    id: 'clients.practiceIntake.stepBookkeeping',
    defaultMessage: 'Bookkeeping',
  },
  practiceStepContext: {
    id: 'clients.practiceIntake.stepContext',
    defaultMessage: 'Context',
  },
  practiceLegalNameLabel: {
    id: 'clients.practiceIntake.legalNameLabel',
    defaultMessage: 'Legal name',
  },
  practiceLegalNamePlaceholder: {
    id: 'clients.practiceIntake.legalNamePlaceholder',
    defaultMessage: 'American Burger Ltd',
  },
  practiceTradingNameLabel: {
    id: 'clients.practiceIntake.tradingNameLabel',
    defaultMessage: 'Trading name',
  },
  practiceTradingNamePlaceholder: {
    id: 'clients.practiceIntake.tradingNamePlaceholder',
    defaultMessage: 'American Burger',
  },
  practiceCrnLabel: {
    id: 'clients.practiceIntake.crnLabel',
    defaultMessage: 'CRN',
  },
  practiceCrnPlaceholder: {
    id: 'clients.practiceIntake.crnPlaceholder',
    defaultMessage: '12345678',
  },
  practiceCrnHint: {
    id: 'clients.practiceIntake.crnHint',
    defaultMessage: 'Auto-fetched from Companies House',
  },
  practiceCompanyTypeLabel: {
    id: 'clients.practiceIntake.companyTypeLabel',
    defaultMessage: 'Company type',
  },
  practiceIndustryLabel: {
    id: 'clients.practiceIntake.industryLabel',
    defaultMessage: 'Industry',
  },
  practiceYearEndLabel: {
    id: 'clients.practiceIntake.yearEndLabel',
    defaultMessage: 'Year-end',
  },
  practiceYearEndPlaceholder: {
    id: 'clients.practiceIntake.yearEndPlaceholder',
    defaultMessage: '31 March',
  },
  practiceCountryLabel: {
    id: 'clients.practiceIntake.countryLabel',
    defaultMessage: 'Country',
  },
  practiceCountryPlaceholder: {
    id: 'clients.practiceIntake.countryPlaceholder',
    defaultMessage: 'United Kingdom',
  },
  practiceCurrencyLabel: {
    id: 'clients.practiceIntake.currencyLabel',
    defaultMessage: 'Base currency',
  },
  practiceCurrencyPlaceholder: {
    id: 'clients.practiceIntake.currencyPlaceholder',
    defaultMessage: 'GBP',
  },
  practiceVatRegisteredLabel: {
    id: 'clients.practiceIntake.vatRegisteredLabel',
    defaultMessage: 'VAT registered',
  },
  practiceVatRegisteredHint: {
    id: 'clients.practiceIntake.vatRegisteredHint',
    defaultMessage: 'VAT numbers are validated against HMRC.',
  },
  practiceVatNumberPlaceholder: {
    id: 'clients.practiceIntake.vatNumberPlaceholder',
    defaultMessage: 'GB 412 8875 21',
  },
  practiceVatSchemeLabel: {
    id: 'clients.practiceIntake.vatSchemeLabel',
    defaultMessage: 'VAT scheme',
  },
  practiceReportingFrequencyLabel: {
    id: 'clients.practiceIntake.reportingFrequencyLabel',
    defaultMessage: 'Reporting frequency',
  },
  practiceContactIntro: {
    id: 'clients.practiceIntake.contactIntro',
    defaultMessage:
      'The mobile number is required — a chase names its recipient by it. The client never installs an app.',
  },
  practiceContactNameLabel: {
    id: 'clients.practiceIntake.contactNameLabel',
    defaultMessage: 'Contact name',
  },
  practiceRolePlaceholder: {
    id: 'clients.practiceIntake.rolePlaceholder',
    defaultMessage: 'Director',
  },
  practiceMobileLabel: {
    id: 'clients.practiceIntake.mobileLabel',
    defaultMessage: 'Mobile number (required)',
  },
  practiceEmailPlaceholder: {
    id: 'clients.practiceIntake.emailPlaceholder',
    defaultMessage: 'john@americanburger.co.uk',
  },
  practiceWhatsappLabel: {
    id: 'clients.practiceIntake.whatsappLabel',
    defaultMessage: 'Submits documents via WhatsApp',
  },
  practiceWhatsappHint: {
    id: 'clients.practiceIntake.whatsappHint',
    defaultMessage: 'Intake only — chasing is always by email.',
  },
  practiceManagedByLabel: {
    id: 'clients.practiceIntake.managedByLabel',
    defaultMessage: 'Managed by',
  },
  practiceFrequencyLabel: {
    id: 'clients.practiceIntake.frequencyLabel',
    defaultMessage: 'Frequency',
  },
  practiceDeadlineLabel: {
    id: 'clients.practiceIntake.deadlineLabel',
    defaultMessage: 'Next deadline',
  },
  practiceDeadlinePlaceholder: {
    id: 'clients.practiceIntake.deadlinePlaceholder',
    defaultMessage: '12 Aug 2026',
  },
  practiceAssigneeLabel: {
    id: 'clients.practiceIntake.assigneeLabel',
    defaultMessage: 'Assignee',
  },
  practiceAssigneePlaceholder: {
    id: 'clients.practiceIntake.assigneePlaceholder',
    defaultMessage: 'You',
  },
  practiceContextIntro: {
    id: 'clients.practiceIntake.contextIntro',
    defaultMessage: 'This feeds the AI directly — it is what stops new-vendor guesses going wrong.',
  },
  practiceSellsLabel: {
    id: 'clients.practiceIntake.sellsLabel',
    defaultMessage: 'What the business sells',
  },
  practiceSellsPlaceholder: {
    id: 'clients.practiceIntake.sellsPlaceholder',
    defaultMessage: 'Burgers, fries, shakes — dine-in and delivery',
  },
  practiceSuppliersLabel: {
    id: 'clients.practiceIntake.suppliersLabel',
    defaultMessage: 'Typical suppliers',
  },
  practiceSuppliersPlaceholder: {
    id: 'clients.practiceIntake.suppliersPlaceholder',
    defaultMessage: 'Bidfood, Brakes, Uber Eats, Costco',
  },
  practiceCardsLabel: {
    id: 'clients.practiceIntake.cardsLabel',
    defaultMessage: 'Company cards / employee spending',
  },
  practiceCardsPlaceholder: {
    id: 'clients.practiceIntake.cardsPlaceholder',
    defaultMessage: '2 Amex cards held by managers',
  },
  practiceUnusualLabel: {
    id: 'clients.practiceIntake.unusualLabel',
    defaultMessage: 'Expected unusual transactions',
  },
  practiceUnusualPlaceholder: {
    id: 'clients.practiceIntake.unusualPlaceholder',
    defaultMessage: 'Quarterly equipment leases',
  },
  practiceBack: {
    id: 'clients.practiceIntake.back',
    defaultMessage: 'Back',
  },
  practiceContinue: {
    id: 'clients.practiceIntake.continue',
    defaultMessage: 'Continue',
  },
  practiceReviewTitle: {
    id: 'clients.practiceIntake.reviewTitle',
    defaultMessage: 'Create {name}',
  },
  practiceReviewTitleUnnamed: {
    id: 'clients.practiceIntake.reviewTitleUnnamed',
    defaultMessage: 'Create new client',
  },
  practiceReviewSubtitle: {
    id: 'clients.practiceIntake.reviewSubtitle',
    defaultMessage: '{industry} • {managedBy}-managed',
  },
  practiceIdentitySection: {
    id: 'clients.practiceIntake.identitySection',
    defaultMessage: 'Identity',
  },
  practiceTaxSection: {
    id: 'clients.practiceIntake.taxSection',
    defaultMessage: 'Tax',
  },
  practiceContactSection: {
    id: 'clients.practiceIntake.contactSection',
    defaultMessage: 'Primary contact',
  },
  practiceLogoLabel: {
    id: 'clients.practiceIntake.logoLabel',
    defaultMessage: 'Logo',
  },
  practiceLogoUploaded: {
    id: 'clients.practiceIntake.logoUploaded',
    defaultMessage: 'Uploaded',
  },
  practiceLogoNone: {
    id: 'clients.practiceIntake.logoNone',
    defaultMessage: 'None',
  },
  practiceYes: {
    id: 'clients.practiceIntake.yes',
    defaultMessage: 'Yes',
  },
  practiceNo: {
    id: 'clients.practiceIntake.no',
    defaultMessage: 'No',
  },
  practiceSchemeLabel: {
    id: 'clients.practiceIntake.schemeLabel',
    defaultMessage: 'Scheme',
  },
  practiceNameLabel: {
    id: 'clients.practiceIntake.nameLabel',
    defaultMessage: 'Name',
  },
  practiceContactNameValue: {
    id: 'clients.practiceIntake.contactNameValue',
    defaultMessage: '{name} ({role})',
  },
  practiceWhatsappRowLabel: {
    id: 'clients.practiceIntake.whatsappRowLabel',
    defaultMessage: 'WhatsApp intake',
  },
  practiceWhatsappOn: {
    id: 'clients.practiceIntake.whatsappOn',
    defaultMessage: 'On',
  },
  practiceWhatsappOff: {
    id: 'clients.practiceIntake.whatsappOff',
    defaultMessage: 'Off',
  },
  practiceNoMobileReviewWarning: {
    id: 'clients.practiceIntake.noMobileReviewWarning',
    defaultMessage: 'No mobile number — chasing will not work until one is added.',
  },
  practiceApproveLabel: {
    id: 'clients.practiceIntake.approveLabel',
    defaultMessage: 'Approve & create',
  },
  practiceSuccessMessage: {
    id: 'clients.practiceIntake.successMessage',
    defaultMessage: '{name} created and ready to use.',
  },
  // The noun the success line falls back to when the name is still empty.
  practiceSuccessFallbackName: {
    id: 'clients.practiceIntake.successFallbackName',
    defaultMessage: 'Client',
  },
  practiceAuditAction: {
    id: 'clients.practiceIntake.auditAction',
    defaultMessage: 'Created client',
  },
  practiceAuditScopeUnnamed: {
    id: 'clients.practiceIntake.auditScopeUnnamed',
    defaultMessage: 'unnamed client',
  },

  // LogoPicker.
  logoPickerLabel: {
    id: 'clients.logoPicker.label',
    defaultMessage: 'Logo',
  },
  logoPickerNotAnImage: {
    id: 'clients.logoPicker.notAnImage',
    defaultMessage: 'That is not an image file.',
  },
  logoPickerTooLarge: {
    id: 'clients.logoPicker.tooLarge',
    defaultMessage: 'Logos must be under 2MB.',
  },
  logoPickerReplace: {
    id: 'clients.logoPicker.replace',
    defaultMessage: 'Replace',
  },
  logoPickerUpload: {
    id: 'clients.logoPicker.upload',
    defaultMessage: 'Upload',
  },
  logoPickerRemove: {
    id: 'clients.logoPicker.remove',
    defaultMessage: 'Remove',
  },
});

/**
 * The six steps, as descriptors rather than strings: a module-scope constant
 * cannot call a hook, so the copy is declared here and formatted at the call
 * site. Typed non-empty for the same reason `Options` is — the rail indexes it
 * by state, and `noUncheckedIndexedAccess` is on.
 */
const STEPS: [MessageDescriptor, ...MessageDescriptor[]] = [
  m.practiceStepIdentity,
  m.practiceStepTax,
  m.practiceStepContact,
  m.practiceStepBookkeeping,
  m.practiceStepContext,
];

/**
 * Who fills the record in. The practice path keys everything in itself; the
 * invite path sends one setup link and the client registers their own details.
 * Neither path asks for a connection of any kind (D47).
 */
type IntakeMode = 'invite' | 'practice';

/** The invite path's link asks for the company record and nothing else. */
const INVITE_TASKS: SetupTask[] = ['profile'];

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
 * uses, rendered inline in chat.
 *
 * Two worlds behind one name (launch M7): with a live session the form is
 * `LiveIntake`, one flow against `POST /v1/businesses` — the server creates
 * the workspace, its contact, its VT integration and the setup invite in one
 * transaction, and the registration email carries the link. Synthetic mode
 * keeps the original two-path demo flow unchanged (METH_MODE §1's standing
 * condition), whose creation goes through the local Review -> Approve theatre.
 */
export function ClientIntakeForm({ defaultName = '' }: { defaultName?: string }) {
  const { session } = useAppContext();
  const [mode, setMode] = useState<IntakeMode | null>(null);

  if (API_ENABLED && session.status === 'authenticated') return <LiveIntake defaultName={defaultName} />;
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
  const intl = useIntl();

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
            title={intl.formatMessage(m.shellChangeTitle)}
            className="shrink-0 flex items-center gap-1.5 px-3.5 py-2 rounded-full text-[12px] font-bold text-zinc-500 hover:text-white hover:bg-white/5 transition-colors"
          >
            <ArrowLeft size={14} />
            {intl.formatMessage(m.shellChange)}
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
  const intl = useIntl();

  return (
    <Shell title={intl.formatMessage(m.modeChooserTitle)} subtitle={intl.formatMessage(m.modeChooserSubtitle)}>
      <div className="p-6 flex flex-col gap-3">
        <ModeOption
          icon={Send}
          name={intl.formatMessage(m.modeChooserInviteName)}
          detail={intl.formatMessage(m.modeChooserInviteDetail)}
          bullets={[
            intl.formatMessage(m.modeChooserInviteBulletFields),
            intl.formatMessage(m.modeChooserInviteBulletOwnRecord),
            intl.formatMessage(m.modeChooserInviteBulletFastest),
          ]}
          onClick={() => onPick('invite')}
        />
        <ModeOption
          icon={PencilLine}
          name={intl.formatMessage(m.modeChooserPracticeName)}
          detail={intl.formatMessage(m.modeChooserPracticeDetail)}
          bullets={[
            intl.formatMessage(m.modeChooserPracticeBulletSteps),
            intl.formatMessage(m.modeChooserPracticeBulletControl),
            intl.formatMessage(m.modeChooserPracticeBulletPaperwork),
          ]}
          onClick={() => onPick('practice')}
        />

        <div className="flex items-start gap-3 p-4 rounded-2xl border border-white/5 bg-ground/60 shadow-inner mt-1">
          <Link2 size={16} className="text-zinc-500 mt-0.5 shrink-0" />
          <div className="min-w-0">
            <div className="text-[13px] font-bold text-white">
              {intl.formatMessage(m.modeChooserConnectionsHeading)}
            </div>
            <p className="text-[12px] text-zinc-500 mt-1 leading-relaxed">
              {intl.formatMessage(m.modeChooserConnectionsBody)}
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
 * The invite path: the three things needed to address a setup link, and nothing else.
 * Everything the practice would otherwise key in is asked of the client on the
 * link, so asking for it here as well would only be a second guess at it.
 */
function InviteIntake({ defaultName, onBack }: { defaultName: string; onBack: () => void }) {
  const { addClient, sendOnboardingLink } = useAppContext();
  const [form, setForm] = useState({ name: defaultName, contactName: '', mobile: '' });
  const intl = useIntl();

  const set = <K extends keyof typeof form>(key: K, value: (typeof form)[K]) =>
    setForm((f) => ({ ...f, [key]: value }));

  const name = form.name.trim();
  const contactName = form.contactName.trim();
  const mobile = form.mobile.trim();
  const missing = [
    ...(name ? [] : [intl.formatMessage(m.inviteMissingCompanyName)]),
    ...(contactName ? [] : [intl.formatMessage(m.inviteMissingContactName)]),
    ...(mobile ? [] : [intl.formatMessage(m.inviteMissingMobile)]),
  ];
  const ready = missing.length === 0;

  return (
    <Shell
      title={name || intl.formatMessage(m.inviteTitle)}
      subtitle={intl.formatMessage(m.inviteSubtitle)}
      onBack={onBack}
    >
      <div className="p-6">
        <motion.div initial={{ opacity: 0, x: 10 }} animate={{ opacity: 1, x: 0 }} className="flex flex-col gap-4">
          <p className="text-[13px] text-zinc-500 leading-relaxed">{intl.formatMessage(m.inviteIntro)}</p>
          <Field
            label={intl.formatMessage(m.inviteCompanyNameLabel)}
            value={form.name}
            onChange={(v) => set('name', v)}
            placeholder={intl.formatMessage(m.inviteCompanyNamePlaceholder)}
          />
          <Field
            label={intl.formatMessage(m.inviteContactNameLabel)}
            value={form.contactName}
            onChange={(v) => set('contactName', v)}
            placeholder={intl.formatMessage(commonPlaceholders.personName)}
            hint={intl.formatMessage(m.inviteContactNameHint)}
          />
          <Field
            label={intl.formatMessage(m.inviteMobileLabel)}
            value={form.mobile}
            onChange={(v) => set('mobile', v)}
            placeholder={intl.formatMessage(commonPlaceholders.ukMobile)}
          />

          <div className="flex items-start gap-3 p-4 rounded-2xl border border-white/5 bg-ground/60 shadow-inner">
            <Smartphone size={16} className="text-zinc-500 mt-0.5 shrink-0" />
            <div className="min-w-0">
              <div className="text-[13px] font-bold text-white">
                {ready ? intl.formatMessage(m.inviteSmsLinkTo, { mobile }) : intl.formatMessage(m.inviteSmsLinkPending)}
              </div>
              <p className="text-[12px] text-zinc-500 mt-1 leading-relaxed">
                {intl.formatMessage(m.inviteSmsLinkBody)}
              </p>
            </div>
          </div>

          {!ready && (
            <p className="text-[13px] text-amber-400 font-semibold">
              {intl.formatMessage(m.inviteStillNeeded, { missing: missing.join(', ') })}
            </p>
          )}
        </motion.div>
      </div>

      <div className="p-4 bg-raised/50">
        {/* No review card until the link is actually sendable — approving a
            half-filled invite would create a record and queue a setup link to
            nobody. The three fields are the whole form, so this is not a
            hidden gate. */}
        {!ready ? (
          <div className="flex items-center gap-3 px-5 py-3.5 rounded-full bg-ground/60 border border-white/5 text-[13px] font-bold text-zinc-500">
            <Send size={15} className="shrink-0" />
            {intl.formatMessage(m.inviteAddToReview, { missing: missing.join(', ') })}
          </div>
        ) : (
          <ReviewGate
            icon={Send}
            title={intl.formatMessage(m.inviteReviewTitle, { name })}
            subtitle={intl.formatMessage(m.inviteReviewSubtitle)}
            detail={
              <>
                <ReviewSection title={intl.formatMessage(m.inviteSendingSection)}>
                  <ReviewRows
                    rows={[
                      { label: intl.formatMessage(m.inviteCompanyNameLabel), value: name },
                      { label: intl.formatMessage(m.inviteContactNameLabel), value: contactName },
                      { label: intl.formatMessage(m.inviteGoesToLabel), value: mobile },
                      {
                        label: intl.formatMessage(m.inviteLinkExpiresLabel),
                        value: intl.formatMessage(m.inviteLinkExpiresValue),
                      },
                    ]}
                  />
                </ReviewSection>
                <ReviewSection title={intl.formatMessage(m.inviteClientDoesSection)}>
                  <ReviewRows
                    rows={[
                      {
                        label: intl.formatMessage(m.inviteCompanyDetailsLabel),
                        value: <Pill tone="amber">{intl.formatMessage(m.inviteClientRegisters)}</Pill>,
                      },
                    ]}
                  />
                  <p className="text-[12px] text-zinc-500 leading-relaxed mt-3">
                    {intl.formatMessage(m.inviteApprovalNote)}
                  </p>
                </ReviewSection>
              </>
            }
            approveLabel={intl.formatMessage(m.inviteApproveLabel)}
            successMessage={intl.formatMessage(m.inviteSuccessMessage, { name, mobile })}
            auditAction={intl.formatMessage(m.inviteAuditAction)}
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

/** The full five-step record, keyed in by the practice. */
function PracticeIntake({ defaultName, onBack }: { defaultName: string; onBack: () => void }) {
  const { addClient } = useAppContext();
  const [step, setStep] = useState(0);
  const intl = useIntl();

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


  return (
    <Shell
      title={form.name.trim() || intl.formatMessage(m.practiceTitle)}
      subtitle={intl.formatMessage(m.practiceStepSubtitle, {
        current: step + 1,
        total: STEPS.length,
        step: intl.formatMessage(STEPS[step] ?? STEPS[0]),
      })}
      onBack={onBack}
    >
      {/* Step rail */}
      <div className="px-6 pt-5 flex items-center gap-1.5">
        {STEPS.map((s, i) => (
          <button
            key={s.id}
            type="button"
            onClick={() => setStep(i)}
            title={intl.formatMessage(s)}
            aria-label={intl.formatMessage(m.shellStepLabel, { number: i + 1, name: intl.formatMessage(s) })}
            {...(i === step ? { 'aria-current': 'step' as const } : {})}
            className="flex-1 py-3 -my-3 group"
          >
            {/* The bar is 4px; the button around it is 24px. A 4px tap target
                is unhittable with a thumb, and growing the bar would make the
                progress rail look like a scrubber. */}
            <span className={`block h-1 rounded-full transition-all ${i <= step ? 'bg-brand' : 'bg-white/10 group-hover:bg-white/20'}`} />
          </button>
        ))}
      </div>

      <div className="p-6">
        <motion.div key={step} initial={{ opacity: 0, x: 10 }} animate={{ opacity: 1, x: 0 }} className="flex flex-col gap-4">
          {step === 0 && (
            <>
              <LogoPicker value={form.logoDataUrl} onChange={(v) => set('logoDataUrl', v)} name={form.name} />
              <Field
                label={intl.formatMessage(m.practiceLegalNameLabel)}
                value={form.name}
                onChange={(v) => set('name', v)}
                placeholder={intl.formatMessage(m.practiceLegalNamePlaceholder)}
              />
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <Field
                  label={intl.formatMessage(m.practiceTradingNameLabel)}
                  value={form.tradingName}
                  onChange={(v) => set('tradingName', v)}
                  placeholder={intl.formatMessage(m.practiceTradingNamePlaceholder)}
                />
                <Field
                  label={intl.formatMessage(m.practiceCrnLabel)}
                  value={form.crn}
                  onChange={(v) => set('crn', v)}
                  placeholder={intl.formatMessage(m.practiceCrnPlaceholder)}
                  hint={intl.formatMessage(m.practiceCrnHint)}
                />
              </div>
              <Select
                label={intl.formatMessage(m.practiceCompanyTypeLabel)}
                value={form.companyType}
                onChange={(v) => set('companyType', v)}
                options={COMPANY_TYPES}
              />
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <Select
                  label={intl.formatMessage(m.practiceIndustryLabel)}
                  value={form.industry}
                  onChange={(v) => set('industry', v)}
                  options={INDUSTRIES}
                />
                <Field
                  label={intl.formatMessage(m.practiceYearEndLabel)}
                  value={form.yearEnd}
                  onChange={(v) => set('yearEnd', v)}
                  placeholder={intl.formatMessage(m.practiceYearEndPlaceholder)}
                />
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <Field
                  label={intl.formatMessage(m.practiceCountryLabel)}
                  value={form.country}
                  onChange={(v) => set('country', v)}
                  placeholder={intl.formatMessage(m.practiceCountryPlaceholder)}
                />
                <Field
                  label={intl.formatMessage(m.practiceCurrencyLabel)}
                  value={form.currency}
                  onChange={(v) => set('currency', v)}
                  placeholder={intl.formatMessage(m.practiceCurrencyPlaceholder)}
                />
              </div>
            </>
          )}

          {step === 1 && (
            <>
              <Toggle
                label={intl.formatMessage(m.practiceVatRegisteredLabel)}
                hint={intl.formatMessage(m.practiceVatRegisteredHint)}
                value={form.vatRegistered}
                onChange={(v) => set('vatRegistered', v)}
              />
              {form.vatRegistered && (
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <Field
                    label={intl.formatMessage(commonLabels.vatNumber)}
                    value={form.vatNumber}
                    onChange={(v) => set('vatNumber', v)}
                    placeholder={intl.formatMessage(m.practiceVatNumberPlaceholder)}
                  />
                  <Select
                    label={intl.formatMessage(m.practiceVatSchemeLabel)}
                    value={form.vatScheme}
                    onChange={(v) => set('vatScheme', v)}
                    options={VAT_SCHEMES}
                  />
                </div>
              )}
              <Select
                label={intl.formatMessage(m.practiceReportingFrequencyLabel)}
                value={form.frequency}
                onChange={(v) => set('frequency', v)}
                options={FREQUENCIES}
              />
            </>
          )}

          {step === 2 && (
            <>
              <p className="text-[13px] text-zinc-500 leading-relaxed">
                {intl.formatMessage(m.practiceContactIntro)}
              </p>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <Field
                  label={intl.formatMessage(m.practiceContactNameLabel)}
                  value={form.contactName}
                  onChange={(v) => set('contactName', v)}
                  placeholder={intl.formatMessage(commonPlaceholders.personName)}
                />
                <Field
                  label={intl.formatMessage(commonLabels.role)}
                  value={form.contactRole}
                  onChange={(v) => set('contactRole', v)}
                  placeholder={intl.formatMessage(m.practiceRolePlaceholder)}
                />
              </div>
              <Field
                label={intl.formatMessage(m.practiceMobileLabel)}
                value={form.mobile}
                onChange={(v) => set('mobile', v)}
                placeholder={intl.formatMessage(commonPlaceholders.ukMobile)}
              />
              <Field
                label={intl.formatMessage(commonLabels.email)}
                value={form.email}
                onChange={(v) => set('email', v)}
                placeholder={intl.formatMessage(m.practiceEmailPlaceholder)}
              />
              <Toggle
                label={intl.formatMessage(m.practiceWhatsappLabel)}
                hint={intl.formatMessage(m.practiceWhatsappHint)}
                value={form.whatsappIntake}
                onChange={(v) => set('whatsappIntake', v)}
              />
            </>
          )}

          {step === 3 && (
            <>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <Select
                  label={intl.formatMessage(m.practiceManagedByLabel)}
                  value={form.managedBy}
                  onChange={(v) => set('managedBy', v)}
                  options={['Practice', 'Client']}
                />
                <Select
                  label={intl.formatMessage(m.practiceFrequencyLabel)}
                  value={form.frequency}
                  onChange={(v) => set('frequency', v)}
                  options={FREQUENCIES}
                />
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <Field
                  label={intl.formatMessage(m.practiceDeadlineLabel)}
                  value={form.deadline}
                  onChange={(v) => set('deadline', v)}
                  placeholder={intl.formatMessage(m.practiceDeadlinePlaceholder)}
                />
                <Field
                  label={intl.formatMessage(m.practiceAssigneeLabel)}
                  value={form.assignee}
                  onChange={(v) => set('assignee', v)}
                  placeholder={intl.formatMessage(m.practiceAssigneePlaceholder)}
                />
              </div>
            </>
          )}

          {step === 4 && (
            <>
              <p className="text-[13px] text-zinc-500 leading-relaxed">
                {intl.formatMessage(m.practiceContextIntro)}
              </p>
              <Field
                label={intl.formatMessage(m.practiceSellsLabel)}
                value={form.sells}
                onChange={(v) => set('sells', v)}
                placeholder={intl.formatMessage(m.practiceSellsPlaceholder)}
              />
              <Field
                label={intl.formatMessage(m.practiceSuppliersLabel)}
                value={form.suppliers}
                onChange={(v) => set('suppliers', v)}
                placeholder={intl.formatMessage(m.practiceSuppliersPlaceholder)}
              />
              <Field
                label={intl.formatMessage(m.practiceCardsLabel)}
                value={form.cards}
                onChange={(v) => set('cards', v)}
                placeholder={intl.formatMessage(m.practiceCardsPlaceholder)}
              />
              <Field
                label={intl.formatMessage(m.practiceUnusualLabel)}
                value={form.unusual}
                onChange={(v) => set('unusual', v)}
                placeholder={intl.formatMessage(m.practiceUnusualPlaceholder)}
              />
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
            {intl.formatMessage(m.practiceBack)}
          </button>
          <button
            onClick={() => setStep((s) => Math.min(s + 1, STEPS.length - 1))}
            className="flex items-center gap-2 px-6 py-2.5 text-sm font-bold text-white bg-brand hover:bg-brand-hover rounded-full transition-all shadow-glow-btn-strong"
          >
            {intl.formatMessage(m.practiceContinue)}
            <ChevronRight size={16} strokeWidth={2.5} />
          </button>
        </div>
      ) : (
        <div className="p-4 bg-raised/50 flex flex-col gap-3">
          <button
            onClick={() => setStep((s) => Math.max(s - 1, 0))}
            className="self-start px-5 py-2.5 text-sm font-bold text-zinc-400 hover:text-white hover:bg-white/5 rounded-full transition-colors"
          >
            {intl.formatMessage(m.practiceBack)}
          </button>
          <ReviewGate
            icon={Building2}
            title={
              form.name.trim()
                ? intl.formatMessage(m.practiceReviewTitle, { name: form.name.trim() })
                : intl.formatMessage(m.practiceReviewTitleUnnamed)
            }
            subtitle={intl.formatMessage(m.practiceReviewSubtitle, {
              industry: form.industry,
              managedBy: form.managedBy,
            })}
            detail={
              <>
                <ReviewSection title={intl.formatMessage(m.practiceIdentitySection)}>
                  <ReviewRows
                    rows={[
                      { label: intl.formatMessage(m.practiceLegalNameLabel), value: form.name.trim() || '—' },
                      { label: intl.formatMessage(m.practiceTradingNameLabel), value: form.tradingName.trim() || '—' },
                      { label: intl.formatMessage(m.practiceCrnLabel), value: form.crn.trim() || '—' },
                      { label: intl.formatMessage(m.practiceCompanyTypeLabel), value: form.companyType },
                      { label: intl.formatMessage(m.practiceIndustryLabel), value: form.industry },
                      {
                        label: intl.formatMessage(m.practiceLogoLabel),
                        value: form.logoDataUrl ? (
                          <Pill tone="blue">{intl.formatMessage(m.practiceLogoUploaded)}</Pill>
                        ) : (
                          intl.formatMessage(m.practiceLogoNone)
                        ),
                      },
                      { label: intl.formatMessage(m.practiceYearEndLabel), value: form.yearEnd },
                      { label: intl.formatMessage(m.practiceCurrencyLabel), value: form.currency },
                    ]}
                  />
                </ReviewSection>
                <ReviewSection title={intl.formatMessage(m.practiceTaxSection)}>
                  <ReviewRows
                    rows={[
                      {
                        label: intl.formatMessage(m.practiceVatRegisteredLabel),
                        value: form.vatRegistered ? intl.formatMessage(m.practiceYes) : intl.formatMessage(m.practiceNo),
                      },
                      { label: intl.formatMessage(commonLabels.vatNumber), value: form.vatNumber.trim() || '—' },
                      { label: intl.formatMessage(m.practiceSchemeLabel), value: form.vatScheme },
                      { label: intl.formatMessage(m.practiceFrequencyLabel), value: form.frequency },
                    ]}
                  />
                </ReviewSection>
                <ReviewSection title={intl.formatMessage(m.practiceContactSection)}>
                  <ReviewRows
                    rows={[
                      {
                        label: intl.formatMessage(m.practiceNameLabel),
                        value: intl.formatMessage(m.practiceContactNameValue, {
                          name: form.contactName.trim() || '—',
                          role: form.contactRole,
                        }),
                      },
                      { label: intl.formatMessage(commonLabels.mobile), value: form.mobile.trim() || '—' },
                      { label: intl.formatMessage(commonLabels.email), value: form.email.trim() || '—' },
                      {
                        label: intl.formatMessage(m.practiceWhatsappRowLabel),
                        value: form.whatsappIntake ? (
                          <Pill tone="blue">{intl.formatMessage(m.practiceWhatsappOn)}</Pill>
                        ) : (
                          intl.formatMessage(m.practiceWhatsappOff)
                        ),
                      },
                    ]}
                  />
                </ReviewSection>
                {!form.mobile.trim() && (
                  <p className="text-[13px] text-amber-400 font-semibold">
                    {intl.formatMessage(m.practiceNoMobileReviewWarning)}
                  </p>
                )}
              </>
            }
            approveLabel={intl.formatMessage(m.practiceApproveLabel)}
            successMessage={intl.formatMessage(m.practiceSuccessMessage, {
              name: form.name.trim() || intl.formatMessage(m.practiceSuccessFallbackName),
            })}
            auditAction={intl.formatMessage(m.practiceAuditAction)}
            auditScope={form.name.trim() || intl.formatMessage(m.practiceAuditScopeUnnamed)}
            onApprove={() => {
              const client = {
                id: `client-${Date.now()}`,
                name: form.name.trim() || 'New client',
                industry: form.industry,
                health: 100,
                missingDocs: 0,
                toReview: 0,
                deadline: form.deadline.trim() || '—',
                // Always false at creation: statements are the only bank input.
                bankConnected: false,
                contactName: form.contactName.trim(),
                mobile: form.mobile.trim(),
                vatNumber: form.vatNumber.trim(),
                companyType: form.companyType,
                logoDataUrl: form.logoDataUrl || undefined,
              };
              addClient(client);
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

/** Logo upload — held as a data URI so it survives without a file server. */
function LogoPicker({ value, onChange, name }: { value: string; onChange: (v: string) => void; name: string }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [error, setError] = useState('');
  const intl = useIntl();

  const pick = (file?: File) => {
    if (!file) return;
    if (!file.type.startsWith('image/')) {
      setError(intl.formatMessage(m.logoPickerNotAnImage));
      return;
    }
    if (file.size > 2 * 1024 * 1024) {
      setError(intl.formatMessage(m.logoPickerTooLarge));
      return;
    }
    setError('');
    const reader = new FileReader();
    reader.onload = () => onChange(String(reader.result));
    reader.readAsDataURL(file);
  };

  return (
    <div>
      <div className="text-[11px] font-bold text-zinc-500 uppercase tracking-widest mb-2">
        {intl.formatMessage(m.logoPickerLabel)}
      </div>
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
            {value ? intl.formatMessage(m.logoPickerReplace) : intl.formatMessage(m.logoPickerUpload)}
          </button>
          {value && (
            <button
              onClick={() => onChange('')}
              className="flex items-center gap-1.5 px-3 py-2 rounded-full text-[13px] font-bold text-zinc-500 hover:text-white transition-colors"
            >
              <X size={14} />
              {intl.formatMessage(m.logoPickerRemove)}
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

/**
 * Copy for the live intake (launch M7). The registration is by EMAIL — the
 * client signs in with a six-digit code we email them (M6); nothing here may
 * say "text" or "SMS", because ID sends none. And per D47 the flow asks for
 * no bank connection and no accounting-software connection, which the strict
 * contract body makes structural rather than a promise.
 */
const mLive = defineMessages({
  title: { id: 'clients.liveIntake.title', defaultMessage: 'Add new client' },
  stepSubtitle: {
    id: 'clients.liveIntake.stepSubtitle',
    defaultMessage: 'Step {current} of {total} — {step}',
  },
  stepCompany: { id: 'clients.liveIntake.stepCompany', defaultMessage: 'Company' },
  stepContact: { id: 'clients.liveIntake.stepContact', defaultMessage: 'Contact' },
  stepProfile: { id: 'clients.liveIntake.stepProfile', defaultMessage: 'Business type' },

  // Step 1 — company.
  legalNameLabel: { id: 'clients.liveIntake.legalNameLabel', defaultMessage: 'Legal name' },
  legalNamePlaceholder: { id: 'clients.liveIntake.legalNamePlaceholder', defaultMessage: 'Sparkle Cleaning Ltd' },
  tradingNameLabel: { id: 'clients.liveIntake.tradingNameLabel', defaultMessage: 'Trading name' },
  tradingNamePlaceholder: { id: 'clients.liveIntake.tradingNamePlaceholder', defaultMessage: 'Sparkle' },
  companyNumberLabel: { id: 'clients.liveIntake.companyNumberLabel', defaultMessage: 'Company number' },
  companyNumberPlaceholder: { id: 'clients.liveIntake.companyNumberPlaceholder', defaultMessage: '12345678' },
  industryLabel: { id: 'clients.liveIntake.industryLabel', defaultMessage: 'Industry' },
  industryPlaceholder: { id: 'clients.liveIntake.industryPlaceholder', defaultMessage: 'Commercial cleaning' },
  vatRegisteredLabel: { id: 'clients.liveIntake.vatRegisteredLabel', defaultMessage: 'VAT registered' },
  vatNumberPlaceholder: { id: 'clients.liveIntake.vatNumberPlaceholder', defaultMessage: 'GB 412 8875 21' },

  // Step 2 — the primary contact, who the registration email goes to.
  contactIntro: {
    id: 'clients.liveIntake.contactIntro',
    defaultMessage:
      'The registration email goes to this person. They sign in with a six-digit code we email them, register the company details themselves, and complete their own onboarding — including the subscription.',
  },
  firstNameLabel: { id: 'clients.liveIntake.firstNameLabel', defaultMessage: 'First name' },
  lastNameLabel: { id: 'clients.liveIntake.lastNameLabel', defaultMessage: 'Last name' },
  emailHint: {
    id: 'clients.liveIntake.emailHint',
    defaultMessage: 'Their registered address — the sign-in link, the codes and every request go here.',
  },
  emailPlaceholder: { id: 'clients.liveIntake.emailPlaceholder', defaultMessage: 'priya@sparklecleaning.co.uk' },
  mobileLabel: { id: 'clients.liveIntake.mobileLabel', defaultMessage: 'Mobile (optional)' },
  mobileHint: {
    id: 'clients.liveIntake.mobileHint',
    defaultMessage: 'Include the country code, like +44 7700 900123.',
  },

  // Step 3 — the business-type profile, §24.4's whole weight.
  profileIntro: {
    id: 'clients.liveIntake.profileIntro',
    defaultMessage:
      'This is the only context the AI gets when it codes this client’s documents — there is no connected chart of accounts. One honest sentence is worth more than a category.',
  },
  activityLabel: { id: 'clients.liveIntake.activityLabel', defaultMessage: 'What the business does' },
  activityPlaceholder: {
    id: 'clients.liveIntake.activityPlaceholder',
    defaultMessage: 'Commercial cleaning for offices and schools',
  },
  suppliersLabel: { id: 'clients.liveIntake.suppliersLabel', defaultMessage: 'Typical suppliers' },
  suppliersPlaceholder: { id: 'clients.liveIntake.suppliersPlaceholder', defaultMessage: 'Nisbets, Costco' },
  suppliersHint: {
    id: 'clients.liveIntake.suppliersHint',
    defaultMessage: 'Comma-separated. Supplier coding rules are seeded from these.',
  },
  costsLabel: { id: 'clients.liveIntake.costsLabel', defaultMessage: 'Typical costs' },
  costsPlaceholder: { id: 'clients.liveIntake.costsPlaceholder', defaultMessage: 'Cleaning materials, wages, fuel' },
  costsHint: {
    id: 'clients.liveIntake.costsHint',
    defaultMessage: 'Comma-separated. The chart of accounts is seeded from these.',
  },
  hasEmployeesLabel: { id: 'clients.liveIntake.hasEmployeesLabel', defaultMessage: 'Employees' },
  usesSubcontractorsLabel: { id: 'clients.liveIntake.usesSubcontractorsLabel', defaultMessage: 'Subcontractors' },
  triUnknown: { id: 'clients.liveIntake.triUnknown', defaultMessage: 'Not sure' },
  triYes: { id: 'clients.liveIntake.triYes', defaultMessage: 'Yes' },
  triNo: { id: 'clients.liveIntake.triNo', defaultMessage: 'No' },
  notesLabel: { id: 'clients.liveIntake.notesLabel', defaultMessage: 'Anything else' },
  notesPlaceholder: {
    id: 'clients.liveIntake.notesPlaceholder',
    defaultMessage: 'Anything else the coding should know — leases, tills, seasonal work…',
  },

  // The still-needed line, invite-style: names joined with ', ' at the call site.
  missingName: { id: 'clients.liveIntake.missingName', defaultMessage: 'company name' },
  missingFirstName: { id: 'clients.liveIntake.missingFirstName', defaultMessage: 'contact first name' },
  missingLastName: { id: 'clients.liveIntake.missingLastName', defaultMessage: 'contact last name' },
  missingEmail: { id: 'clients.liveIntake.missingEmail', defaultMessage: 'contact email' },
  missingActivity: { id: 'clients.liveIntake.missingActivity', defaultMessage: 'what the business does' },
  stillNeeded: {
    id: 'clients.liveIntake.stillNeeded',
    defaultMessage: 'Still needed before this client can be created: {missing}.',
  },

  // The review before the one real call.
  reviewCompanySection: { id: 'clients.liveIntake.reviewCompanySection', defaultMessage: 'Company' },
  reviewContactSection: { id: 'clients.liveIntake.reviewContactSection', defaultMessage: 'Primary contact' },
  reviewProfileSection: { id: 'clients.liveIntake.reviewProfileSection', defaultMessage: 'Business type' },
  reviewVatValue: { id: 'clients.liveIntake.reviewVatValue', defaultMessage: 'Yes — {number}' },
  reviewContactValue: { id: 'clients.liveIntake.reviewContactValue', defaultMessage: '{firstName} {lastName}' },
  noConnectionsNote: {
    id: 'clients.liveIntake.noConnectionsNote',
    defaultMessage:
      'No bank connection and no accounting-software connection is asked for, at any point. Documents arrive by upload, email and the portal.',
  },
  createNote: {
    id: 'clients.liveIntake.createNote',
    defaultMessage:
      'Creating the client emails {email} a secure registration link. Nothing else is sent, and nothing is asked of them here.',
  },
  createLabel: { id: 'clients.liveIntake.createLabel', defaultMessage: 'Create client & email the sign-in link' },
  creatingLabel: { id: 'clients.liveIntake.creatingLabel', defaultMessage: 'Creating…' },
  mobileRefused: {
    id: 'clients.liveIntake.mobileRefused',
    defaultMessage: 'Enter the mobile with its country code, like +44 7700 900123 — or leave it empty.',
  },
  contractRefused: {
    id: 'clients.liveIntake.contractRefused',
    defaultMessage: 'This cannot be sent yet — {detail}',
  },

  // Success — what actually happened, and what happens next.
  successTitle: { id: 'clients.liveIntake.successTitle', defaultMessage: '{name} added' },
  successSubtitle: { id: 'clients.liveIntake.successSubtitle', defaultMessage: 'Registration email sent' },
  successBody: {
    id: 'clients.liveIntake.successBody',
    defaultMessage:
      'We’ve emailed {email} a secure link. {firstName} signs in with a six-digit code we email them, registers the company details, and completes their own onboarding — including the subscription.',
  },
  successUntil: {
    id: 'clients.liveIntake.successUntil',
    defaultMessage: 'Until they finish, the client is listed here as awaiting onboarding.',
  },
  addAnother: { id: 'clients.liveIntake.addAnother', defaultMessage: 'Add another client' },
});

const LIVE_STEPS: [MessageDescriptor, ...MessageDescriptor[]] = [
  mLive.stepCompany,
  mLive.stepContact,
  mLive.stepProfile,
];

const EMPTY_DRAFT: Omit<IntakeDraft, 'name'> = {
  tradingName: '',
  companyNumber: '',
  industry: '',
  vatRegistered: false,
  vatNumber: '',
  firstName: '',
  lastName: '',
  email: '',
  mobile: '',
  businessActivity: '',
  typicalSuppliers: '',
  typicalCosts: '',
  hasEmployees: 'unknown',
  usesSubcontractors: 'unknown',
  notes: '',
};

/**
 * The live intake (launch M7): one flow, three steps, one call.
 *
 * `POST /v1/businesses` is `x-nt-side-effect: ingest`, not a proposal — it
 * creates records and changes the state of nothing that exists, so there is
 * no Review → Approve here and no `ReviewGate` theatre pretending there is.
 * What stands in front of the call instead is the full read-back of exactly
 * what will be sent, and a client-side refusal (`buildIntakeRequest`) for
 * anything the contract itself would refuse.
 */
function LiveIntake({ defaultName }: { defaultName: string }) {
  const { refetchBusinesses } = useAppContext();
  const intl = useIntl();
  const [step, setStep] = useState(0);
  const [draft, setDraft] = useState<IntakeDraft>({ name: defaultName, ...EMPTY_DRAFT });
  const [sending, setSending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [created, setCreated] = useState<CreatedBusiness | null>(null);

  const set = <K extends keyof IntakeDraft>(key: K, value: IntakeDraft[K]) =>
    setDraft((d) => ({ ...d, [key]: value }));

  const missing = [
    ...(draft.name.trim() ? [] : [intl.formatMessage(mLive.missingName)]),
    ...(draft.firstName.trim() ? [] : [intl.formatMessage(mLive.missingFirstName)]),
    ...(draft.lastName.trim() ? [] : [intl.formatMessage(mLive.missingLastName)]),
    ...(draft.email.trim() ? [] : [intl.formatMessage(mLive.missingEmail)]),
    ...(draft.businessActivity.trim().length >= 3 ? [] : [intl.formatMessage(mLive.missingActivity)]),
  ];
  const ready = missing.length === 0;
  const isLast = step === LIVE_STEPS.length - 1;

  const submit = async () => {
    const built = buildIntakeRequest(draft);
    if (!built.ok) {
      setFailure(
        built.refusal.reason === 'mobileNotE164'
          ? intl.formatMessage(mLive.mobileRefused)
          : intl.formatMessage(mLive.contractRefused, { detail: built.refusal.detail }),
      );
      return;
    }
    setFailure(null);
    setSending(true);
    try {
      setCreated(await submitClientIntake(built.request));
      refetchBusinesses();
    } catch (error) {
      setFailure(errorLabel(error));
    } finally {
      setSending(false);
    }
  };

  if (created) {
    return (
      <Shell
        title={intl.formatMessage(mLive.successTitle, { name: created.name })}
        subtitle={intl.formatMessage(mLive.successSubtitle)}
      >
        <div className="p-6 flex flex-col gap-4">
          <div className="flex items-start gap-3 p-4 rounded-2xl border border-white/5 bg-ground/60 shadow-inner">
            <CheckCircle2 size={18} className="text-brand mt-0.5 shrink-0" />
            <p className="text-[13px] text-zinc-300 leading-relaxed min-w-0">
              {intl.formatMessage(mLive.successBody, {
                email: draft.email.trim(),
                firstName: draft.firstName.trim(),
              })}
            </p>
          </div>
          <p className="text-[12px] text-zinc-500 leading-relaxed">{intl.formatMessage(mLive.successUntil)}</p>
          <button
            onClick={() => {
              setCreated(null);
              setDraft({ name: '', ...EMPTY_DRAFT });
              setStep(0);
            }}
            className="self-start flex items-center gap-2 px-6 py-2.5 text-sm font-bold text-white bg-brand hover:bg-brand-hover rounded-full transition-all shadow-glow-btn-soft"
          >
            <Mail size={15} />
            {intl.formatMessage(mLive.addAnother)}
          </button>
        </div>
      </Shell>
    );
  }

  return (
    <Shell
      title={draft.name.trim() || intl.formatMessage(mLive.title)}
      subtitle={intl.formatMessage(mLive.stepSubtitle, {
        current: step + 1,
        total: LIVE_STEPS.length,
        step: intl.formatMessage(LIVE_STEPS[step] ?? LIVE_STEPS[0]),
      })}
    >
      {/* The same step rail the practice flow draws — same 4px bar, same 24px target. */}
      <div className="px-6 pt-5 flex items-center gap-1.5">
        {LIVE_STEPS.map((s, i) => (
          <button
            key={s.id}
            type="button"
            onClick={() => setStep(i)}
            title={intl.formatMessage(s)}
            aria-label={intl.formatMessage(m.shellStepLabel, { number: i + 1, name: intl.formatMessage(s) })}
            {...(i === step ? { 'aria-current': 'step' as const } : {})}
            className="flex-1 py-3 -my-3 group"
          >
            <span className={`block h-1 rounded-full transition-all ${i <= step ? 'bg-brand' : 'bg-white/10 group-hover:bg-white/20'}`} />
          </button>
        ))}
      </div>

      <div className="p-6">
        <motion.div key={step} initial={{ opacity: 0, x: 10 }} animate={{ opacity: 1, x: 0 }} className="flex flex-col gap-4">
          {step === 0 && (
            <>
              <Field
                label={intl.formatMessage(mLive.legalNameLabel)}
                value={draft.name}
                onChange={(v) => set('name', v)}
                placeholder={intl.formatMessage(mLive.legalNamePlaceholder)}
              />
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <Field
                  label={intl.formatMessage(mLive.tradingNameLabel)}
                  value={draft.tradingName}
                  onChange={(v) => set('tradingName', v)}
                  placeholder={intl.formatMessage(mLive.tradingNamePlaceholder)}
                />
                <Field
                  label={intl.formatMessage(mLive.companyNumberLabel)}
                  value={draft.companyNumber}
                  onChange={(v) => set('companyNumber', v)}
                  placeholder={intl.formatMessage(mLive.companyNumberPlaceholder)}
                />
              </div>
              <Field
                label={intl.formatMessage(mLive.industryLabel)}
                value={draft.industry}
                onChange={(v) => set('industry', v)}
                placeholder={intl.formatMessage(mLive.industryPlaceholder)}
              />
              <Toggle
                label={intl.formatMessage(mLive.vatRegisteredLabel)}
                value={draft.vatRegistered}
                onChange={(v) => set('vatRegistered', v)}
              />
              {draft.vatRegistered && (
                <Field
                  label={intl.formatMessage(commonLabels.vatNumber)}
                  value={draft.vatNumber}
                  onChange={(v) => set('vatNumber', v)}
                  placeholder={intl.formatMessage(mLive.vatNumberPlaceholder)}
                />
              )}
            </>
          )}

          {step === 1 && (
            <>
              <p className="text-[13px] text-zinc-500 leading-relaxed">{intl.formatMessage(mLive.contactIntro)}</p>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <Field
                  label={intl.formatMessage(mLive.firstNameLabel)}
                  value={draft.firstName}
                  onChange={(v) => set('firstName', v)}
                  placeholder={intl.formatMessage(commonPlaceholders.personName)}
                />
                <Field
                  label={intl.formatMessage(mLive.lastNameLabel)}
                  value={draft.lastName}
                  onChange={(v) => set('lastName', v)}
                />
              </div>
              <Field
                label={intl.formatMessage(commonLabels.email)}
                value={draft.email}
                onChange={(v) => set('email', v)}
                placeholder={intl.formatMessage(mLive.emailPlaceholder)}
                hint={intl.formatMessage(mLive.emailHint)}
              />
              <Field
                label={intl.formatMessage(mLive.mobileLabel)}
                value={draft.mobile}
                onChange={(v) => set('mobile', v)}
                placeholder={intl.formatMessage(commonPlaceholders.ukMobile)}
                hint={intl.formatMessage(mLive.mobileHint)}
              />
            </>
          )}

          {step === 2 && (
            <>
              <p className="text-[13px] text-zinc-500 leading-relaxed">{intl.formatMessage(mLive.profileIntro)}</p>
              <Area
                label={intl.formatMessage(mLive.activityLabel)}
                value={draft.businessActivity}
                onChange={(v) => set('businessActivity', v)}
                placeholder={intl.formatMessage(mLive.activityPlaceholder)}
                maxLength={500}
              />
              <Field
                label={intl.formatMessage(mLive.suppliersLabel)}
                value={draft.typicalSuppliers}
                onChange={(v) => set('typicalSuppliers', v)}
                placeholder={intl.formatMessage(mLive.suppliersPlaceholder)}
                hint={intl.formatMessage(mLive.suppliersHint)}
              />
              <Field
                label={intl.formatMessage(mLive.costsLabel)}
                value={draft.typicalCosts}
                onChange={(v) => set('typicalCosts', v)}
                placeholder={intl.formatMessage(mLive.costsPlaceholder)}
                hint={intl.formatMessage(mLive.costsHint)}
              />
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <TriChoice
                  label={intl.formatMessage(mLive.hasEmployeesLabel)}
                  value={draft.hasEmployees}
                  onChange={(v) => set('hasEmployees', v)}
                />
                <TriChoice
                  label={intl.formatMessage(mLive.usesSubcontractorsLabel)}
                  value={draft.usesSubcontractors}
                  onChange={(v) => set('usesSubcontractors', v)}
                />
              </div>
              <Area
                label={intl.formatMessage(mLive.notesLabel)}
                value={draft.notes}
                onChange={(v) => set('notes', v)}
                placeholder={intl.formatMessage(mLive.notesPlaceholder)}
                maxLength={2000}
              />
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
            {intl.formatMessage(m.practiceBack)}
          </button>
          <button
            onClick={() => setStep((s) => Math.min(s + 1, LIVE_STEPS.length - 1))}
            className="flex items-center gap-2 px-6 py-2.5 text-sm font-bold text-white bg-brand hover:bg-brand-hover rounded-full transition-all shadow-glow-btn-strong"
          >
            {intl.formatMessage(m.practiceContinue)}
            <ChevronRight size={16} strokeWidth={2.5} />
          </button>
        </div>
      ) : (
        <div className="p-4 bg-raised/50 flex flex-col gap-3">
          <button
            onClick={() => setStep((s) => Math.max(s - 1, 0))}
            className="self-start px-5 py-2.5 text-sm font-bold text-zinc-400 hover:text-white hover:bg-white/5 rounded-full transition-colors"
          >
            {intl.formatMessage(m.practiceBack)}
          </button>

          {!ready ? (
            <div className="flex items-center gap-3 px-5 py-3.5 rounded-full bg-ground/60 border border-white/5 text-[13px] font-bold text-zinc-500">
              <Mail size={15} className="shrink-0" />
              {intl.formatMessage(mLive.stillNeeded, { missing: missing.join(', ') })}
            </div>
          ) : (
            <div className="rounded-2xl border border-white/5 bg-ground/60 p-5 flex flex-col gap-4 shadow-inner">
              <ReviewSection title={intl.formatMessage(mLive.reviewCompanySection)}>
                <ReviewRows
                  rows={[
                    { label: intl.formatMessage(mLive.legalNameLabel), value: draft.name.trim() },
                    { label: intl.formatMessage(mLive.tradingNameLabel), value: draft.tradingName.trim() || '—' },
                    { label: intl.formatMessage(mLive.companyNumberLabel), value: draft.companyNumber.trim() || '—' },
                    { label: intl.formatMessage(mLive.industryLabel), value: draft.industry.trim() || '—' },
                    {
                      label: intl.formatMessage(mLive.vatRegisteredLabel),
                      value: draft.vatRegistered
                        ? intl.formatMessage(mLive.reviewVatValue, { number: draft.vatNumber.trim() || '—' })
                        : intl.formatMessage(mLive.triNo),
                    },
                  ]}
                />
              </ReviewSection>
              <ReviewSection title={intl.formatMessage(mLive.reviewContactSection)}>
                <ReviewRows
                  rows={[
                    {
                      label: intl.formatMessage(commonLabels.client),
                      value: intl.formatMessage(mLive.reviewContactValue, {
                        firstName: draft.firstName.trim(),
                        lastName: draft.lastName.trim(),
                      }),
                    },
                    { label: intl.formatMessage(commonLabels.email), value: draft.email.trim() },
                    { label: intl.formatMessage(commonLabels.mobile), value: draft.mobile.trim() || '—' },
                  ]}
                />
              </ReviewSection>
              <ReviewSection title={intl.formatMessage(mLive.reviewProfileSection)}>
                <ReviewRows
                  rows={[
                    { label: intl.formatMessage(mLive.activityLabel), value: draft.businessActivity.trim() },
                    { label: intl.formatMessage(mLive.suppliersLabel), value: draft.typicalSuppliers.trim() || '—' },
                    { label: intl.formatMessage(mLive.costsLabel), value: draft.typicalCosts.trim() || '—' },
                    { label: intl.formatMessage(mLive.hasEmployeesLabel), value: triLabel(intl, draft.hasEmployees) },
                    {
                      label: intl.formatMessage(mLive.usesSubcontractorsLabel),
                      value: triLabel(intl, draft.usesSubcontractors),
                    },
                  ]}
                />
              </ReviewSection>
              <p className="text-[12px] text-zinc-500 leading-relaxed">
                {intl.formatMessage(mLive.noConnectionsNote)}
              </p>
              <p className="text-[12px] text-zinc-500 leading-relaxed">
                {intl.formatMessage(mLive.createNote, { email: draft.email.trim() })}
              </p>
              {failure && (
                <p role="alert" className="text-[13px] text-red-400 font-semibold">
                  {failure}
                </p>
              )}
              <button
                onClick={() => void submit()}
                disabled={sending}
                className="flex items-center justify-center gap-2 px-6 py-3 text-sm font-bold text-white bg-brand hover:bg-brand-hover rounded-full transition-all shadow-glow-btn-strong disabled:opacity-50"
              >
                <Mail size={15} />
                {intl.formatMessage(sending ? mLive.creatingLabel : mLive.createLabel)}
              </button>
            </div>
          )}
        </div>
      )}
    </Shell>
  );
}

function triLabel(intl: ReturnType<typeof useIntl>, value: TriState): string {
  return intl.formatMessage(value === 'yes' ? mLive.triYes : value === 'no' ? mLive.triNo : mLive.triUnknown);
}

/** Three answers, the honest third being "not answered" — which omits the key. */
function TriChoice({
  label,
  value,
  onChange,
}: {
  label: string;
  value: TriState;
  onChange: (v: TriState) => void;
}) {
  const intl = useIntl();
  const options: { key: TriState; text: string }[] = [
    { key: 'unknown', text: intl.formatMessage(mLive.triUnknown) },
    { key: 'yes', text: intl.formatMessage(mLive.triYes) },
    { key: 'no', text: intl.formatMessage(mLive.triNo) },
  ];
  return (
    <div>
      <div className="text-[11px] font-bold text-zinc-500 uppercase tracking-widest mb-2">{label}</div>
      <div className="flex items-center bg-ground border border-white/5 rounded-xl p-1">
        {options.map((o) => (
          <button
            key={o.key}
            type="button"
            aria-pressed={value === o.key}
            onClick={() => onChange(o.key)}
            className={`flex-1 px-3 py-1.5 rounded-lg text-[13px] font-bold transition-all ${
              value === o.key ? 'bg-brand text-white' : 'text-zinc-500 hover:text-white'
            }`}
          >
            {o.text}
          </button>
        ))}
      </div>
    </div>
  );
}

/** `Field`'s multi-line twin, for the two long questionnaire answers. */
function Area({
  label,
  value,
  onChange,
  placeholder,
  hint,
  maxLength,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  hint?: string;
  maxLength?: number;
}) {
  return (
    <div>
      <div className="text-[11px] font-bold text-zinc-500 uppercase tracking-widest mb-2">{label}</div>
      <textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        maxLength={maxLength}
        rows={3}
        className="w-full bg-ground border border-white/5 rounded-xl px-4 py-2.5 text-sm text-white placeholder:text-zinc-600 focus:outline-none focus:border-brand transition-colors resize-none"
      />
      {hint && <div className="text-[11px] text-zinc-600 mt-1.5 font-medium">{hint}</div>}
    </div>
  );
}
