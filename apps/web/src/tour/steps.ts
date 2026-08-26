import type { MessageDescriptor } from 'react-intl';
import { defineMessages } from 'react-intl';
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
 * Every user-visible string here is a MessageDescriptor, not a literal.
 * Governance §12.6 applies to a .ts data file exactly as it does to markup —
 * and this is the file where it would go unnoticed, because
 * `no-literal-string-in-jsx` only ever looks at JSX. The descriptors are
 * resolved by TourOverlay through `useIntl`, and by TourProvider (which owns
 * the `t` on TourCtx) for the sentences seeded into a conversation.
 */

/** Section headings, shared across the steps that sit under them. */
const s = defineMessages({
  welcome: { id: 'tour.section.welcome', defaultMessage: 'Welcome' },
  aiWorkspace: { id: 'tour.section.aiWorkspace', defaultMessage: 'AI Workspace' },
  fromTheChat: { id: 'tour.section.fromTheChat', defaultMessage: 'From the chat' },
  navigation: { id: 'tour.section.navigation', defaultMessage: 'Navigation' },
  clients: { id: 'tour.section.clients', defaultMessage: 'Clients' },
  clientRecord: { id: 'tour.section.clientRecord', defaultMessage: 'Client record' },
  inboxes: { id: 'tour.section.inboxes', defaultMessage: 'Inboxes' },
  chases: { id: 'tour.section.chases', defaultMessage: 'Chases' },
  approvals: { id: 'tour.section.approvals', defaultMessage: 'Approvals' },
  documents: { id: 'tour.section.documents', defaultMessage: 'Documents' },
  analytics: { id: 'tour.section.analytics', defaultMessage: 'Analytics' },
  team: { id: 'tour.section.team', defaultMessage: 'Team' },
  settings: { id: 'tour.section.settings', defaultMessage: 'Settings' },
  businessPortal: { id: 'tour.section.businessPortal', defaultMessage: 'Business portal' },
  done: { id: 'tour.section.done', defaultMessage: 'Done' },
});

/**
 * Step copy. One id per step per field, so a translator sees the title, the
 * body and the "or just ask" prompt of a step as three separate strings —
 * which is what they are: a heading, a paragraph, and a sentence a user is
 * meant to be able to type back into the composer.
 */
const m = defineMessages({
  welcomeTitle: { id: 'tour.steps.welcome.title', defaultMessage: 'A quick tour of the whole practice' },
  welcomeBody: { id: 'tour.steps.welcome.body', defaultMessage: 'In about five minutes you will see every screen — clients, inboxes, chasing, approvals, publishing to Xero, and the portal your clients use. One idea runs through all of it: anything you can click, you can also just ask for in the chat.' },
  composerTitle: { id: 'tour.steps.composer.title', defaultMessage: 'Start by asking' },
  composerBody: { id: 'tour.steps.composer.body', defaultMessage: 'This box is the front door. Type what you need in plain English — "what is missing for Ananda?", "publish the ready items", "add a client" — and the answer comes back as something you can act on, not a paragraph.' },
  attachClientTitle: { id: 'tour.steps.attachClient.title', defaultMessage: 'Scope a conversation to a client' },
  attachClientBody: { id: 'tour.steps.attachClient.body', defaultMessage: 'Attach one or more clients and every answer is about them. Leave it empty and questions span the whole practice.' },
  composerDocumentsTitle: { id: 'tour.steps.composerDocuments.title', defaultMessage: 'Drop documents straight into the chat' },
  composerDocumentsBody: { id: 'tour.steps.composerDocuments.body', defaultMessage: 'PDF, photos, HEIC, CSV and XLSX. They are read, classified into Costs or Sales, and filed to the right client — a spreadsheet is read row by row rather than OCR-ed.' },
  composerVoiceTitle: { id: 'tour.steps.composerVoice.title', defaultMessage: 'Or say it' },
  composerVoiceBody: { id: 'tour.steps.composerVoice.body', defaultMessage: 'Push to talk. You see the transcript and confirm it before anything runs.' },
  historyTitle: { id: 'tour.steps.history.title', defaultMessage: 'Every conversation is kept' },
  historyBody: { id: 'tour.steps.history.body', defaultMessage: 'Pinned clients and recent conversations live here. Each chat has its own address, so a link in a message lands exactly where you were.' },
  chatMissingTitle: { id: 'tour.steps.chatMissing.title', defaultMessage: 'Ask what is missing' },
  chatMissingBody: { id: 'tour.steps.chatMissing.body', defaultMessage: 'The answer is a working card: how many documents are outstanding, for whom, and the next move — chase them, review the list, or export it. Nothing to find in a menu.' },
  chatMissingAsk: { id: 'tour.steps.chatMissing.ask', defaultMessage: "What's missing for American Burger?" },
  chatApproveTitle: { id: 'tour.steps.chatApprove.title', defaultMessage: 'Approve a batch' },
  chatApproveBody: { id: 'tour.steps.chatApprove.body', defaultMessage: 'Approvals come back with a review gate: read what is in the batch, who signed off, and what the rules passed — then approve. The same gate the Approvals screen uses, inside the conversation.' },
  chatApproveAsk: { id: 'tour.steps.chatApprove.ask', defaultMessage: 'Approve the pending items for American Burger' },
  chatPublishTitle: { id: 'tour.steps.chatPublish.title', defaultMessage: 'Send it to Xero' },
  chatPublishBody: { id: 'tour.steps.chatPublish.body', defaultMessage: 'Ask to publish and the Ready items are bundled with what will be sent — extracted data plus the original image — and what is held back and why. Approve here and it goes to the ledger. That is the whole "send to Xero" flow, from a sentence.' },
  chatPublishAsk: { id: 'tour.steps.chatPublish.ask', defaultMessage: 'Publish the ready items for American Burger to Xero' },
  chatMatchesTitle: { id: 'tour.steps.chatMatches.title', defaultMessage: 'Reconcile the bank' },
  chatMatchesBody: { id: 'tour.steps.chatMatches.body', defaultMessage: 'Bank lines are matched to documents with a confidence score. Confirmed matches are evidence; probable ones say what is missing. Unmatch from the card if the AI got one wrong.' },
  chatMatchesAsk: { id: 'tour.steps.chatMatches.ask', defaultMessage: 'Match the bank feed for American Burger' },
  chatRuleTitle: { id: 'tour.steps.chatRule.title', defaultMessage: 'Teach it a rule' },
  chatRuleBody: { id: 'tour.steps.chatRule.body', defaultMessage: 'Describe a rule in words — supplier, conditions, what to code it to — and it is built for you, with any conflict called out. Choose whether it also applies to what is already in the inbox.' },
  chatRuleAsk: { id: 'tour.steps.chatRule.ask', defaultMessage: 'Always code Shell receipts for American Burger to Motor expenses' },
  chatInviteTitle: { id: 'tour.steps.chatInvite.title', defaultMessage: 'Bring a colleague in' },
  chatInviteBody: { id: 'tour.steps.chatInvite.body', defaultMessage: 'Inviting someone is a form in the chat: role, permissions, which clients. Everything people-related — colleagues, teams, client users — can start here.' },
  chatInviteAsk: { id: 'tour.steps.chatInvite.ask', defaultMessage: 'Invite Sam as a standard user with access to American Burger' },
  chatAnalyticsTitle: { id: 'tour.steps.chatAnalytics.title', defaultMessage: 'Ask how things are going' },
  chatAnalyticsBody: { id: 'tour.steps.chatAnalytics.body', defaultMessage: 'Pipeline health, correction rate, chase response times — as tiles and a chart, scoped to whoever is attached.' },
  chatAnalyticsAsk: { id: 'tour.steps.chatAnalytics.ask', defaultMessage: 'How is the pipeline doing?' },
  chatAddClientTitle: { id: 'tour.steps.chatAddClient.title', defaultMessage: 'Even onboarding a client' },
  chatAddClientBody: { id: 'tour.steps.chatAddClient.body', defaultMessage: 'Two paths: send the client a registration link (they connect their own Xero and bank), or register them yourself. The same intake the Clients screen uses.' },
  chatAddClientAsk: { id: 'tour.steps.chatAddClient.ask', defaultMessage: 'Add a new client called Harbour Cafe' },
  navTitle: { id: 'tour.steps.nav.title', defaultMessage: 'The screens, when you want them' },
  navBody: { id: 'tour.steps.nav.body', defaultMessage: 'Everything the chat can do also has a screen, for when you want to browse rather than ask. On a phone the rail becomes this bar; the rest sits under More.' },
  clientsTitle: { id: 'tour.steps.clients.title', defaultMessage: 'Your client list' },
  clientsBody: { id: 'tour.steps.clients.body', defaultMessage: 'Every business you look after, with what is outstanding on each. Switch between cards and a sortable table; star the ones you are working on this week.' },
  clientsAsk: { id: 'tour.steps.clients.ask', defaultMessage: 'Show me my clients' },
  clientsAddTitle: { id: 'tour.steps.clientsAdd.title', defaultMessage: 'Add a client' },
  clientsAddBody: { id: 'tour.steps.clientsAdd.body', defaultMessage: 'Send them a registration link by SMS — they add their own details and connect their ledger and bank — or register them on their behalf.' },
  clientsAddAsk: { id: 'tour.steps.clientsAdd.ask', defaultMessage: 'Add a new client' },
  clientsCardTitle: { id: 'tour.steps.clientsCard.title', defaultMessage: 'A client at a glance' },
  clientsCardBody: { id: 'tour.steps.clientsCard.body', defaultMessage: 'Missing documents and items to review, straight on the card. Open, ask the AI about them, or chase from here.' },
  clientsCardAsk: { id: 'tour.steps.clientsCard.ask', defaultMessage: 'How is American Burger doing?' },
  clientHeaderTitle: { id: 'tour.steps.clientHeader.title', defaultMessage: 'The client record' },
  clientHeaderBody: { id: 'tour.steps.clientHeader.body', defaultMessage: 'Ledger, bank, health and deadlines in the header; Ask AI and Chase always one tap away.' },
  clientHeaderAsk: { id: 'tour.steps.clientHeader.ask', defaultMessage: 'Tell me about American Burger' },
  clientTabsTitle: { id: 'tour.steps.clientTabs.title', defaultMessage: 'Fourteen tabs, one pipeline' },
  clientTabsBody: { id: 'tour.steps.clientTabs.body', defaultMessage: 'Overview, then the two inboxes (Costs and Sales), Bank, statements and claims, Approvals, Documents, Chases, Tasks, Integrations, Users, Settings and the client-scoped AI chat. They scroll sideways on a phone.' },
  clientKpisTitle: { id: 'tour.steps.clientKpis.title', defaultMessage: 'Overview' },
  clientKpisBody: { id: 'tour.steps.clientKpis.body', defaultMessage: 'Seven live numbers. Each tile is a shortcut into the tab that explains it; Missing docs carries its own Chase button.' },
  clientKpisAsk: { id: 'tour.steps.clientKpis.ask', defaultMessage: "What's the status of American Burger?" },
  costsReviewTitle: { id: 'tour.steps.costsReview.title', defaultMessage: 'Costs — To Review' },
  costsReviewBody: { id: 'tour.steps.costsReview.body', defaultMessage: 'Purchase documents in pipeline order: Processing, To Review, Ready, Published, Rejected, Duplicates. Each row shows the next move — Fix if something is missing, otherwise Move to Ready.' },
  costsReviewAsk: { id: 'tour.steps.costsReview.ask', defaultMessage: 'Show me the cost inbox for American Burger' },
  costsUploadTitle: { id: 'tour.steps.costsUpload.title', defaultMessage: 'Upload into the pipeline' },
  costsUploadBody: { id: 'tour.steps.costsUpload.body', defaultMessage: 'Upload here or drop files in the chat. An analysis animation shows what was read, then the document is filed where the AI decided — changeable if it got it wrong.' },
  costsUploadAsk: { id: 'tour.steps.costsUpload.ask', defaultMessage: 'Upload these receipts for American Burger' },
  costsReadyPublishTitle: { id: 'tour.steps.costsReadyPublish.title', defaultMessage: 'Ready → Xero' },
  costsReadyPublishBody: { id: 'tour.steps.costsReadyPublish.body', defaultMessage: 'Select the Ready rows and publish. Extracted data and the original image go to the ledger together; anything blocked by a required field stays behind and says why.' },
  costsReadyPublishAsk: { id: 'tour.steps.costsReadyPublish.ask', defaultMessage: 'Publish the ready items for American Burger' },
  costsPublishedTitle: { id: 'tour.steps.costsPublished.title', defaultMessage: 'Published' },
  costsPublishedBody: { id: 'tour.steps.costsPublished.body', defaultMessage: 'What is in the ledger, with the reference Xero gave it. Unpublish is here if something has to come back.' },
  costsPublishedAsk: { id: 'tour.steps.costsPublished.ask', defaultMessage: 'What did we publish for American Burger this month?' },
  salesTitle: { id: 'tour.steps.sales.title', defaultMessage: 'Sales' },
  salesBody: { id: 'tour.steps.sales.body', defaultMessage: 'The same pipeline for money in. The AI decides Costs or Sales on upload — nobody has to choose.' },
  salesAsk: { id: 'tour.steps.sales.ask', defaultMessage: 'Show me sales invoices for American Burger' },
  bankTransactionsTitle: { id: 'tour.steps.bankTransactions.title', defaultMessage: 'Bank — Transactions' },
  bankTransactionsBody: { id: 'tour.steps.bankTransactions.body', defaultMessage: 'The feed, with evidence status per line. Chase for evidence, cash-code what will never have a receipt, or export.' },
  bankTransactionsAsk: { id: 'tour.steps.bankTransactions.ask', defaultMessage: 'Which bank transactions have no receipt for American Burger?' },
  bankMatchesTitle: { id: 'tour.steps.bankMatches.title', defaultMessage: 'Bank — Matches' },
  bankMatchesBody: { id: 'tour.steps.bankMatches.body', defaultMessage: 'Document-to-transaction matches with confidence. Match rules (date and amount tolerances) are configurable, not fixed.' },
  bankMatchesAsk: { id: 'tour.steps.bankMatches.ask', defaultMessage: 'Match the bank feed for American Burger' },
  bankStatementsTitle: { id: 'tour.steps.bankStatements.title', defaultMessage: 'Bank — Statements' },
  bankStatementsBody: { id: 'tour.steps.bankStatements.body', defaultMessage: 'Upload statements, see gaps between them, and request the missing period from the client.' },
  bankStatementsAsk: { id: 'tour.steps.bankStatements.ask', defaultMessage: 'Are there any statement gaps for American Burger?' },
  bankAccountsTitle: { id: 'tour.steps.bankAccounts.title', defaultMessage: 'Bank — Accounts' },
  bankAccountsBody: { id: 'tour.steps.bankAccounts.body', defaultMessage: 'Each connected account, consent expiry, and re-authorisation. The client connects the feed; you see its health.' },
  supplierStatementsTitle: { id: 'tour.steps.supplierStatements.title', defaultMessage: 'Supplier statements' },
  supplierStatementsBody: { id: 'tour.steps.supplierStatements.body', defaultMessage: 'Upload a supplier statement and every line is matched to a document. Lines with no document can be chased in one go.' },
  supplierStatementsAsk: { id: 'tour.steps.supplierStatements.ask', defaultMessage: 'Reconcile the Brakes statement for American Burger' },
  expenseClaimsTitle: { id: 'tour.steps.expenseClaims.title', defaultMessage: 'Expense claims' },
  expenseClaimsBody: { id: 'tour.steps.expenseClaims.body', defaultMessage: 'Employees capture their own receipts; a manager or owner approves before anything reaches you. Every receipt is read and categorised by the AI.' },
  expenseClaimsAsk: { id: 'tour.steps.expenseClaims.ask', defaultMessage: 'Show expense claims waiting for American Burger' },
  clientApprovalsTitle: { id: 'tour.steps.clientApprovals.title', defaultMessage: 'Approvals for this client' },
  clientApprovalsBody: { id: 'tour.steps.clientApprovals.body', defaultMessage: 'Pending items with approve, edit and reject on each row, and the workflows that route them — including client-side stages approved by SMS.' },
  clientApprovalsAsk: { id: 'tour.steps.clientApprovals.ask', defaultMessage: "What's waiting for approval at American Burger?" },
  clientDocumentsTitle: { id: 'tour.steps.clientDocuments.title', defaultMessage: 'Documents' },
  clientDocumentsBody: { id: 'tour.steps.clientDocuments.body', defaultMessage: 'Every document for the client, whatever channel it came in by, with preview, download and retry.' },
  clientDocumentsAsk: { id: 'tour.steps.clientDocuments.ask', defaultMessage: 'Find the Sysco invoice from July for American Burger' },
  clientChasesTitle: { id: 'tour.steps.clientChases.title', defaultMessage: 'Chases' },
  clientChasesBody: { id: 'tour.steps.clientChases.body', defaultMessage: 'What has been requested from the client, how it was detected, and where each chase stands. Chase again from the row.' },
  clientChasesAsk: { id: 'tour.steps.clientChases.ask', defaultMessage: 'Chase the missing documents for American Burger' },
  clientTasksTitle: { id: 'tour.steps.clientTasks.title', defaultMessage: 'Tasks' },
  clientTasksBody: { id: 'tour.steps.clientTasks.body', defaultMessage: 'Workflow tasks the AI raised plus anything you add by hand, assigned to a team member, with blockers shown.' },
  clientTasksAsk: { id: 'tour.steps.clientTasks.ask', defaultMessage: 'Add a task to check the VAT return for American Burger' },
  integrationsTitle: { id: 'tour.steps.integrations.title', defaultMessage: 'Integrations' },
  integrationsBody: { id: 'tour.steps.integrations.body', defaultMessage: 'Xero connection health, bank feed consent, and the setup link you send the client so they connect both themselves.' },
  integrationsAsk: { id: 'tour.steps.integrations.ask', defaultMessage: 'Is American Burger still connected to Xero?' },
  clientUsersTitle: { id: 'tour.steps.clientUsers.title', defaultMessage: 'Users' },
  clientUsersBody: { id: 'tour.steps.clientUsers.body', defaultMessage: 'Who at the business can send documents. Add a user here and the business owner approves them from their portal.' },
  clientUsersAsk: { id: 'tour.steps.clientUsers.ask', defaultMessage: 'Add a user for American Burger' },
  clientSettingsTitle: { id: 'tour.steps.clientSettings.title', defaultMessage: 'Settings' },
  clientSettingsBody: { id: 'tour.steps.clientSettings.body', defaultMessage: 'Client details. Edits go to the client for approval rather than changing silently.' },
  clientAiTitle: { id: 'tour.steps.clientAi.title', defaultMessage: 'AI, scoped to the client' },
  clientAiBody: { id: 'tour.steps.clientAi.body', defaultMessage: 'Suggested questions and this client\'s past conversations. Same chat, already attached.' },
  inboxesTitle: { id: 'tour.steps.inboxes.title', defaultMessage: 'All clients, one inbox' },
  inboxesBody: { id: 'tour.steps.inboxes.body', defaultMessage: 'Costs and Sales across the practice, by status. Filter by client or channel — email, WhatsApp, web upload, the portal, spreadsheets.' },
  inboxesAsk: { id: 'tour.steps.inboxes.ask', defaultMessage: "What's in the cost inbox?" },
  inboxesRequiredTitle: { id: 'tour.steps.inboxesRequired.title', defaultMessage: 'Required fields' },
  inboxesRequiredBody: { id: 'tour.steps.inboxesRequired.body', defaultMessage: 'Switch on a field and it becomes a column; nothing publishes without it and the row says which field is missing.' },
  inboxesPreviewTitle: { id: 'tour.steps.inboxesPreview.title', defaultMessage: 'The document, read' },
  inboxesPreviewBody: { id: 'tour.steps.inboxesPreview.body', defaultMessage: 'The original beside every field the AI extracted, with confidence and where on the page it came from. Tap a value to correct it; the original is never changed.' },
  inboxesPreviewAsk: { id: 'tour.steps.inboxesPreview.ask', defaultMessage: 'Open the latest document for review' },
  inboxesPublishTitle: { id: 'tour.steps.inboxesPublish.title', defaultMessage: 'Publish to the ledger' },
  inboxesPublishBody: { id: 'tour.steps.inboxesPublish.body', defaultMessage: 'Publishing asks first and shows exactly what goes and what is held back. Approve, and the documents are in Xero with their images attached.' },
  inboxesPublishAsk: { id: 'tour.steps.inboxesPublish.ask', defaultMessage: 'Publish everything that is ready' },
  chasesTitle: { id: 'tour.steps.chases.title', defaultMessage: 'Missing evidence, practice-wide' },
  chasesBody: { id: 'tour.steps.chases.body', defaultMessage: 'How much is missing, how many chases are live, and what is overdue. Chasing is by SMS, with quiet hours and a cooldown between messages.' },
  chasesAsk: { id: 'tour.steps.chases.ask', defaultMessage: 'What is overdue across all clients?' },
  chasesRunTitle: { id: 'tour.steps.chasesRun.title', defaultMessage: 'Run the chase engine' },
  chasesRunBody: { id: 'tour.steps.chasesRun.body', defaultMessage: 'Review the message per client, edit the wording, and send. Every chase carries an upload link the client can use without an account.' },
  chasesRunAsk: { id: 'tour.steps.chasesRun.ask', defaultMessage: 'Chase everyone who owes documents' },
  chasesPolicyTitle: { id: 'tour.steps.chasesPolicy.title', defaultMessage: 'Chase policy' },
  chasesPolicyBody: { id: 'tour.steps.chasesPolicy.body', defaultMessage: 'First chase after, reminders, escalation, quiet hours, link lifetime. The AI follows this schedule automatically when auto-chase is on.' },
  approvalsTitle: { id: 'tour.steps.approvals.title', defaultMessage: 'The approval queue' },
  approvalsBody: { id: 'tour.steps.approvals.body', defaultMessage: 'Waiting on me, or everything pending. Each row shows the stage, who approves next and how long it has waited.' },
  approvalsAsk: { id: 'tour.steps.approvals.ask', defaultMessage: 'What needs my approval?' },
  approvalsDetailTitle: { id: 'tour.steps.approvalsDetail.title', defaultMessage: 'Approve or reject' },
  approvalsDetailBody: { id: 'tour.steps.approvalsDetail.body', defaultMessage: 'The stage chain, the document, and a note. Pass the stage, send it back with a reason, or correct it in the chat if the stage allows edits. Every step asks "are you sure".' },
  approvalsDetailAsk: { id: 'tour.steps.approvalsDetail.ask', defaultMessage: 'Approve the Sysco invoice' },
  workflowsTitle: { id: 'tour.steps.workflows.title', defaultMessage: 'Workflows' },
  workflowsBody: { id: 'tour.steps.workflows.body', defaultMessage: 'Multi-stage, conditional, with client-side stages approved by SMS. Describe a workflow in words and it is built for you — then edit by hand.' },
  workflowsAsk: { id: 'tour.steps.workflows.ask', defaultMessage: 'Create a workflow: anything over £500 needs the owner' },
  approvalsHistoryTitle: { id: 'tour.steps.approvalsHistory.title', defaultMessage: 'History' },
  approvalsHistoryBody: { id: 'tour.steps.approvalsHistory.body', defaultMessage: 'Every outcome, locked once published, with the rejection note readable from the row.' },
  documentsTitle: { id: 'tour.steps.documents.title', defaultMessage: 'Archive and vault' },
  documentsBody: { id: 'tour.steps.documents.body', defaultMessage: 'The archive is everything published, grouped by client. The vault holds what is not a transaction — contracts, certificates — by firm, client and year, with expiry.' },
  documentsAsk: { id: 'tour.steps.documents.ask', defaultMessage: 'Find the lease for Ananda Group' },
  analyticsTitle: { id: 'tour.steps.analytics.title', defaultMessage: 'How the practice is running' },
  analyticsBody: { id: 'tour.steps.analytics.body', defaultMessage: 'Documents processed, correction rate, missing and overdue, per-client health. Scope to one client or the whole practice; export as CSV.' },
  analyticsAsk: { id: 'tour.steps.analytics.ask', defaultMessage: 'How is the pipeline doing this month?' },
  teamTitle: { id: 'tour.steps.team.title', defaultMessage: 'Colleagues and teams' },
  teamBody: { id: 'tour.steps.team.body', defaultMessage: 'Roles, permissions, client access, and whether finance fields are hidden. Teams group people around a set of clients.' },
  teamAsk: { id: 'tour.steps.team.ask', defaultMessage: 'Invite a colleague' },
  teamTasksTitle: { id: 'tour.steps.teamTasks.title', defaultMessage: 'Tasks' },
  teamTasksBody: { id: 'tour.steps.teamTasks.body', defaultMessage: 'Workflow tasks across every client, assignable from the row. Ask the AI about workload and it balances them.' },
  teamTasksAsk: { id: 'tour.steps.teamTasks.ask', defaultMessage: 'Who has the most open tasks?' },
  settingsTitle: { id: 'tour.steps.settings.title', defaultMessage: 'Practice settings' },
  settingsBody: { id: 'tour.steps.settings.body', defaultMessage: 'Profile, connections, extraction, automation, chasing, approvals, exports, lists, AI guidance, communication, security.' },
  settingsConnectionsTitle: { id: 'tour.steps.settingsConnections.title', defaultMessage: 'Connections' },
  settingsConnectionsBody: { id: 'tour.steps.settingsConnections.body', defaultMessage: 'Ledger adapters in priority order — Xero first, then QuickBooks, Sage and FreeAgent — and bank feed consent per client. Clients connect; you see health.' },
  settingsConnectionsAsk: { id: 'tour.steps.settingsConnections.ask', defaultMessage: 'Which clients are not connected to Xero?' },
  settingsAutomationTitle: { id: 'tour.steps.settingsAutomation.title', defaultMessage: 'Automation' },
  settingsAutomationBody: { id: 'tour.steps.settingsAutomation.body', defaultMessage: 'Auto-categorisation, whether AI suggestions apply themselves, archiving after publish, and the bank-match tolerances.' },
  portalHomeTitle: { id: 'tour.steps.portalHome.title', defaultMessage: 'What your client sees' },
  portalHomeBody: { id: 'tour.steps.portalHome.body', defaultMessage: 'A separate, phone-first portal. What their accountant is waiting for, what they have sent, and anything that needs their approval — including users you proposed.' },
  portalCaptureTitle: { id: 'tour.steps.portalCapture.title', defaultMessage: 'Capture' },
  portalCaptureBody: { id: 'tour.steps.portalCapture.body', defaultMessage: 'Point the phone at the receipt. Multi-page, with review before sending, or send as they shoot. Everything lands in your inbox already classified.' },
  portalUploadTitle: { id: 'tour.steps.portalUpload.title', defaultMessage: 'Upload' },
  portalUploadBody: { id: 'tour.steps.portalUpload.body', defaultMessage: 'Files from their computer or phone — PDFs, photos, spreadsheets — with a note if they want to explain.' },
  portalSettingsTitle: { id: 'tour.steps.portalSettings.title', defaultMessage: 'Their settings' },
  portalSettingsBody: { id: 'tour.steps.portalSettings.body', defaultMessage: 'Business details, notifications, their people, and the connections they own: accounting software and bank feed.' },
  doneTitle: { id: 'tour.steps.done.title', defaultMessage: 'That is the whole loop' },
  doneBody: { id: 'tour.steps.done.body', defaultMessage: 'Capture → extract → review → approve → publish to Xero → reconcile the bank → chase what is missing. Every screen you just saw is a shortcut; the chat can do all of it. Try asking something.' },
});

/**
 * The assistant's seeded answer for each demo intent. These are messages a
 * user reads in the transcript, so they are copy like anything else.
 */
const replies = defineMessages({
  showMissing: { id: 'tour.chatReply.showMissing', defaultMessage: "Here's what's still missing. You can chase it from here." },
  approveItems: { id: 'tour.chatReply.approveItems', defaultMessage: 'These are waiting on you. Read the review, then approve the batch.' },
  publish: { id: 'tour.chatReply.publish', defaultMessage: 'Everything marked Ready, checked and bundled. Approve to send it to the ledger.' },
  showMatches: { id: 'tour.chatReply.showMatches', defaultMessage: 'Bank lines matched to documents. Anything marked probable needs a look.' },
  createRule: { id: 'tour.chatReply.createRule', defaultMessage: "Here's the rule as I understood it. Approve it and it applies from now on." },
  inviteUser: { id: 'tour.chatReply.inviteUser', defaultMessage: 'Fill in who they are and what they can do, and I will send the invite.' },
  showAnalytics: { id: 'tour.chatReply.showAnalytics', defaultMessage: 'The pipeline at a glance.' },
  addClient: { id: 'tour.chatReply.addClient', defaultMessage: 'Two ways to add them — send a registration link, or set them up yourself.' },
  general: { id: 'tour.chatReply.general', defaultMessage: 'Done.' },
});

export interface TourCtx {
  clients: Client[];
  startConversation: (clientIds: string[], seed?: Message[]) => void;
  /** The first seeded business account, for the portal section. */
  portalAccountId: string | null;
  /** Resolves a descriptor in the active locale. Supplied by TourProvider. */
  t: (descriptor: MessageDescriptor) => string;
}

export interface TourStep {
  id: string;
  section: MessageDescriptor;
  title: MessageDescriptor;
  body: MessageDescriptor;
  /** The prompt that does the same thing from the chat. */
  ask?: MessageDescriptor;
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

/** Build a seeded two-message conversation that renders one answer card. */
function seedChat(ctx: TourCtx, prompt: MessageDescriptor, intent: Intent, extra: Partial<MessagePayload> = {}) {
  const text = ctx.t(prompt);
  const scope = resolveScope(text, ctx.clients, [CLIENT]);
  const now = Date.now();
  const seed: Message[] = [
    { id: `tour-u-${now}`, role: 'user', content: text },
    {
      id: `tour-a-${now}`,
      role: 'assistant',
      content: ctx.t(replyFor(intent)),
      intent,
      payload: { ...scope, ...extra },
    },
  ];
  ctx.startConversation(scope.clientIds.length ? scope.clientIds : [CLIENT], seed);
}

function replyFor(intent: Intent): MessageDescriptor {
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
