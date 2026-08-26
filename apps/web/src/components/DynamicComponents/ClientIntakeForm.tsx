import { useRef, useState } from 'react';
import { Building2, ChevronRight, Link2, Smartphone, ImagePlus, X, ArrowLeft, Send, PencilLine, Check } from 'lucide-react';
import { motion } from 'motion/react';
import { defineMessages, useIntl } from 'react-intl';
import type { MessageDescriptor } from 'react-intl';
import { useAppContext } from '../../context/AppContext';
import { commonLabels, commonPlaceholders } from '../../i18n/common';
import { ReviewGate, ReviewRows, ReviewSection } from './ReviewGate';
import { Pill } from './DataTable';
import type { SetupTask } from '../../lib/types';

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
    id: 'clients.modeChooser.connectionsHeading',
    defaultMessage: 'Either way, the client connects the accounting software and the bank',
  },
  modeChooserConnectionsBody: {
    id: 'clients.modeChooser.connectionsBody',
    defaultMessage:
      'Both need their own login at the provider, which the practice never holds. One SMS link covers whatever is outstanding.',
  },

  // InviteIntake — three fields and an SMS.
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
      'Three things — enough to address the SMS and know whose record it is. The client supplies their own identity, tax and trading detail on the link, so nothing here is a guess you would have to correct later.',
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
    defaultMessage: 'One SMS link to {mobile}',
  },
  inviteSmsLinkPending: {
    id: 'clients.inviteIntake.smsLinkPending',
    defaultMessage: 'One SMS link once the three fields are in',
  },
  inviteSmsLinkBody: {
    id: 'clients.inviteIntake.smsLinkBody',
    defaultMessage:
      'It asks them to register the company, then connect their accounting software and bank. Opens in any phone browser, expires in 72 hours, and never shares their credentials with you.',
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
  inviteAccountingSoftwareLabel: {
    id: 'clients.inviteIntake.accountingSoftwareLabel',
    defaultMessage: 'Accounting software',
  },
  inviteBankFeedLabel: {
    id: 'clients.inviteIntake.bankFeedLabel',
    defaultMessage: 'Bank feed',
  },
  inviteClientConnects: {
    id: 'clients.inviteIntake.clientConnects',
    defaultMessage: 'Client connects',
  },
  inviteApprovalNote: {
    id: 'clients.inviteIntake.approvalNote',
    defaultMessage:
      'Approving creates the record and queues the SMS — it does not register or connect anything. The client shows as awaiting registration until they finish.',
  },
  inviteApproveLabel: {
    id: 'clients.inviteIntake.approveLabel',
    defaultMessage: 'Approve & send link',
  },
  inviteSuccessMessage: {
    id: 'clients.inviteIntake.successMessage',
    defaultMessage:
      '{name} created and one setup SMS queued to {mobile} — they register the company and connect their accounting software and bank themselves.',
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
  practiceStepClientSetup: {
    id: 'clients.practiceIntake.stepClientSetup',
    defaultMessage: 'Client setup',
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
      'The mobile number is required — it drives SMS chasing and OTP onboarding. The client never installs an app.',
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
    defaultMessage: 'Intake only — chasing is always SMS.',
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
  practiceSetupIntro: {
    id: 'clients.practiceIntake.setupIntro',
    defaultMessage:
      "You can key in everything above yourself. These two you cannot — both need the client's own login at the provider, which the practice never holds. They go out on one SMS link.",
  },
  practiceAccountingSoftwareName: {
    id: 'clients.practiceIntake.accountingSoftwareName',
    defaultMessage: 'Accounting software',
  },
  practiceAccountingSoftwareDetail: {
    id: 'clients.practiceIntake.accountingSoftwareDetail',
    defaultMessage: 'Xero, QuickBooks, Sage or FreeAgent — chart of accounts and tax rates sync both ways',
  },
  practiceBankFeedName: {
    id: 'clients.practiceIntake.bankFeedName',
    defaultMessage: 'Bank feed (open banking)',
  },
  practiceBankFeedDetail: {
    id: 'clients.practiceIntake.bankFeedDetail',
    defaultMessage: 'Read-only — until it is live the client is on the statement-upload fallback',
  },
  practiceSmsLinkTo: {
    id: 'clients.practiceIntake.smsLinkTo',
    defaultMessage: 'One SMS link to {mobile}',
  },
  practiceSmsLinkToClient: {
    id: 'clients.practiceIntake.smsLinkToClient',
    defaultMessage: 'One SMS link to the client',
  },
  practiceSmsLinkBody: {
    id: 'clients.practiceIntake.smsLinkBody',
    defaultMessage: 'Opens in any phone browser, expires in 72 hours, and never shares their credentials with you.',
  },
  practiceNoMobileWarning: {
    id: 'clients.practiceIntake.noMobileWarning',
    defaultMessage: 'No mobile number yet — add one on the Contact step or the setup link cannot be sent.',
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
  practiceSetupSection: {
    id: 'clients.practiceIntake.setupSection',
    defaultMessage: 'Client setup — one SMS link',
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
  practiceBankFeedRowLabel: {
    id: 'clients.practiceIntake.bankFeedRowLabel',
    defaultMessage: 'Bank feed',
  },
  practiceLinkGoesToLabel: {
    id: 'clients.practiceIntake.linkGoesToLabel',
    defaultMessage: 'Link goes to',
  },
  practiceLinkExpiresLabel: {
    id: 'clients.practiceIntake.linkExpiresLabel',
    defaultMessage: 'Link expires',
  },
  practiceLinkExpiresValue: {
    id: 'clients.practiceIntake.linkExpiresValue',
    defaultMessage: 'in 72 hours',
  },
  practiceClientConnects: {
    id: 'clients.practiceIntake.clientConnects',
    defaultMessage: 'Client connects',
  },
  practiceSetupNote: {
    id: 'clients.practiceIntake.setupNote',
    defaultMessage:
      "Nothing is connected on approval. Both connections need the client's own login at the provider, so they stay disconnected until the client completes the link.",
  },
  practiceNoMobileReviewWarning: {
    id: 'clients.practiceIntake.noMobileReviewWarning',
    defaultMessage: 'No mobile number — the setup link and SMS chasing will not work until one is added.',
  },
  practiceApproveLabel: {
    id: 'clients.practiceIntake.approveLabel',
    defaultMessage: 'Approve & create',
  },
  practiceSuccessMessage: {
    id: 'clients.practiceIntake.successMessage',
    defaultMessage:
      '{name} created. One setup SMS queued to {mobile} — they connect the accounting software and bank themselves.',
  },
  // The two nouns the success line falls back to when a field is still empty.
  // They fill a slot rather than adding a clause, so one sentence still covers
  // all four states.
  practiceSuccessFallbackName: {
    id: 'clients.practiceIntake.successFallbackName',
    defaultMessage: 'Client',
  },
  practiceSuccessFallbackMobile: {
    id: 'clients.practiceIntake.successFallbackMobile',
    defaultMessage: 'their mobile',
  },
  practiceAuditAction: {
    id: 'clients.practiceIntake.auditAction',
    defaultMessage: 'Created client',
  },
  practiceAuditScopeUnnamed: {
    id: 'clients.practiceIntake.auditScopeUnnamed',
    defaultMessage: 'unnamed client',
  },

  // SetupRequest — the badge on a connection only the client can make.
  setupRequestClientConnects: {
    id: 'clients.setupRequest.clientConnects',
    defaultMessage: 'Client connects',
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
  m.practiceStepClientSetup,
];

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
 * The invite path: the three things needed to address an SMS, and nothing else.
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
            half-filled invite would create a record and queue an SMS to
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
                      {
                        label: intl.formatMessage(m.inviteAccountingSoftwareLabel),
                        value: <Pill tone="amber">{intl.formatMessage(m.inviteClientConnects)}</Pill>,
                      },
                      {
                        label: intl.formatMessage(m.inviteBankFeedLabel),
                        value: <Pill tone="amber">{intl.formatMessage(m.inviteClientConnects)}</Pill>,
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

  const hasMobile = form.mobile.trim().length > 0;

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

          {step === 5 && (
            <>
              <p className="text-[13px] text-zinc-500 leading-relaxed">
                {intl.formatMessage(m.practiceSetupIntro)}
              </p>
              <SetupRequest
                name={intl.formatMessage(m.practiceAccountingSoftwareName)}
                detail={intl.formatMessage(m.practiceAccountingSoftwareDetail)}
              />
              <SetupRequest
                name={intl.formatMessage(m.practiceBankFeedName)}
                detail={intl.formatMessage(m.practiceBankFeedDetail)}
              />

              <div className="flex items-start gap-3 p-4 rounded-2xl border border-white/5 bg-ground/60 shadow-inner">
                <Smartphone size={16} className="text-zinc-500 mt-0.5 shrink-0" />
                <div className="min-w-0">
                  <div className="text-[13px] font-bold text-white">
                    {hasMobile
                      ? intl.formatMessage(m.practiceSmsLinkTo, { mobile: form.mobile.trim() })
                      : intl.formatMessage(m.practiceSmsLinkToClient)}
                  </div>
                  <p className="text-[12px] text-zinc-500 mt-1 leading-relaxed">
                    {intl.formatMessage(m.practiceSmsLinkBody)}
                  </p>
                </div>
              </div>

              {!hasMobile && (
                <p className="text-[13px] text-amber-400 font-semibold">
                  {intl.formatMessage(m.practiceNoMobileWarning)}
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
                <ReviewSection title={intl.formatMessage(m.practiceSetupSection)}>
                  <ReviewRows
                    rows={[
                      {
                        label: intl.formatMessage(m.practiceAccountingSoftwareName),
                        value: <Pill tone="amber">{intl.formatMessage(m.practiceClientConnects)}</Pill>,
                      },
                      {
                        label: intl.formatMessage(m.practiceBankFeedRowLabel),
                        value: <Pill tone="amber">{intl.formatMessage(m.practiceClientConnects)}</Pill>,
                      },
                      { label: intl.formatMessage(m.practiceLinkGoesToLabel), value: form.mobile.trim() || '—' },
                      {
                        label: intl.formatMessage(m.practiceLinkExpiresLabel),
                        value: intl.formatMessage(m.practiceLinkExpiresValue),
                      },
                    ]}
                  />
                  <p className="text-[12px] text-zinc-500 leading-relaxed mt-3">
                    {intl.formatMessage(m.practiceSetupNote)}
                  </p>
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
              mobile: form.mobile.trim() || intl.formatMessage(m.practiceSuccessFallbackMobile),
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
  const intl = useIntl();

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
        {intl.formatMessage(m.setupRequestClientConnects)}
      </span>
    </div>
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
