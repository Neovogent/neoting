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
  bankConnected: boolean;
  contactName?: string | undefined;
  mobile?: string | undefined;
  /**
   * The primary contact's address, from the contract's
   * `BusinessSummary.primaryContactEmail` on a live row.
   *
   * ⚠ **Display only — there is no path that writes it back.** The client
   * details panel proposes changes through `ClientDetailChange['field']`, which
   * applies onto this shape locally, and the only server write to a contact is
   * `POST /businesses` at intake. An editable input here would stage a change
   * nothing can persist, which this repo's rule ("a button whose write the next
   * poll reverts is worse than absent") forbids. Chases go out by EMAIL in this
   * release, so the accountant must be able to READ it; changing it needs a
   * contract operation that does not exist yet.
   */
  email?: string | undefined;
  /**
   * When the newest setup invite was created for this business (ISO instant),
   * from `BusinessSummary.setupLinkSentAt` on a live row. Lets the setup-link
   * panel say "sent on {date}" instead of the false "no link has been sent" it
   * showed for every live client. Display only, like the contact fields.
   */
  setupLinkSentAt?: string | undefined;
  /**
   * The contract's own words, from `BusinessSummary.subscription.status` on a
   * live row — written only by the Stripe webhook server-side. Display only,
   * like the contact fields. Absent means the server sent no subscription
   * (never through checkout) or the row is seeded. The type-only import is
   * erased at build (the `ChatMessage.display` precedent below).
   */
  subscriptionStatus?: import('@neoting/contracts/model').SubscriptionStatus | undefined;
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
 * What the client has to do themselves. `profile` is the company record
 * itself, on the invite path where the client registers rather than the
 * accountant keying it in. The connection tasks are gone with D47 — client
 * onboarding asks for no connections, so there is nothing left to authorise.
 */
export type SetupTask = 'profile';

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

/**
 * The client's subscription (D48), as the portal's Plan section shows it —
 * the seed-side stand-in for the contract's `BusinessSubscription`, which is
 * a projection of what Stripe knows and is written only by the webhook. The
 * price is deliberately NOT here, in either shape: it lives in copy as
 * "£8.50 + VAT per month", and the authoritative figures are on Stripe's own
 * checkout and invoice (launch stage M6).
 */
export interface BusinessPlan {
  status: 'active' | 'past_due' | 'canceled';
  /** "27 Sep 2026" — when the current paid period ends. */
  renewsOn?: string | undefined;
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
  /** Absent until the client has been through checkout (launch stage M6). */
  subscription?: BusinessPlan | undefined;
}

/**
 * Where on the original a value was read — the contract's
 * `ExtractedField.boundingBox`: normalised 0–1 relative to the page, `page`
 * 1-based. Only ever built from a complete server box; a partial one is
 * dropped rather than guessed at.
 */
export interface FieldBoundingBox {
  page: number;
  x: number;
  y: number;
  width: number;
  height: number;
}

/** A single extracted field carries its own confidence + provenance (PRD stage 2). */
export interface ExtractedField {
  label: string;
  value: string;
  confidence: number;
  provenance: string;
  /**
   * True when a person confirmed/typed this value (`HUMAN_CONFIRMED`, live
   * rows only). The display renders "Confirmed by you" instead of a
   * percentage: the old 100% badge read as the system endorsing whatever was
   * typed — the £9,000-tax screenshot in review item 22 wore it.
   */
  humanConfirmed?: boolean | undefined;
  /** Present only when extraction placed the value on the page (live rows only). */
  boundingBox?: FieldBoundingBox | undefined;
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
  /**
   * The API's stable failure code (`NT-EXT-*`, `NT-PUB-*`, `NT-ING-*`) when
   * the document failed. Only live rows carry one — it is what tells a publish
   * failure from an extraction failure without parsing prose (METH S12).
   */
  failureCode?: string | undefined;
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
  /**
   * True when extraction classified this a bank STATEMENT (4 Sep 2026). A
   * statement has no supplier, no single total and no category — it can never
   * become Ready — so the To Review and Ready tabs exclude it (`onStatusTab`
   * in `api/documents.ts`); its home is the Bank tab's Statements panel, which
   * carries the D41 verdict. Undefined on the synthetic cast, which keeps
   * synthetic mode byte-for-byte unchanged (METH_MODE §1).
   */
  isStatement?: boolean | undefined;
  /**
   * The document's classified type, live rows only (5 Sep 2026, items 36/47).
   * `OTHER` is the D46 flag every surface must carry: the pipeline judged this
   * not to be a financial document, and the server's readiness rule refuses it
   * READY until a human corrects the type (`readinessOf` mirrors that —
   * "Type" leads the missing list). Undefined on the synthetic cast, which
   * keeps synthetic mode byte-for-byte unchanged (METH_MODE §1).
   */
  docType?: 'INVOICE' | 'RECEIPT' | 'CREDIT_NOTE' | 'STATEMENT' | 'OTHER' | undefined;
  /** The original file name, kept only until extraction has used it. */
  uploadFileName?: string | undefined;
  fields: ExtractedField[];
  lineItems: LineItem[];
  /** Set when a previous release for export was refused (yellow Ready). */
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
  /**
   * The SERVER's match state, present only on rows that came from
   * `GET /bank-transactions` (METH Stage 11). Seeded rows leave it undefined.
   *
   * It exists beside `matchedDocId` rather than replacing it because the two
   * answer different questions and the contract only carries one of them: the
   * feed says *whether* a line is matched, not *which* document matched it.
   * `isMatched()` in `lib/matching.ts` is the one place that difference is
   * reconciled — read it before branching on either field.
   */
  matchState?: 'UNMATCHED' | 'SUGGESTED' | 'CONFIRMED' | 'EXCLUDED' | undefined;
  /**
   * A bank-originated line with no paperwork to chase — SERVICE CHARGE, STRIPE
   * PAYOUT (SoT §4 Stage 7). Suppressed lines never enter chase detection; the
   * flag is visible so "why isn't this chased" has an answer on the screen.
   */
  chaseSuppressed?: boolean | undefined;
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
  /**
   * D41's completeness verdict, on a live statement.
   *
   * ⚠ Separate from `status`, and it must stay separate. `status` says whether
   * the import happened; this says what could be PROVEN about the result, and
   * the two are independent — a statement can import perfectly and still be
   * unprovable, which is exactly the case `reduced` exists for. Folding it into
   * `status` would make "we read every line" and "we could not check" the same
   * green tick, which is the claim D41 forbids.
   *
   * Undefined on a seeded statement, which predates the gate.
   */
  assurance?: 'complete' | 'reduced' | 'incomplete' | undefined;
  /** What the gate found. Empty when `complete`; the reason otherwise. */
  findings?: readonly StatementFinding[] | undefined;
  /** The document it was read from — D43's link back to the source file. */
  documentId?: string | undefined;
}

/** One thing D41's completeness check found in a statement. */
export interface StatementFinding {
  readonly kind: string;
  readonly detail: string;
  readonly sourceLine: number | null;
  readonly amountPence: number | null;
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
  /** Which of the four detection engines flagged this. */
  detectedBy: 'bank-transaction' | 'supplier-statement' | 'statement-gap' | 'recurring';
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
  /**
   * Set on a conversation hydrated from `GET /chat/conversations` whose
   * transcript has not been fetched yet (the list is summaries only — review
   * item 9, 5 Sep 2026). The drawer treats a row with a remote count as
   * "started" even while `messages` is still empty, and opening it is what
   * fetches the detail.
   */
  remoteMessageCount?: number | undefined;
}

export type Intent =
  | 'GENERAL'
  | 'ADD_CLIENT'
  | 'SHOW_MISSING'
  | 'CHASE_MISSING'
  | 'APPROVE_CHASE'
  | 'SHOW_INBOX'
  // The server's SHOW_STATEMENTS lands here (#233). D40 makes uploaded
  // statements the only bank input in ID, so "show me the bank statements" is a
  // request for a screen this product already has — the Bank tab's Statements
  // sub-tab — and not a question to be refused.
  | 'SHOW_STATEMENTS'
  | 'SHOW_REJECTED'
  | 'SHOW_APPROVALS'
  | 'APPROVE_ITEMS'
  | 'CREATE_RULE'
  | 'REVIEW_DOCUMENT'
  | 'SHOW_DUPLICATES'
  | 'SHOW_MATCHES'
  | 'PUBLISH'
  // ⚠ No `INVITE_USER`. It was removed with the last of its producers (2 Sep
  // 2026): `UserInviteForm` and its `IntentRenderer` case had already gone, and
  // the union member was what let the classifier, the tour and a canned reply
  // keep compiling against a card that no longer existed. Inviting a colleague
  // is `POST /v1/practice-members` on the Team screen; the server's chat runtime
  // has never had an intent for it, so nothing live regressed.
  | 'SHOW_ANALYTICS'
  | 'SHOW_AUDIT'
  | 'SHOW_MISSING_TABLE'
  // Review item 9 (5 Sep 2026): the server's SHOW_EXPORTS lands here —
  // navigation to the Export screen, D42's sole egress. Payload-free like
  // SHOW_STATEMENTS; the Export screen reads its own data.
  | 'SHOW_EXPORTS'
  // The METH Stage 13 golden paths — emitted only by the canned demo table
  // when the workspace session is live, rendered by the LIVE cards whose
  // state changes go through the real proposal engine.
  | 'LIVE_MISSING'
  | 'LIVE_CHASE'
  | 'LIVE_RULE'
  | 'LIVE_PUBLISH';

/** Read-only intents render instantly with no review step (PRD section 8). */
export const READ_ONLY_INTENTS: Intent[] = [
  'GENERAL',
  'SHOW_MISSING',
  'SHOW_INBOX',
  'SHOW_STATEMENTS',
  'SHOW_REJECTED',
  'SHOW_APPROVALS',
  'REVIEW_DOCUMENT',
  'SHOW_DUPLICATES',
  'SHOW_MATCHES',
  'SHOW_ANALYTICS',
  'SHOW_AUDIT',
  'SHOW_MISSING_TABLE',
  'SHOW_EXPORTS',
  'LIVE_MISSING',
];

/**
 * What an assistant message carries besides its prose.
 *
 * ⚠ THE SCOPE FIELDS ARE WHY THIS IS NOT `any`. `IntentRenderer` reads
 * `clientIds` off here and hands it to the tables, which filter on it — so a
 * typo in a payload key does not throw, it silently produces an EMPTY scope,
 * and an empty scope renders as "All clients". Mistyping the key that decides
 * whose documents an accountant is looking at is exactly the class of error a
 * type should catch, and `any` caught none of them.
 *
 * Every field is optional because one intent's payload is another's noise, but
 * the SET is closed: adding a key means adding it here, which is the point.
 * `| undefined` is written out because `exactOptionalPropertyTypes` is on and
 * `InputRow` assigns `clientName` unconditionally from a ternary.
 */
export interface MessagePayload {
  /** Which clients this answer is scoped to. Empty means every client. */
  clientIds?: string[] | undefined;
  /** Display names for the same scope, kept alongside so cards need no lookup. */
  clientNames?: string[] | undefined;
  /** A single client's name, for the intake form's prefill. */
  clientName?: string | undefined;
  /** The user's own words, kept so a card can quote what was asked. */
  query?: string | undefined;
  period?: string | undefined;
  missingItemIds?: string[] | undefined;
  documentId?: string | undefined;
  documentIds?: string[] | undefined;
  /**
   * The SERVER business the live intents act on (METH Stage 13) — an id from
   * `GET /businesses`, never a synthetic client id: it goes into proposal
   * payloads the API resolves through RLS. Absent when the utterance named no
   * client; the live cards then offer a picker rather than guessing.
   */
  businessId?: string | undefined;
  businessName?: string | undefined;
  /** The canned parse of a rule utterance (`// DEMO-MOCK: Opus via Bedrock`). */
  ruleDraft?:
    | {
        scopeKey: string;
        categoryCode: string;
        categoryName: string;
        vatTreatment: string | undefined;
      }
    | undefined;
  /** Narrows the inbox table a navigation intent renders ("everything to review"). */
  statusFilter?: DocStatus | undefined;
}

/**
 * What actually answered, recorded on the message it answered with.
 *
 * Present ONLY on replies that came from the server's model runtime. Its
 * absence is meaningful and must stay meaningful: a synthetic reply has no
 * meta, and a surface that invented one would be claiming a model spoke when
 * none did. Never default these values.
 *
 * Deliberately NOT a "thought process". The chat runtime runs with thinking
 * OFF — `temperature: 0` and a forced tool call, chosen for determinism, the
 * output-schema guarantee and reproducible evals — so there is no chain of
 * reasoning to show. Rendering a plausible-looking one would be inventing the
 * single thing this product exists to not invent.
 */
export interface AssistantMeta {
  /** The pinned model id that served the turn, e.g. `anthropic.claude-opus-4-6-v1`. */
  model: string;
  tier: 'judgment' | 'workhorse' | 'mechanical';
  latencyMs: number;
  /** True when the intended tier failed and a lower one answered (Governance §9.3). */
  degraded: boolean;
  /** True from 80% of the practice's daily AI budget onward (§9.7). */
  budgetWarning: boolean;
}

export interface Message {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  intent?: Intent | undefined;
  /** Resolved data the dynamic component renders from. */
  payload?: MessagePayload | undefined;
  attachments?: { name: string; size: number }[];
  viaVoice?: boolean | undefined;
  /** Set only on a server-answered assistant turn. See {@link AssistantMeta}. */
  meta?: AssistantMeta | undefined;
  /**
   * Server-composed tables/charts beside a grounded reply (§9.4's display
   * blocks). The type-only import is erased at build; the values are the
   * contract's, filled server-side — nothing in the browser invents a cell.
   */
  display?: import('@neoting/contracts/model').ChatDisplayBlock[] | undefined;
}
