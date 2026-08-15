/**
 * ⚠ OPTIONAL FIELDS ARE WRITTEN `?: T | undefined`, NOT `?: T`.
 *
 * Under `exactOptionalPropertyTypes` (tsconfig.base.json) those two are
 * different types: `?: T` means "absent or T", while `?: T | undefined` means
 * "absent, or present and undefined". This model is populated by generators and
 * API mappers that build object literals with computed values — they write
 * `statusNote: maybeUndefined` rather than conditionally omitting the key — so
 * the second is what the data actually is.
 *
 * Writing `?: T` here does not make the code safer; it makes every construction
 * site an error, which is how this file was before the import.
 */

/**
 * Domain types for the document pipeline.
 * Ingest -> Extract -> Rules -> AI -> Validate -> Dedupe -> Match -> Chase -> Approve -> Publish -> Archive
 */

export type SourceChannel = 'email' | 'web' | 'whatsapp' | 'sms-link' | 'csv' | 'chat' | 'portal';

export interface Client {
  id: string;
  name: string;
  industry: string;
  health: number;
  missingDocs: number;
  toReview: number;
  deadline: string;
  xeroConnected: boolean;
  bankConnected: boolean;
  contactName?: string | undefined;
  mobile?: string | undefined;
  vatNumber?: string | undefined;
  /** Ltd, LLP, sole trader… — drives the filings the client is subject to. */
  companyType?: string | undefined;
  /** Data URI, uploaded by the accountant at intake. */
  logoDataUrl?: string | undefined;
  /**
   * Created from an invite rather than keyed in by the practice: the record
   * holds only a name, a contact and a mobile until the client fills the rest
   * in from their setup link.
   */
  awaitingRegistration?: boolean | undefined;
}

/**
 * What the client has to do themselves. `ledger` and `bank` need their own
 * credentials at the provider, which the practice never holds; `profile` is the
 * company record itself, on the invite path where the client registers rather
 * than the accountant keying it in.
 */
export type SetupTask = 'profile' | 'ledger' | 'bank';

/**
 * One SMS link covering everything the client must connect themselves. The
 * accountant can complete the whole intake without it — this is only ever about
 * access the practice does not hold.
 */
export interface OnboardingLink {
  id: string;
  clientId: string;
  clientName: string;
  recipientName: string;
  recipientMobile: string;
  tasks: SetupTask[];
  completed: SetupTask[];
  sentAt: string;
  expiresInHours: number;
  resendCount: number;
  message: string;
}

/**
 * The business-side portal account. A business signs in here to send paperwork
 * to its accountant and nothing else — it never sees the practice's other
 * clients, so this is deliberately a separate shell rather than a tab.
 *
 * An account arrives one of two ways: the accountant creates it for a client
 * they already hold, or the business signs itself up and is linked afterwards.
 */
export type BusinessAccountOrigin = 'accountant-invite' | 'self-signup';

/** Invited accounts exist but have never been signed into. */
export type BusinessAccountStatus = 'invited' | 'active';

/**
 * Owner, Manager and Staff are the suggested three, but a business names its
 * own people — "Head Chef", "Site Foreman", "Bookkeeper" — so the role is free
 * text with those as the starting point rather than a closed set.
 */
export type BusinessMemberRole = 'Owner' | 'Manager' | 'Staff' | (string & {});

export interface BusinessMember {
  id: string;
  name: string;
  email: string;
  /** Where the registration link and later sign-in codes go. */
  mobile?: string | undefined;
  role: BusinessMemberRole;
  canUpload: boolean;
  /** Staff photographing receipts often shouldn't see the company's figures. */
  canSeeTotals: boolean;
  /**
   * Where this person is between being proposed and being able to send
   * anything:
   *
   *   pending-client-approval  the accountant added them; the business has not
   *                            agreed yet, and nothing has been sent to them
   *   invited                  approved, link out, waiting on them to finish
   *   active                   registered and able to send documents
   *   declined                 the business said no
   *
   * The first state exists because the practice adding someone to a client's
   * user list is the practice deciding who works at that business, which is
   * not the practice's decision to make.
   */
  status?: 'pending-client-approval' | 'invited' | 'active' | 'declined' | undefined;
  /** Added by the person during registration, not by the accountant. */
  avatarDataUrl?: string | undefined;
  invitedAt?: string | undefined;
  /** Set when the accountant raised the invite rather than the business. */
  invitedBy?: string | undefined;
  /** Who at the business ruled on it, and when. */
  approvedBy?: string | undefined;
  approvedAt?: string | undefined;
  declinedReason?: string | undefined;
}

export interface BusinessAccount {
  id: string;
  /** The client record in the practice this account belongs to. */
  clientId: string;
  businessName: string;
  contactName: string;
  email: string;
  mobile: string;
  origin: BusinessAccountOrigin;
  status: BusinessAccountStatus;
  createdAt: string;
  createdBy: string;
  /** Set on a self-signup that has not been claimed by a practice yet. */
  practiceCode?: string | undefined;
  // — Settings the business controls itself —
  notifyBySms: boolean;
  notifyByEmail: boolean;
  weeklySummary: boolean;
  /** Which inbox a portal upload defaults into. */
  defaultDocKind: DocKind;
  /** Send straight from the camera instead of stopping at the review step. */
  autoSubmitOnCapture: boolean;
  multiPageCapture: boolean;
  members: BusinessMember[];
  twoFactor: boolean;
}

/** A single extracted field carries its own confidence + provenance (PRD stage 2). */
export interface ExtractedField {
  label: string;
  value: string;
  confidence: number;
  provenance: string;
}

export interface LineItem {
  description: string;
  quantity: number;
  total: number;
  tax: number;
}

export type DocStatus = 'processing' | 'review' | 'ready' | 'rejected' | 'published';

/** Costs and Sales are separate inboxes; classification routes items automatically. */
export type DocKind = 'cost' | 'sales';

export interface Document {
  id: string;
  clientId: string;
  clientName: string;
  supplier: string;
  date: string;
  total: number;
  category: string;
  status: DocStatus;
  statusNote?: string | undefined;
  source: SourceChannel;
  uploader: string;
  currency: string;
  kind: DocKind;
  /**
   * The uploader did not say whether this is money in or money out, so the
   * value above is provisional until extraction classifies it. Set on every
   * client channel — a business sends its accountant paperwork, it does not
   * file it, and asking it to choose an inbox is asking it to do bookkeeping.
   */
  classifyKind?: boolean | undefined;
  /** Set when nobody named a client at upload — extraction reads the addressee. */
  classifyClient?: boolean | undefined;
  /** The original file name, kept only until extraction has used it. */
  uploadFileName?: string | undefined;
  fields: ExtractedField[];
  lineItems: LineItem[];
  /** Set when a previous publish to the accounting software failed (yellow Ready). */
  publishFailed?: boolean | undefined;
  /** Auto-split provenance: "page 3 of 40-page batch". */
  splitFrom?: string | undefined;
  /** Free text the business typed when sending this from its portal. */
  clientNote?: string | undefined;
}

/**
 * Documents that arrived at doc@ourdomain.com but could not be routed to a
 * client with confidence. They land here visibly — never silently dropped.
 */
/** A sender the accountant has taught the router to always route one way. */
export interface RoutingRule {
  sender: string;
  clientId: string;
  clientName: string;
}

export interface BankTransaction {
  id: string;
  clientId: string;
  clientName: string;
  description: string;
  date: string;
  amount: number;
  matchedDocId?: string | undefined;
  /** Negative amounts are credit notes / refunds — the 266-vote Dext gap. */
  isCredit: boolean;
  accountId: string;
  /**
   * A transaction with no document evidence IS a missing item. Keeping the link
   * explicit means matching or cash-coding it closes the chase everywhere.
   */
  missingItemId?: string | undefined;
}

export interface BankAccount {
  id: string;
  clientId: string;
  clientName: string;
  bankName: string;
  sortCode: string;
  last4: string;
  balance: number;
  lastSync: string;
  /** UK open-banking consent expires every 90 days. */
  reauthDays: number;
  status: 'live' | 'error' | 'disconnected';
  source: 'feed' | 'statements';
}

/** Detected by comparing opening/closing balances and date continuity. */
/**
 * A statement from a supplier listing everything they invoiced in a period.
 * Reconciling it against the documents on file is one of the detection engines
 * behind a missing item — the supplier says there were six invoices, we hold
 * four, so two are missing and nobody had to notice by hand.
 *
 * Not to be confused with a bank statement, which lives on the Bank tab.
 */
export interface SupplierStatementLine {
  /** The supplier's own invoice reference, as printed. */
  reference: string;
  date: string;
  total: number;
  /** The document we hold for this line. Absent means it is missing. */
  documentId?: string | undefined;
}

export interface SupplierStatement {
  id: string;
  clientId: string;
  clientName: string;
  supplier: string;
  fileName: string;
  period: string;
  /** What the supplier says the period came to. */
  statementTotal: number;
  lines: SupplierStatementLine[];
  status: 'processing' | 'reconciled' | 'gaps' | 'failed';
  uploadedAt: string;
  note?: string | undefined;
}

/** Employee-submitted spend, grouped for reimbursement. */
export interface ExpenseClaimItem {
  id: string;
  description: string;
  date: string;
  total: number;
  category: string;
  /** The receipt backing this line — absent means it is unevidenced. */
  documentId?: string | undefined;
}

/**
 * A claim's life. `submitted` means the employee has sent it to their own
 * manager — it does not reach the practice until someone at the business has
 * signed it off, because whether a spend was legitimate is the employer's call
 * and not the bookkeeper's.
 */
export type ExpenseClaimStatus =
  | 'draft'
  | 'submitted'
  | 'internally-approved'
  | 'approved'
  | 'reimbursed'
  | 'rejected';

/** Who at the business signed a claim off before it reached the practice. */
export interface ClaimApproval {
  by: string;
  role: 'Manager' | 'Owner' | 'HR';
  at: string;
  note?: string | undefined;
}

export interface ExpenseClaim {
  id: string;
  clientId: string;
  clientName: string;
  /** Who is out of pocket. */
  claimant: string;
  period: string;
  items: ExpenseClaimItem[];
  status: ExpenseClaimStatus;
  submittedAt?: string | undefined;
  /** Absent until someone at the business has approved it. */
  approval?: ClaimApproval | undefined;
  /** Set when the business sent it back rather than approving. */
  rejectedReason?: string | undefined;
  note?: string | undefined;
}

export interface StatementGap {
  id: string;
  clientId: string;
  clientName: string;
  accountId: string;
  periodStart: string;
  periodEnd: string;
  reason: string;
}

export interface Statement {
  id: string;
  clientId: string;
  clientName: string;
  accountId: string;
  fileName: string;
  period: string;
  openingBalance: number;
  closingBalance: number;
  rows: number;
  status: 'processing' | 'extracted' | 'failed';
  uploadedAt: string;
  note?: string | undefined;
}

/** Bank Match tolerances — configurable, unlike Dext's fixed windows. */
export interface MatchSettings {
  /** Days after the document date a payment may land. */
  documentWindow: number;
  /** Days around the due date, when the document has one. */
  dueWindow: number;
  lookbackMonths: number;
  allowProbable: boolean;
}

export type MatchKind = 'exact' | 'probable' | 'partial' | 'credit-note';

export interface Match {
  id: string;
  clientName: string;
  documentId: string;
  transactionId: string;
  documentLabel: string;
  transactionLabel: string;
  amount: number;
  confidence: number;
  kind: MatchKind;
  reason: string;
  /** Linked by the matcher itself because there was nothing to decide. */
  auto?: boolean | undefined;
}

export interface DuplicatePair {
  id: string;
  clientName: string;
  similarity: number;
  signals: string[];
  crossType: boolean;
  left: { id: string; label: string; type: string; total: number; date: string; uploader: string };
  right: { id: string; label: string; type: string; total: number; date: string; uploader: string };
}

export type RuleTier = 'user' | 'payment-method' | 'supplier' | 'defaults';

export interface RuleCondition {
  field: string;
  operator: string;
  value: string;
}

export interface Rule {
  id: string;
  clientId: string | 'all';
  clientName: string;
  supplier: string;
  tier: RuleTier;
  conditions: RuleCondition[];
  sets: { field: string; value: string }[];
  active: boolean;
  retroApply: boolean;
  /** Populated when this rule overlaps an existing one for the same supplier. */
  conflictsWith?: string | undefined;
}

export type ChaseStage = 'sent' | 'reminder-1' | 'reminder-2' | 'escalated' | 'closed';

/** Suppression reasons, per the policy engine: a chased item stops chasing when… */
export type ChaseItemStatus = 'requested' | 'received' | 'unavailable' | 'dismissed' | 'cash-coded';

export interface ChaseItem {
  missingItemId: string;
  supplier: string;
  amount: number;
  date: string;
  status: ChaseItemStatus;
  /**
   * The missing item as it stood when the chase went out. Marking an item
   * received or cash-coded drops it from the missing list, so this is what puts
   * it back if the accountant changes their mind.
   */
  origin: MissingItem;
  /** The document that answered this request, once one has arrived. */
  answeredByDocId?: string | undefined;
  /**
   * Documents the accountant has said are not this item. Without it, undoing a
   * wrong match would be pointless — the matcher would pick the same document
   * up again on the next pass.
   */
  rejectedDocIds?: string[] | undefined;
}

export interface ChaseEvent {
  at: string;
  label: string;
  detail?: string | undefined;
}

export interface Chase {
  id: string;
  /**
   * Wording the accountant has written for the next send, replacing the
   * generated text. Separate from `message` because that one is history — it
   * is what actually reached the client's phone, and editing it would be the
   * app pretending a delivered SMS said something else.
   */
  nextMessage?: string | undefined;
  clientId: string;
  clientName: string;
  recipientName: string;
  recipientMobile: string;
  message: string;
  /** Hours since the chase was first sent — drives the reminder schedule. */
  hoursSinceSent: number;
  /**
   * When a text last actually went to this person. Real clock time, because
   * the cooldown between messages has to be measured rather than inferred
   * from a stage.
   */
  lastSmsAtMs: number;
  stage: ChaseStage;
  items: ChaseItem[];
  linkExpiresInHours: number;
  events: ChaseEvent[];
  lastUpload: string;
  policy: string;
}

/**
 * A change the practice wants to make to a client's own record, waiting on the
 * client to agree.
 *
 * The company's legal name, its contact, the mobile that chases go to — these
 * are the business's facts, not the practice's. Editing them silently means a
 * client can find their own details changed by someone else, and a wrong
 * mobile means every chase after it goes to a stranger. So the accountant
 * proposes and the business confirms, in the same place it approves anything
 * else.
 */
export interface ClientDetailChange {
  id: string;
  clientId: string;
  clientName: string;
  /** The Client field being changed. */
  field: 'name' | 'industry' | 'contactName' | 'mobile' | 'vatNumber' | 'deadline';
  label: string;
  from: string;
  to: string;
  requestedBy: string;
  requestedAt: string;
  status: 'pending' | 'approved' | 'declined';
  declinedReason?: string | undefined;
}

/** Per-firm chase schedule and escalation policy (PRD stage 8.6). */
export interface ChasePolicy {
  firstChaseAfterHours: number;
  reminderOneDays: number;
  reminderTwoDays: number;
  escalateAfterDays: number;
  quietHoursStart: string;
  quietHoursEnd: string;
  senderId: string;
  linkTtlHours: number;
  /**
   * How long to wait before a link can be sent again. Resending while the
   * first one is still live is just a second text saying the same thing, so
   * this defaults to the link's own lifetime.
   */
  resendAfterHours: number;
  autoChase: boolean;
  notifyOnUpload: boolean;
}

/** Per-document questions, carried over the same SMS secure-link mechanism. */
export interface ItemMessage {
  id: string;
  clientId: string;
  clientName: string;
  documentLabel: string;
  question: string;
  sentAt: string;
  answer?: string | undefined;
}

export interface ApprovalStage {
  name: string;
  approver: string;
  /** Always, or only when the amount clears a threshold. */
  thresholdAbove?: number | undefined;
  canEdit: boolean;
  /**
   * Approved by someone at the business rather than in the practice. These
   * stages are delivered by SMS + OTP — the client never installs an app or
   * holds a login, exactly as chasing works.
   */
  clientSide?: boolean | undefined;
}

/** Conditional branching — the upmarket gap Dext's linear workflows can't cover. */
export interface ApprovalBranch {
  field: 'amount' | 'supplier-age' | 'category';
  operator: '>' | 'is';
  value: string;
  addApprover: string;
  label: string;
}

export interface ApprovalWorkflow {
  id: string;
  name: string;
  appliesTo: string;
  /**
   * Which clients this workflow governs.
   *
   * Approvals are opt-in and default off (wireframe screen 12, Dext parity):
   * a client with no workflow has no approval step at all and its items go
   * Ready → published without pausing. Without this field every workflow
   * silently applied to every client, which is the opposite of opt-in — one
   * practice-wide rule would have held up the invoices of a client who had
   * never asked for approvals.
   */
  clientIds: string[];
  /**
   * Higher wins when more than one workflow could apply. The wireframe orders
   * scope type → owners → suppliers → categories, so a category rule beats a
   * supplier rule, which beats a blanket one.
   */
  specificity: number;
  stages: ApprovalStage[];
  branches: ApprovalBranch[];
  selfApproval: boolean;
  autoPublishOnApproval: boolean;
  active: boolean;
}

export type ApprovalState = 'pending' | 'approved' | 'rejected';

export interface ApprovalItem {
  id: string;
  documentId?: string | undefined;
  clientId: string;
  clientName: string;
  supplier: string;
  total: number;
  category: string;
  workflowId: string;
  stageIndex: number;
  stage: string;
  approver: string;
  waitingDays: number;
  state: ApprovalState;
  /** Approver names added by a branch condition firing on this item. */
  addedByBranch: string[];
  history: { at: string; label: string; actor: string; note?: string | undefined }[];
  /** Item details lock once approved. */
  locked: boolean;
}

/**
 * One SMS approval session for a client. Batched per client — one link, one
 * session, however many items — so an approver signing off four invoices
 * verifies once, not four times.
 */
export interface ApprovalRequest {
  id: string;
  clientId: string;
  clientName: string;
  recipientName: string;
  recipientMobile: string;
  /** The approval items this link covers, in the order they are presented. */
  itemIds: string[];
  message: string;
  sentAt: string;
  /** Real clock time, so a cooldown can be measured rather than guessed. */
  sentAtMs: number;
  expiresInHours: number;
  resendCount: number;
  /** The OTP challenge has been passed for this session. */
  verified: boolean;
  /** Simulated one-time code — a real build never holds this client-side. */
  code: string;
}

export type VaultCategory =
  | 'Contracts'
  | 'Leases'
  | 'Insurance'
  | 'Tax filings'
  | 'Engagement letters'
  | 'Payroll'
  | 'Certificates';

/**
 * Who the file belongs to. Firm-owned files are practice records anyone in the
 * firm works from; accountant-owned files belong to one person's engagement —
 * their working papers, their correspondence — and follow them, not the client.
 */
export type VaultOwnerKind = 'firm' | 'accountant';

export interface VaultDocument {
  id: string;
  clientId: string;
  clientName: string;
  financialYear: string;
  category: VaultCategory;
  name: string;
  summary: string;
  tags: string[];
  ownerKind: VaultOwnerKind;
  /** The practice name when firm-owned, otherwise the accountant's name. */
  ownerName: string;
  /** Key dates the AI extracted; drives the expiry reminders. */
  expiresOn?: string | undefined;
  daysToExpiry?: number | undefined;
  sizeKb: number;
  source: string;
  uploader: string;
  uploadedAt: string;
  access: 'practice' | 'client-visible';
}

export type ColleagueRole = 'Practice Admin' | 'Client Admin' | 'Standard User';

export interface Colleague {
  id: string;
  name: string;
  email: string;
  role: ColleagueRole;
  location: string;
  teamId?: string | undefined;
  clientIds: string[];
  permissions: string[];
  hideFinanceFields: boolean;
  active: boolean;
  /** Profile picture, held as a data URI. */
  avatarDataUrl?: string | undefined;
  jobTitle?: string | undefined;
  mobile?: string | undefined;
  /** Set when a reset link was last sent; the practice never sees a password. */
  passwordResetSentAt?: string | undefined;
}

export interface Team {
  id: string;
  name: string;
  accessLevel: 'All clients' | 'Assigned clients only';
  memberIds: string[];
}

export type TaskStatus = 'open' | 'complete' | 'complete-with-issues' | 'not-applicable';

/** Recurring per-client checklists scoped to this product's job. */
export interface WorkflowTask {
  id: string;
  clientId: string;
  clientName: string;
  title: string;
  assignee: string;
  due: string;
  status: TaskStatus;
  /** True when the engine can mark it done from real pipeline state. */
  aiPrefilled: boolean;
  dependsOn?: string | undefined;
}

export type Theme = 'dark' | 'light';

export interface AppSettings {
  theme: Theme;
  practiceName: string;
  country: string;
  baseCurrency: string;
  yearEnd: string;
  docEmail: string;
  duplicateMode: 'automatic' | 'review' | 'off';
  extractTax: boolean;
  extractDueDate: boolean;
  autoCategorisation: 'always' | 'supplier-rules-only' | 'never';
  suggestionMode: 'suggest' | 'auto-apply';
  autoArchiveOnPublish: boolean;
  autoArchiveOnExport: boolean;
  dateFormat: 'DD/MM/YYYY' | 'MM/DD/YYYY' | 'YYYY-MM-DD';
  csvFormat: string;
  enforce2fa: boolean;
  sso: 'off' | 'Microsoft Entra ID' | 'Okta';
  whatsappNumber: string;
  notifyPublishFailure: boolean;
  notifyExtractionFailure: boolean;
  notifyClientUpload: boolean;
}

export interface MissingItem {
  id: string;
  clientId: string;
  clientName: string;
  supplier: string;
  date: string;
  amount: number;
  /** Which of the five detection engines flagged this. */
  detectedBy: 'bank-transaction' | 'supplier-statement' | 'statement-gap' | 'ledger-attachment' | 'recurring';
  chased: boolean;
}

export interface AuditEntry {
  id: string;
  action: string;
  scope: string;
  actor: string;
  at: string;
  reviewOpened: boolean;
}

export interface Conversation {
  id: string;
  title: string;
  messages: Message[];
  attachedClientIds: string[];
  pinned: boolean;
  updatedAt: number;
}

export type Intent =
  | 'GENERAL'
  | 'ADD_CLIENT'
  | 'SHOW_MISSING'
  | 'CHASE_MISSING'
  | 'APPROVE_CHASE'
  | 'SHOW_INBOX'
  | 'SHOW_REJECTED'
  | 'SHOW_APPROVALS'
  | 'APPROVE_ITEMS'
  | 'CREATE_RULE'
  | 'REVIEW_DOCUMENT'
  | 'SHOW_DUPLICATES'
  | 'SHOW_MATCHES'
  | 'PUBLISH'
  | 'INVITE_USER'
  | 'SHOW_ANALYTICS'
  | 'SHOW_AUDIT'
  | 'SHOW_MISSING_TABLE';

/** Read-only intents render instantly with no review step (PRD section 8). */
export const READ_ONLY_INTENTS: Intent[] = [
  'GENERAL',
  'SHOW_MISSING',
  'SHOW_INBOX',
  'SHOW_REJECTED',
  'SHOW_APPROVALS',
  'REVIEW_DOCUMENT',
  'SHOW_DUPLICATES',
  'SHOW_MATCHES',
  'SHOW_ANALYTICS',
  'SHOW_AUDIT',
  'SHOW_MISSING_TABLE',
];

export interface Message {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  intent?: Intent | undefined;
  /** Resolved data the dynamic component renders from. */
  payload?: any | undefined;
  attachments?: { name: string; size: number }[];
  viaVoice?: boolean | undefined;
}
