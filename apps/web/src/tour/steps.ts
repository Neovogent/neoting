import type { Client, Intent, Message, MessagePayload } from '../lib/types';
import { resolveScope } from '../lib/resolver';

/**
 * The tour script. Each step is a place (route), a thing on that screen
 * (`target`, a data-tour key), and what to say about it.
 *
 * The point the tour keeps making: every screen is optional — the chat can do
 * all of it. So the chat section seeds real conversations and explains the
 * answer cards, and every later step carries an "Or just ask" sentence, the
 * prompt that would do the same thing from the composer.
 *
 * ⚠ THIS FILE IS ENGLISH-ONLY, ON PURPOSE. Shakib decided it on 26 Aug 2026,
 * told that carrying the tour through react-intl costs +206 catalogue keys —
 * ~190 of them prose paragraphs — for a surface that exists to demonstrate the
 * product rather than to run a practice on. "Yeah English only" was the call.
 * So the three blocks below are plain string constants, not `defineMessages`,
 * and TourStep carries strings rather than MessageDescriptors. Do not re-i18n
 * them without a decision that reverses that one.
 *
 * What this is NOT licence to do: the tour's own CHROME — leave / back / next /
 * finish / the progress counter / "Or just ask" — stays internationalised in
 * `TourOverlay.tsx`, which keeps its own `defineMessages`. That is ordinary UI
 * copy on a button, it is rendered as a JSX literal would be, and
 * `neoting/no-literal-string-in-jsx` is an ERROR on it. The step prose escapes
 * that rule only because TourOverlay renders it as a VARIABLE —
 * `{step.title}`, never a literal — which the rule does not and cannot see.
 */

/** Section headings, shared across the steps that sit under them. */
const s = {
  welcome: 'Welcome',
  aiWorkspace: 'AI Workspace',
  fromTheChat: 'From the chat',
  navigation: 'Navigation',
  clients: 'Clients',
  clientRecord: 'Client record',
  inboxes: 'Inboxes',
  chases: 'Chases',
  approvals: 'Approvals',
  documents: 'Documents',
  analytics: 'Analytics',
  team: 'Team',
  settings: 'Settings',
  businessPortal: 'Business portal',
  done: 'Done',
};

/**
 * Step copy: a heading, a paragraph, and — where the same thing can be had
 * from the composer — the sentence a user is meant to be able to type back
 * into the chat. Three fields per step, because they are three different
 * kinds of writing, not one blob.
 */
const m = {
  welcomeTitle: 'A quick tour of the whole practice',
  welcomeBody: 'In about five minutes you will see every screen — clients, inboxes, chasing, approvals, publishing to Xero, and the portal your clients use. One idea runs through all of it: anything you can click, you can also just ask for in the chat.',
  composerTitle: 'Start by asking',
  composerBody: 'This box is the front door. Type what you need in plain English — "what is missing for Ananda?", "publish the ready items", "add a client" — and the answer comes back as something you can act on, not a paragraph.',
  attachClientTitle: 'Scope a conversation to a client',
  attachClientBody: 'Attach one or more clients and every answer is about them. Leave it empty and questions span the whole practice.',
  composerDocumentsTitle: 'Drop documents straight into the chat',
  composerDocumentsBody: 'PDF, photos, HEIC, CSV and XLSX. They are read, classified into Costs or Sales, and filed to the right client — a spreadsheet is read row by row rather than OCR-ed.',
  composerVoiceTitle: 'Or say it',
  composerVoiceBody: 'Push to talk. You see the transcript and confirm it before anything runs.',
  historyTitle: 'Every conversation is kept',
  historyBody: 'Pinned clients and recent conversations live here. Each chat has its own address, so a link in a message lands exactly where you were.',
  chatMissingTitle: 'Ask what is missing',
  chatMissingBody: 'The answer is a working card: how many documents are outstanding, for whom, and the next move — chase them, review the list, or export it. Nothing to find in a menu.',
  chatMissingAsk: "What's missing for American Burger?",
  chatApproveTitle: 'Approve a batch',
  chatApproveBody: 'Approvals come back with a review gate: read what is in the batch, who signed off, and what the rules passed — then approve. The same gate the Approvals screen uses, inside the conversation.',
  chatApproveAsk: 'Approve the pending items for American Burger',
  chatPublishTitle: 'Send it to Xero',
  chatPublishBody: 'Ask to publish and the Ready items are bundled with what will be sent — extracted data plus the original image — and what is held back and why. Approve here and it goes to the ledger. That is the whole "send to Xero" flow, from a sentence.',
  chatPublishAsk: 'Publish the ready items for American Burger to Xero',
  chatMatchesTitle: 'Reconcile the bank',
  chatMatchesBody: 'Bank lines are matched to documents with a confidence score. Confirmed matches are evidence; probable ones say what is missing. Unmatch from the card if the AI got one wrong.',
  chatMatchesAsk: 'Match the bank feed for American Burger',
  chatRuleTitle: 'Teach it a rule',
  chatRuleBody: 'Describe a rule in words — supplier, conditions, what to code it to — and it is built for you, with any conflict called out. Choose whether it also applies to what is already in the inbox.',
  chatRuleAsk: 'Always code Shell receipts for American Burger to Motor expenses',
  chatInviteTitle: 'Bring a colleague in',
  chatInviteBody: 'Inviting someone is a form in the chat: role, permissions, which clients. Everything people-related — colleagues, teams, client users — can start here.',
  chatInviteAsk: 'Invite Sam as a standard user with access to American Burger',
  chatAnalyticsTitle: 'Ask how things are going',
  chatAnalyticsBody: 'Pipeline health, correction rate, chase response times — as tiles and a chart, scoped to whoever is attached.',
  chatAnalyticsAsk: 'How is the pipeline doing?',
  chatAddClientTitle: 'Even onboarding a client',
  chatAddClientBody: 'Two paths: send the client a registration link (they connect their own Xero and bank), or register them yourself. The same intake the Clients screen uses.',
  chatAddClientAsk: 'Add a new client called Harbour Cafe',
  navTitle: 'The screens, when you want them',
  navBody: 'Everything the chat can do also has a screen, for when you want to browse rather than ask. On a phone the rail becomes this bar; the rest sits under More.',
  clientsTitle: 'Your client list',
  clientsBody: 'Every business you look after, with what is outstanding on each. Switch between cards and a sortable table; star the ones you are working on this week.',
  clientsAsk: 'Show me my clients',
  clientsAddTitle: 'Add a client',
  clientsAddBody: 'Send them a registration link by SMS — they add their own details and connect their ledger and bank — or register them on their behalf.',
  clientsAddAsk: 'Add a new client',
  clientsCardTitle: 'A client at a glance',
  clientsCardBody: 'Missing documents and items to review, straight on the card. Open, ask the AI about them, or chase from here.',
  clientsCardAsk: 'How is American Burger doing?',
  clientHeaderTitle: 'The client record',
  clientHeaderBody: 'Ledger, bank, health and deadlines in the header; Ask AI and Chase always one tap away.',
  clientHeaderAsk: 'Tell me about American Burger',
  clientTabsTitle: 'Fourteen tabs, one pipeline',
  clientTabsBody: 'Overview, then the two inboxes (Costs and Sales), Bank, statements and claims, Approvals, Documents, Chases, Tasks, Integrations, Users, Settings and the client-scoped AI chat. They scroll sideways on a phone.',
  clientKpisTitle: 'Overview',
  clientKpisBody: 'Seven live numbers. Each tile is a shortcut into the tab that explains it; Missing docs carries its own Chase button.',
  clientKpisAsk: "What's the status of American Burger?",
  costsReviewTitle: 'Costs — To Review',
  costsReviewBody: 'Purchase documents in pipeline order: Processing, To Review, Ready, Published, Rejected, Duplicates. Each row shows the next move — Fix if something is missing, otherwise Move to Ready.',
  costsReviewAsk: 'Show me the cost inbox for American Burger',
  costsUploadTitle: 'Upload into the pipeline',
  costsUploadBody: 'Upload here or drop files in the chat. An analysis animation shows what was read, then the document is filed where the AI decided — changeable if it got it wrong.',
  costsUploadAsk: 'Upload these receipts for American Burger',
  costsReadyPublishTitle: 'Ready → Xero',
  costsReadyPublishBody: 'Select the Ready rows and publish. Extracted data and the original image go to the ledger together; anything blocked by a required field stays behind and says why.',
  costsReadyPublishAsk: 'Publish the ready items for American Burger',
  costsPublishedTitle: 'Published',
  costsPublishedBody: 'What is in the ledger, with the reference Xero gave it. Unpublish is here if something has to come back.',
  costsPublishedAsk: 'What did we publish for American Burger this month?',
  salesTitle: 'Sales',
  salesBody: 'The same pipeline for money in. The AI decides Costs or Sales on upload — nobody has to choose.',
  salesAsk: 'Show me sales invoices for American Burger',
  bankTransactionsTitle: 'Bank — Transactions',
  bankTransactionsBody: 'The feed, with evidence status per line. Chase for evidence, cash-code what will never have a receipt, or export.',
  bankTransactionsAsk: 'Which bank transactions have no receipt for American Burger?',
  bankMatchesTitle: 'Bank — Matches',
  bankMatchesBody: 'Document-to-transaction matches with confidence. Match rules (date and amount tolerances) are configurable, not fixed.',
  bankMatchesAsk: 'Match the bank feed for American Burger',
  bankStatementsTitle: 'Bank — Statements',
  bankStatementsBody: 'Upload statements, see gaps between them, and request the missing period from the client.',
  bankStatementsAsk: 'Are there any statement gaps for American Burger?',
  bankAccountsTitle: 'Bank — Accounts',
  bankAccountsBody: 'Each connected account, consent expiry, and re-authorisation. The client connects the feed; you see its health.',
  supplierStatementsTitle: 'Supplier statements',
  supplierStatementsBody: 'Upload a supplier statement and every line is matched to a document. Lines with no document can be chased in one go.',
  supplierStatementsAsk: 'Reconcile the Brakes statement for American Burger',
  expenseClaimsTitle: 'Expense claims',
  expenseClaimsBody: 'Employees capture their own receipts; a manager or owner approves before anything reaches you. Every receipt is read and categorised by the AI.',
  expenseClaimsAsk: 'Show expense claims waiting for American Burger',
  clientApprovalsTitle: 'Approvals for this client',
  clientApprovalsBody: 'Pending items with approve, edit and reject on each row, and the workflows that route them — including client-side stages approved by SMS.',
  clientApprovalsAsk: "What's waiting for approval at American Burger?",
  clientDocumentsTitle: 'Documents',
  clientDocumentsBody: 'Every document for the client, whatever channel it came in by, with preview, download and retry.',
  clientDocumentsAsk: 'Find the Sysco invoice from July for American Burger',
  clientChasesTitle: 'Chases',
  clientChasesBody: 'What has been requested from the client, how it was detected, and where each chase stands. Chase again from the row.',
  clientChasesAsk: 'Chase the missing documents for American Burger',
  clientTasksTitle: 'Tasks',
  clientTasksBody: 'Workflow tasks the AI raised plus anything you add by hand, assigned to a team member, with blockers shown.',
  clientTasksAsk: 'Add a task to check the VAT return for American Burger',
  integrationsTitle: 'Integrations',
  integrationsBody: 'Xero connection health, bank feed consent, and the setup link you send the client so they connect both themselves.',
  integrationsAsk: 'Is American Burger still connected to Xero?',
  clientUsersTitle: 'Users',
  clientUsersBody: 'Who at the business can send documents. Add a user here and the business owner approves them from their portal.',
  clientUsersAsk: 'Add a user for American Burger',
  clientSettingsTitle: 'Settings',
  clientSettingsBody: 'Client details. Edits go to the client for approval rather than changing silently.',
  clientAiTitle: 'AI, scoped to the client',
  clientAiBody: 'Suggested questions and this client\'s past conversations. Same chat, already attached.',
  inboxesTitle: 'All clients, one inbox',
  inboxesBody: 'Costs and Sales across the practice, by status. Filter by client or channel — email, WhatsApp, web upload, the portal, spreadsheets.',
  inboxesAsk: "What's in the cost inbox?",
  inboxesRequiredTitle: 'Required fields',
  inboxesRequiredBody: 'Switch on a field and it becomes a column; nothing publishes without it and the row says which field is missing.',
  inboxesPreviewTitle: 'The document, read',
  inboxesPreviewBody: 'The original beside every field the AI extracted, with confidence and where on the page it came from. Tap a value to correct it; the original is never changed.',
  inboxesPreviewAsk: 'Open the latest document for review',
  inboxesPublishTitle: 'Publish to the ledger',
  inboxesPublishBody: 'Publishing asks first and shows exactly what goes and what is held back. Approve, and the documents are in Xero with their images attached.',
  inboxesPublishAsk: 'Publish everything that is ready',
  chasesTitle: 'Missing evidence, practice-wide',
  chasesBody: 'How much is missing, how many chases are live, and what is overdue. Chasing is by SMS, with quiet hours and a cooldown between messages.',
  chasesAsk: 'What is overdue across all clients?',
  chasesRunTitle: 'Run the chase engine',
  chasesRunBody: 'Review the message per client, edit the wording, and send. Every chase carries an upload link the client can use without an account.',
  chasesRunAsk: 'Chase everyone who owes documents',
  chasesPolicyTitle: 'Chase policy',
  chasesPolicyBody: 'First chase after, reminders, escalation, quiet hours, link lifetime. The AI follows this schedule automatically when auto-chase is on.',
  approvalsTitle: 'The approval queue',
  approvalsBody: 'Waiting on me, or everything pending. Each row shows the stage, who approves next and how long it has waited.',
  approvalsAsk: 'What needs my approval?',
  approvalsDetailTitle: 'Approve or reject',
  approvalsDetailBody: 'The stage chain, the document, and a note. Pass the stage, send it back with a reason, or correct it in the chat if the stage allows edits. Every step asks "are you sure".',
  approvalsDetailAsk: 'Approve the Sysco invoice',
  workflowsTitle: 'Workflows',
  workflowsBody: 'Multi-stage, conditional, with client-side stages approved by SMS. Describe a workflow in words and it is built for you — then edit by hand.',
  workflowsAsk: 'Create a workflow: anything over £500 needs the owner',
  approvalsHistoryTitle: 'History',
  approvalsHistoryBody: 'Every outcome, locked once published, with the rejection note readable from the row.',
  documentsTitle: 'Archive and vault',
  documentsBody: 'The archive is everything published, grouped by client. The vault holds what is not a transaction — contracts, certificates — by firm, client and year, with expiry.',
  documentsAsk: 'Find the lease for Ananda Group',
  analyticsTitle: 'How the practice is running',
  analyticsBody: 'Documents processed, correction rate, missing and overdue, per-client health. Scope to one client or the whole practice; export as CSV.',
  analyticsAsk: 'How is the pipeline doing this month?',
  teamTitle: 'Colleagues and teams',
  teamBody: 'Roles, permissions, client access, and whether finance fields are hidden. Teams group people around a set of clients.',
  teamAsk: 'Invite a colleague',
  teamTasksTitle: 'Tasks',
  teamTasksBody: 'Workflow tasks across every client, assignable from the row. Ask the AI about workload and it balances them.',
  teamTasksAsk: 'Who has the most open tasks?',
  settingsTitle: 'Practice settings',
  settingsBody: 'Profile, connections, extraction, automation, chasing, approvals, exports, lists, AI guidance, communication, security.',
  settingsConnectionsTitle: 'Connections',
  settingsConnectionsBody: 'Ledger adapters in priority order — Xero first, then QuickBooks, Sage and FreeAgent — and bank feed consent per client. Clients connect; you see health.',
  settingsConnectionsAsk: 'Which clients are not connected to Xero?',
  settingsAutomationTitle: 'Automation',
  settingsAutomationBody: 'Auto-categorisation, whether AI suggestions apply themselves, archiving after publish, and the bank-match tolerances.',
  portalHomeTitle: 'What your client sees',
  portalHomeBody: 'A separate, phone-first portal. What their accountant is waiting for, what they have sent, and anything that needs their approval — including users you proposed.',
  portalCaptureTitle: 'Capture',
  portalCaptureBody: 'Point the phone at the receipt. Multi-page, with review before sending, or send as they shoot. Everything lands in your inbox already classified.',
  portalUploadTitle: 'Upload',
  portalUploadBody: 'Files from their computer or phone — PDFs, photos, spreadsheets — with a note if they want to explain.',
  portalSettingsTitle: 'Their settings',
  portalSettingsBody: 'Business details, notifications, their people, and the connections they own: accounting software and bank feed.',
  doneTitle: 'That is the whole loop',
  doneBody: 'Capture → extract → review → approve → publish to Xero → reconcile the bank → chase what is missing. Every screen you just saw is a shortcut; the chat can do all of it. Try asking something.',
};

/**
 * DEMO-MOCK: the assistant's line for each seeded demo conversation. Every one
 * of these is CANNED — written here by hand, picked by `replyFor` off the
 * intent the step already decided, with no model called and nothing sent to
 * `POST /v1/chat/turns`. Read `seedChat` below before touching them.
 */
const replies = {
  showMissing: "Here's what's still missing. You can chase it from here.",
  approveItems: 'These are waiting on you. Read the review, then approve the batch.',
  publish: 'Everything marked Ready, checked and bundled. Approve to send it to the ledger.',
  showMatches: 'Bank lines matched to documents. Anything marked probable needs a look.',
  createRule: "Here's the rule as I understood it. Approve it and it applies from now on.",
  inviteUser: 'Fill in who they are and what they can do, and I will send the invite.',
  showAnalytics: 'The pipeline at a glance.',
  addClient: 'Two ways to add them — send a registration link, or set them up yourself.',
  general: 'Done.',
};

export interface TourCtx {
  clients: Client[];
  startConversation: (clientIds: string[], seed?: Message[]) => void;
  /** The first seeded business account, for the portal section. */
  portalAccountId: string | null;
}

export interface TourStep {
  id: string;
  /** English prose, already resolved — see the English-only note at the top. */
  section: string;
  title: string;
  body: string;
  /** The prompt that does the same thing from the chat. */
  ask?: string;
  /** Navigate here before looking for the target. Omit to stay put. */
  route?: string | ((ctx: TourCtx) => string);
  /** data-tour key. Omit for a centred card with no spotlight. */
  target?: string;
  /** Bus action emitted once the route has rendered (opens a local modal). */
  action?: string;
  /** Runs before navigation — used to seed a conversation. */
  setup?: (ctx: TourCtx) => void;
  /** Extra time to wait after navigation, for animated content. */
  settle?: number;
}

const CLIENT = '1'; // American Burger Ltd, the starred demo client

/**
 * Build a seeded two-message conversation that renders one answer card.
 *
 * // DEMO-MOCK: THE ASSISTANT TURN THIS WRITES IS FABRICATED. The reply text is
 * a canned string from `replies` above, the intent is whichever one the step
 * declared, and the payload is hand-assembled from `resolveScope` — no model
 * was called, nothing went to `POST /v1/chat/turns`, and the §9 chat runtime
 * (`apps/api/src/modules/chat-framework`) never saw the utterance. It is a
 * scripted illustration of what an answer LOOKS like, not an answer. This is
 * legitimate for a tour, and it is the only place in the app that writes an
 * assistant message the runtime did not produce — everywhere else a live
 * failure is rendered honestly rather than answered locally (see
 * `apps/web/CLAUDE.md`, "The chat, and where classification actually happens").
 *
 * Root `CLAUDE.md` owes every `// DEMO-MOCK` a tracked issue. **This one is not
 * filed yet** — deliberately said out loud rather than left implied. What it
 * must cover: either drive these steps through the real runtime, or keep the
 * canned turns and mark them in the TRANSCRIPT so a viewer can see which turns
 * were scripted, which the current UI does not do.
 */
function seedChat(ctx: TourCtx, prompt: string, intent: Intent, extra: Partial<MessagePayload> = {}) {
  const scope = resolveScope(prompt, ctx.clients, [CLIENT]);
  const now = Date.now();
  const seed: Message[] = [
    { id: `tour-u-${now}`, role: 'user', content: prompt },
    {
      id: `tour-a-${now}`,
      role: 'assistant',
      content: replyFor(intent),
      intent,
      payload: { ...scope, ...extra },
    },
  ];
  ctx.startConversation(scope.clientIds.length ? scope.clientIds : [CLIENT], seed);
}

/** DEMO-MOCK, see `seedChat`: picks a canned line, never calls a model. */
function replyFor(intent: Intent): string {
  switch (intent) {
    case 'SHOW_MISSING': return replies.showMissing;
    case 'APPROVE_ITEMS': return replies.approveItems;
    case 'PUBLISH': return replies.publish;
    case 'SHOW_MATCHES': return replies.showMatches;
    case 'CREATE_RULE': return replies.createRule;
    case 'INVITE_USER': return replies.inviteUser;
    case 'SHOW_ANALYTICS': return replies.showAnalytics;
    case 'ADD_CLIENT': return replies.addClient;
    default: return replies.general;
  }
}

export const TOUR_STEPS: TourStep[] = [
  // ───────────────────────── Welcome ─────────────────────────
  {
    id: 'welcome',
    section: s.welcome,
    title: m.welcomeTitle,
    body: m.welcomeBody,
    route: '/',
  },

  // ───────────────────────── AI Workspace ─────────────────────────
  {
    id: 'composer',
    section: s.aiWorkspace,
    title: m.composerTitle,
    body: m.composerBody,
    route: '/',
    target: 'composer',
  },
  {
    id: 'attach-client',
    section: s.aiWorkspace,
    title: m.attachClientTitle,
    body: m.attachClientBody,
    route: '/',
    target: 'attach-client',
  },
  {
    id: 'composer-documents',
    section: s.aiWorkspace,
    title: m.composerDocumentsTitle,
    body: m.composerDocumentsBody,
    route: '/',
    target: 'composer-documents',
  },
  {
    id: 'composer-voice',
    section: s.aiWorkspace,
    title: m.composerVoiceTitle,
    body: m.composerVoiceBody,
    route: '/',
    target: 'composer-voice',
  },
  {
    id: 'history',
    section: s.aiWorkspace,
    title: m.historyTitle,
    body: m.historyBody,
    route: '/',
    target: 'history-toggle',
  },

  // ───────────────────────── Chat demo ─────────────────────────
  {
    id: 'chat-missing',
    section: s.fromTheChat,
    title: m.chatMissingTitle,
    body: m.chatMissingBody,
    ask: m.chatMissingAsk,
    setup: (ctx) => seedChat(ctx, m.chatMissingAsk, 'SHOW_MISSING'),
    target: 'chat-card',
    settle: 500,
  },
  {
    id: 'chat-approve',
    section: s.fromTheChat,
    title: m.chatApproveTitle,
    body: m.chatApproveBody,
    ask: m.chatApproveAsk,
    setup: (ctx) => seedChat(ctx, m.chatApproveAsk, 'APPROVE_ITEMS'),
    target: 'chat-card',
    settle: 500,
  },
  {
    id: 'chat-publish',
    section: s.fromTheChat,
    title: m.chatPublishTitle,
    body: m.chatPublishBody,
    ask: m.chatPublishAsk,
    setup: (ctx) => seedChat(ctx, m.chatPublishAsk, 'PUBLISH'),
    target: 'chat-card',
    settle: 500,
  },
  {
    id: 'chat-matches',
    section: s.fromTheChat,
    title: m.chatMatchesTitle,
    body: m.chatMatchesBody,
    ask: m.chatMatchesAsk,
    setup: (ctx) => seedChat(ctx, m.chatMatchesAsk, 'SHOW_MATCHES'),
    target: 'chat-card',
    settle: 500,
  },
  {
    id: 'chat-rule',
    section: s.fromTheChat,
    title: m.chatRuleTitle,
    body: m.chatRuleBody,
    ask: m.chatRuleAsk,
    setup: (ctx) => seedChat(ctx, m.chatRuleAsk, 'CREATE_RULE'),
    target: 'chat-card',
    settle: 500,
  },
  {
    id: 'chat-invite',
    section: s.fromTheChat,
    title: m.chatInviteTitle,
    body: m.chatInviteBody,
    ask: m.chatInviteAsk,
    setup: (ctx) => seedChat(ctx, m.chatInviteAsk, 'INVITE_USER'),
    target: 'chat-card',
    settle: 500,
  },
  {
    id: 'chat-analytics',
    section: s.fromTheChat,
    title: m.chatAnalyticsTitle,
    body: m.chatAnalyticsBody,
    ask: m.chatAnalyticsAsk,
    setup: (ctx) => seedChat(ctx, m.chatAnalyticsAsk, 'SHOW_ANALYTICS'),
    target: 'chat-card',
    settle: 500,
  },
  {
    id: 'chat-add-client',
    section: s.fromTheChat,
    title: m.chatAddClientTitle,
    body: m.chatAddClientBody,
    ask: m.chatAddClientAsk,
    setup: (ctx) => seedChat(ctx, m.chatAddClientAsk, 'ADD_CLIENT', { clientName: 'Harbour Cafe' }),
    target: 'chat-card',
    settle: 500,
  },

  // ───────────────────────── Navigation ─────────────────────────
  {
    id: 'nav',
    section: s.navigation,
    title: m.navTitle,
    body: m.navBody,
    route: '/',
    target: 'nav',
  },

  // ───────────────────────── Clients ─────────────────────────
  {
    id: 'clients',
    section: s.clients,
    title: m.clientsTitle,
    body: m.clientsBody,
    ask: m.clientsAsk,
    route: '/clients',
    target: 'clients-header',
  },
  {
    id: 'clients-add',
    section: s.clients,
    title: m.clientsAddTitle,
    body: m.clientsAddBody,
    ask: m.clientsAddAsk,
    route: '/clients',
    target: 'clients-add',
  },
  {
    id: 'clients-card',
    section: s.clients,
    title: m.clientsCardTitle,
    body: m.clientsCardBody,
    ask: m.clientsCardAsk,
    route: '/clients',
    target: 'client-card',
  },

  // ───────────────────────── Client record ─────────────────────────
  {
    id: 'client-header',
    section: s.clientRecord,
    title: m.clientHeaderTitle,
    body: m.clientHeaderBody,
    ask: m.clientHeaderAsk,
    route: `/clients/${CLIENT}`,
    target: 'client-header',
  },
  {
    id: 'client-tabs',
    section: s.clientRecord,
    title: m.clientTabsTitle,
    body: m.clientTabsBody,
    route: `/clients/${CLIENT}`,
    target: 'client-tabs',
  },
  {
    id: 'client-kpis',
    section: s.clientRecord,
    title: m.clientKpisTitle,
    body: m.clientKpisBody,
    ask: m.clientKpisAsk,
    route: `/clients/${CLIENT}`,
    target: 'client-kpis',
  },
  {
    id: 'costs-review',
    section: s.clientRecord,
    title: m.costsReviewTitle,
    body: m.costsReviewBody,
    ask: m.costsReviewAsk,
    route: `/clients/${CLIENT}/costs/review`,
    target: 'client-subtabs',
  },
  {
    id: 'costs-upload',
    section: s.clientRecord,
    title: m.costsUploadTitle,
    body: m.costsUploadBody,
    ask: m.costsUploadAsk,
    route: `/clients/${CLIENT}/costs/review`,
    target: 'inbox-upload',
  },
  {
    id: 'costs-ready-publish',
    section: s.clientRecord,
    title: m.costsReadyPublishTitle,
    body: m.costsReadyPublishBody,
    ask: m.costsReadyPublishAsk,
    route: `/clients/${CLIENT}/costs/ready`,
    target: 'bulk-publish-selected',
  },
  {
    id: 'costs-published',
    section: s.clientRecord,
    title: m.costsPublishedTitle,
    body: m.costsPublishedBody,
    ask: m.costsPublishedAsk,
    route: `/clients/${CLIENT}/costs/published`,
    target: 'datatable',
  },
  {
    id: 'sales',
    section: s.clientRecord,
    title: m.salesTitle,
    body: m.salesBody,
    ask: m.salesAsk,
    route: `/clients/${CLIENT}/sales/review`,
    target: 'client-subtabs',
  },
  {
    id: 'bank-transactions',
    section: s.clientRecord,
    title: m.bankTransactionsTitle,
    body: m.bankTransactionsBody,
    ask: m.bankTransactionsAsk,
    route: `/clients/${CLIENT}/bank/transactions`,
    target: 'bank-header',
  },
  {
    id: 'bank-matches',
    section: s.clientRecord,
    title: m.bankMatchesTitle,
    body: m.bankMatchesBody,
    ask: m.bankMatchesAsk,
    route: `/clients/${CLIENT}/bank/matches`,
    target: 'client-subtabs',
  },
  {
    id: 'bank-statements',
    section: s.clientRecord,
    title: m.bankStatementsTitle,
    body: m.bankStatementsBody,
    ask: m.bankStatementsAsk,
    route: `/clients/${CLIENT}/bank/statements`,
    target: 'client-subtabs',
  },
  {
    id: 'bank-accounts',
    section: s.clientRecord,
    title: m.bankAccountsTitle,
    body: m.bankAccountsBody,
    route: `/clients/${CLIENT}/bank/accounts`,
    target: 'client-subtabs',
  },
  {
    id: 'supplier-statements',
    section: s.clientRecord,
    title: m.supplierStatementsTitle,
    body: m.supplierStatementsBody,
    ask: m.supplierStatementsAsk,
    route: `/clients/${CLIENT}/supplier-statements`,
    target: 'ss-header',
  },
  {
    id: 'expense-claims',
    section: s.clientRecord,
    title: m.expenseClaimsTitle,
    body: m.expenseClaimsBody,
    ask: m.expenseClaimsAsk,
    route: `/clients/${CLIENT}/expense-claims`,
    target: 'ec-header',
  },
  {
    id: 'client-approvals',
    section: s.clientRecord,
    title: m.clientApprovalsTitle,
    body: m.clientApprovalsBody,
    ask: m.clientApprovalsAsk,
    route: `/clients/${CLIENT}/approvals`,
    target: 'client-approvals',
  },
  {
    id: 'client-documents',
    section: s.clientRecord,
    title: m.clientDocumentsTitle,
    body: m.clientDocumentsBody,
    ask: m.clientDocumentsAsk,
    route: `/clients/${CLIENT}/documents`,
    target: 'datatable',
  },
  {
    id: 'client-chases',
    section: s.clientRecord,
    title: m.clientChasesTitle,
    body: m.clientChasesBody,
    ask: m.clientChasesAsk,
    route: `/clients/${CLIENT}/chases`,
    target: 'datatable',
  },
  {
    id: 'client-tasks',
    section: s.clientRecord,
    title: m.clientTasksTitle,
    body: m.clientTasksBody,
    ask: m.clientTasksAsk,
    route: `/clients/${CLIENT}/tasks`,
    target: 'add-task',
  },
  {
    id: 'integrations',
    section: s.clientRecord,
    title: m.integrationsTitle,
    body: m.integrationsBody,
    ask: m.integrationsAsk,
    route: `/clients/${CLIENT}/integrations`,
    target: 'integrations',
  },
  {
    id: 'client-users',
    section: s.clientRecord,
    title: m.clientUsersTitle,
    body: m.clientUsersBody,
    ask: m.clientUsersAsk,
    route: `/clients/${CLIENT}/users`,
    target: 'add-user',
  },
  {
    id: 'client-settings',
    section: s.clientRecord,
    title: m.clientSettingsTitle,
    body: m.clientSettingsBody,
    route: `/clients/${CLIENT}/settings`,
    target: 'client-settings',
  },
  {
    id: 'client-ai',
    section: s.clientRecord,
    title: m.clientAiTitle,
    body: m.clientAiBody,
    route: `/clients/${CLIENT}/ai`,
    target: 'client-ai',
  },

  // ───────────────────────── Inboxes ─────────────────────────
  {
    id: 'inboxes',
    section: s.inboxes,
    title: m.inboxesTitle,
    body: m.inboxesBody,
    ask: m.inboxesAsk,
    route: '/inboxes/cost/review',
    target: 'inboxes-tabs',
  },
  {
    id: 'inboxes-required',
    section: s.inboxes,
    title: m.inboxesRequiredTitle,
    body: m.inboxesRequiredBody,
    route: '/inboxes/cost/review',
    target: 'inboxes-required-fields',
  },
  {
    id: 'inboxes-preview',
    section: s.inboxes,
    title: m.inboxesPreviewTitle,
    body: m.inboxesPreviewBody,
    ask: m.inboxesPreviewAsk,
    route: '/inboxes/cost/review',
    action: 'inboxes:open-preview',
    target: 'document-preview',
    settle: 400,
  },
  {
    id: 'inboxes-publish',
    section: s.inboxes,
    title: m.inboxesPublishTitle,
    body: m.inboxesPublishBody,
    ask: m.inboxesPublishAsk,
    route: '/inboxes/cost/ready',
    action: 'inboxes:request-publish',
    target: 'publish-confirm',
    settle: 400,
  },

  // ───────────────────────── Chases ─────────────────────────
  {
    id: 'chases',
    section: s.chases,
    title: m.chasesTitle,
    body: m.chasesBody,
    ask: m.chasesAsk,
    route: '/chases',
    target: 'chases-kpis',
  },
  {
    id: 'chases-run',
    section: s.chases,
    title: m.chasesRunTitle,
    body: m.chasesRunBody,
    ask: m.chasesRunAsk,
    route: '/chases',
    target: 'chases-run',
  },
  {
    id: 'chases-policy',
    section: s.chases,
    title: m.chasesPolicyTitle,
    body: m.chasesPolicyBody,
    route: '/chases',
    target: 'chases-policy',
  },

  // ───────────────────────── Approvals ─────────────────────────
  {
    id: 'approvals',
    section: s.approvals,
    title: m.approvalsTitle,
    body: m.approvalsBody,
    ask: m.approvalsAsk,
    route: '/approvals',
    target: 'approvals-scope',
  },
  {
    id: 'approvals-detail',
    section: s.approvals,
    title: m.approvalsDetailTitle,
    body: m.approvalsDetailBody,
    ask: m.approvalsDetailAsk,
    route: '/approvals',
    action: 'approvals:open-detail',
    target: 'approval-detail',
    settle: 400,
  },
  {
    id: 'workflows',
    section: s.approvals,
    title: m.workflowsTitle,
    body: m.workflowsBody,
    ask: m.workflowsAsk,
    route: '/approvals/workflows',
    target: 'workflows',
  },
  {
    id: 'approvals-history',
    section: s.approvals,
    title: m.approvalsHistoryTitle,
    body: m.approvalsHistoryBody,
    route: '/approvals/history',
    target: 'datatable',
  },

  // ───────────────────────── Documents ─────────────────────────
  {
    id: 'documents',
    section: s.documents,
    title: m.documentsTitle,
    body: m.documentsBody,
    ask: m.documentsAsk,
    route: '/documents',
    target: 'documents-tabs',
  },

  // ───────────────────────── Analytics ─────────────────────────
  {
    id: 'analytics',
    section: s.analytics,
    title: m.analyticsTitle,
    body: m.analyticsBody,
    ask: m.analyticsAsk,
    route: '/analytics',
    target: 'analytics-kpis',
  },

  // ───────────────────────── Team ─────────────────────────
  {
    id: 'team',
    section: s.team,
    title: m.teamTitle,
    body: m.teamBody,
    ask: m.teamAsk,
    route: '/team',
    target: 'team-header',
  },
  {
    id: 'team-tasks',
    section: s.team,
    title: m.teamTasksTitle,
    body: m.teamTasksBody,
    ask: m.teamTasksAsk,
    route: '/team/tasks',
    target: 'datatable',
  },

  // ───────────────────────── Settings ─────────────────────────
  {
    id: 'settings',
    section: s.settings,
    title: m.settingsTitle,
    body: m.settingsBody,
    route: '/settings',
    target: 'settings-nav',
  },
  {
    id: 'settings-connections',
    section: s.settings,
    title: m.settingsConnectionsTitle,
    body: m.settingsConnectionsBody,
    ask: m.settingsConnectionsAsk,
    route: '/settings/connections',
    target: 'settings-panel',
  },
  {
    id: 'settings-automation',
    section: s.settings,
    title: m.settingsAutomationTitle,
    body: m.settingsAutomationBody,
    route: '/settings/automation',
    target: 'settings-panel',
  },

  // ───────────────────────── Business portal ─────────────────────────
  {
    id: 'portal-home',
    section: s.businessPortal,
    title: m.portalHomeTitle,
    body: m.portalHomeBody,
    route: (ctx) => (ctx.portalAccountId ? `/portal/${ctx.portalAccountId}` : '/portal'),
    target: 'portal-home',
    settle: 300,
  },
  {
    id: 'portal-capture',
    section: s.businessPortal,
    title: m.portalCaptureTitle,
    body: m.portalCaptureBody,
    route: (ctx) => (ctx.portalAccountId ? `/portal/${ctx.portalAccountId}/capture` : '/portal'),
    target: 'portal-capture',
  },
  {
    id: 'portal-upload',
    section: s.businessPortal,
    title: m.portalUploadTitle,
    body: m.portalUploadBody,
    route: (ctx) => (ctx.portalAccountId ? `/portal/${ctx.portalAccountId}/upload` : '/portal'),
    target: 'portal-upload',
  },
  {
    id: 'portal-settings',
    section: s.businessPortal,
    title: m.portalSettingsTitle,
    body: m.portalSettingsBody,
    route: (ctx) => (ctx.portalAccountId ? `/portal/${ctx.portalAccountId}/settings` : '/portal'),
    target: 'portal-settings',
  },

  // ───────────────────────── Done ─────────────────────────
  {
    id: 'done',
    section: s.done,
    title: m.doneTitle,
    body: m.doneBody,
    route: '/',
  },
];
