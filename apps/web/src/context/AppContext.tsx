import { createContext, useCallback, useContext, useEffect, useMemo, useState, ReactNode } from 'react';
import { useIntl, type IntlShape } from 'react-intl';
import {
  seedClients,
  seedConversations,
  seedDocuments,
  seedMatches,
  seedMissing,
  seedRules,
  seedDuplicateCopies,
  seedExpenseClaims,
  seedExpenseDocuments,
  seedStatements,
  seedSupplierStatements,
  seedTransactions,
} from '../lib/seed';
import { currency as currencyText, titleFromMessage } from '../lib/resolver';
import {
  buildAccounts,
  buildApprovals,
  buildChases,
  buildDocuments,
  buildGaps,
  buildMissing,
  buildTransactions,
  branchesFor,
  clampLinkTtl,
  composeChaseMessage,
  DEFAULT_CHASE_POLICY,
} from '../lib/generate';
import {
  buildTasks,
  buildVault,
  DEFAULT_SETTINGS,
  PRACTICE_NAME,
  seedColleagues,
  seedTeams,
  seedWorkflows,
} from '../lib/seed2';
import { autoMatches, DEFAULT_MATCH_SETTINGS, sameMerchant, shortLabel, txnLabel } from '../lib/matching';
import { completeExtraction, ingestFiles, type IngestOptions } from '../lib/ingest';
import { analyseSheet, readTable, sheetReadMessage } from '../lib/spreadsheet';
import { confirmMatchProposal, useBankTransactions } from '../api/bank';
import { useDocuments } from '../api/documents';
import { API_ENABLED } from '../api/config';
import { logout as apiLogout, useSession, type SessionState } from '../api/auth';
import { deriveBusinessSummaries, useBusinesses, type BusinessSummary } from '../api/businesses';
import { SEED_SLICE, errorLabel, sliceStatus, type SliceStatuses } from '../api/slices';
import { queryClient } from '../api/queryClient';
import { importSheet, type SheetImport } from '../lib/tableImport';
import { buildBusinessAccounts, newBusinessAccount } from '../lib/business';
import { deriveClientStats, type ClientStats } from '../lib/selectors';
import { detectDuplicates } from '../lib/dedupe';
import { fromSlug, navigate, path, slug, usePath } from '../lib/router';
import type {
  AppSettings,
  ApprovalItem,
  ApprovalRequest,
  ApprovalWorkflow,
  AuditEntry,
  BankTransaction,
  BusinessAccount,
  BusinessMember,
  BusinessMemberRole,
  Chase,
  ChaseItemStatus,
  ChasePolicy,
  Client,
  ClientDetailChange,
  Colleague,
  Team,
  VaultDocument,
  WorkflowTask,
  Conversation,
  Document,
  DocStatus,
  DocKind,
  DuplicatePair,
  ExpenseClaim,
  ExpenseClaimStatus,
  ItemMessage,
  Match,
  Message,
  MatchKind,
  MatchSettings,
  MissingItem,
  OnboardingLink,
  RoutingRule,
  Rule,
  SetupTask,
  SourceChannel,
  Statement,
  StatementGap,
  SupplierStatement,
  SupplierStatementLine,
  BankAccount,
} from '../lib/types';

export type {
  ApprovalItem,
  AuditEntry,
  BankTransaction,
  BusinessAccount,
  BusinessMember,
  Chase,
  ChaseItem,
  ChasePolicy,
  ItemMessage,
  Client,
  Conversation,
  Document,
  DuplicatePair,
  Match,
  Message,
  MissingItem,
  OnboardingLink,
  SetupTask,
  RoutingRule,
  Rule,
} from '../lib/types';

export type { ClientStats } from '../lib/selectors';

/**
 * The sidebar's own entries, which are also the top level of the address bar:
 * /clients, /chases, /approvals and so on. 'AI Workspace' is the root, so it
 * lives at '/' rather than '/ai-workspace'.
 */
export const SIDEBAR_TABS = [
  'AI Workspace', 'Clients', 'Inboxes', 'Chases', 'Approvals',
  'Documents', 'Analytics', 'Team', 'Settings',
] as const;

interface AppContextType {
  // Pipeline data
  clients: Client[];
  documents: Document[];
  transactions: BankTransaction[];
  matches: Match[];
  duplicates: DuplicatePair[];
  rules: Rule[];
  chases: Chase[];
  approvals: ApprovalItem[];
  missing: MissingItem[];
  auditLog: AuditEntry[];
  routingRules: RoutingRule[];

  // Bank layer
  accounts: BankAccount[];
  statements: Statement[];
  statementGaps: StatementGap[];
  matchSettings: MatchSettings;
  setMatchSettings: (s: MatchSettings) => void;

  // Approvals
  approvalWorkflows: ApprovalWorkflow[];
  saveWorkflow: (w: ApprovalWorkflow) => void;
  deleteWorkflow: (id: string) => void;
  /**
   * Advances one stage; the final stage approves and locks the item. `actor`
   * names who signed off — the practice by default, the business on a
   * client-side stage.
   */
  advanceApproval: (id: string, note?: string, actor?: string) => void;
  rejectApproval: (id: string, reason: string, actor?: string) => void;
  /** Approval items sitting on a stage only the business can clear. */
  clientSideApprovals: (clientId: string) => ApprovalItem[];
  approvalRequests: ApprovalRequest[];
  /** Batches every client-side item for a client into one SMS link. */
  sendApprovalRequest: (clientId: string) => void;
  resendApprovalRequest: (id: string) => void;
  /** Opens the session. Code checking is server-side, so this always succeeds. */
  verifyApprovalCode: (id: string, code: string) => boolean;

  // Vault & archive
  vault: VaultDocument[];
  addVaultDocument: (
    clientId: string,
    category: VaultDocument['category'],
    name: string,
    sizeKb: number,
    owner?: { kind: VaultDocument['ownerKind']; name: string },
  ) => void;
  updateVaultDocument: (id: string, patch: Partial<VaultDocument>) => void;
  deleteVaultDocument: (id: string) => void;
  moveVaultDocument: (id: string, clientId: string) => void;

  // Team
  colleagues: Colleague[];
  teams: Team[];
  tasks: WorkflowTask[];
  saveColleague: (c: Colleague) => void;
  removeColleague: (id: string) => void;
  /** Emails a reset link. A practice admin never sets or sees a password. */
  sendPasswordReset: (id: string) => void;
  /** Creates or updates a team; membership is stored on the team. */
  saveTeam: (t: Team) => void;
  removeTeam: (id: string) => void;
  setTaskStatus: (id: string, status: WorkflowTask['status']) => void;
  /** Hands a checklist task to a colleague. */
  assignTask: (id: string, assignee: string) => void;
  addTask: (task: WorkflowTask) => void;

  // Settings
  settings: AppSettings;
  updateSettings: (patch: Partial<AppSettings>) => void;

  // Chase engine
  chasePolicy: ChasePolicy;
  setChasePolicy: (p: ChasePolicy) => void;
  itemMessages: ItemMessage[];
  /** Sends (or extends) a chase for these missing items. SMS only, by design. */
  /**
   * `message` is what the accountant approved. Passing it through matters:
   * the composer lets them rewrite the text, and re-deriving it here would
   * throw that away and send the machine's wording instead.
   */
  sendChase: (clientId: string, missingItemIds: string[], message?: string) => void;
  sendReminder: (chaseId: string) => void;
  /** Rewrites what the next reminder or re-sent link will say. */
  setChaseMessage: (chaseId: string, message: string | undefined) => void;
  escalateChase: (chaseId: string) => void;
  closeChase: (chaseId: string) => void;
  resendLink: (chaseId: string) => void;
  /** Suppression: received / unavailable / dismissed / cash-coded. */
  setChaseItemStatus: (chaseId: string, missingItemId: string, status: ChaseItemStatus) => void;
  /** The client uploads through the OTP link — closes the item across the pipeline. */
  /**
   * Puts a settled item back to requested. Every button on a chased item is a
   * judgement call, so each one has to be reversible — including an upload,
   * which un-files the document it created.
   */
  revertChaseItem: (chaseId: string, missingItemId: string) => void;
  sendItemMessage: (clientId: string, documentLabel: string, question: string) => void;

  /** Links a document to an existing transaction — never creates transactions. */
  matchTransaction: (txnId: string, documentId: string, kind: MatchKind, confidence: number, reason: string) => void;
  unmatchTransaction: (matchId: string) => void;
  /** Cash coding: an unmatched transaction becomes a cost item in the pipeline. */
  cashCode: (txnId: string, category: string) => void;
  uploadStatement: (fileName: string, clientId: string) => void;

  /**
   * Supplier statements — a supplier's own list of what they invoiced in a
   * period. Reconciling it is how a missing invoice is found without anyone
   * noticing by hand. Distinct from a bank statement, which lives on Bank.
   */
  supplierStatements: SupplierStatement[];
  uploadSupplierStatement: (fileName: string, clientId: string, supplier: string) => void;
  deleteSupplierStatement: (id: string) => void;

  /** Employee-submitted spend, grouped for reimbursement. */
  expenseClaims: ExpenseClaim[];
  saveExpenseClaim: (claim: ExpenseClaim) => void;
  setExpenseClaimStatus: (id: string, status: ExpenseClaimStatus) => void;
  deleteExpenseClaim: (id: string) => void;
  reauthAccount: (accountId: string) => void;
  /** Extra fields required before publish, on top of Supplier + Total + Category. */
  mandatoryFields: string[];
  setMandatoryFields: (fields: string[]) => void;
  /** Files rejected at ingest, kept visible with a reason. */
  ingestRejections: { fileName: string; reason: string; at: string }[];

  /** Live per-client pipeline figures, derived from the arrays above. */
  statsFor: (clientId: string) => ClientStats;

  /**
   * Client setup links. The accountant can key in every detail of a client
   * except the accounting-software and bank connections, which need the
   * client's own logins — so intake always queues one SMS link for those.
   */
  onboardingLinks: OnboardingLink[];
  /** Takes the client itself, so it works for one created in the same handler. */
  sendOnboardingLink: (client: Client, tasks: SetupTask[]) => void;
  resendOnboardingLink: (id: string) => void;
  /** The client completes a connection from the link (or the business portal). */
  completeOnboardingTask: (clientId: string, task: SetupTask) => void;

  /**
   * Business portal. A business signs in to its own shell — it can send
   * paperwork and manage its own settings, and sees nothing belonging to the
   * practice's other clients.
   */
  businessAccounts: BusinessAccount[];
  /** 'accountant' is the practice shell; 'business' is the client-facing one. */
  /** 'approval' is the SMS link surface — no login, no portal account. */
  /**
   * 'chase-upload' is the other SMS link surface, and the stricter of the two:
   * `/p/<linkToken>`, opened by a chase text, scoped to the items that one
   * chase asked for. No account and no browsing — a delegated session that may
   * add documents to those items and see nothing else (METH Stage 9).
   */
  portal: 'accountant' | 'business' | 'approval' | 'registration' | 'chase-upload';
  /** The approval session the SMS link opened, when portal === 'approval'. */
  openApprovalRequestId: string | null;
  openApprovalLink: (requestId: string) => void;
  /**
   * The signed link token out of the chase SMS, when portal === 'chase-upload'.
   * Held in the address rather than in state so the text message is the whole
   * of what opens the page — which is what a forwardable link means.
   */
  portalLinkToken: string | null;
  /** Which business account the portal is signed into. */
  portalAccountId: string | null;
  /** Signing in with no id lands on the sign-up / invite screen. */
  openBusinessPortal: (accountId?: string | null) => void;
  exitBusinessPortal: () => void;
  /** Created by the accountant for an existing client, or by the business itself. */
  createBusinessAccount: (account: BusinessAccount) => void;
  /**
   * The accountant invites someone at the business by SMS. The practice sets
   * who they are and what they may do; the person fills in their own email and
   * photo from the link. Creates the portal account if the client has none.
   */
  inviteBusinessUser: (
    clientId: string,
    invite: {
      name: string;
      email: string;
      mobile: string;
      role: BusinessMemberRole;
      canUpload: boolean;
      canSeeTotals: boolean;
    },
  ) => void;
  /** The business rules on a person the practice proposed. */
  reviewProposedUser: (accountId: string, memberId: string, verdict: 'approve' | 'decline', reason?: string) => void;

  /** Changes to a client's own record, waiting on the client to confirm. */
  clientDetailChanges: ClientDetailChange[];
  proposeClientDetailChanges: (
    clientId: string,
    changes: { field: ClientDetailChange['field']; label: string; to: string }[],
  ) => number;
  reviewClientDetailChange: (id: string, verdict: 'approve' | 'decline', reason?: string) => void;
  /** The invited person completes their own record from the registration link. */
  completeBusinessUserRegistration: (accountId: string, memberId: string, patch: Partial<BusinessMember>) => void;
  /** Opens the registration link as that person — the demo's way in. */
  openRegistrationLink: (accountId: string, memberId: string) => void;
  openRegistrationFor: { accountId: string; memberId: string } | null;
  updateBusinessAccount: (id: string, patch: Partial<BusinessAccount>) => void;
  /** An invited account becomes active the first time it is signed into. */
  activateBusinessAccount: (id: string) => void;

  /**
   * The workspace session (METH Stage 6). 'off' in synthetic mode — no login
   * wall, no identity, the app exactly as it was. `App.tsx` gates on it;
   * the context header renders from it; the API slices wait for it.
   */
  session: SessionState;
  /** Clears the server cookie; the refetched /me returns the app to LoginView. */
  logout: () => Promise<void>;
  /**
   * The businesses slice — who is in scope, with waiting-work counts. From
   * `GET /businesses` when the session is live, derived from the seeded
   * clients otherwise. The same shape either way, so the header never cares.
   */
  businesses: BusinessSummary[];
  /**
   * Where each slice's data actually came from (the hydration architecture,
   * METH Stage 6). A wired screen renders the dev-only fallback badge from
   * this instead of letting fixtures impersonate server truth.
   */
  slices: SliceStatuses;
  /**
   * The server business id for a client the synthetic side keys by seed id
   * ('1'). Joined through the hydrated businesses slice by normalised name;
   * falls back to the fixture convention (`biz_<id>`, api/uploads.ts) when
   * the slice has not answered. Retires with S6's plan: the clients list
   * itself reading from GET /businesses.
   */
  serverClientIdFor: (clientId: string) => string;
  /** Whether a row's businessId names the given (possibly seed-id) client. */
  isSameClient: (rowClientId: string, clientId: string) => boolean;

  // Navigation shared across sections
  activeTab: string;
  setActiveTab: (tab: string) => void;
  openClientId: string | null;
  openClient: (id: string | null) => void;
  starredClientIds: string[];
  toggleStarClient: (id: string) => void;

  // Conversation state
  conversations: Conversation[];
  activeConversationId: string | null;
  messages: Message[];
  attachedClients: Client[];
  /** Opens the AI workspace on a fresh conversation scoped to these clients. */
  startConversation: (clientIds: string[], seed?: Message[]) => void;

  // Conversation actions
  addMessage: (msg: Message) => void;
  setMessages: (msgs: Message[]) => void;
  newConversation: () => void;
  selectConversation: (id: string) => void;
  deleteConversation: (id: string) => void;
  togglePinConversation: (id: string) => void;
  attachClient: (id: string) => void;
  detachClient: (id: string) => void;

  // Pipeline actions
  addClient: (client: Client) => void;
  updateClient: (id: string, patch: Partial<Client>) => void;
  updateDocumentStatus: (id: string, status: DocStatus) => void;
  /** Corrects money in / money out, moving the document to the other inbox. */
  setDocumentKind: (id: string, kind: DocKind) => void;
  updateDocumentField: (docId: string, label: string, value: string) => void;
  /**
   * Ingest stage 1: files in, documents out, with auto-split and visible
   * rejections. `raw` carries the file itself, which spreadsheets need — their
   * rows are read here rather than photographed.
   */
  ingest: (
    files: { name: string; size: number; raw?: File }[],
    clientId: string | undefined,
    source: SourceChannel,
    options?: IngestOptions,
  ) => {
    documents: Document[];
    rejected: { fileName: string; reason: string }[];
    /** One ticket per spreadsheet, which fills in as its rows are read. */
    imports: SheetImport[];
  };
  /** Every spreadsheet read this session, with what came out of it. */
  sheetImports: SheetImport[];

  /**
   * Where the documents on screen came from, and how that read went. Exposed
   * so a screen can say "loading" or name a contract mismatch instead of
   * rendering an empty table that looks like a clean inbox.
   */
  documentsSource: 'api' | 'seed';
  documentsLoading: boolean;
  documentsError: string | null;
  /**
   * The 73-vote move-between-entities, with the addressee check done by the
   * caller. `teachSender` records the senders of those documents against the
   * client, so the same address routes itself next time — the one useful thing
   * the old unrouted queue did, kept where routing decisions are now made.
   */
  moveDocuments: (ids: string[], clientId: string, teachSender?: boolean) => void;
  deleteDocuments: (ids: string[]) => void;
  markMissingChased: (ids: string[]) => void;
  addRule: (rule: Rule) => void;
  resolveDuplicate: (id: string, action: 'delete' | 'keep-both') => void;
  approveItems: (ids: string[]) => void;
  publishDocuments: (ids: string[]) => void;
  retryDocument: (id: string) => void;
  logAudit: (entry: Omit<AuditEntry, 'id' | 'at' | 'actor'>) => void;

  // UI
  isHistoryVisible: boolean;
  toggleHistory: () => void;
}

const AppContext = createContext<AppContextType | undefined>(undefined);

const ACTOR = 'You (Practice Admin)';

export const SETUP_LABEL: Record<SetupTask, string> = {
  profile: 'company details',
  ledger: 'accounting software',
  bank: 'bank feed',
};

let draftSeq = 0;

/** An empty conversation, hidden from history until it has its first message. */
function newDraft(attachedClientIds: string[], id?: string): Conversation {
  return {
    id: id ?? `draft-${Date.now()}-${draftSeq++}`,
    title: 'New conversation',
    messages: [],
    attachedClientIds,
    pinned: false,
    updatedAt: Date.now(),
  };
}

/**
 * The starting pipeline, built once. Anything the matcher can settle on its own
 * is already linked here, so the Bank section only ever asks about transactions
 * it genuinely cannot call.
 *
 * `intl` comes in as an argument because the matcher writes the reason a
 * transaction was linked, and `Match.reason` is text the accountant reads. This
 * runs inside `useState`'s initialiser, below the provider's own `useIntl()`.
 */
function buildInitialPipeline(intl: IntlShape) {
  // Expense receipts are ordinary cost documents — they belong in the inbox
  // and the archive like anything else, and the claim just points at them.
  const documents = buildDocuments(
    [...seedDocuments, ...seedExpenseDocuments, ...seedDuplicateCopies],
    seedClients,
  );
  const accounts = buildAccounts(seedClients);
  const missing = buildMissing(seedMissing, seedClients);
  const transactions = buildTransactions(seedTransactions, seedClients, missing, accounts);

  const auto = autoMatches(intl, transactions, documents, DEFAULT_MATCH_SETTINGS);
  const byTxn = new Map(auto.map((a) => [a.txnId, a.candidate]));

  const linked = transactions.map((t) => {
    const c = byTxn.get(t.id);
    return c ? { ...t, matchedDocId: c.document.id } : t;
  });

  const autoMatchRows: Match[] = auto.map(({ txnId, candidate }) => {
    const txn = transactions.find((t) => t.id === txnId)!;
    return {
      id: `match-auto-${txnId}`,
      clientName: txn.clientName,
      documentId: candidate.document.id,
      transactionId: txnId,
      documentLabel: shortLabel(candidate.document),
      transactionLabel: txnLabel(txn),
      amount: txn.amount,
      confidence: candidate.confidence,
      kind: candidate.kind,
      reason: candidate.reason,
      auto: true,
    };
  });

  // Evidence now exists for those, so they are no longer missing items.
  const resolved = new Set(
    auto.map(({ txnId }) => transactions.find((t) => t.id === txnId)?.missingItemId).filter(Boolean) as string[],
  );

  return {
    documents,
    accounts,
    transactions: linked,
    matches: [...autoMatchRows, ...seedMatches],
    missing: missing.filter((m) => !resolved.has(m.id)),
  };
}

export function AppProvider({ children }: { children: ReactNode }) {
  // `AppIntlProvider` sits above this in `main.tsx`, so messages are available
  // to the seed pipeline and to every derivation below it.
  const intl = useIntl();

  const [initial] = useState(() => buildInitialPipeline(intl));

  /**
   * Everything about *where you are* comes from the address bar rather than
   * from state, so every screen has a link, Back works, and nothing is
   * reachable that cannot be shared. The setters further down all navigate.
   *
   * Read here, above the data layer, because the session and the API slices
   * key off `portal`: a client on an SMS-link surface has no workspace
   * session and their browser must not go asking for the practice's data.
   */
  const segments = usePath();
  const [root, first, second] = segments;

  const portal: 'accountant' | 'business' | 'approval' | 'registration' | 'chase-upload' =
    root === 'portal' ? 'business'
      : root === 'approve' ? 'approval'
      : root === 'register' ? 'registration'
      // `/p/<token>`, and one letter on purpose: this address is typed into an
      // SMS, where every character is billed and re-typed by hand when the link
      // does not survive the client's phone.
      : root === 'p' ? 'chase-upload'
      : 'accountant';

  /**
   * The workspace session (METH Stage 6). Asked for only where a workspace
   * exists: API mode, practice shell. The API slices additionally wait for it
   * to be answered — a query fired before login would only 401, and a query
   * fired on a portal surface would be someone else's data being asked for
   * with a credential the visitor does not hold.
   */
  const workspaceApiOn = API_ENABLED && portal === 'accountant';
  const { session } = useSession({ enabled: workspaceApiOn });
  const slicesOn = workspaceApiOn && session.status === 'authenticated';

  const [clients, setClients] = useState<Client[]>(seedClients);
  const [documents, setDocuments] = useState<Document[]>(initial.documents);

  /**
   * The businesses slice (METH Stage 6) — the hydration pattern's proof. It
   * lives above the other slices because their row mappers resolve client
   * names through it, and the id bridge below reads it as a dictionary.
   */
  const businessesQuery = useBusinesses({ enabled: slicesOn, params: { limit: 100 } });

  /**
   * The seed↔server client-id bridge (METH S14 hardening).
   *
   * The synthetic cast keys everything on its own client ids ('1'); server
   * rows carry opaque ids ('biz_burger'). Until the clients list itself reads
   * from GET /businesses (the retirement plan recorded in api/uploads.ts),
   * the hydrated businesses slice is the dictionary between the two worlds —
   * joined by normalised name, the only fact both casts share.
   */
  const serverIdByClient = useMemo(() => {
    const map = new Map<string, string>();
    if (businessesQuery.businesses.length === 0) return map;
    const normalise = (name: string) =>
      name.toLowerCase().replace(/\b(ltd|limited)\b/g, '').replace(/[^a-z0-9]/g, '');
    const byName = new Map(businessesQuery.businesses.map((b) => [normalise(b.name), b.id]));
    for (const c of clients) {
      const hit = byName.get(normalise(c.name));
      if (hit && hit !== c.id) map.set(c.id, hit);
    }
    return map;
  }, [businessesQuery.businesses, clients]);

  const serverClientIdFor = useCallback(
    (clientId: string) =>
      serverIdByClient.get(clientId) ??
      // The MSW fixture convention (api/uploads.ts): seed ids became biz_<id>.
      (clientId.startsWith('biz_') ? clientId : `biz_${clientId}`),
    [serverIdByClient],
  );

  const isSameClient = useCallback(
    (rowClientId: string, clientId: string) =>
      rowClientId === clientId || rowClientId === serverClientIdFor(clientId),
    [serverClientIdFor],
  );

  /**
   * The documents surface, migrated to the API.
   *
   * The first read path off local state. It fills the same array every mutator
   * already writes to, rather than becoming a second source beside it — the
   * pipeline derives approvals, chases, duplicates and every client statistic
   * from `documents`, so a parallel list would have half the app disagreeing
   * with the other half about what exists.
   *
   * With `VITE_API_ENABLED` unset the query never runs and the seeds stand, so
   * the demo is unchanged until someone asks for the API.
   */
  const clientNameFor = useCallback(
    (businessId: string) => {
      const direct = clients.find((c) => c.id === businessId);
      if (direct) return direct.name;
      // A hydrated server row knows its own name — the businesses slice is
      // the authority for opaque ids the synthetic cast has never heard of.
      const hydrated = businessesQuery.businesses.find((b) => b.id === businessId);
      if (hydrated) return hydrated.name;
      // The mock encodes the seed id as biz_<id>; a real id will not match and
      // falls through to the id itself rather than inventing a name.
      const seeded = clients.find((c) => `biz_${c.id}` === businessId);
      return seeded?.name ?? businessId;
    },
    [clients, businessesQuery.businesses],
  );

  const documentsQuery = useDocuments({ enabled: slicesOn, clientNameFor, params: { limit: 100 } });

  useEffect(() => {
    if (!API_ENABLED || documentsQuery.documents.length === 0) return;
    setDocuments(documentsQuery.documents);
  }, [documentsQuery.documents]);
  const [accounts, setAccounts] = useState<BankAccount[]>(initial.accounts);
  const [transactions, setTransactions] = useState<BankTransaction[]>(initial.transactions);
  const [matches, setMatches] = useState<Match[]>(initial.matches);

  /**
   * The bank feed, migrated to the API (METH Stage 11).
   *
   * Same arrangement as `documents` above and for the same reason: it fills
   * the array every existing mutator already writes to, rather than becoming a
   * second source beside it. With `VITE_API_ENABLED` unset the query never
   * runs and the seeds stand, so the demo is unchanged until someone asks for
   * the API.
   *
   * ⚠ Server rows carry `matchState` and NOT `matchedDocId` — the contract has
   * no field for the matched document's id. `isMatched()` is what every screen
   * asks instead; see `lib/matching.ts`.
   */
  const bankQuery = useBankTransactions({ enabled: slicesOn, clientNameFor, params: { limit: 100 } });
  const refetchBank = bankQuery.refetch;

  useEffect(() => {
    if (!API_ENABLED || bankQuery.transactions.length === 0) return;
    setTransactions(bankQuery.transactions);
  }, [bankQuery.transactions]);

  /**
   * Unlike `documents` and `transactions` the businesses slice does not fill
   * a seed array, because nothing mutates a business client-side: the
   * provider simply selects between the server rows and the same shape
   * derived from the seeded clients. Either way a consumer gets one list,
   * and `slices` below says which world it came from.
   */
  const businesses = useMemo(
    () =>
      slicesOn && businessesQuery.businesses.length > 0
        ? businessesQuery.businesses
        : deriveBusinessSummaries(clients, documents),
    [slicesOn, businessesQuery.businesses, clients, documents],
  );

  /**
   * Where each slice's data actually came from. Recomputed every render on
   * purpose — the inputs are the queries' own observable state, and the
   * provider's value object is rebuilt per render anyway.
   *
   * `chases` and `proposals` stayed 'seed' HERE when METH S12 wired their
   * screens, and that is a statement about these arrays, not those screens:
   * the live queries live in the view chunks (`api/chases.ts`,
   * `api/proposals.ts` — ChasesView, ApprovalsView, InboxesView), because a
   * fill effect in this file would put their generated clients on the bundle
   * floor, which has no headroom (apps/web/CLAUDE.md, Bundle). The wired
   * views compute their own `sliceStatus` and wear their own badge; the
   * synthetic `chases`/`approvals` arrays keep feeding everything else.
   * `publishes` has no reading screen yet.
   */
  const slices: SliceStatuses = {
    documents: sliceStatus(slicesOn, documentsQuery),
    bankTransactions: sliceStatus(slicesOn, bankQuery),
    businesses: sliceStatus(slicesOn, businessesQuery),
    chases: SEED_SLICE,
    proposals: SEED_SLICE,
    publishes: SEED_SLICE,
  };

  /**
   * Ends the workspace session. The cookie clear is best-effort (see
   * `api/auth.ts`); the invalidation is what matters — /me refetches to a
   * 401, App returns to LoginView, and the gated slices go quiet with it.
   */
  const logout = useCallback(async () => {
    await apiLogout();
    await queryClient.invalidateQueries();
  }, []);
  const [statements, setStatements] = useState<Statement[]>(seedStatements);
  const [supplierStatements, setSupplierStatements] = useState<SupplierStatement[]>(seedSupplierStatements);
  const [expenseClaims, setExpenseClaims] = useState<ExpenseClaim[]>(seedExpenseClaims);
  const [statementGaps, setStatementGaps] = useState<StatementGap[]>(() => buildGaps(seedClients, initial.accounts));
  const [matchSettings, setMatchSettings] = useState<MatchSettings>(DEFAULT_MATCH_SETTINGS);
  /**
   * Pairs a person has already ruled on, so a decision sticks. Detection is
   * pure and re-runs on every change — without this, "keep both" would be
   * undone the moment anything else moved.
   */
  const [resolvedDuplicates, setResolvedDuplicates] = useState<string[]>([]);

  const [rules, setRules] = useState<Rule[]>(seedRules);
  const [chasePolicy, setChasePolicyState] = useState<ChasePolicy>(DEFAULT_CHASE_POLICY);

  /** Central clamp: no caller can set a secure link to outlive a week. */
  const setChasePolicy = useCallback((p: ChasePolicy) => {
    setChasePolicyState({ ...p, linkTtlHours: clampLinkTtl(p.linkTtlHours) });
  }, []);
  const [chases, setChases] = useState<Chase[]>(() =>
    buildChases(initial.missing, seedClients, DEFAULT_CHASE_POLICY),
  );
  const [itemMessages, setItemMessages] = useState<ItemMessage[]>([]);
  const [approvalWorkflows, setApprovalWorkflows] = useState<ApprovalWorkflow[]>(seedWorkflows);
  const [approvals, setApprovals] = useState<ApprovalItem[]>(() => buildApprovals(initial.documents, seedWorkflows));
  const [approvalRequests, setApprovalRequests] = useState<ApprovalRequest[]>([]);
  const [clientDetailChanges, setClientDetailChanges] = useState<ClientDetailChange[]>([]);

  /**
   * Proposes edits to a client's record. Nothing is written to the client
   * until they agree — returns how many were actually queued, so the caller
   * can say so.
   */
  const proposeClientDetailChanges = useCallback(
    (clientId: string, changes: { field: ClientDetailChange['field']; label: string; to: string }[]) => {
      const client = clients.find((c) => c.id === clientId);
      if (!client) return 0;

      const queued = changes
        .map((c) => ({ ...c, from: String(client[c.field] ?? '') }))
        .filter((c) => c.to.trim() !== c.from.trim());
      if (queued.length === 0) return 0;

      setClientDetailChanges((prev) => [
        ...queued.map((c, i) => ({
          id: `chg-${clientId}-${Date.now()}-${i}`,
          clientId,
          clientName: client.name,
          field: c.field,
          label: c.label,
          from: c.from || '—',
          to: c.to.trim(),
          requestedBy: ACTOR,
          requestedAt: 'just now',
          status: 'pending' as const,
        })),
        // A field proposed twice keeps only the newer request.
        ...prev.filter(
          (p) => !(p.clientId === clientId && p.status === 'pending' && queued.some((q) => q.field === p.field)),
        ),
      ]);

      logAudit({
        action: 'Proposed a change to client details',
        scope: `${client.name} — ${queued.map((c) => c.label).join(', ')} · waiting on the client`,
        reviewOpened: true,
      });
      return queued.length;
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps -- logAudit is declared later in this file (a dep here is a TDZ crash at render) and is a []-dep useCallback, stable for the app's lifetime; #87 file, inventory for the stable-callback sweep.
    [clients],
  );

  /** The business's ruling. Approving is what writes it to the record. */
  const reviewClientDetailChange = useCallback((id: string, verdict: 'approve' | 'decline', reason?: string) => {
    setClientDetailChanges((prev) =>
      prev.map((c) => {
        if (c.id !== id) return c;
        if (verdict === 'approve') {
          setClients((all) => all.map((cl) => (cl.id === c.clientId ? { ...cl, [c.field]: c.to } : cl)));
        }
        return { ...c, status: verdict === 'approve' ? 'approved' : 'declined', declinedReason: reason };
      }),
    );
  }, []);

  const [vault, setVault] = useState<VaultDocument[]>(() => buildVault(seedClients));
  const [colleagues, setColleagues] = useState<Colleague[]>(seedColleagues);
  const [teams, setTeams] = useState<Team[]>(seedTeams);
  const [tasks, setTasks] = useState<WorkflowTask[]>(() => buildTasks(seedClients));
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS);

  /**
   * Duplicates are derived, never stored: a flag is a live opinion about the
   * documents on file, so correcting a supplier or a total re-runs the test
   * rather than leaving a stale pair behind. `off` disables the whole stage.
   */
  const duplicates = useMemo(
    () =>
      settings.duplicateMode === 'off'
        ? []
        : detectDuplicates(intl, documents).filter((d) => !resolvedDuplicates.includes(d.id)),
    [intl, documents, settings.duplicateMode, resolvedDuplicates],
  );

  const [missing, setMissing] = useState<MissingItem[]>(initial.missing);
  const [auditLog, setAuditLog] = useState<AuditEntry[]>([]);

  const [routingRules, setRoutingRules] = useState<RoutingRule[]>([]);
  const [mandatoryFields, setMandatoryFields] = useState<string[]>([]);
  const [ingestRejections, setIngestRejections] = useState<{ fileName: string; reason: string; at: string }[]>([]);
  /** Spreadsheets that have been read, newest first. */
  const [sheetImports, setSheetImports] = useState<SheetImport[]>([]);

  const [onboardingLinks, setOnboardingLinks] = useState<OnboardingLink[]>([]);
  const [businessAccounts, setBusinessAccounts] = useState<BusinessAccount[]>(() => buildBusinessAccounts(seedClients));

  // `segments`/`root`/`portal` are read at the top of the provider (the
  // session and the API slices key off them); everything else the address
  // carries is derived here, with the setters that navigate.
  const openApprovalRequestId = root === 'approve' ? first ?? null : null;
  const portalLinkToken = root === 'p' ? first ?? null : null;
  const portalAccountId = root === 'portal' ? first ?? null : null;
  const openRegistrationFor =
    root === 'register' && first && second ? { accountId: first, memberId: second } : null;

  const activeTab = root === undefined ? 'AI Workspace' : (fromSlug(root, SIDEBAR_TABS) ?? 'AI Workspace');
  const openClientId = root === 'clients' ? first ?? null : null;

  const setActiveTab = useCallback((tab: string) => {
    navigate(tab === 'AI Workspace' ? '/' : path(slug(tab)));
  }, []);

  const openClient = useCallback((id: string | null) => {
    navigate(id ? path('clients', id) : '/clients');
  }, []);

  const [starredClientIds, setStarredClientIds] = useState<string[]>(['1']);

  /**
   * There is always exactly one active conversation. A brand-new one starts
   * empty and is hidden from history until it has its first message, which
   * also gives it its title. Keeping the active id stable means callbacks stay
   * correct across awaits and are safe to run twice under StrictMode.
   */
  const [conversations, setConversations] = useState<Conversation[]>(() => [
    newDraft(['1'], 'draft-initial'),
    ...seedConversations,
  ]);
  /**
   * The conversation in the address bar, falling back to the newest draft.
   * A new chat is a new address, so history is browsable rather than a menu.
   */
  const routedConversationId = root === 'chat' ? first : undefined;
  const [fallbackConversationId, setFallbackConversationId] = useState<string>('draft-initial');
  const activeConversationId = routedConversationId ?? fallbackConversationId;
  /**
   * Navigation is a side effect, so it happens here in the callback — never
   * inside the state updater. React replays updaters during the render phase
   * (always when another update is already queued, and twice under
   * StrictMode), so a navigate() in the updater dispatched 'app:navigate'
   * mid-render: the setState-during-render warning, and the hooks-order crash
   * under rapid route changes (#87).
   */
  const setActiveConversationId = useCallback((value: string) => {
    setFallbackConversationId(value);
    navigate(path('chat', value));
  }, []);
  const [isHistoryVisible, setIsHistoryVisible] = useState(false);

  const active = conversations.find((c) => c.id === activeConversationId) ?? conversations[0];
  const messages = active?.messages ?? [];

  const attachedClients = useMemo(
    () => clients.filter((c) => (active?.attachedClientIds ?? []).includes(c.id)),
    [clients, active],
  );

  const patch = useCallback((id: string, fn: (c: Conversation) => Conversation) => {
    setConversations((prev) => prev.map((c) => (c.id === id ? fn(c) : c)));
  }, []);

  const addMessage = useCallback(
    (msg: Message) => {
      const id = activeConversationId;
      patch(id, (c) => {
        if (c.messages.some((m) => m.id === msg.id)) return c; // idempotent under StrictMode
        return {
          ...c,
          title: c.messages.length === 0 && msg.role === 'user' ? titleFromMessage(msg.content) : c.title,
          messages: [...c.messages, msg],
          updatedAt: Date.now(),
        };
      });
    },
    [activeConversationId, patch],
  );

  /**
   * Opens the AI workspace on a new conversation already scoped to these
   * clients — the bridge the Clients section uses for [Ask AI] and [Chase].
   */
  const startConversation = useCallback((clientIds: string[], seed: Message[] = []) => {
    const draft = newDraft(clientIds.length ? clientIds : ['1']);
    const conversation: Conversation = seed.length
      ? {
          ...draft,
          messages: seed,
          // The `seed.length` ternary above guarantees seed[0]; restate it.
          title: titleFromMessage(seed.find((m) => m.role === 'user')?.content ?? seed[0]?.content ?? ''),
        }
      : draft;
    setConversations((prev) => [conversation, ...prev.filter((c) => c.messages.length > 0)]);
    // A new chat is a new address — one navigation, not three state writes.
    setFallbackConversationId(conversation.id);
    navigate(path('chat', conversation.id));
  }, []);

  const startFresh = useCallback(() => {
    const draft = newDraft(active?.attachedClientIds ?? ['1']);
    // Drop any other empty drafts so history stays clean.
    setConversations((prev) => [draft, ...prev.filter((c) => c.messages.length > 0)]);
    setActiveConversationId(draft.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- setActiveConversationId is a []-dep useCallback, stable for the app's lifetime; #87 file, inventory for the stable-callback sweep.
  }, [active]);

  const setMessages = useCallback(
    (msgs: Message[]) => {
      if (msgs.length === 0) {
        startFresh();
        return;
      }
      patch(activeConversationId, (c) => ({ ...c, messages: msgs, updatedAt: Date.now() }));
    },
    [activeConversationId, patch, startFresh],
  );

  // eslint-disable-next-line react-hooks/exhaustive-deps -- setActiveConversationId is a []-dep useCallback, stable for the app's lifetime; #87 file, inventory for the stable-callback sweep.
  const selectConversation = useCallback((id: string) => setActiveConversationId(id), []);

  const deleteConversation = useCallback(
    (id: string) => {
      setConversations((prev) => {
        const next = prev.filter((c) => c.id !== id);
        return next.length ? next : [newDraft(['1'])];
      });
      // Only deleting the conversation on screen moves the user; deleting any
      // other row must not navigate them away from what they are reading.
      if (activeConversationId !== id) return;
      const fallback = conversations.find((c) => c.id !== id);
      if (fallback) setActiveConversationId(fallback.id);
    },
    [conversations, activeConversationId, setActiveConversationId],
  );

  const togglePinConversation = useCallback((id: string) => {
    setConversations((prev) => prev.map((c) => (c.id === id ? { ...c, pinned: !c.pinned } : c)));
  }, []);

  const attachClient = useCallback(
    (id: string) => {
      patch(activeConversationId, (c) =>
        c.attachedClientIds.includes(id) ? c : { ...c, attachedClientIds: [...c.attachedClientIds, id] },
      );
    },
    [activeConversationId, patch],
  );

  const detachClient = useCallback(
    (id: string) => {
      patch(activeConversationId, (c) => ({ ...c, attachedClientIds: c.attachedClientIds.filter((x) => x !== id) }));
    },
    [activeConversationId, patch],
  );

  const logAudit = useCallback((entry: Omit<AuditEntry, 'id' | 'at' | 'actor'>) => {
    setAuditLog((prev) => [
      {
        ...entry,
        id: `audit-${Date.now()}-${prev.length}`,
        actor: ACTOR,
        at: new Date().toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }),
      },
      ...prev,
    ]);
  }, []);

  const addClient = useCallback((client: Client) => setClients((prev) => [...prev, client]), []);

  /**
   * Queues the one setup SMS. Sending again for a client replaces the live link
   * rather than leaving two valid ones in the wild.
   */
  const sendOnboardingLink = useCallback(
    (client: Client, tasks: SetupTask[]) => {
      if (!client || tasks.length === 0) return;
      const clientId = client.id;

      // "Connect" is wrong for the profile task — that one is filled in, not
      // authorised — so the two read as separate clauses.
      const connect = tasks.filter((t) => t !== 'profile').map((t) => SETUP_LABEL[t]);
      const what = [
        ...(tasks.includes('profile') ? ['register your company details'] : []),
        ...(connect.length ? [`connect your ${connect.join(' and ')}`] : []),
      ].join(', then ');
      setOnboardingLinks((prev) => [
        {
          id: `setup-${clientId}-${Date.now()}`,
          clientId,
          clientName: client.name,
          recipientName: client.contactName ?? 'Primary contact',
          recipientMobile: client.mobile ?? '—',
          tasks,
          completed: [],
          sentAt: 'just now',
          expiresInHours: 72,
          resendCount: 0,
          message: `${client.name}: your accountant needs you to ${what}. It takes two minutes and only you can do it — your logins are never shared with them.`,
        },
        ...prev.filter((l) => l.clientId !== clientId),
      ]);
    },
    [],
  );

  const resendOnboardingLink = useCallback((id: string) => {
    setOnboardingLinks((prev) =>
      prev.map((l) =>
        l.id === id ? { ...l, sentAt: 'just now', expiresInHours: 72, resendCount: l.resendCount + 1 } : l,
      ),
    );
  }, []);

  /**
   * The client connects at the provider. The connection flag is only ever set
   * from here — the practice has no way to switch it on itself.
   */
  const completeOnboardingTask = useCallback((clientId: string, task: SetupTask) => {
    const patchFor: Record<SetupTask, Partial<Client>> = {
      // The client has filled in the record the invite path left blank.
      profile: { awaitingRegistration: false },
      ledger: { xeroConnected: true },
      bank: { bankConnected: true },
    };
    setClients((prev) => prev.map((c) => (c.id === clientId ? { ...c, ...patchFor[task] } : c)));
    setOnboardingLinks((prev) =>
      prev.map((l) =>
        l.clientId === clientId && !l.completed.includes(task)
          ? { ...l, completed: [...l.completed, task] }
          : l,
      ),
    );
  }, []);

  /**
   * Portal switching. Opening the business portal deliberately drops the
   * practice-side navigation state, so nothing from the accountant's session
   * bleeds into the shell the client sees.
   */
  const openBusinessPortal = useCallback((accountId: string | null = null) => {
    navigate(accountId ? path('portal', accountId) : '/portal');
  }, []);

  const exitBusinessPortal = useCallback(() => navigate('/clients'), []);

  /**
   * Opening the SMS approval link. Deliberately not the business portal: the
   * approver needs no account, and the session covers one client's batch only.
   */
  const openApprovalLink = useCallback((requestId: string) => {
    navigate(path('approve', requestId));
  }, []);

  /**
   * Invite someone at the business, from the practice side. Only three things
   * are asked for — who they are, their number, and what they may do — because
   * everything else is theirs to supply. If the client has no portal account
   * yet, inviting a user is what creates one.
   */
  const inviteBusinessUser = useCallback(
    (
      clientId: string,
      invite: {
        name: string;
        email: string;
        mobile: string;
        role: BusinessMemberRole;
        canUpload: boolean;
        canSeeTotals: boolean;
      },
    ) => {
      const client = clients.find((c) => c.id === clientId);
      if (!client) return;

      const member: BusinessMember = {
        id: `bm-${Date.now()}`,
        name: invite.name.trim(),
        email: invite.email.trim(),
        mobile: invite.mobile.trim(),
        role: invite.role,
        canUpload: invite.canUpload,
        canSeeTotals: invite.canSeeTotals,
        // Nothing is sent to them yet — the business has to agree first.
        status: 'pending-client-approval',
        invitedAt: 'just now',
        invitedBy: ACTOR,
      };

      setBusinessAccounts((prev) => {
        const existing = prev.find((a) => a.clientId === clientId);
        if (existing) {
          return prev.map((a) => (a.id === existing.id ? { ...a, members: [...a.members, member] } : a));
        }
        return [
          ...prev,
          newBusinessAccount({
            clientId,
            businessName: client.name,
            contactName: client.contactName ?? invite.name.trim(),
            email: '',
            mobile: client.mobile ?? invite.mobile.trim(),
            origin: 'accountant-invite',
            createdBy: ACTOR,
            members: [member],
          }),
        ];
      });

      logAudit({
        action: 'Proposed a business user',
        scope: `${invite.name.trim()} (${invite.role}) at ${client.name} — waiting on the client to approve`,
        reviewOpened: true,
      });
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps -- logAudit is a []-dep useCallback, stable for the app's lifetime; #87 file, inventory for the stable-callback sweep.
    [clients],
  );

  /**
   * The business's ruling on someone the practice proposed. Approving is what
   * sends the invite — until then the person has been told nothing, which is
   * the point: their own employer decides whether they get access.
   */
  const reviewProposedUser = useCallback(
    (accountId: string, memberId: string, verdict: 'approve' | 'decline', reason?: string) => {
      let name = '';
      setBusinessAccounts((prev) =>
        prev.map((a) => {
          if (a.id !== accountId) return a;
          return {
            ...a,
            members: a.members.map((m) => {
              if (m.id !== memberId) return m;
              name = m.name;
              return verdict === 'approve'
                ? { ...m, status: 'invited' as const, approvedBy: a.contactName, approvedAt: 'just now' }
                : { ...m, status: 'declined' as const, declinedReason: reason };
            }),
          };
        }),
      );
      logAudit({
        action: verdict === 'approve' ? 'Client approved a new user' : 'Client declined a new user',
        scope: reason ? `${name} — ${reason}` : name,
        reviewOpened: true,
      });
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps -- logAudit is a []-dep useCallback, stable for the app's lifetime; #87 file, inventory for the stable-callback sweep.
    [],
  );

  const completeBusinessUserRegistration = useCallback(
    (accountId: string, memberId: string, patch: Partial<BusinessMember>) => {
      setBusinessAccounts((prev) =>
        prev.map((a) =>
          a.id === accountId
            ? { ...a, members: a.members.map((m) => (m.id === memberId ? { ...m, ...patch, status: 'active' } : m)) }
            : a,
        ),
      );
    },
    [],
  );

  const openRegistrationLink = useCallback((accountId: string, memberId: string) => {
    navigate(path('register', accountId, memberId));
  }, []);

  const createBusinessAccount = useCallback((account: BusinessAccount) => {
    setBusinessAccounts((prev) => [...prev, account]);
  }, []);

  const updateBusinessAccount = useCallback((id: string, patchFields: Partial<BusinessAccount>) => {
    setBusinessAccounts((prev) => prev.map((a) => (a.id === id ? { ...a, ...patchFields } : a)));
  }, []);

  const activateBusinessAccount = useCallback((id: string) => {
    setBusinessAccounts((prev) => prev.map((a) => (a.id === id ? { ...a, status: 'active' } : a)));
  }, []);

  const updateClient = useCallback((id: string, patchFields: Partial<Client>) => {
    setClients((prev) => prev.map((c) => (c.id === id ? { ...c, ...patchFields } : c)));
  }, []);

  const toggleStarClient = useCallback((id: string) => {
    setStarredClientIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  }, []);

  const statsFor = useCallback(
    (clientId: string) => {
      const client = clients.find((c) => c.id === clientId) ?? clients[0];
      return deriveClientStats(client, { documents, missing, chases, approvals, duplicates, transactions, statementGaps });
    },
    [clients, documents, missing, chases, approvals, duplicates, transactions, statementGaps],
  );

  const updateDocumentStatus = useCallback((id: string, status: DocStatus) => {
    setDocuments((prev) => prev.map((d) => (d.id === id ? { ...d, status } : d)));
  }, []);

  /**
   * Corrects the AI's money-in / money-out call.
   *
   * Classification is a judgement made from the bill-to block, and it is
   * occasionally wrong. When it is, the document is not in the wrong state —
   * it is in the wrong inbox entirely, so the correction moves it and records
   * that a person, not the model, decided.
   */
  const setDocumentKind = useCallback((id: string, kind: DocKind) => {
    setDocuments((prev) =>
      prev.map((d) =>
        d.id !== id
          ? d
          : {
              ...d,
              kind,
              fields: d.fields.map((f) =>
                f.label === 'Document type'
                  ? {
                      ...f,
                      value: kind === 'sales' ? 'Money in — sales invoice' : 'Money out — bill or receipt',
                      confidence: 1,
                      provenance: 'corrected by accountant',
                    }
                  : f,
              ),
            },
      ),
    );
  }, []);

  /** Corrections are stored against the field; the original image is never altered. */
  const updateDocumentField = useCallback((docId: string, label: string, value: string) => {
    setDocuments((prev) =>
      prev.map((d) =>
        d.id === docId
          ? {
              ...d,
              fields: d.fields.map((f) =>
                f.label === label ? { ...f, value, confidence: 1, provenance: 'corrected by accountant' } : f,
              ),
            }
          : d,
      ),
    );
  }, []);

  /**
   * Files enter at stage 1 as Processing documents; extraction lands a few
   * seconds later and moves each one to To Review or Ready.
   */
  const ingest = useCallback(
    (
      files: { name: string; size: number; raw?: File }[],
      clientId: string | undefined,
      source: SourceChannel,
      options?: IngestOptions,
    ) => {
      const client = clients.find((c) => c.id === clientId);
      const { documents: created, rejected, sheets } = ingestFiles(files, client, source, intl, options);

      if (rejected.length) {
        setIngestRejections((prev) => [
          ...rejected.map((r) => ({ ...r, at: new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }) })),
          ...prev,
        ]);
      }

      // No client named at upload is not a filing problem for a human to
      // clear later — extraction reads the addressee off the document, and an
      // uncertain read lands in To Review asking to be confirmed.
      if (created.length) {
        setDocuments((prev) => [...created, ...prev]);
        const ids = created.map((d) => d.id);
        setTimeout(() => {
          setDocuments((prev) => prev.map((d) => (ids.includes(d.id) ? completeExtraction(d, clients, routingRules) : d)));
        }, 2600);
      }

      /**
       * Spreadsheets are read here rather than extracted.
       *
       * The work is asynchronous — an XLSX has to be unzipped before a single
       * cell can be seen — so each file gets a ticket immediately and the rows
       * arrive against it. That way the screen has something true to show from
       * the first frame instead of an empty table that fills in later.
       */
      const tickets: SheetImport[] = sheets.map((sheet, i) => ({
        id: `sheet-${Date.now()}-${i}`,
        fileName: sheet.fileName,
        status: 'reading',
        documentIds: [],
        transactionIds: [],
        skipped: [],
        counts: { cost: 0, sales: 0, transactions: 0 },
      }));

      if (tickets.length) {
        setSheetImports((prev) => [...tickets, ...prev]);

        sheets.forEach((sheet, i) => {
          const ticket = tickets[i];
          if (!ticket) return; // `tickets` was mapped from `sheets`, so i is in range — restated for the compiler
          void (async () => {
            try {
              const analysis = analyseSheet(await readTable(sheet.file));
              if (!analysis.rows.length) throw new Error('No rows found under the headings');

              const account = accounts.find((a) => a.clientId === client?.id);
              const { documents: rows, transactions: txns, skipped } = importSheet(
                analysis,
                sheet.fileName,
                client,
                'csv',
                options?.uploader ?? 'You (web upload)',
                account?.id ?? '',
              );

              if (rows.length) setDocuments((prev) => [...rows, ...prev]);
              if (txns.length) setTransactions((prev) => [...txns, ...prev]);

              setSheetImports((prev) =>
                prev.map((t) =>
                  t.id !== ticket.id
                    ? t
                    : {
                        ...t,
                        status: 'done',
                        sheetKind: analysis.kind,
                        reason: analysis.reason,
                        headers: analysis.headers,
                        mapping: analysis.mapping,
                        unmapped: analysis.unmapped,
                        documentIds: rows.map((d) => d.id),
                        transactionIds: txns.map((x) => x.id),
                        skipped,
                        counts: {
                          cost: rows.filter((d) => d.kind === 'cost').length,
                          sales: rows.filter((d) => d.kind === 'sales').length,
                          transactions: txns.length,
                        },
                      },
                ),
              );

              logAudit({
                action: 'Imported a spreadsheet',
                scope: `${sheet.fileName} → ${rows.length} document(s), ${txns.length} transaction(s)`,
                reviewOpened: true,
              });
            } catch (error) {
              // The reader is module scope, so the two failures it raises
              // itself come back as catalogue entries and are worded here.
              // Anything else — a platform error, a corrupt buffer — keeps
              // whatever text it already carried.
              const descriptor = sheetReadMessage(error);
              const message = descriptor
                ? intl.formatMessage(descriptor)
                : error instanceof Error
                ? error.message
                : 'The file could not be read';

              setSheetImports((prev) =>
                prev.map((t) => (t.id !== ticket.id ? t : { ...t, status: 'failed', error: message })),
              );
            }
          })();
        });
      }

      return { documents: created, rejected, imports: tickets };
    },
    [clients, routingRules, accounts, logAudit, intl],
  );

  const moveDocuments = useCallback(
    (ids: string[], clientId: string, teachSender = false) => {
      const client = clients.find((c) => c.id === clientId);
      if (!client) return;

      const moved = documents.filter((d) => ids.includes(d.id));
      setDocuments((prev) =>
        prev.map((d) => (ids.includes(d.id) ? { ...d, clientId: client.id, clientName: client.name } : d)),
      );

      if (!teachSender) return;
      // One rule per distinct sender, and never a second rule for a sender
      // that already has one — a taught address must have a single answer.
      const senders = [...new Set(moved.map((d) => d.uploader).filter(Boolean))];
      setRoutingRules((prev) => [
        ...prev,
        ...senders
          .filter((sender) => !prev.some((r) => r.sender.toLowerCase() === sender.toLowerCase()))
          .map((sender) => ({ sender, clientId: client.id, clientName: client.name })),
      ]);
    },
    [clients, documents],
  );

  const deleteDocuments = useCallback((ids: string[]) => {
    setDocuments((prev) => prev.filter((d) => !ids.includes(d.id)));
  }, []);


  /**
   * Links a document to a transaction. Bank Match never creates transactions —
   * it explains existing ones. Because an unexplained transaction *is* a
   * missing item, matching one also closes that item and its chase.
   */
  const matchTransaction = useCallback(
    (txnId: string, documentId: string, kind: MatchKind, confidence: number, reason: string) => {
      const txn = transactions.find((t) => t.id === txnId);
      const doc = documents.find((d) => d.id === documentId);
      if (!txn || !doc) return;

      setTransactions((prev) => prev.map((t) => (t.id === txnId ? { ...t, matchedDocId: documentId } : t)));
      setMatches((prev) => [
        {
          id: `match-${txnId}-${documentId}`,
          clientName: txn.clientName,
          documentId,
          transactionId: txnId,
          documentLabel: shortLabel(doc),
          transactionLabel: txnLabel(txn),
          amount: txn.amount,
          confidence,
          kind,
          reason,
        },
        ...prev,
      ]);

      if (txn.missingItemId) setMissing((prev) => prev.filter((m) => m.id !== txn.missingItemId));

      // On the API, the match is only real once it is APPROVED (Governance
      // §10): create the proposal, open the review, approve echoing the hash.
      // The optimistic local update above stays — it is what makes the click
      // feel instant — and the refetch below replaces it with server truth
      // either way, so a refusal corrects the screen rather than leaving a
      // match that only this browser believes in.
      if (!API_ENABLED) return;
      void confirmMatchProposal({
        businessId: txn.clientId,
        transactionId: txnId,
        documentId,
        kind,
        confidence,
      })
        .catch((error: unknown) => {
          logAudit({
            action: 'Match could not be confirmed',
            scope: `${txnLabel(txn)} — ${error instanceof Error ? error.message : 'unknown error'}`,
            reviewOpened: true,
          });
        })
        .finally(() => {
          void refetchBank();
        });
    },
    // `refetchBank`, not `bankQuery`: the hook returns a fresh object every
    // render, so depending on the whole thing would rebuild this callback on
    // every render for no behavioural gain.
    [transactions, documents, logAudit, refetchBank],
  );

  const unmatchTransaction = useCallback(
    (matchId: string) => {
      const match = matches.find((m) => m.id === matchId);
      if (!match) return;

      setMatches((prev) => prev.filter((m) => m.id !== matchId));
      setTransactions((prev) => prev.map((t) => (t.id === match.transactionId ? { ...t, matchedDocId: undefined } : t)));
    },
    [matches],
  );

  /** Cash coding: the transaction becomes a cost item entering the pipeline. */
  const cashCode = useCallback(
    (txnId: string, category: string) => {
      const txn = transactions.find((t) => t.id === txnId);
      if (!txn) return;

      const docId = `cash-${txnId}`;
      setDocuments((prev) => [
        {
          id: docId,
          clientId: txn.clientId,
          clientName: txn.clientName,
          supplier: txn.description.replace(/\b(LTD|LIMITED|ONLINE|PAYMENT)\b/g, '').trim() || txn.description,
          date: txn.date,
          total: Math.abs(txn.amount),
          category,
          status: category === '—' ? 'review' : 'ready',
          statusNote: category === '—' ? 'Missing Category' : undefined,
          source: 'web',
          uploader: 'Cash coded from bank',
          currency: 'GBP',
          kind: 'cost',
          fields: [
            { label: 'Supplier', value: txn.description, confidence: 1, provenance: 'bank transaction description' },
            { label: 'Total', value: `£${Math.abs(txn.amount).toFixed(2)}`, confidence: 1, provenance: 'bank transaction amount' },
            { label: 'Category', value: category, confidence: 1, provenance: 'set by accountant at cash coding' },
          ],
          lineItems: [],
        },
        ...prev,
      ]);

      setTransactions((prev) => prev.map((t) => (t.id === txnId ? { ...t, matchedDocId: docId } : t)));
      if (txn.missingItemId) setMissing((prev) => prev.filter((m) => m.id !== txn.missingItemId));
    },
    [transactions],
  );

  /** Statement fallback for clients without a live feed, with gap detection. */
  /**
   * A supplier statement lands in Processing, then reconciles against the
   * documents we already hold for that supplier. Any line we cannot match is
   * a missing invoice — which is the whole reason to ask for the statement.
   */
  const uploadSupplierStatement = useCallback(
    (fileName: string, clientId: string, supplier: string) => {
      const client = clients.find((c) => c.id === clientId);
      if (!client) return;
      const id = `sup-${Date.now()}`;

      setSupplierStatements((prev) => [
        {
          id,
          clientId,
          clientName: client.name,
          supplier,
          fileName,
          period: 'extracting…',
          statementTotal: 0,
          lines: [],
          status: 'processing',
          uploadedAt: 'just now',
        },
        ...prev,
      ]);

      logAudit({ action: 'Uploaded supplier statement', scope: `${supplier} — ${client.name}`, reviewOpened: true });

      // Extraction, then reconciliation against what is already on file.
      window.setTimeout(() => {
        setSupplierStatements((prev) =>
          prev.map((st) => {
            if (st.id !== id) return st;
            const held = documents.filter(
              (d) => d.clientId === clientId && d.supplier.toLowerCase().includes(supplier.toLowerCase()),
            );
            const lines: SupplierStatementLine[] = held.map((d, i) => ({
              reference: `${supplier.slice(0, 3).toUpperCase()}-${10000 + i}`,
              date: d.date,
              total: d.total,
              documentId: d.id,
            }));
            // A statement almost always lists something we have not seen —
            // that is what makes it worth reconciling.
            lines.push({
              reference: `${supplier.slice(0, 3).toUpperCase()}-${10000 + held.length}`,
              date: '05 Aug 2026',
              total: 418.6,
            });
            return {
              ...st,
              period: '01 Aug – 12 Aug 2026',
              statementTotal: Math.round(lines.reduce((n, l) => n + l.total, 0) * 100) / 100,
              lines,
              status: lines.some((l) => !l.documentId) ? 'gaps' : 'reconciled',
            };
          }),
        );
      }, 1600);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps -- logAudit is a []-dep useCallback, stable for the app's lifetime; #87 file, inventory for the stable-callback sweep.
    [clients, documents],
  );

  const deleteSupplierStatement = useCallback(
    (id: string) => setSupplierStatements((prev) => prev.filter((st) => st.id !== id)),
    [],
  );

  const saveExpenseClaim = useCallback((claim: ExpenseClaim) => {
    setExpenseClaims((prev) =>
      prev.some((c) => c.id === claim.id) ? prev.map((c) => (c.id === claim.id ? claim : c)) : [claim, ...prev],
    );
  }, []);

  const setExpenseClaimStatus = useCallback((id: string, status: ExpenseClaimStatus) => {
    setExpenseClaims((prev) =>
      prev.map((c) => (c.id === id ? { ...c, status, submittedAt: status === 'submitted' ? 'just now' : c.submittedAt } : c)),
    );
  }, []);

  const deleteExpenseClaim = useCallback(
    (id: string) => setExpenseClaims((prev) => prev.filter((c) => c.id !== id)),
    [],
  );

  const uploadStatement = useCallback(
    (fileName: string, clientId: string) => {
      const client = clients.find((c) => c.id === clientId);
      if (!client) return;
      const account = accounts.find((a) => a.clientId === clientId);
      const id = `st-${Date.now()}`;

      setStatements((prev) => [
        {
          id,
          clientId,
          clientName: client.name,
          accountId: account?.id ?? '',
          fileName,
          period: 'extracting…',
          openingBalance: 0,
          closingBalance: 0,
          rows: 0,
          status: 'processing',
          uploadedAt: 'just now',
        },
        ...prev,
      ]);

      setTimeout(() => {
        setStatements((prev) =>
          prev.map((s) =>
            s.id === id
              ? {
                  ...s,
                  status: 'extracted',
                  period: '01 Aug – 31 Aug 2026',
                  openingBalance: 9871.4,
                  closingBalance: 12418.06,
                  rows: 143,
                }
              : s,
          ),
        );
        // A statement covering a gap period closes that gap.
        setStatementGaps((prev) => prev.filter((g, i) => !(g.clientId === clientId && i === prev.findIndex((x) => x.clientId === clientId))));
      }, 2600);
    },
    [clients, accounts],
  );

  const reauthAccount = useCallback((accountId: string) => {
    setAccounts((prev) =>
      prev.map((a) => (a.id === accountId ? { ...a, status: 'live', reauthDays: 90, lastSync: 'just now' } : a)),
    );
  }, []);

  const markMissingChased = useCallback((ids: string[]) => {
    setMissing((prev) => prev.map((m) => (ids.includes(m.id) ? { ...m, chased: true } : m)));
  }, []);

  /**
   * Sends a chase (or folds new items into a client's live one). SMS-only by
   * design — the client can still reply through any inbound channel.
   */
  const sendChase = useCallback(
    (clientId: string, missingItemIds: string[], message?: string) => {
      const client = clients.find((c) => c.id === clientId);
      if (!client) return;
      const items = missing.filter((m) => missingItemIds.includes(m.id));
      if (items.length === 0) return;

      markMissingChased(missingItemIds);

      setChases((prev) => {
        const existing = prev.find((c) => c.clientId === clientId);
        const newItems = items.map((m) => ({
          missingItemId: m.id,
          supplier: m.supplier,
          amount: m.amount,
          date: m.date,
          status: 'requested' as const,
          origin: m,
        }));

        if (existing) {
          const merged = [
            ...existing.items,
            ...newItems.filter((n) => !existing.items.some((i) => i.missingItemId === n.missingItemId)),
          ];
          return prev.map((c) =>
            c.id === existing.id
              ? {
                  ...c,
                  items: merged,
                  stage: 'sent',
                  hoursSinceSent: 0,
                  lastSmsAtMs: Date.now(),
                  linkExpiresInHours: chasePolicy.linkTtlHours,
                  message: message?.trim() || composeChaseMessage(client, merged),
                  events: [{ at: 'just now', label: 'Chase re-sent by SMS', detail: `${merged.length} items requested` }, ...c.events],
                }
              : c,
          );
        }

        return [
          {
            id: `chase-${clientId}-${Date.now()}`,
            clientId,
            clientName: client.name,
            recipientName: client.contactName ?? 'Primary contact',
            recipientMobile: client.mobile ?? '—',
            message: message?.trim() || composeChaseMessage(client, newItems),
            hoursSinceSent: 0,
            lastSmsAtMs: Date.now(),
            stage: 'sent',
            items: newItems,
            linkExpiresInHours: chasePolicy.linkTtlHours,
            lastUpload: 'awaiting',
            policy: `Standard (${chasePolicy.reminderOneDays}/${chasePolicy.reminderTwoDays} days)`,
            events: [{ at: 'just now', label: 'Chase sent by SMS', detail: `${newItems.length} items requested` }],
          },
          ...prev,
        ];
      });
    },
    [clients, missing, markMissingChased, chasePolicy],
  );

  const setChaseMessage = useCallback((chaseId: string, message: string | undefined) => {
    setChases((prev) =>
      prev.map((c) =>
        c.id === chaseId
          ? {
              ...c,
              nextMessage: message?.trim() || undefined,
              events: message?.trim()
                ? [{ at: 'just now', label: 'Message rewritten for the next send' }, ...c.events]
                : c.events,
            }
          : c,
      ),
    );
  }, []);

  const sendReminder = useCallback((chaseId: string) => {
    setChases((prev) =>
      prev.map((c) => {
        if (c.id !== chaseId) return c;
        const next = c.stage === 'sent' ? 'reminder-1' : c.stage === 'reminder-1' ? 'reminder-2' : 'escalated';
        return {
          ...c,
          stage: next,
          lastSmsAtMs: Date.now(),
          // What was written for this send becomes what was sent, and the
          // draft is spent — the next one starts from the generated text
          // again rather than silently repeating an old rewrite.
          message: c.nextMessage?.trim() || c.message,
          nextMessage: undefined,
          // A reminder refreshes the link on the configured TTL, not a fixed one.
          linkExpiresInHours: chasePolicy.linkTtlHours,
          events: [
            { at: 'just now', label: `Reminder sent by SMS`, detail: `Secure link refreshed — valid ${chasePolicy.linkTtlHours}h` },
            ...c.events,
          ],
        };
      }),
    );
  }, [chasePolicy]);

  /**
   * Escalation — NOT YET REAL. This only moves the stage.
   *
   * What it does today: sets the chase to `escalated`, which relabels it and
   * moves it into the Overdue & Escalated column. Nobody new is contacted and
   * nothing is sent. Presenting that as escalation is generous, so here is
   * what it has to do before it earns the name.
   *
   * Escalating means going over the contact's head. The bookkeeper who has
   * ignored four texts is not going to answer a fifth; the person who will
   * act is the owner or the finance director, and the reason to involve them
   * is that their own filing deadline is now at risk. So:
   *
   * 1. An escalation contact on the client. Clients need a second named
   *    person — owner, director, whoever the accountant answers to — separate
   *    from the day-to-day contact in `recipientName`/`recipientMobile`. It
   *    is set during intake and editable in Client → Users, and a chase
   *    cannot escalate without one; the button should say so rather than
   *    silently going nowhere.
   *
   * 2. A different message, not a louder one. It goes to the escalation
   *    contact and it is addressed to their problem, not the bookkeeper's:
   *    what is outstanding, how long it has been asked for, and what it
   *    stops — the VAT return, the year end, the management accounts. It
   *    names the original contact without blaming them. SMS by policy
   *    (`channels.ts` already lists chases as SMS-only), and it carries the
   *    same upload link so the director can forward it back down.
   *
   * 3. Both people stay on the thread. The original contact is told it has
   *    been escalated — quietly, and before the director hears about it, so
   *    nobody is ambushed. That is a courtesy that keeps the relationship
   *    intact, and it is often what actually produces the receipt.
   *
   * 4. Its own cooldown, longer than the ordinary one. Texting a director
   *    weekly about a £40 receipt costs more goodwill than the receipt is
   *    worth. `chasePolicy` needs an `escalateCooldownHours` alongside
   *    `escalateAfterDays`, and escalation stays exempt from the *standard*
   *    cooldown — the whole point is that waiting has stopped working.
   *
   * 5. An audit entry naming who was contacted and why. When a client later
   *    asks why their director was texted, the answer has to be on file:
   *    four requests over eleven days, none answered.
   *
   * 6. A way back down. If the item arrives, the chase closes as normal; if
   *    the accountant escalated by mistake, de-escalating should restore the
   *    previous stage rather than leaving the chase stuck at the top.
   *
   * Until all six exist, this is a label change and should be read as one.
   */
  const escalateChase = useCallback((chaseId: string) => {
    setChases((prev) =>
      prev.map((c) =>
        c.id === chaseId
          ? {
              ...c,
              stage: 'escalated',
              // Deliberately honest about what happened: no message went out.
              events: [{ at: 'just now', label: 'Marked escalated', detail: 'Stage only — no message sent yet' }, ...c.events],
            }
          : c,
      ),
    );
  }, []);

  const closeChase = useCallback((chaseId: string) => {
    setChases((prev) =>
      prev.map((c) =>
        c.id === chaseId ? { ...c, stage: 'closed', events: [{ at: 'just now', label: 'Chase closed' }, ...c.events] } : c,
      ),
    );
  }, []);

  const resendLink = useCallback(
    (chaseId: string) => {
      setChases((prev) =>
        prev.map((c) =>
          c.id === chaseId
            ? {
                ...c,
                lastSmsAtMs: Date.now(),
                message: c.nextMessage?.trim() || c.message,
                nextMessage: undefined,
                linkExpiresInHours: chasePolicy.linkTtlHours,
                events: [{ at: 'just now', label: 'Secure link re-sent', detail: `New OTP link, ${chasePolicy.linkTtlHours}h TTL` }, ...c.events],
              }
            : c,
        ),
      );
    },
    [chasePolicy],
  );

  /** Suppression stops an item chasing without pretending evidence arrived. */
  const setChaseItemStatus = useCallback((chaseId: string, missingItemId: string, status: ChaseItemStatus) => {
    setChases((prev) =>
      prev.map((c) =>
        c.id === chaseId
          ? {
              ...c,
              items: c.items.map((i) => (i.missingItemId === missingItemId ? { ...i, status } : i)),
              events: [{ at: 'just now', label: `Item marked ${status}`, detail: c.items.find((i) => i.missingItemId === missingItemId)?.supplier }, ...c.events],
            }
          : c,
      ),
    );
    // Only a genuine receipt removes the gap; the rest merely stop the chasing.
    if (status === 'received' || status === 'cash-coded') {
      setMissing((prev) => prev.filter((m) => m.id !== missingItemId));
    }
  }, []);


  /**
   * Attaches a document that has actually arrived to the item it answers.
   *
   * The chase does not care which door the receipt came in through — the
   * client's secure link, the practice inbox, an email, or the accountant
   * uploading it themselves. What matters is that evidence now exists for the
   * gap, so the item is answered, the bank line it explains is matched, and
   * the chase stops asking.
   */
  const attachDocumentToChaseItem = useCallback(
    (chaseId: string, missingItemId: string, docId: string, how: string) => {
      setTransactions((prev) =>
        prev.map((t) => (t.missingItemId === missingItemId ? { ...t, matchedDocId: docId } : t)),
      );
      setMissing((prev) => prev.filter((m) => m.id !== missingItemId));

      setChases((prev) =>
        prev.map((c) => {
          if (c.id !== chaseId) return c;
          const items = c.items.map((i) =>
            i.missingItemId === missingItemId ? { ...i, status: 'received' as const, answeredByDocId: docId } : i,
          );
          const answered = c.items.find((i) => i.missingItemId === missingItemId);
          const allDone = items.every((i) => i.status !== 'requested');
          return {
            ...c,
            items,
            stage: allDone ? 'closed' : c.stage,
            lastUpload: 'just now',
            events: [{ at: 'just now', label: how, detail: answered?.supplier }, ...c.events],
          };
        }),
      );
    },
    [],
  );

  /**
   * A document arriving anywhere answers any chase it matches.
   *
   * Without this the only thing that could close a chase was a button inside
   * the chase itself, which is backwards: the accountant who has just filed the
   * Brakes receipt in the Costs tab should not then have to go and tell the
   * chase about it, and the client who uploads through the link should not
   * depend on someone noticing. Matching on client, amount and supplier is the
   * same test the bank matcher uses, so an item only closes on real evidence.
   */
  useEffect(() => {
    const outstanding = chases.flatMap((c) =>
      c.items.filter((i) => i.status === 'requested').map((i) => ({ chase: c, item: i })),
    );
    if (!outstanding.length) return;

    for (const { chase, item } of outstanding) {
      const match = documents.find(
        (d) =>
          d.clientId === chase.clientId &&
          d.status !== 'processing' &&
          d.status !== 'rejected' &&
          Math.abs(d.total - item.amount) < 0.01 &&
          !item.rejectedDocIds?.includes(d.id) &&
          sameMerchant(d.supplier, item.supplier),
      );
      if (match) {
        attachDocumentToChaseItem(chase.id, item.missingItemId, match.id, 'Receipt arrived — matched to this request');
        // One at a time: the state this writes feeds straight back in here,
        // and the next pass picks up whatever is still outstanding.
        return;
      }
    }
  }, [documents, chases, attachDocumentToChaseItem]);

  /**
   * Undoes whichever call was made on a chased item. A received item also
   * created a document and explained a bank line, so reverting has to unpick
   * those too rather than leaving evidence behind for a gap that is open again.
   */
  const revertChaseItem = useCallback(
    (chaseId: string, missingItemId: string) => {
      const chase = chases.find((c) => c.id === chaseId);
      const item = chase?.items.find((i) => i.missingItemId === missingItemId);
      if (!chase || !item || item.status === 'requested') return;

      const previous = item.status;

      /**
       * A received item was answered by a real document — the client's upload
       * or the accountant's own copy. Undo here means "that is not this
       * receipt", so the link comes off and the gap reopens, but the document
       * stays: it exists, somebody sent it, and deleting evidence to undo a
       * mismatch would be a far worse mistake than the mismatch.
       */
      const answeredBy = previous === 'received' ? item.answeredByDocId : undefined;
      if (answeredBy) {
        setTransactions((prev) =>
          prev.map((t) => (t.matchedDocId === answeredBy ? { ...t, matchedDocId: undefined } : t)),
        );
      }

      // The gap is open again, so the item belongs back on the missing list.
      setMissing((prev) =>
        prev.some((m) => m.id === missingItemId) ? prev : [{ ...item.origin, chased: true }, ...prev],
      );

      setChases((prev) =>
        prev.map((c) => {
          if (c.id !== chaseId) return c;
          const items = c.items.map((i) =>
            i.missingItemId === missingItemId
              ? {
                  ...i,
                  status: 'requested' as const,
                  answeredByDocId: undefined,
                  // Remembered, so the matcher does not re-attach it.
                  rejectedDocIds: answeredBy ? [...(i.rejectedDocIds ?? []), answeredBy] : i.rejectedDocIds,
                }
              : i,
          );
          return {
            ...c,
            items,
            // A chase that closed because everything was settled reopens.
            stage: c.stage === 'closed' ? 'sent' : c.stage,
            events: [
              {
                at: 'just now',
                label: `Reverted — ${item.supplier} is requested again`,
                detail: `Was marked ${previous.replace('-', ' ')}`,
              },
              ...c.events,
            ],
          };
        }),
      );
    },
    [chases],
  );

  const sendItemMessage = useCallback(
    (clientId: string, documentLabel: string, question: string) => {
      const client = clients.find((c) => c.id === clientId);
      if (!client) return;
      setItemMessages((prev) => [
        {
          id: `msg-${Date.now()}`,
          clientId,
          clientName: client.name,
          documentLabel,
          question,
          sentAt: 'just now',
        },
        ...prev,
      ]);
    },
    [clients],
  );

  const addRule = useCallback((rule: Rule) => setRules((prev) => [...prev, rule]), []);

  /**
   * A ruling on a flagged pair. `delete` removes the copy — recoverable,
   * because it is on the deleted document, not the pair. `keep-both` is the
   * explicit "intentional duplicate" override Dext has no answer for: two
   * identical invoices genuinely happen, and the flag must be dismissible
   * without deleting anything.
   */
  const resolveDuplicate = useCallback(
    (id: string, action: 'delete' | 'keep-both') => {
      setResolvedDuplicates((prev) => (prev.includes(id) ? prev : [...prev, id]));
      if (action === 'delete') {
        // Look the pair up rather than parsing the id — a document id can
        // itself contain hyphens, so splitting the composite key is wrong.
        const pair = duplicates.find((d) => d.id === id);
        if (pair) setDocuments((prev) => prev.filter((d) => d.id !== pair.right.id));
      }
      logAudit({
        action: action === 'delete' ? 'Deleted a duplicate' : 'Kept an intentional duplicate',
        scope: duplicates.find((d) => d.id === id)?.left.label ?? id,
        reviewOpened: true,
      });
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps -- logAudit is a []-dep useCallback, stable for the app's lifetime; #87 file, inventory for the stable-callback sweep.
    [duplicates],
  );

  const approveItems = useCallback((ids: string[]) => {
    setApprovals((prev) => prev.filter((a) => !ids.includes(a.id)));
  }, []);

  const saveWorkflow = useCallback((w: ApprovalWorkflow) => {
    setApprovalWorkflows((prev) => (prev.some((x) => x.id === w.id) ? prev.map((x) => (x.id === w.id ? w : x)) : [...prev, w]));
  }, []);

  const deleteWorkflow = useCallback((id: string) => {
    setApprovalWorkflows((prev) => prev.filter((w) => w.id !== id));
  }, []);

  /**
   * One approval passes a stage. Clearing the final stage approves the item and
   * locks its details — and, where the workflow says so, publishes it.
   */
  const advanceApproval = useCallback(
    (id: string, note?: string, actor: string = ACTOR) => {
      setApprovals((prev) =>
        prev.map((a) => {
          if (a.id !== id) return a;
          const workflow = approvalWorkflows.find((w) => w.id === a.workflowId);
          if (!workflow) return a;

          // A fired branch inserts an extra approver before the item can clear.
          const extra = branchesFor(workflow, a.total, a.addedByBranch.length > 0);
          const totalStages = workflow.stages.length + extra.length;
          const nextIndex = a.stageIndex + 1;

          if (nextIndex >= totalStages) {
            if (workflow.autoPublishOnApproval && a.documentId) {
              setDocuments((docs) => docs.map((d) => (d.id === a.documentId ? { ...d, status: 'published' } : d)));
            }
            return {
              ...a,
              state: 'approved',
              locked: true,
              stage: 'Approved',
              history: [{ at: 'just now', label: 'Approved — item locked', actor, note }, ...a.history],
            };
          }

          const stage = workflow.stages[Math.min(nextIndex, workflow.stages.length - 1)];
          if (!stage) return a; // a workflow with no stages cannot advance
          // Past the workflow's own stages, the extra approvers added by a
          // conditional branch take over. Falling back to the stage keeps a
          // malformed branch list from erasing the approver entirely.
          const branchStage = extra[nextIndex - workflow.stages.length];
          const stageName = nextIndex < workflow.stages.length ? stage.name : (branchStage?.addApprover ?? stage.name);
          const approver = nextIndex < workflow.stages.length ? stage.approver : (branchStage?.addApprover ?? stage.approver);

          return {
            ...a,
            stageIndex: nextIndex,
            stage: `Stage ${nextIndex + 1} — ${stageName}`,
            approver,
            waitingDays: 0,
            history: [{ at: 'just now', label: `Passed stage ${a.stageIndex + 1}`, actor, note }, ...a.history],
          };
        }),
      );
    },
    [approvalWorkflows],
  );

  /**
   * The stage an item currently sits on, resolved through its workflow. Branch
   * approvers are appended after the named stages, and are always practice-side
   * — only a stage the workflow author marked clientSide leaves the practice.
   */
  const stageOf = useCallback(
    (a: ApprovalItem) => {
      const workflow = approvalWorkflows.find((w) => w.id === a.workflowId);
      return workflow?.stages[a.stageIndex];
    },
    [approvalWorkflows],
  );

  const clientSideApprovals = useCallback(
    (clientId: string) =>
      approvals.filter((a) => a.state === 'pending' && a.clientId === clientId && stageOf(a)?.clientSide),
    [approvals, stageOf],
  );

  /**
   * One link, one session, however many items — an approver signing off four
   * invoices verifies once. Sending again for a client replaces the live
   * session rather than leaving two valid links in the wild.
   */
  const sendApprovalRequest = useCallback(
    (clientId: string) => {
      const client = clients.find((c) => c.id === clientId);
      if (!client) return;
      const items = approvals.filter(
        (a) => a.state === 'pending' && a.clientId === clientId && stageOf(a)?.clientSide,
      );
      if (items.length === 0) return;

      const headline = items[0];
      if (!headline) return; // items.length === 0 returned above; this restates it for the compiler
      const rest = items.length - 1;
      const message =
        `${client.name}: ${items.length} item${items.length === 1 ? '' : 's'} need${items.length === 1 ? 's' : ''} your approval` +
        ` incl. ${headline.supplier} ${currencyText(headline.total)}${rest > 0 ? ` and ${rest} more` : ''}.` +
        ` Review securely: neo.tg/${clientId}${items.length}x`;

      setApprovalRequests((prev) => [
        {
          id: `appr-req-${clientId}-${prev.length}`,
          clientId,
          clientName: client.name,
          recipientName: client.contactName ?? 'Primary contact',
          recipientMobile: client.mobile ?? '—',
          itemIds: items.map((i) => i.id),
          message,
          sentAt: 'just now',
          sentAtMs: Date.now(),
          expiresInHours: chasePolicy.linkTtlHours,
          resendCount: 0,
          verified: false,
          // Fixed in the demo so the flow is walkable; a real build never
          // holds the code client-side.
          code: '4821',
        },
        ...prev.filter((r) => r.clientId !== clientId),
      ]);

      logAudit({
        action: 'Sent approval request',
        scope: `${client.name} — ${items.length} item${items.length === 1 ? '' : 's'} by SMS`,
        reviewOpened: true,
      });
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps -- logAudit is a []-dep useCallback, stable for the app's lifetime; #87 file, inventory for the stable-callback sweep.
    [approvals, clients, stageOf, chasePolicy.linkTtlHours],
  );

  const resendApprovalRequest = useCallback((id: string) => {
    setApprovalRequests((prev) =>
      prev.map((r) =>
        r.id === id
          ? { ...r, sentAt: 'just now', sentAtMs: Date.now(), resendCount: r.resendCount + 1, verified: false }
          : r,
      ),
    );
  }, []);

  /**
   * The OTP step. Rate limiting, code generation and session logging are all
   * server-side concerns, so the front end does not hold a real code and does
   * not check one — Verify passes through and the session opens. The screen
   * stays because it is part of the flow the approver sees.
   */
  const verifyApprovalCode = useCallback((id: string, _code: string) => {
    setApprovalRequests((prev) => prev.map((r) => (r.id === id ? { ...r, verified: true } : r)));
    return true;
  }, []);

  const rejectApproval = useCallback((id: string, reason: string, actor: string = ACTOR) => {
    setApprovals((prev) =>
      prev.map((a) =>
        a.id === id
          ? { ...a, state: 'rejected', stage: 'Rejected', history: [{ at: 'just now', label: 'Rejected', actor, note: reason }, ...a.history] }
          : a,
      ),
    );
  }, []);

  const addVaultDocument = useCallback(
    (
      clientId: string,
      category: VaultDocument['category'],
      name: string,
      sizeKb: number,
      owner: { kind: VaultDocument['ownerKind']; name: string } = { kind: 'firm', name: PRACTICE_NAME },
    ) => {
      const client = clients.find((c) => c.id === clientId);
      if (!client) return;
      setVault((prev) => [
        {
          id: `vault-${Date.now()}`,
          clientId,
          clientName: client.name,
          financialYear: 'FY 2026',
          category,
          name,
          summary: 'Summarised on upload — key dates extracted and reminders set.',
          tags: ['new'],
          ownerKind: owner.kind,
          ownerName: owner.name,
          sizeKb,
          source: 'Web upload',
          uploader: 'You',
          uploadedAt: 'just now',
          access: 'practice',
        },
        ...prev,
      ]);
    },
    [clients],
  );

  const updateVaultDocument = useCallback((id: string, patchFields: Partial<VaultDocument>) => {
    setVault((prev) => prev.map((v) => (v.id === id ? { ...v, ...patchFields } : v)));
  }, []);

  const deleteVaultDocument = useCallback((id: string) => setVault((prev) => prev.filter((v) => v.id !== id)), []);

  const moveVaultDocument = useCallback(
    (id: string, clientId: string) => {
      const client = clients.find((c) => c.id === clientId);
      if (!client) return;
      setVault((prev) => prev.map((v) => (v.id === id ? { ...v, clientId, clientName: client.name } : v)));
    },
    [clients],
  );

  const saveColleague = useCallback((c: Colleague) => {
    setColleagues((prev) => (prev.some((x) => x.id === c.id) ? prev.map((x) => (x.id === c.id ? c : x)) : [...prev, c]));
  }, []);

  const removeColleague = useCallback((id: string) => {
    setColleagues((prev) => prev.filter((c) => c.id !== id));
    // A removed colleague must not stay listed as a team member.
    setTeams((prev) => prev.map((t) => ({ ...t, memberIds: t.memberIds.filter((m) => m !== id) })));
  }, []);

  /**
   * Password resets are sent, never set. The practice can start the flow but
   * only the colleague ever chooses the password.
   */
  const sendPasswordReset = useCallback((id: string) => {
    const at = new Date().toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
    setColleagues((prev) => prev.map((c) => (c.id === id ? { ...c, passwordResetSentAt: at } : c)));
  }, []);

  const saveTeam = useCallback((team: Team) => {
    setTeams((prev) => (prev.some((t) => t.id === team.id) ? prev.map((t) => (t.id === team.id ? team : t)) : [...prev, team]));
  }, []);

  const removeTeam = useCallback((id: string) => setTeams((prev) => prev.filter((t) => t.id !== id)), []);

  const setTaskStatus = useCallback((id: string, status: WorkflowTask['status']) => {
    setTasks((prev) => prev.map((t) => (t.id === id ? { ...t, status } : t)));
  }, []);

  const assignTask = useCallback((id: string, assignee: string) => {
    setTasks((prev) => prev.map((t) => (t.id === id ? { ...t, assignee } : t)));
  }, []);

  const addTask = useCallback((task: WorkflowTask) => setTasks((prev) => [task, ...prev]), []);

  const updateSettings = useCallback((patch: Partial<AppSettings>) => {
    setSettings((prev) => ({ ...prev, ...patch }));
  }, []);

  const publishDocuments = useCallback((ids: string[]) => {
    setDocuments((prev) => prev.map((d) => (ids.includes(d.id) ? { ...d, status: 'published' } : d)));
  }, []);

  /**
   * Retries a failed document — and what that means depends on what failed,
   * which is the whole subtlety.
   *
   * A document fails in one of two places. Either extraction never got
   * anything off the file (a password-protected PDF, a photo too blurred to
   * read), in which case there is nothing to keep and the file goes back
   * through extraction. Or extraction worked and the *publish* was rejected by
   * the accounting software (a tax rate missing from the chart of accounts) —
   * there the data is good, and re-reading the file would be wrong. It goes
   * back to Ready to be published again.
   *
   * Telling them apart by whether any fields were extracted matters: an
   * earlier version re-ran extraction on everything, which replaced a rejected
   * Adobe invoice for £61.99 with a fabricated Currys one for £1,048.20.
   */
  const retryDocument = useCallback(
    (id: string) => {
      const before = documents.find((d) => d.id === id);
      if (!before) return;
      const extractionFailed = before.fields.length === 0;

      setDocuments((prev) =>
        prev.map((d) =>
          d.id !== id
            ? d
            : extractionFailed
            ? { ...d, status: 'processing', statusNote: 'Retrying extraction — ETA 2 min', publishFailed: undefined }
            : { ...d, status: 'ready', statusNote: undefined, publishFailed: undefined },
        ),
      );

      logAudit({
        action: extractionFailed ? 'Sent a document back through extraction' : 'Queued a failed publish to retry',
        scope: `${before.supplier}${before.statusNote ? ` — was: ${before.statusNote}` : ''}`,
        reviewOpened: true,
      });

      // Only the extraction case has anything to wait for.
      if (extractionFailed) {
        window.setTimeout(() => {
          setDocuments((prev) =>
            prev.map((d) => (d.id === id && d.status === 'processing' ? completeExtraction(d, clients, routingRules) : d)),
          );
        }, 2000);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps -- logAudit is stable ([]-dep useCallback); clients/routingRules are read only inside the 2s retry timeout, and rebuilding this callback on their every change was deliberately avoided — the staleness window is noted as inventory for the stable-callback sweep (#87 file, no behavioural edits here).
    [documents],
  );

  const toggleHistory = useCallback(() => setIsHistoryVisible((p) => !p), []);

  return (
    <AppContext.Provider
      value={{
        clients,
        documents,
        transactions,
        matches,
        duplicates,
        rules,
        chases,
        approvals,
        missing,
        auditLog,
        routingRules,
        approvalWorkflows,
        saveWorkflow,
        deleteWorkflow,
        advanceApproval,
        rejectApproval,
        clientSideApprovals,
        approvalRequests,
        openApprovalRequestId,
        openApprovalLink,
        sendApprovalRequest,
        resendApprovalRequest,
        verifyApprovalCode,
        vault,
        addVaultDocument,
        updateVaultDocument,
        deleteVaultDocument,
        moveVaultDocument,
        colleagues,
        teams,
        tasks,
        saveColleague,
        removeColleague,
        sendPasswordReset,
        saveTeam,
        removeTeam,
        setTaskStatus,
        assignTask,
        addTask,
        settings,
        updateSettings,
        accounts,
        statements,
        statementGaps,
        matchSettings,
        setMatchSettings,
        matchTransaction,
        unmatchTransaction,
        cashCode,
        uploadStatement,
        supplierStatements,
        uploadSupplierStatement,
        deleteSupplierStatement,
        expenseClaims,
        saveExpenseClaim,
        setExpenseClaimStatus,
        deleteExpenseClaim,
        reauthAccount,
        mandatoryFields,
        setMandatoryFields,
        ingestRejections,
        sheetImports,
        documentsSource: API_ENABLED ? 'api' : 'seed',
        documentsLoading: documentsQuery.isLoading,
        documentsError: documentsQuery.contractError ?? errorLabel(documentsQuery.error),
        session,
        logout,
        businesses,
        slices,
        serverClientIdFor,
        isSameClient,
        statsFor,
        onboardingLinks,
        sendOnboardingLink,
        resendOnboardingLink,
        completeOnboardingTask,
        businessAccounts,
        portal,
        portalLinkToken,
        portalAccountId,
        openBusinessPortal,
        exitBusinessPortal,
        createBusinessAccount,
        inviteBusinessUser,
        reviewProposedUser,
        clientDetailChanges,
        proposeClientDetailChanges,
        reviewClientDetailChange,
        completeBusinessUserRegistration,
        openRegistrationLink,
        openRegistrationFor,
        updateBusinessAccount,
        activateBusinessAccount,
        activeTab,
        setActiveTab,
        openClientId,
        openClient,
        starredClientIds,
        toggleStarClient,
        conversations,
        activeConversationId,
        messages,
        attachedClients,
        startConversation,
        addMessage,
        setMessages,
        newConversation: startFresh,
        selectConversation,
        deleteConversation,
        togglePinConversation,
        attachClient,
        detachClient,
        addClient,
        updateClient,
        updateDocumentStatus,
        setDocumentKind,
        updateDocumentField,
        ingest,
        moveDocuments,
        deleteDocuments,
        markMissingChased,
        chasePolicy,
        setChasePolicy,
        itemMessages,
        sendChase,
        sendReminder,
        setChaseMessage,
        escalateChase,
        closeChase,
        resendLink,
        setChaseItemStatus,
        revertChaseItem,
        sendItemMessage,
        addRule,
        resolveDuplicate,
        approveItems,
        publishDocuments,
        retryDocument,
        logAudit,
        isHistoryVisible,
        toggleHistory,
      }}
    >
      {children}
    </AppContext.Provider>
  );
}

export function useAppContext() {
  const context = useContext(AppContext);
  if (!context) throw new Error('useAppContext must be used within an AppProvider');
  return context;
}
