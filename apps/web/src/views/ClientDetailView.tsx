import { useMemo, useState } from 'react';
import {
  ArrowLeft, Sparkles, Send, Activity, Landmark, Link2, Star,
  RefreshCw, CheckCircle, Eye, Users, Settings as SettingsIcon, Download, Smartphone,
  Radio, History, ListChecks, Bot, Circle, Plus, PencilLine, X as XIcon, ShieldCheck, Clock, Check,
  LucideIcon,
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { defineMessages, useIntl, type IntlShape, type MessageDescriptor } from 'react-intl';
import { commonActions, commonLabels, commonPlaceholders } from '../i18n/common';
import { useAppContext } from '../context/AppContext';
import { DataTable, Pill, type Column } from '../components/DynamicComponents/DataTable';
import { DocumentPreview } from '../components/DynamicComponents/DocumentPreview';
import { Modal, WorkflowCard, WorkflowEditor, blankWorkflow } from './ApprovalsView';
import { RolePicker } from '../components/DynamicComponents/RolePicker';
import { ClientInbox } from './ClientInbox';
import { ChaseComposer } from '../components/DynamicComponents/ChaseComposer';
import { BankView } from './BankView';
import { ClientSupplierStatements } from './ClientSupplierStatements';
import { ClientExpenseClaims } from './ClientExpenseClaims';
import { currency } from '../lib/resolver';
import { healthTone } from '../lib/selectors';
import { fromSlug, slug, useQueryParam, useSegment } from '../lib/router';
import { useConfirm } from '../components/DynamicComponents/ConfirmProvider';
import { channelLabel } from '../lib/channels';
import type { ApprovalWorkflow, BusinessMemberRole, Client, ClientDetailChange, Colleague, Document, Intent, MissingItem, SetupTask, WorkflowTask } from '../lib/types';

/**
 * Copy for the client detail screen — Governance §12.6, following the shape of
 * `components/DynamicComponents/ActionCard.tsx`.
 *
 * Counted phrases are ICU `plural` rather than `n === 1 ? '' : 's'`, and a
 * sentence whose ending changes is two whole messages rather than one with an
 * inserted clause — see the note at the head of ActionCard for why.
 */
const m = defineMessages({
  // ── Status column ───────────────────────────────────────────────────────
  statusToReview: { id: 'clients.clientDetailView.statusToReview', defaultMessage: 'To review' },
  statusReady: { id: 'clients.clientDetailView.statusReady', defaultMessage: 'Ready' },
  statusReadyPublishFailed: { id: 'clients.clientDetailView.statusReadyPublishFailed', defaultMessage: 'Ready — publish failed' },
  statusRejected: { id: 'clients.clientDetailView.statusRejected', defaultMessage: 'Rejected' },
  statusRejectedWithNote: { id: 'clients.clientDetailView.statusRejectedWithNote', defaultMessage: 'Rejected — {note}' },
  statusProcessing: { id: 'clients.clientDetailView.statusProcessing', defaultMessage: 'Processing' },
  statusPublished: { id: 'clients.clientDetailView.statusPublished', defaultMessage: 'Published' },

  // ── Header ──────────────────────────────────────────────────────────────
  backToClients: { id: 'clients.clientDetailView.backToClients', defaultMessage: 'All clients' },
  pillAwaitingRegistration: { id: 'clients.clientDetailView.pillAwaitingRegistration', defaultMessage: 'Awaiting client registration' },
  pillPipelineHealth: { id: 'clients.clientDetailView.pillPipelineHealth', defaultMessage: 'Pipeline health {health}%' },
  pillXero: { id: 'clients.clientDetailView.pillXero', defaultMessage: 'Xero' },
  pillNoLedger: { id: 'clients.clientDetailView.pillNoLedger', defaultMessage: 'No ledger' },
  pillBankFeedLive: { id: 'clients.clientDetailView.pillBankFeedLive', defaultMessage: 'Bank feed live' },
  pillStatementFallback: { id: 'clients.clientDetailView.pillStatementFallback', defaultMessage: 'Statement fallback' },
  pillSetupLinkSent: { id: 'clients.clientDetailView.pillSetupLinkSent', defaultMessage: 'Setup link sent' },
  askAi: { id: 'clients.clientDetailView.askAi', defaultMessage: 'Ask AI' },
  chaseAction: { id: 'clients.clientDetailView.chaseAction', defaultMessage: 'Chase' },
  chaseActionCount: { id: 'clients.clientDetailView.chaseActionCount', defaultMessage: 'Chase ({count})' },

  // ── Overview: pipeline snapshot ─────────────────────────────────────────
  tileInProcessing: { id: 'clients.clientDetailView.tileInProcessing', defaultMessage: 'In processing' },
  tileInProcessingHint: { id: 'clients.clientDetailView.tileInProcessingHint', defaultMessage: 'ETA per item' },
  tileToReview: { id: 'clients.clientDetailView.tileToReview', defaultMessage: 'To review' },
  tileReady: { id: 'clients.clientDetailView.tileReady', defaultMessage: 'Ready' },
  tileRejected: { id: 'clients.clientDetailView.tileRejected', defaultMessage: 'Rejected / failed' },
  tileMissingDocs: { id: 'clients.clientDetailView.tileMissingDocs', defaultMessage: 'Missing docs' },
  tileUnmatched: { id: 'clients.clientDetailView.tileUnmatched', defaultMessage: 'Unmatched bank txns' },
  tileAwaitingApproval: { id: 'clients.clientDetailView.tileAwaitingApproval', defaultMessage: 'Awaiting approval' },

  // ── Overview: channel mix ───────────────────────────────────────────────
  panelChannelMix: { id: 'clients.clientDetailView.panelChannelMix', defaultMessage: 'Channel mix' },
  channelMixIntro: {
    id: 'clients.clientDetailView.channelMixIntro',
    defaultMessage: "How this client's documents arrive. Email lands at <highlight>{email}</highlight>.",
  },
  channelMixEmpty: { id: 'clients.clientDetailView.channelMixEmpty', defaultMessage: 'No documents in yet.' },
  channelSharePct: { id: 'clients.clientDetailView.channelSharePct', defaultMessage: '{pct}%' },

  // ── Overview: integration health ────────────────────────────────────────
  panelIntegrationHealth: { id: 'clients.clientDetailView.panelIntegrationHealth', defaultMessage: 'Integration health' },
  accountingSoftware: { id: 'clients.clientDetailView.accountingSoftware', defaultMessage: 'Accounting software' },
  ledgerTokenValidLong: { id: 'clients.clientDetailView.ledgerTokenValidLong', defaultMessage: 'Xero token valid — re-auth in 284d' },
  ledgerNotConnected: { id: 'clients.clientDetailView.ledgerNotConnected', defaultMessage: 'No ledger connected' },
  pillLive: { id: 'clients.clientDetailView.pillLive', defaultMessage: 'Live' },
  pillOff: { id: 'clients.clientDetailView.pillOff', defaultMessage: 'Off' },
  bankFeed: { id: 'clients.clientDetailView.bankFeed', defaultMessage: 'Bank feed' },
  bankFeedNoAccount: { id: 'clients.clientDetailView.bankFeedNoAccount', defaultMessage: 'No account on file.' },
  bankAccountName: { id: 'clients.clientDetailView.bankAccountName', defaultMessage: '{bank} ••{last4}' },
  bankAccountLive: { id: 'clients.clientDetailView.bankAccountLive', defaultMessage: 'Re-auth in {days}d · synced {sync}' },
  bankAccountError: { id: 'clients.clientDetailView.bankAccountError', defaultMessage: 'Credential error — feed has stalled' },
  bankAccountDisconnected: { id: 'clients.clientDetailView.bankAccountDisconnected', defaultMessage: 'Disconnected — statement upload only' },
  reauthNow: { id: 'clients.clientDetailView.reauthNow', defaultMessage: 'Re-auth now' },

  // ── Overview: recent activity ───────────────────────────────────────────
  panelRecentActivity: { id: 'clients.clientDetailView.panelRecentActivity', defaultMessage: 'Recent activity' },
  activityEmpty: {
    id: 'clients.clientDetailView.activityEmpty',
    defaultMessage: 'Nothing yet. Approvals, chases and publishes for this client appear here as they happen.',
  },
  activityMeta: { id: 'clients.clientDetailView.activityMeta', defaultMessage: '{actor} · {at}' },
  activityChaseEngine: { id: 'clients.clientDetailView.activityChaseEngine', defaultMessage: 'Chase engine' },

  // ── Overview: pipeline health ───────────────────────────────────────────
  panelPipelineHealth: { id: 'clients.clientDetailView.panelPipelineHealth', defaultMessage: 'Pipeline health' },
  pipelineHealthPct: { id: 'clients.clientDetailView.pipelineHealthPct', defaultMessage: '{health}%' },
  pipelineHealthCaveat: { id: 'clients.clientDetailView.pipelineHealthCaveat', defaultMessage: 'document pipeline only' },
  rowUnverifiedSpend: { id: 'clients.clientDetailView.rowUnverifiedSpend', defaultMessage: 'Unverified spend' },
  rowItemDelay: { id: 'clients.clientDetailView.rowItemDelay', defaultMessage: 'Item delay' },
  itemDelayValue: { id: 'clients.clientDetailView.itemDelayValue', defaultMessage: '{days} days' },
  rowAutoPublish: { id: 'clients.clientDetailView.rowAutoPublish', defaultMessage: 'Suppliers on auto-publish' },
  autoPublishValue: { id: 'clients.clientDetailView.autoPublishValue', defaultMessage: '{pct}%' },
  rowDuplicates: { id: 'clients.clientDetailView.rowDuplicates', defaultMessage: 'Duplicates flagged' },
  rowOverdueChases: { id: 'clients.clientDetailView.rowOverdueChases', defaultMessage: 'Overdue chases' },
  rowUnexplained: { id: 'clients.clientDetailView.rowUnexplained', defaultMessage: 'Unexplained transactions' },
  rowStatementGaps: { id: 'clients.clientDetailView.rowStatementGaps', defaultMessage: 'Statement gaps' },
  rowRejected: { id: 'clients.clientDetailView.rowRejected', defaultMessage: 'Rejected / failed' },

  // ── Overview: client contact ────────────────────────────────────────────
  panelClientContact: { id: 'clients.clientDetailView.panelClientContact', defaultMessage: 'Client contact' },
  rowPrimaryContact: { id: 'clients.clientDetailView.rowPrimaryContact', defaultMessage: 'Primary contact' },
  rowChasePolicy: { id: 'clients.clientDetailView.rowChasePolicy', defaultMessage: 'Chase policy' },
  chasePolicyDefault: { id: 'clients.clientDetailView.chasePolicyDefault', defaultMessage: 'Standard (3/7 days)' },
  rowLastUpload: { id: 'clients.clientDetailView.rowLastUpload', defaultMessage: 'Last upload' },
  clientContactNote: {
    id: 'clients.clientDetailView.clientContactNote',
    defaultMessage: 'Chasing is SMS-only to this number. The client needs no app — the secure link opens in any phone browser.',
  },

  // ── AI tab ──────────────────────────────────────────────────────────────
  panelAskAboutClient: { id: 'clients.clientDetailView.panelAskAboutClient', defaultMessage: 'Ask about this client' },
  askIntro: {
    id: 'clients.clientDetailView.askIntro',
    defaultMessage:
      "Opens the workspace on a conversation already scoped to {client} — every answer is drawn from this client's pipeline only. Analysis stays within document operations; it does not prepare financial statements.",
  },
  promptMissing: { id: 'clients.clientDetailView.promptMissing', defaultMessage: 'What is still missing for {client}?' },
  promptMatches: { id: 'clients.clientDetailView.promptMatches', defaultMessage: 'Show the bank matches for {client}' },
  promptApprovals: { id: 'clients.clientDetailView.promptApprovals', defaultMessage: 'Which items are waiting on approval?' },
  promptReply: { id: 'clients.clientDetailView.promptReply', defaultMessage: 'Here you go:' },
  newConversation: { id: 'clients.clientDetailView.newConversation', defaultMessage: 'New conversation' },
  panelConversations: { id: 'clients.clientDetailView.panelConversations', defaultMessage: 'Conversations about this client' },
  conversationsEmpty: {
    id: 'clients.clientDetailView.conversationsEmpty',
    defaultMessage: 'None yet. Anything you ask with {client} attached is kept here.',
  },
  conversationMeta: {
    id: 'clients.clientDetailView.conversationMeta',
    defaultMessage: '{count, plural, one {# message} other {# messages}}',
  },
  conversationMetaWithClients: {
    id: 'clients.clientDetailView.conversationMetaWithClients',
    defaultMessage: '{count, plural, one {# message} other {# messages}} · {clients} clients attached',
  },

  // ── Shared table columns ────────────────────────────────────────────────
  colChannel: { id: 'clients.clientDetailView.colChannel', defaultMessage: 'Channel' },
  colDetectedBy: { id: 'clients.clientDetailView.colDetectedBy', defaultMessage: 'Detected by' },
  colStage: { id: 'clients.clientDetailView.colStage', defaultMessage: 'Stage' },
  colApprover: { id: 'clients.clientDetailView.colApprover', defaultMessage: 'Approver' },
  colSignedOffBy: { id: 'clients.clientDetailView.colSignedOffBy', defaultMessage: 'Signed off by' },
  colWaiting: { id: 'clients.clientDetailView.colWaiting', defaultMessage: 'Waiting' },

  // ── Chases tab ──────────────────────────────────────────────────────────
  pillRequested: { id: 'clients.clientDetailView.pillRequested', defaultMessage: 'Requested' },
  pillNotChased: { id: 'clients.clientDetailView.pillNotChased', defaultMessage: 'Not chased' },
  chaseAgain: { id: 'clients.clientDetailView.chaseAgain', defaultMessage: 'Chase again' },
  chasesEmpty: { id: 'clients.clientDetailView.chasesEmpty', defaultMessage: 'Nothing outstanding for this client.' },
  chaseSelected: { id: 'clients.clientDetailView.chaseSelected', defaultMessage: 'Chase selected' },
  chasesFooter: {
    id: 'clients.clientDetailView.chasesFooter',
    defaultMessage: '{missing} not chased • {requested} requested • {overdue} overdue',
  },

  // ── Tasks tab ───────────────────────────────────────────────────────────
  panelTasks: { id: 'clients.clientDetailView.panelTasks', defaultMessage: 'Document-workflow tasks' },
  tasksIntro: {
    id: 'clients.clientDetailView.tasksIntro',
    defaultMessage:
      'The recurring checklist for {client}. Steps marked AI-prefilled can be answered from real pipeline state rather than from memory.',
  },
  addTask: { id: 'clients.clientDetailView.addTask', defaultMessage: 'Add task' },
  tasksEmpty: { id: 'clients.clientDetailView.tasksEmpty', defaultMessage: 'No tasks for this client.' },
  taskWaitingOn: { id: 'clients.clientDetailView.taskWaitingOn', defaultMessage: 'Waiting on: {title}' },
  taskMarkComplete: { id: 'clients.clientDetailView.taskMarkComplete', defaultMessage: 'Mark complete' },
  taskReopen: { id: 'clients.clientDetailView.taskReopen', defaultMessage: 'Reopen' },
  taskMeta: { id: 'clients.clientDetailView.taskMeta', defaultMessage: '{assignee} · due {due}' },
  taskMetaBlocked: {
    id: 'clients.clientDetailView.taskMetaBlocked',
    defaultMessage: '{assignee} · due {due} · waiting on "{title}"',
  },
  pillAiPrefilled: { id: 'clients.clientDetailView.pillAiPrefilled', defaultMessage: 'AI-prefilled' },
  pillComplete: { id: 'clients.clientDetailView.pillComplete', defaultMessage: 'Complete' },
  pillWithIssues: { id: 'clients.clientDetailView.pillWithIssues', defaultMessage: 'With issues' },
  pillNotApplicable: { id: 'clients.clientDetailView.pillNotApplicable', defaultMessage: 'N/A' },

  // ── Approvals tab: the client-side banner ───────────────────────────────
  clientSideHeading: {
    id: 'clients.clientDetailView.clientSideHeading',
    defaultMessage: '{count, plural, one {# item} other {# items}} waiting on {client}',
  },
  itemSummary: { id: 'clients.clientDetailView.itemSummary', defaultMessage: '{supplier} {amount}' },
  clientSideLinkOpened: {
    id: 'clients.clientDetailView.clientSideLinkOpened',
    defaultMessage: '{items} — link sent {sentAt} to {mobile}, opened',
  },
  clientSideLinkUnopened: {
    id: 'clients.clientDetailView.clientSideLinkUnopened',
    defaultMessage: '{items} — link sent {sentAt} to {mobile}, not opened yet',
  },
  clientSideNoLink: { id: 'clients.clientDetailView.clientSideNoLink', defaultMessage: '{items} — no link sent yet' },
  resendTitle: { id: 'clients.clientDetailView.resendTitle', defaultMessage: 'Text {name} again?' },
  resendApprovalDetail: {
    id: 'clients.clientDetailView.resendApprovalDetail',
    defaultMessage: 'A fresh link replaces the one sent {sentAt}. Their previous link stops working.',
  },
  resendConfirmLabel: { id: 'clients.clientDetailView.resendConfirmLabel', defaultMessage: 'Yes, resend it' },
  resendLockedHint: {
    id: 'clients.clientDetailView.resendLockedHint',
    defaultMessage: 'The link sent {sentAt} is still live. Resend unlocks in {hours}h — change the wait under Settings → Chasing.',
  },
  resendReadyHint: { id: 'clients.clientDetailView.resendReadyHint', defaultMessage: 'Send a fresh link' },
  resendLocked: { id: 'clients.clientDetailView.resendLocked', defaultMessage: 'Resend in {hours}h' },
  resend: { id: 'clients.clientDetailView.resend', defaultMessage: 'Resend' },
  sendRequestTitle: { id: 'clients.clientDetailView.sendRequestTitle', defaultMessage: 'Text {name} for approval?' },
  sendRequestTitleUnnamed: {
    id: 'clients.clientDetailView.sendRequestTitleUnnamed',
    defaultMessage: 'Text the approver for approval?',
  },
  sendRequestDetail: {
    id: 'clients.clientDetailView.sendRequestDetail',
    defaultMessage: '{count, plural, one {# item} other {# items}} · {amount} to {mobile}.',
  },
  sendRequestConsequence: {
    id: 'clients.clientDetailView.sendRequestConsequence',
    defaultMessage: 'One link covers the whole batch and expires with the chase policy.',
  },
  sendRequestConfirmLabel: { id: 'clients.clientDetailView.sendRequestConfirmLabel', defaultMessage: 'Yes, send it' },
  sendRequestNoMobile: { id: 'clients.clientDetailView.sendRequestNoMobile', defaultMessage: 'No mobile on file for this client' },
  sendRequest: { id: 'clients.clientDetailView.sendRequest', defaultMessage: 'Send the request' },
  openLinkHint: { id: 'clients.clientDetailView.openLinkHint', defaultMessage: 'See exactly what the approver sees' },
  openLinkDisabledHint: { id: 'clients.clientDetailView.openLinkDisabledHint', defaultMessage: 'Send the request first' },
  openLink: { id: 'clients.clientDetailView.openLink', defaultMessage: 'Open the link' },

  // ── Approvals tab: the queue ────────────────────────────────────────────
  approvalsTableTitle: { id: 'clients.clientDetailView.approvalsTableTitle', defaultMessage: 'Pending items' },
  approvalsTableSubtitle: {
    id: 'clients.clientDetailView.approvalsTableSubtitle',
    defaultMessage: 'Approving here is the same queue an approver sees under Approvals',
  },
  pillClientBySms: { id: 'clients.clientDetailView.pillClientBySms', defaultMessage: 'Client — by SMS' },
  pillPractice: { id: 'clients.clientDetailView.pillPractice', defaultMessage: 'Practice' },
  waitingDays: { id: 'clients.clientDetailView.waitingDays', defaultMessage: '{days}d' },
  pillApproved: { id: 'clients.clientDetailView.pillApproved', defaultMessage: 'Approved' },
  pillRejected: { id: 'clients.clientDetailView.pillRejected', defaultMessage: 'Rejected' },
  pillWithTheClient: { id: 'clients.clientDetailView.pillWithTheClient', defaultMessage: 'With the client' },
  editCodingHint: { id: 'clients.clientDetailView.editCodingHint', defaultMessage: 'Correct the coding before approving' },
  rejectItemHint: { id: 'clients.clientDetailView.rejectItemHint', defaultMessage: 'Reject this item' },
  rejectTitle: { id: 'clients.clientDetailView.rejectTitle', defaultMessage: 'Reject {supplier}?' },
  rejectDetail: {
    id: 'clients.clientDetailView.rejectDetail',
    defaultMessage: '{amount} · {category}. It stops here and is not published.',
  },
  rejectConsequence: {
    id: 'clients.clientDetailView.rejectConsequence',
    defaultMessage: 'No reason is recorded from this button — open the row to add one.',
  },
  rejectConfirmLabel: { id: 'clients.clientDetailView.rejectConfirmLabel', defaultMessage: 'Yes, reject' },
  rejectReason: {
    id: 'clients.clientDetailView.rejectReason',
    defaultMessage: 'Rejected from the client approvals tab',
  },
  approveHint: { id: 'clients.clientDetailView.approveHint', defaultMessage: 'Approve — passes {stage}' },
  approveTitle: { id: 'clients.clientDetailView.approveTitle', defaultMessage: 'Pass {stage} on {supplier}?' },
  approveDetail: {
    id: 'clients.clientDetailView.approveDetail',
    defaultMessage: '{amount} · {category}. Your name goes on the approval.',
  },
  approveConsequence: {
    id: 'clients.clientDetailView.approveConsequence',
    defaultMessage: 'At the last stage this locks the item and publishes it.',
  },
  approveConfirmLabel: { id: 'clients.clientDetailView.approveConfirmLabel', defaultMessage: 'Yes, approve' },
  approvalsEmptyNoWorkflow: {
    id: 'clients.clientDetailView.approvalsEmptyNoWorkflow',
    defaultMessage: 'No workflow applies to this client, so nothing pauses for approval — Ready items publish directly.',
  },
  approvalsEmpty: { id: 'clients.clientDetailView.approvalsEmpty', defaultMessage: 'Nothing awaiting approval.' },
  approveSelected: { id: 'clients.clientDetailView.approveSelected', defaultMessage: 'Approve selected' },
  nothingYoursTitle: { id: 'clients.clientDetailView.nothingYoursTitle', defaultMessage: 'Nothing here is yours to approve' },
  nothingYoursDetail: {
    id: 'clients.clientDetailView.nothingYoursDetail',
    defaultMessage: 'These are either already decided or sitting with the client.',
  },
  bulkApproveTitle: {
    id: 'clients.clientDetailView.bulkApproveTitle',
    defaultMessage: 'Pass {count, plural, one {# item} other {# items}}?',
  },
  bulkApproveConsequence: {
    id: 'clients.clientDetailView.bulkApproveConsequence',
    defaultMessage: 'Anything on its last stage locks and publishes to the accounting software.',
  },

  // ── Approvals tab: workflows ────────────────────────────────────────────
  workflowsHeading: { id: 'clients.clientDetailView.workflowsHeading', defaultMessage: 'Workflows' },
  workflowsIntro: {
    id: 'clients.clientDetailView.workflowsIntro',
    defaultMessage:
      'Approvals are opt-in. With no active workflow this client has no approval step at all — items go Ready → publish with nothing pausing.',
  },
  newWorkflow: { id: 'clients.clientDetailView.newWorkflow', defaultMessage: 'New workflow' },
  deleteWorkflowTitle: { id: 'clients.clientDetailView.deleteWorkflowTitle', defaultMessage: 'Delete the "{name}" workflow?' },
  deleteWorkflowDetail: {
    id: 'clients.clientDetailView.deleteWorkflowDetail',
    defaultMessage: '{count, plural, one {# stage} other {# stages}}, applying to {appliesTo}.',
  },
  deleteWorkflowConsequence: {
    id: 'clients.clientDetailView.deleteWorkflowConsequence',
    defaultMessage: 'Items on it stop pausing for approval and publish straight through.',
  },
  deleteWorkflowConfirmLabel: { id: 'clients.clientDetailView.deleteWorkflowConfirmLabel', defaultMessage: 'Yes, delete it' },

  // ── Documents tab ───────────────────────────────────────────────────────
  documentsEmpty: { id: 'clients.clientDetailView.documentsEmpty', defaultMessage: 'No documents yet.' },
  bulkPreview: { id: 'clients.clientDetailView.bulkPreview', defaultMessage: 'Preview' },
  download: { id: 'clients.clientDetailView.download', defaultMessage: 'Download' },
  bulkRetryFailed: { id: 'clients.clientDetailView.bulkRetryFailed', defaultMessage: 'Retry failed' },
  retryTitle: {
    id: 'clients.clientDetailView.retryTitle',
    defaultMessage: 'Retry {count, plural, one {# failed item} other {# failed items}}?',
  },
  retryDetail: {
    id: 'clients.clientDetailView.retryDetail',
    defaultMessage:
      'Anything that failed to extract is read again; anything that failed to publish goes back to Ready to be pushed again. Whatever was already read off a document is kept.',
  },
  retryConfirmLabel: { id: 'clients.clientDetailView.retryConfirmLabel', defaultMessage: 'Yes, retry' },
  documentsFooter: {
    id: 'clients.clientDetailView.documentsFooter',
    defaultMessage: '{total} total • {published} published • {rejected} rejected — click a row to preview',
  },

  // ── Users tab ───────────────────────────────────────────────────────────
  panelBusinessUsers: { id: 'clients.clientDetailView.panelBusinessUsers', defaultMessage: 'Business users' },
  businessUsersIntro: {
    id: 'clients.clientDetailView.businessUsersIntro',
    defaultMessage:
      'People at {client} who can send paperwork. You propose them and set what they may do — the business approves before anyone is contacted, because who works there is their call, not yours.',
  },
  businessUsersEmpty: {
    id: 'clients.clientDetailView.businessUsersEmpty',
    defaultMessage: 'Nobody yet. Invite whoever handles the paperwork.',
  },
  memberUnnamed: { id: 'clients.clientDetailView.memberUnnamed', defaultMessage: 'Unnamed' },
  memberProposed: {
    id: 'clients.clientDetailView.memberProposed',
    defaultMessage: 'Proposed {at} · nothing sent to them yet',
  },
  memberDeclined: { id: 'clients.clientDetailView.memberDeclined', defaultMessage: 'Declined by the business' },
  memberDeclinedWithReason: {
    id: 'clients.clientDetailView.memberDeclinedWithReason',
    defaultMessage: 'Declined by the business — {reason}',
  },
  memberInvited: {
    id: 'clients.clientDetailView.memberInvited',
    defaultMessage: 'Approved by {approver} · invite {channel} to {email}',
  },
  memberApproverFallback: { id: 'clients.clientDetailView.memberApproverFallback', defaultMessage: 'the business' },
  memberEmailFallback: { id: 'clients.clientDetailView.memberEmailFallback', defaultMessage: 'their email' },
  memberNoContact: { id: 'clients.clientDetailView.memberNoContact', defaultMessage: 'No contact on file' },
  pillWaitingClientApproval: { id: 'clients.clientDetailView.pillWaitingClientApproval', defaultMessage: 'Waiting client approval' },
  pillDeclinedByClient: { id: 'clients.clientDetailView.pillDeclinedByClient', defaultMessage: 'Declined by the client' },
  pillAwaitingMemberRegistration: {
    id: 'clients.clientDetailView.pillAwaitingMemberRegistration',
    defaultMessage: 'Awaiting registration',
  },
  pillRegistered: { id: 'clients.clientDetailView.pillRegistered', defaultMessage: 'Registered' },
  openRegistrationLink: { id: 'clients.clientDetailView.openRegistrationLink', defaultMessage: 'Open link' },
  addUser: { id: 'clients.clientDetailView.addUser', defaultMessage: 'Add user' },
  panelContacts: { id: 'clients.clientDetailView.panelContacts', defaultMessage: 'Contacts' },
  contactNoMobile: { id: 'clients.clientDetailView.contactNoMobile', defaultMessage: 'No mobile on file' },
  contactPrimaryRole: { id: 'clients.clientDetailView.contactPrimaryRole', defaultMessage: 'Primary — receives chases' },
  contactInboxName: { id: 'clients.clientDetailView.contactInboxName', defaultMessage: 'Accounts inbox' },
  contactInboxDetail: { id: 'clients.clientDetailView.contactInboxDetail', defaultMessage: 'Forwards to {email}' },
  contactInboxRole: { id: 'clients.clientDetailView.contactInboxRole', defaultMessage: 'Document owner on email intake' },
  contactsNote: {
    id: 'clients.clientDetailView.contactsNote',
    defaultMessage:
      'A contact is a verified phone number and nothing more — it receives chases and uploads through OTP links without ever being provisioned as a user. A business user, above, can sign in to the portal.',
  },

  // ── Integrations tab ────────────────────────────────────────────────────
  panelConnections: { id: 'clients.clientDetailView.panelConnections', defaultMessage: 'Connections' },
  connectionLedgerDetail: {
    id: 'clients.clientDetailView.connectionLedgerDetail',
    defaultMessage: 'Chart of accounts, tax rates and tracking categories sync both ways',
  },
  connectionBankName: { id: 'clients.clientDetailView.connectionBankName', defaultMessage: 'Bank feed (open banking)' },
  connectionBankConnected: { id: 'clients.clientDetailView.connectionBankConnected', defaultMessage: 'Re-auth due in 62 days' },
  connectionBankFallback: {
    id: 'clients.clientDetailView.connectionBankFallback',
    defaultMessage: 'Statement upload is the fallback until connected',
  },
  // The three states of a ConnectionRow pill. Own ids rather than reuse of
  // `waitingOnClient` / `ledgerTokenNone`, which happen to read the same today:
  // those label a setup task and a token row, and a translator who shortens one
  // to fit its column must not silently reword a pill on another tab.
  connectionConnected: { id: 'clients.clientDetailView.connectionConnected', defaultMessage: 'Connected' },
  connectionRequested: { id: 'clients.clientDetailView.connectionRequested', defaultMessage: 'Waiting on client' },
  connectionNotConnected: { id: 'clients.clientDetailView.connectionNotConnected', defaultMessage: 'Not connected' },
  connectionsNote: {
    id: 'clients.clientDetailView.connectionsNote',
    defaultMessage:
      'Only the client can switch these on — both need their own login at the provider, which the practice never holds. Ask for them with a setup link.',
  },
  panelSetupLink: { id: 'clients.clientDetailView.panelSetupLink', defaultMessage: 'Client setup link' },
  rowSentTo: { id: 'clients.clientDetailView.rowSentTo', defaultMessage: 'Sent to' },
  setupSentToValue: { id: 'clients.clientDetailView.setupSentToValue', defaultMessage: '{name} · {mobile}' },
  rowSent: { id: 'clients.clientDetailView.rowSent', defaultMessage: 'Sent' },
  rowExpires: { id: 'clients.clientDetailView.rowExpires', defaultMessage: 'Expires' },
  setupExpiresValue: { id: 'clients.clientDetailView.setupExpiresValue', defaultMessage: '{hours}h from sending' },
  rowResent: { id: 'clients.clientDetailView.rowResent', defaultMessage: 'Resent' },
  setupNotResent: { id: 'clients.clientDetailView.setupNotResent', defaultMessage: 'Not resent' },
  setupResentCount: { id: 'clients.clientDetailView.setupResentCount', defaultMessage: '{count}×' },
  setupTaskProfile: { id: 'clients.clientDetailView.setupTaskProfile', defaultMessage: 'Company details' },
  setupTaskDoneProfile: { id: 'clients.clientDetailView.setupTaskDoneProfile', defaultMessage: 'Registered by client' },
  setupTaskDoneConnection: { id: 'clients.clientDetailView.setupTaskDoneConnection', defaultMessage: 'Connected by client' },
  waitingOnClient: { id: 'clients.clientDetailView.waitingOnClient', defaultMessage: 'Waiting on client' },
  resendSetupDetail: {
    id: 'clients.clientDetailView.resendSetupDetail',
    defaultMessage: 'A fresh setup link replaces the one sent {sentAt}. Their previous link stops working.',
  },
  resendSetupLink: { id: 'clients.clientDetailView.resendSetupLink', defaultMessage: 'Resend link' },
  setupAllConnected: {
    id: 'clients.clientDetailView.setupAllConnected',
    defaultMessage: 'Everything the client had to connect is connected.',
  },
  setupNoLinkSent: {
    id: 'clients.clientDetailView.setupNoLinkSent',
    defaultMessage: 'No setup link has been sent. One SMS covers everything still outstanding.',
  },
  sendSetupLink: { id: 'clients.clientDetailView.sendSetupLink', defaultMessage: 'Send setup link' },
  setupNeedsMobile: {
    id: 'clients.clientDetailView.setupNeedsMobile',
    defaultMessage: 'Add a mobile number on the Settings tab first.',
  },
  rowLedgerToken: { id: 'clients.clientDetailView.rowLedgerToken', defaultMessage: 'Ledger token' },
  ledgerTokenValid: { id: 'clients.clientDetailView.ledgerTokenValid', defaultMessage: 'Valid — 284 days' },
  ledgerTokenNone: { id: 'clients.clientDetailView.ledgerTokenNone', defaultMessage: 'Not connected' },
  rowBankReauth: { id: 'clients.clientDetailView.rowBankReauth', defaultMessage: 'Bank re-auth' },
  bankReauthValue: { id: 'clients.clientDetailView.bankReauthValue', defaultMessage: '62 days' },
  rowPublishFailures: { id: 'clients.clientDetailView.rowPublishFailures', defaultMessage: 'Publish failures' },

  // ── Modals ──────────────────────────────────────────────────────────────
  chaseReviewNote: {
    id: 'clients.clientDetailView.chaseReviewNote',
    defaultMessage: 'Nothing sends until you read the review and approve it.',
  },
  chaseDone: { id: 'clients.clientDetailView.chaseDone', defaultMessage: 'Done' },
  previewNote: {
    id: 'clients.clientDetailView.previewNote',
    defaultMessage: 'Extracted data and line items · the original stays immutable',
  },
});

/**
 * Wireframe screen 7 — the client is the single home of everything
 * client-scoped, so this tab set is the whole surface. Order matches the
 * wireframe exactly: the daily pipeline work first, configuration last.
 *
 * The tuple stays untranslated on purpose: it types `Tab`, it is what the URL
 * segment round-trips through `slug`/`fromSlug`, and it is what every
 * `tab === 'Costs'` compares against. The words on the buttons are a separate
 * lookup, so translating a tab cannot break a route.
 */
const TABS = [
  'Overview', 'Costs', 'Sales', 'Bank', 'Supplier Statements', 'Expense Claims',
  'Approvals', 'Documents', 'Chases', 'Tasks', 'Integrations', 'Users', 'Settings', 'AI',
] as const;
type Tab = (typeof TABS)[number];

/** What each tab is called on screen. Descriptors, formatted at the call site. */
const TAB_LABEL: Record<Tab, MessageDescriptor> = defineMessages({
  Overview: { id: 'clients.clientDetailView.tabOverview', defaultMessage: 'Overview' },
  Costs: { id: 'clients.clientDetailView.tabCosts', defaultMessage: 'Costs' },
  Sales: { id: 'clients.clientDetailView.tabSales', defaultMessage: 'Sales' },
  Bank: { id: 'clients.clientDetailView.tabBank', defaultMessage: 'Bank' },
  'Supplier Statements': { id: 'clients.clientDetailView.tabSupplierStatements', defaultMessage: 'Supplier Statements' },
  'Expense Claims': { id: 'clients.clientDetailView.tabExpenseClaims', defaultMessage: 'Expense Claims' },
  Approvals: { id: 'clients.clientDetailView.tabApprovals', defaultMessage: 'Approvals' },
  Documents: { id: 'clients.clientDetailView.tabDocuments', defaultMessage: 'Documents' },
  Chases: { id: 'clients.clientDetailView.tabChases', defaultMessage: 'Chases' },
  Tasks: { id: 'clients.clientDetailView.tabTasks', defaultMessage: 'Tasks' },
  Integrations: { id: 'clients.clientDetailView.tabIntegrations', defaultMessage: 'Integrations' },
  Users: { id: 'clients.clientDetailView.tabUsers', defaultMessage: 'Users' },
  Settings: { id: 'clients.clientDetailView.tabSettings', defaultMessage: 'Settings' },
  AI: { id: 'clients.clientDetailView.tabAi', defaultMessage: 'AI' },
});

/**
 * What the Status column actually says. Four of the five states are a fixed
 * word, but `review` has always shown its note instead — so "Missing VAT" is
 * not a status, it is a review note. Rejected, Processing and a failed-publish
 * Ready now show theirs too, trimmed to fit a cell with the full text on hover.
 *
 * Takes `intl` rather than calling `useIntl` — it is a plain function, used for
 * the sort value as well as the cell, so it cannot hold a hook.
 */
function statusLabel(intl: IntlShape, d: Document): string {
  const note = d.statusNote?.split('—')[0]?.trim();
  if (d.status === 'review') return d.statusNote ?? intl.formatMessage(m.statusToReview);
  if (d.status === 'ready') return intl.formatMessage(d.publishFailed ? m.statusReadyPublishFailed : m.statusReady);
  if (d.status === 'rejected') {
    return note
      ? intl.formatMessage(m.statusRejectedWithNote, { note: note.toLowerCase() })
      : intl.formatMessage(m.statusRejected);
  }
  if (d.status === 'processing') return note || intl.formatMessage(m.statusProcessing);
  return intl.formatMessage(m.statusPublished);
}

/**
 * `title?: string` means absent or a string — never present-and-undefined — so
 * a document with no note has to hand the Pill no prop at all.
 */
function noteTitle(note: string | undefined): { title?: string } {
  return note === undefined ? {} : { title: note };
}

/** How each intake channel is named on the Overview's channel mix. */
const CHANNEL_LABEL: Record<Document['source'], MessageDescriptor> = defineMessages({
  email: { id: 'clients.clientDetailView.channelEmail', defaultMessage: 'Email' },
  whatsapp: { id: 'clients.clientDetailView.channelWhatsapp', defaultMessage: 'WhatsApp' },
  'sms-link': { id: 'clients.clientDetailView.channelSmsLink', defaultMessage: 'SMS chase links' },
  web: { id: 'clients.clientDetailView.channelWeb', defaultMessage: 'Web upload' },
  portal: { id: 'clients.clientDetailView.channelPortal', defaultMessage: 'Client portal' },
  chat: { id: 'clients.clientDetailView.channelChat', defaultMessage: 'Chat upload' },
  csv: { id: 'clients.clientDetailView.channelCsv', defaultMessage: 'CSV import' },
});

export function ClientDetailView() {
  const {
    clients, openClientId, openClient, statsFor, documents, missing,
    approvals, chases, startConversation, retryDocument,
    starredClientIds, toggleStarClient,
    onboardingLinks, sendOnboardingLink, resendOnboardingLink,
    accounts, reauthAccount,
    tasks, setTaskStatus, auditLog, settings, conversations, selectConversation, setActiveTab,
    approvalWorkflows, saveWorkflow, deleteWorkflow,
    businessAccounts, inviteBusinessUser, openRegistrationLink, colleagues, addTask,
    advanceApproval, rejectApproval,
    clientSideApprovals, approvalRequests, sendApprovalRequest, resendApprovalRequest, openApprovalLink,
    chasePolicy, clientDetailChanges, proposeClientDetailChanges,
  } = useAppContext();

  // /clients/:id/:tab — the tab is in the address, so every one is linkable
  // and Back steps between them.
  const [tabSlug, setTabSlug] = useSegment(2);
  const tab: Tab = fromSlug(tabSlug, TABS) ?? 'Overview';
  const setTab = (next: Tab) => setTabSlug(next === 'Overview' ? null : slug(next));

  // ?doc=<id> — a preview is a layer over wherever you already were, so it
  // gets a link without the path having to know about it.
  const [previewId, setPreviewId] = useQueryParam('doc');
  const preview = previewId ? documents.find((d) => d.id === previewId) ?? null : null;
  const setPreview = (doc: Document | null) => setPreviewId(doc ? doc.id : null);
  const [editingWorkflow, setEditingWorkflow] = useState<ApprovalWorkflow | null>(null);
  const [inviting, setInviting] = useState(false);
  const [addingTask, setAddingTask] = useState(false);
  const [chasing, setChasing] = useState<string[] | null>(null);
  const confirm = useConfirm();
  const intl = useIntl();
  const client = clients.find((c) => c.id === openClientId);

  /**
   * Wireframe screen 7, "Channel mix (how docs arrive)" — a real share of this
   * client's own documents, not the practice-wide figure the Analytics view
   * shows. Sorted heaviest first so the dominant channel reads immediately.
   *
   * Both memos sit above the `!client` return: a hook after a conditional
   * return changes the hook count between renders, which is the exact shape
   * behind "Rendered fewer hooks than expected" (#87).
   */
  const channelMix = useMemo(() => {
    const clientDocs = documents.filter((d) => d.clientId === openClientId);
    const counts = new Map<Document['source'], number>();
    clientDocs.forEach((d) => counts.set(d.source, (counts.get(d.source) ?? 0) + 1));
    const total = clientDocs.length;
    return [...counts.entries()]
      .map(([source, count]) => ({
        source,
        count,
        pct: total === 0 ? 0 : Math.round((count / total) * 100),
      }))
      .sort((a, b) => b.count - a.count);
  }, [documents, openClientId]);

  /**
   * Wireframe's "Recent activity" feed. Built from things that actually
   * happened rather than a seeded list: entries this user approved through a
   * Review gate, plus the chase timeline. Newest first.
   */
  const activity = useMemo(() => {
    if (!client) return [];
    const clientChase = chases.find((c) => c.clientId === client.id);
    const fromAudit = auditLog
      .filter((e) => e.scope.toLowerCase().includes(client.name.toLowerCase()))
      .map((e) => ({ id: e.id, at: e.at, label: e.action, detail: e.scope, actor: e.actor }));
    const fromChase = (clientChase?.events ?? []).map((e, i) => ({
      id: `chase-ev-${i}`,
      at: e.at,
      label: e.label,
      detail: e.detail,
      actor: intl.formatMessage(m.activityChaseEngine),
    }));
    return [...fromAudit, ...fromChase].slice(0, 8);
  }, [auditLog, chases, client, intl]);

  if (!client) return null;

  const s = statsFor(client.id);
  const docs = documents.filter((d) => d.clientId === client.id);
  const miss = missing.filter((m) => m.clientId === client.id);
  const clientApprovals = approvals.filter((a) => a.clientName === client.name);
  /** Live workflows this client's items are actually running through. */
  const clientWorkflows = approvalWorkflows.filter(
    (w) => w.active && clientApprovals.some((a) => a.workflowId === w.id),
  );
  const chase = chases.find((c) => c.clientId === client.id);
  const setupLink = onboardingLinks.find((l) => l.clientId === client.id);
  // What the client still owes. `profile` only appears on invite-path records,
  // where the client registers the company rather than the practice keying it
  // in; the other two the practice cannot do at all.
  const pendingTasks: SetupTask[] = [
    ...(client.awaitingRegistration ? (['profile'] as SetupTask[]) : []),
    ...(client.xeroConnected ? [] : (['ledger'] as SetupTask[])),
    ...(client.bankConnected ? [] : (['bank'] as SetupTask[])),
  ];

  const clientAccounts = accounts.filter((a) => a.clientId === client.id);
  const clientTasks = tasks.filter((t) => t.clientId === client.id);
  const pendingChanges = clientDetailChanges.filter((c) => c.clientId === client.id && c.status === 'pending');
  const clientSideItems = clientSideApprovals(client.id);
  const approvalRequest = approvalRequests.find((r) => r.clientId === client.id);
  /**
   * Hours still to wait before the link can be sent again. Resending while the
   * first one is live is a second text saying the same thing, which is how a
   * chase turns into nagging — so the wait is a policy, not a habit.
   */
  const resendIn = approvalRequest
    ? Math.max(0, Math.ceil(chasePolicy.resendAfterHours - (Date.now() - approvalRequest.sentAtMs) / 3_600_000))
    : 0;
  const businessAccount = businessAccounts.find((a) => a.clientId === client.id);
  const businessMembers = businessAccount?.members ?? [];
  const clientConversations = conversations.filter(
    (c) => c.attachedClientIds.includes(client.id) && c.messages.length > 0,
  );

  const scoped = (intent: Intent, content: string, response: string) =>
    startConversation([client.id], [
      { id: `${Date.now()}-u`, role: 'user', content },
      { id: `${Date.now()}-a`, role: 'assistant', content: response, intent, payload: { clientIds: [client.id], clientNames: [client.name] } },
    ]);

  /**
   * Chases a specific set of items, in a composer on this page.
   *
   * Deliberately not the chat: asking the agent to chase and doing it yourself
   * are two ways of working, and someone who has already picked the rows has
   * made the decision the chat would be there to help with. Being thrown into
   * a conversation at that point loses their place on the page.
   */
  const chaseItems = (items: MissingItem[]) => {
    const outstanding = items.filter((m) => !m.chased);
    const target = outstanding.length ? outstanding : items;
    setChasing(target.map((m) => m.id));
  };

  /** The header button and the Missing tile — everything outstanding. */
  const chaseClient = () => setChasing(miss.filter((m) => !m.chased).map((m) => m.id));

  const docColumns: Column<Document>[] = [
    { key: 'supplier', label: intl.formatMessage(commonLabels.supplier), sortValue: (d) => d.supplier, render: (d) => <span className="text-white font-semibold">{d.supplier}</span> },
    { key: 'date', label: intl.formatMessage(commonLabels.date), sortValue: (d) => d.date },
    { key: 'category', label: intl.formatMessage(commonLabels.category), sortValue: (d) => d.category },
    { key: 'source', label: intl.formatMessage(m.colChannel), sortValue: (d) => d.source, render: (d) => <Pill>{d.source}</Pill> },
    { key: 'total', label: intl.formatMessage(commonLabels.total), align: 'right', sortValue: (d) => d.total, render: (d) => <span className="text-white font-bold tabular-nums">{currency(d.total)}</span> },
    {
      key: 'status', label: intl.formatMessage(commonLabels.status),
      // Sorted by the label on screen, not the raw status — "Missing VAT" and
      // "Suspected duplicate" both being `review` made the column look
      // unsorted to anyone reading it.
      sortValue: (d) => statusLabel(intl, d),
      render: (d) => {
        const label = statusLabel(intl, d);
        if (d.status === 'ready') {
          // Green Ready vs yellow Ready: a previous publish having failed is
          // the whole difference, and it was invisible in this table.
          return d.publishFailed
            ? <Pill tone="amber" {...noteTitle(d.statusNote)}>{label}</Pill>
            : <Pill tone="green">{intl.formatMessage(m.statusReady)}</Pill>;
        }
        if (d.status === 'review') return <Pill tone="amber">{label}</Pill>;
        // Rejected and Processing carry their reason too — a bare "Rejected"
        // hides the one thing that says what to do about it.
        if (d.status === 'rejected') return <Pill tone="red" {...noteTitle(d.statusNote)}>{label}</Pill>;
        if (d.status === 'published') return <Pill tone="blue">{intl.formatMessage(m.statusPublished)}</Pill>;
        return <Pill {...noteTitle(d.statusNote)}>{label}</Pill>;
      },
    },
  ];

  return (
    <div className="flex-1 flex flex-col min-w-0 bg-ground h-full overflow-hidden">
      <header className="px-10 pt-8 pb-5 shrink-0">
        <button
          onClick={() => openClient(null)}
          className="flex items-center gap-2 text-[13px] font-bold text-zinc-500 hover:text-white transition-colors mb-5"
        >
          <ArrowLeft size={15} />
          {intl.formatMessage(m.backToClients)}
        </button>

        <div className="flex items-start justify-between gap-6 flex-wrap">
          <div className="flex items-center gap-5 min-w-0">
            <div className="w-16 h-16 rounded-3xl bg-raised flex items-center justify-center font-sans text-3xl font-bold text-white border border-white/5 shadow-inner shrink-0 overflow-hidden">
              {client.logoDataUrl ? (
                <img src={client.logoDataUrl} alt="" className="w-full h-full object-cover" />
              ) : (
                client.name.charAt(0)
              )}
            </div>
            <div className="min-w-0">
              <div className="flex items-center gap-3">
                <h1 className="font-sans text-3xl font-semibold text-white tracking-tight truncate">{client.name}</h1>
                <button
                  onClick={() => toggleStarClient(client.id)}
                  className={starredClientIds.includes(client.id) ? 'text-brand' : 'text-zinc-700 hover:text-zinc-400'}
                >
                  <Star size={18} fill={starredClientIds.includes(client.id) ? 'currentColor' : 'none'} />
                </button>
              </div>
              <div className="flex items-center gap-3 mt-2 flex-wrap">
                <Pill>{client.industry}</Pill>
                {client.companyType && <Pill>{client.companyType}</Pill>}
                {client.awaitingRegistration && <Pill tone="amber">{intl.formatMessage(m.pillAwaitingRegistration)}</Pill>}
                <Pill tone={healthTone(s.health)}>{intl.formatMessage(m.pillPipelineHealth, { health: s.health })}</Pill>
                {client.xeroConnected
                  ? <Pill tone="blue">{intl.formatMessage(m.pillXero)}</Pill>
                  : <Pill tone="red">{intl.formatMessage(m.pillNoLedger)}</Pill>}
                {client.bankConnected
                  ? <Pill tone="green">{intl.formatMessage(m.pillBankFeedLive)}</Pill>
                  : <Pill tone="amber">{intl.formatMessage(m.pillStatementFallback)}</Pill>}
                {setupLink && setupLink.completed.length < setupLink.tasks.length && (
                  <Pill tone="amber">{intl.formatMessage(m.pillSetupLinkSent)}</Pill>
                )}
              </div>
            </div>
          </div>

          <div className="flex items-center gap-3">
            <button
              onClick={() => startConversation([client.id])}
              className="flex items-center gap-2 px-5 py-2.5 bg-brand/10 text-brand border border-brand/20 text-sm font-bold rounded-full hover:bg-brand/20 transition-all"
            >
              <Sparkles size={16} />
              {intl.formatMessage(m.askAi)}
            </button>
            <button
              disabled={s.missing === 0}
              onClick={chaseClient}
              className="flex items-center gap-2 px-6 py-2.5 bg-brand text-white text-sm font-bold rounded-full hover:bg-brand-hover transition-all shadow-glow-btn-soft disabled:opacity-40"
            >
              <Send size={16} />
              {s.missing > 0
                ? intl.formatMessage(m.chaseActionCount, { count: s.missing })
                : intl.formatMessage(m.chaseAction)}
            </button>
          </div>
        </div>
      </header>

      <div className="px-10 pb-5 flex items-center gap-2 shrink-0 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {TABS.map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`px-4 py-2 rounded-full text-[13px] font-bold transition-all border whitespace-nowrap ${
              tab === t
                ? 'bg-brand text-white border-brand shadow-glow-pill'
                : 'bg-card text-zinc-400 border-white/5 hover:text-white hover:border-white/15'
            }`}
          >
            {intl.formatMessage(TAB_LABEL[t])}
          </button>
        ))}
      </div>

      <div className="flex-1 overflow-y-auto px-10 pb-10 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        <motion.div key={tab} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }}>
          {tab === 'Overview' && (
            <div className="flex flex-col gap-6">
              {/* Wireframe's pipeline snapshot — the same seven figures, in the
                  same order, each one drilling to the tab that can act on it. */}
              <div className="grid grid-cols-2 md:grid-cols-4 xl:grid-cols-7 gap-4">
                <Tile label={intl.formatMessage(m.tileInProcessing)} value={s.processing} hint={intl.formatMessage(m.tileInProcessingHint)} onClick={() => setTab('Costs')} />
                <Tile label={intl.formatMessage(m.tileToReview)} value={s.toReview} onClick={() => setTab('Costs')} />
                <Tile label={intl.formatMessage(m.tileReady)} value={s.ready} onClick={() => setTab('Costs')} />
                <Tile label={intl.formatMessage(m.tileRejected)} value={s.rejected} tone="red" onClick={() => setTab('Costs')} />
                <Tile
                  label={intl.formatMessage(m.tileMissingDocs)}
                  value={s.missing}
                  tone="red"
                  onClick={() => setTab('Chases')}
                  {...(s.missing > 0
                    ? { action: { label: intl.formatMessage(m.chaseAction), onClick: () => chaseClient() } }
                    : {})}
                />
                <Tile label={intl.formatMessage(m.tileUnmatched)} value={s.unmatched} tone="red" onClick={() => setTab('Bank')} />
                <Tile label={intl.formatMessage(m.tileAwaitingApproval)} value={s.approvals} onClick={() => setTab('Approvals')} />
              </div>

              <div className="grid grid-cols-1 lg:grid-cols-2 xl:grid-cols-3 gap-6">
                <Panel title={intl.formatMessage(m.panelChannelMix)} icon={Radio}>
                  <p className="text-[12px] text-zinc-500 mb-4 leading-relaxed">
                    {intl.formatMessage(m.channelMixIntro, {
                      email: settings.docEmail,
                      highlight: (chunks: React.ReactNode[]) => (
                        <span className="text-zinc-300 font-semibold">{chunks}</span>
                      ),
                    })}
                  </p>
                  {channelMix.length === 0 ? (
                    <p className="text-[13px] text-zinc-500">{intl.formatMessage(m.channelMixEmpty)}</p>
                  ) : (
                    <div className="flex flex-col gap-3">
                      {channelMix.map((c) => (
                        <div key={c.source}>
                          <div className="flex justify-between items-baseline gap-3 mb-1.5">
                            <span className="text-[13px] text-zinc-300 font-semibold">{intl.formatMessage(CHANNEL_LABEL[c.source])}</span>
                            <span className="text-[13px] text-white font-bold tabular-nums">{intl.formatMessage(m.channelSharePct, { pct: c.pct })}</span>
                          </div>
                          <div className="h-1.5 w-full bg-raised rounded-full overflow-hidden shadow-inner">
                            <div className="h-full rounded-full bg-brand" style={{ width: `${c.pct}%` }} />
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </Panel>

                {/* Wireframe puts integration health on Overview, not buried on
                    the Integrations tab — a dead token stops the pipeline. */}
                <Panel title={intl.formatMessage(m.panelIntegrationHealth)} icon={Landmark}>
                  <div className="flex flex-col gap-3">
                    <div className="flex items-center justify-between gap-3 p-3.5 rounded-2xl bg-ground/60 border border-white/5">
                      <div className="min-w-0">
                        <div className="text-[13px] font-bold text-white">{intl.formatMessage(m.accountingSoftware)}</div>
                        <div className="text-[12px] text-zinc-500">
                          {intl.formatMessage(client.xeroConnected ? m.ledgerTokenValidLong : m.ledgerNotConnected)}
                        </div>
                      </div>
                      {client.xeroConnected
                        ? <Pill tone="green">{intl.formatMessage(m.pillLive)}</Pill>
                        : <Pill tone="red">{intl.formatMessage(m.pillOff)}</Pill>}
                    </div>

                    {clientAccounts.length === 0 ? (
                      <div className="p-3.5 rounded-2xl bg-ground/60 border border-white/5">
                        <div className="text-[13px] font-bold text-white">{intl.formatMessage(m.bankFeed)}</div>
                        <div className="text-[12px] text-zinc-500">{intl.formatMessage(m.bankFeedNoAccount)}</div>
                      </div>
                    ) : (
                      clientAccounts.map((a) => (
                        <div key={a.id} className="flex items-center justify-between gap-3 p-3.5 rounded-2xl bg-ground/60 border border-white/5">
                          <div className="min-w-0">
                            <div className="text-[13px] font-bold text-white truncate">
                              {intl.formatMessage(m.bankAccountName, { bank: a.bankName, last4: a.last4 })}
                            </div>
                            <div className="text-[12px] text-zinc-500">
                              {a.status === 'live'
                                ? intl.formatMessage(m.bankAccountLive, { days: a.reauthDays, sync: a.lastSync })
                                : a.status === 'error'
                                ? intl.formatMessage(m.bankAccountError)
                                : intl.formatMessage(m.bankAccountDisconnected)}
                            </div>
                          </div>
                          {/* Open banking consent expires every 90 days; this is
                              the one integration action the practice can take. */}
                          {a.status === 'live' && a.reauthDays > 14 ? (
                            <Pill tone="green">{intl.formatMessage(m.pillLive)}</Pill>
                          ) : (
                            <button
                              onClick={() => reauthAccount(a.id)}
                              className="shrink-0 flex items-center gap-1.5 px-3.5 py-1.5 rounded-full text-[12px] font-bold text-white bg-brand hover:bg-brand-hover transition-colors"
                            >
                              <RefreshCw size={13} strokeWidth={2.5} />
                              {intl.formatMessage(m.reauthNow)}
                            </button>
                          )}
                        </div>
                      ))
                    )}
                  </div>
                </Panel>

                <Panel title={intl.formatMessage(m.panelRecentActivity)} icon={History}>
                  {activity.length === 0 ? (
                    <p className="text-[13px] text-zinc-500 leading-relaxed">
                      {intl.formatMessage(m.activityEmpty)}
                    </p>
                  ) : (
                    <div className="flex flex-col gap-3">
                      {activity.map((e) => (
                        <div key={e.id} className="flex gap-3">
                          <div className="w-1.5 h-1.5 rounded-full bg-brand mt-2 shrink-0" />
                          <div className="min-w-0">
                            <div className="text-[13px] text-white font-semibold leading-snug">{e.label}</div>
                            <div className="text-[12px] text-zinc-500 leading-snug">{e.detail}</div>
                            <div className="text-[11px] text-zinc-600 font-semibold uppercase tracking-wider mt-0.5">
                              {intl.formatMessage(m.activityMeta, { actor: e.actor, at: e.at })}
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </Panel>
              </div>

              <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                <Panel title={intl.formatMessage(m.panelPipelineHealth)} icon={Activity}>
                  <div className="flex items-end justify-between mb-3">
                    <span className="text-4xl font-bold text-white tracking-tight tabular-nums">{intl.formatMessage(m.pipelineHealthPct, { health: s.health })}</span>
                    <span className="text-[12px] text-zinc-500 font-semibold">{intl.formatMessage(m.pipelineHealthCaveat)}</span>
                  </div>
                  <div className="h-2 w-full bg-raised rounded-full overflow-hidden shadow-inner mb-5">
                    <div
                      className={`h-full rounded-full ${s.health > 80 ? 'bg-brand' : s.health > 50 ? 'bg-amber-400' : 'bg-red-500'}`}
                      style={{ width: `${s.health}%` }}
                    />
                  </div>
                  <div className="flex flex-col gap-2.5 text-[13px]">
                    <Row label={intl.formatMessage(m.rowUnverifiedSpend)} value={currency(s.unverified)} />
                    <Row label={intl.formatMessage(m.rowItemDelay)} value={intl.formatMessage(m.itemDelayValue, { days: s.itemDelay })} />
                    <Row label={intl.formatMessage(m.rowAutoPublish)} value={intl.formatMessage(m.autoPublishValue, { pct: s.autoPublishCoverage })} />
                    <Row label={intl.formatMessage(m.rowDuplicates)} value={String(s.duplicates)} />
                    <Row label={intl.formatMessage(m.rowOverdueChases)} value={String(s.overdue)} />
                    <Row label={intl.formatMessage(m.rowUnexplained)} value={String(s.unmatched)} />
                    <Row label={intl.formatMessage(m.rowStatementGaps)} value={String(s.statementGaps)} />
                    <Row label={intl.formatMessage(m.rowRejected)} value={String(s.rejected)} />
                  </div>
                </Panel>

                <Panel title={intl.formatMessage(m.panelClientContact)} icon={Users}>
                  <div className="flex flex-col gap-2.5 text-[13px]">
                    <Row label={intl.formatMessage(m.rowPrimaryContact)} value={client.contactName ?? '—'} />
                    <Row label={intl.formatMessage(commonLabels.mobile)} value={client.mobile ?? '—'} />
                    <Row label={intl.formatMessage(commonLabels.vatNumber)} value={client.vatNumber ?? '—'} />
                    <Row label={intl.formatMessage(commonLabels.nextDeadline)} value={client.deadline} />
                    <Row label={intl.formatMessage(m.rowChasePolicy)} value={chase?.policy ?? intl.formatMessage(m.chasePolicyDefault)} />
                    <Row label={intl.formatMessage(m.rowLastUpload)} value={chase?.lastUpload ?? '—'} />
                  </div>
                  <p className="text-[12px] text-zinc-500 mt-5 leading-relaxed">
                    {intl.formatMessage(m.clientContactNote)}
                  </p>
                </Panel>
              </div>
            </div>
          )}

          {/* Wireframe screen 8. Both inboxes are the same component over
              opposite sides of the ledger. */}
          {(tab === 'Costs' || tab === 'Sales') && (
            <ClientInbox client={client} kind={tab === 'Costs' ? 'cost' : 'sales'} onPreview={setPreview} />
          )}

          {/* Wireframe: "[AI] tab = same chat as screen 3, pre-scoped to this
              client." The chat is the full workspace, so this tab is the way
              in and the record of what has already been asked. */}
          {tab === 'AI' && (
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
              <Panel title={intl.formatMessage(m.panelAskAboutClient)} icon={Bot}>
                <p className="text-[13px] text-zinc-500 leading-relaxed mb-5">
                  {intl.formatMessage(m.askIntro, { client: client.name })}
                </p>
                <div className="flex flex-col gap-2 mb-5">
                  {([
                    { q: intl.formatMessage(m.promptMissing, { client: client.name }), intent: 'SHOW_MISSING' },
                    { q: intl.formatMessage(m.promptMatches, { client: client.name }), intent: 'SHOW_MATCHES' },
                    { q: intl.formatMessage(m.promptApprovals), intent: 'SHOW_APPROVALS' },
                  ] satisfies { q: string; intent: Intent }[]).map((p) => (
                    <button
                      key={p.q}
                      onClick={() => scoped(p.intent, p.q, intl.formatMessage(m.promptReply))}
                      className="text-left px-4 py-3 rounded-2xl bg-ground/60 border border-white/5 text-[13px] text-zinc-300 hover:text-white hover:border-white/15 transition-colors"
                    >
                      {p.q}
                    </button>
                  ))}
                </div>
                <button
                  onClick={() => startConversation([client.id])}
                  className="flex items-center gap-2 px-5 py-2.5 rounded-full text-[13px] font-bold text-white bg-brand hover:bg-brand-hover transition-colors shadow-glow-btn"
                >
                  <Sparkles size={15} />
                  {intl.formatMessage(m.newConversation)}
                </button>
              </Panel>

              <Panel title={intl.formatMessage(m.panelConversations)} icon={History}>
                {clientConversations.length === 0 ? (
                  <p className="text-[13px] text-zinc-500 leading-relaxed">
                    {intl.formatMessage(m.conversationsEmpty, { client: client.name })}
                  </p>
                ) : (
                  <div className="flex flex-col gap-2">
                    {clientConversations.map((c) => (
                      <button
                        key={c.id}
                        onClick={() => {
                          selectConversation(c.id);
                          setActiveTab('AI Workspace');
                          openClient(null);
                        }}
                        className="text-left p-4 rounded-2xl bg-ground/60 border border-white/5 hover:border-white/15 transition-colors"
                      >
                        <div className="text-[13px] font-bold text-white truncate">{c.title}</div>
                        <div className="text-[12px] text-zinc-500 mt-0.5">
                          {c.attachedClientIds.length > 1
                            ? intl.formatMessage(m.conversationMetaWithClients, {
                                count: c.messages.length,
                                clients: c.attachedClientIds.length,
                              })
                            : intl.formatMessage(m.conversationMeta, { count: c.messages.length })}
                        </div>
                      </button>
                    ))}
                  </div>
                )}
              </Panel>
            </div>
          )}

          {/* Wireframe screen 10, Statements sub-tab: uploaded statements plus
              gap detection, where a gap is chaseable in one step. */}
          {/* Supplier statements — the supplier's own list of what they
              invoiced, reconciled against what we hold. Bank statements are a
              different thing and live on the Bank tab. */}
          {tab === 'Supplier Statements' && <ClientSupplierStatements client={client} />}

          {tab === 'Expense Claims' && <ClientExpenseClaims client={client} onPreview={setPreview} />}

          {/* The whole bank surface, pinned to this client. There is no
              practice-wide Bank any more — bank data is always one client's,
              so matching, cash coding, match rules, statement upload and gap
              detection all live here. */}
          {tab === 'Bank' && <BankView clientId={client.id} />}

          {tab === 'Chases' && (
            <DataTable<MissingItem>
              className="max-w-none"
              columns={[
                { key: 'supplier', label: intl.formatMessage(commonLabels.supplier), sortValue: (row) => row.supplier, render: (row) => <span className="text-white font-semibold">{row.supplier}</span> },
                { key: 'date', label: intl.formatMessage(commonLabels.date), sortValue: (row) => row.date },
                { key: 'detectedBy', label: intl.formatMessage(m.colDetectedBy), sortValue: (row) => row.detectedBy, render: (row) => <Pill>{row.detectedBy}</Pill> },
                { key: 'chased', label: intl.formatMessage(commonLabels.status), sortValue: (row) => String(row.chased), render: (row) => (row.chased ? <Pill tone="blue">{intl.formatMessage(m.pillRequested)}</Pill> : <Pill tone="red">{intl.formatMessage(m.pillNotChased)}</Pill>) },
                { key: 'amount', label: intl.formatMessage(commonLabels.amount), align: 'right', sortValue: (row) => row.amount, render: (row) => <span className="text-white font-bold tabular-nums">{row.amount ? currency(row.amount) : '—'}</span> },
                {
                  // The verb on the row, so one item can be chased without
                  // ticking it first. Already-requested items say so and offer
                  // the nudge instead, since asking twice is a different act.
                  key: 'actions', label: '', align: 'right',
                  render: (row) => (
                    <button
                      onClick={(e) => { e.stopPropagation(); chaseItems([row]); }}
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[12px] font-bold text-brand bg-brand/10 border border-brand/25 hover:bg-brand/20 transition-colors whitespace-nowrap"
                    >
                      <Send size={12} strokeWidth={2.5} />
                      {intl.formatMessage(row.chased ? m.chaseAgain : m.chaseAction)}
                    </button>
                  ),
                },
              ]}
              rows={miss}
              rowId={(row) => row.id}
              selectable
              actionsOnTop
              emptyMessage={intl.formatMessage(m.chasesEmpty)}
              bulkActions={[
                {
                  label: intl.formatMessage(m.chaseSelected), icon: Send, primary: true,
                  onClick: (sel) => chaseItems(sel),
                },
              ]}
              footer={intl.formatMessage(m.chasesFooter, { missing: s.missing, requested: s.requested, overdue: s.overdue })}
            />
          )}

          {tab === 'Tasks' && (
            <Panel title={intl.formatMessage(m.panelTasks)} icon={ListChecks}>
              <div className="flex items-start justify-between gap-4 mb-5 flex-wrap">
                <p className="text-[13px] text-zinc-500 leading-relaxed max-w-xl">
                  {intl.formatMessage(m.tasksIntro, { client: client.name })}
                </p>
                <button
                  onClick={() => setAddingTask(true)}
                  className="shrink-0 flex items-center gap-2 px-5 py-2.5 rounded-full text-[13px] font-bold text-white bg-brand hover:bg-brand-hover transition-colors shadow-glow-btn"
                >
                  <Plus size={15} strokeWidth={2.5} />
                  {intl.formatMessage(m.addTask)}
                </button>
              </div>
              {clientTasks.length === 0 ? (
                <p className="text-[13px] text-zinc-500">{intl.formatMessage(m.tasksEmpty)}</p>
              ) : (
                <div className="flex flex-col gap-2">
                  {clientTasks.map((t) => {
                    const blocker = t.dependsOn ? clientTasks.find((x) => x.id === t.dependsOn) : undefined;
                    const blocked = !!blocker && blocker.status === 'open';
                    const open = t.status === 'open';
                    return (
                      <div key={t.id} className="flex items-center gap-3 p-4 rounded-2xl bg-ground/60 border border-white/5">
                        <button
                          onClick={() => setTaskStatus(t.id, open ? 'complete' : 'open')}
                          disabled={blocked && open}
                          title={
                            blocked && open
                              ? intl.formatMessage(m.taskWaitingOn, { title: blocker?.title })
                              : intl.formatMessage(open ? m.taskMarkComplete : m.taskReopen)
                          }
                          className={`shrink-0 transition-colors ${
                            !open ? 'text-brand' : blocked ? 'text-zinc-700 cursor-not-allowed' : 'text-zinc-600 hover:text-white'
                          }`}
                        >
                          {open ? <Circle size={18} /> : <CheckCircle size={18} />}
                        </button>
                        <div className="min-w-0 flex-1">
                          <div className={`text-[13px] font-bold ${open ? 'text-white' : 'text-zinc-500 line-through'}`}>
                            {t.title}
                          </div>
                          <div className="text-[12px] text-zinc-500">
                            {blocked && open
                              ? intl.formatMessage(m.taskMetaBlocked, { assignee: t.assignee, due: t.due, title: blocker?.title })
                              : intl.formatMessage(m.taskMeta, { assignee: t.assignee, due: t.due })}
                          </div>
                        </div>
                        {t.aiPrefilled && open && <Pill tone="blue">{intl.formatMessage(m.pillAiPrefilled)}</Pill>}
                        {t.status === 'complete' && <Pill tone="green">{intl.formatMessage(m.pillComplete)}</Pill>}
                        {t.status === 'complete-with-issues' && <Pill tone="amber">{intl.formatMessage(m.pillWithIssues)}</Pill>}
                        {t.status === 'not-applicable' && <Pill>{intl.formatMessage(m.pillNotApplicable)}</Pill>}
                      </div>
                    );
                  })}
                </div>
              )}
            </Panel>
          )}

          {tab === 'Approvals' && (
            <div className="flex flex-col gap-6">
              {/* Items on a client-side stage. Nobody in the practice can clear
                  these — the only move is getting the SMS link to the approver
                  and, if they go quiet, chasing it. */}
              {clientSideItems.length > 0 && (
                <div className="border border-brand/20 rounded-[28px] bg-brand/[0.05] p-5 flex items-center justify-between gap-4 flex-wrap">
                  <div className="min-w-0">
                    <div className="text-[14px] font-bold text-white">
                      {intl.formatMessage(m.clientSideHeading, { count: clientSideItems.length, client: client.name })}
                    </div>
                    <p className="text-[12px] text-zinc-400 mt-1 leading-relaxed">
                      {(() => {
                        const items = clientSideItems
                          .map((a) => intl.formatMessage(m.itemSummary, { supplier: a.supplier, amount: currency(a.total) }))
                          .join(' · ');
                        if (!approvalRequest) return intl.formatMessage(m.clientSideNoLink, { items });
                        return intl.formatMessage(
                          approvalRequest.verified ? m.clientSideLinkOpened : m.clientSideLinkUnopened,
                          { items, sentAt: approvalRequest.sentAt, mobile: approvalRequest.recipientMobile },
                        );
                      })()}
                    </p>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    {approvalRequest && (
                      <button
                        onClick={async () => {
                          const ok = await confirm({
                            title: intl.formatMessage(m.resendTitle, { name: approvalRequest.recipientName }),
                            detail: intl.formatMessage(m.resendApprovalDetail, { sentAt: approvalRequest.sentAt }),
                            confirmLabel: intl.formatMessage(m.resendConfirmLabel),
                          });
                          if (ok) resendApprovalRequest(approvalRequest.id);
                        }}
                        disabled={resendIn > 0}
                        title={
                          resendIn > 0
                            ? intl.formatMessage(m.resendLockedHint, { sentAt: approvalRequest.sentAt, hours: resendIn })
                            : intl.formatMessage(m.resendReadyHint)
                        }
                        className="px-4 py-2 rounded-full text-[12px] font-bold text-zinc-400 border border-white/10 hover:text-white hover:border-white/25 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                      >
                        {resendIn > 0 ? intl.formatMessage(m.resendLocked, { hours: resendIn }) : intl.formatMessage(m.resend)}
                      </button>
                    )}
                    {/* Two acts, two buttons. Sending texts the approver;
                        opening steps into their view to see what they see.
                        Bundling them meant you could not do one without the
                        other. */}
                    {!approvalRequest && (
                      <button
                        onClick={async () => {
                          const ok = await confirm({
                            // Two whole messages rather than a name with an
                            // inline fallback: `undefined` is the only case the
                            // `??` covered, and each sentence translates alone.
                            title: client.contactName === undefined
                              ? intl.formatMessage(m.sendRequestTitleUnnamed)
                              : intl.formatMessage(m.sendRequestTitle, { name: client.contactName }),
                            detail: intl.formatMessage(m.sendRequestDetail, {
                              count: clientSideItems.length,
                              amount: currency(clientSideItems.reduce((n, a) => n + a.total, 0)),
                              mobile: client.mobile,
                            }),
                            consequence: intl.formatMessage(m.sendRequestConsequence),
                            confirmLabel: intl.formatMessage(m.sendRequestConfirmLabel),
                          });
                          if (ok) sendApprovalRequest(client.id);
                        }}
                        disabled={!client.mobile}
                        title={client.mobile ? undefined : intl.formatMessage(m.sendRequestNoMobile)}
                        className="flex items-center gap-2 px-5 py-2 rounded-full text-[12px] font-bold text-white bg-brand hover:bg-brand-hover disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                      >
                        <Send size={13} strokeWidth={2.5} />
                        {intl.formatMessage(m.sendRequest)}
                      </button>
                    )}
                    <button
                      onClick={() => openApprovalLink(approvalRequest?.id ?? `appr-req-${client.id}-0`)}
                      disabled={!approvalRequest}
                      title={intl.formatMessage(approvalRequest ? m.openLinkHint : m.openLinkDisabledHint)}
                      className="flex items-center gap-2 px-5 py-2 rounded-full text-[12px] font-bold text-brand bg-brand/10 border border-brand/25 hover:bg-brand/20 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                    >
                      <Smartphone size={13} strokeWidth={2.5} />
                      {intl.formatMessage(m.openLink)}
                    </button>
                  </div>
                </div>
              )}

              <DataTable
                className="max-w-none"
                title={intl.formatMessage(m.approvalsTableTitle)}
                subtitle={intl.formatMessage(m.approvalsTableSubtitle)}
                columns={[
                  { key: 'supplier', label: intl.formatMessage(commonLabels.supplier), sortValue: (a) => a.supplier, render: (a) => <span className="text-white font-semibold">{a.supplier}</span> },
                  { key: 'stage', label: intl.formatMessage(m.colStage), sortValue: (a) => a.stage },
                  { key: 'approver', label: intl.formatMessage(m.colApprover), sortValue: (a) => a.approver },
                  {
                    key: 'side', label: intl.formatMessage(m.colSignedOffBy),
                    render: (a) =>
                      approvalWorkflows.find((w) => w.id === a.workflowId)?.stages[a.stageIndex]?.clientSide
                        ? <Pill tone="amber">{intl.formatMessage(m.pillClientBySms)}</Pill>
                        : <Pill tone="blue">{intl.formatMessage(m.pillPractice)}</Pill>,
                  },
                  { key: 'waitingDays', label: intl.formatMessage(m.colWaiting), align: 'right', sortValue: (a) => a.waitingDays, render: (a) => (a.waitingDays >= 5 ? <Pill tone="red">{intl.formatMessage(m.waitingDays, { days: a.waitingDays })}</Pill> : <Pill>{intl.formatMessage(m.waitingDays, { days: a.waitingDays })}</Pill>) },
                  { key: 'total', label: intl.formatMessage(commonLabels.total), align: 'right', sortValue: (a) => a.total, render: (a) => <span className="text-white font-bold tabular-nums">{currency(a.total)}</span> },
                  {
                    // Every action the row allows, on the row. Edit appears
                    // only where the stage permits it, and neither Approve nor
                    // Reject is offered on a stage that has left the practice.
                    key: 'actions', label: '', align: 'right',
                    render: (a) => {
                      const stage = approvalWorkflows.find((w) => w.id === a.workflowId)?.stages[a.stageIndex];
                      if (a.state !== 'pending') {
                        return a.state === 'approved'
                          ? <Pill tone="green">{intl.formatMessage(m.pillApproved)}</Pill>
                          : <Pill tone="red">{intl.formatMessage(m.pillRejected)}</Pill>;
                      }
                      if (stage?.clientSide) return <Pill tone="amber">{intl.formatMessage(m.pillWithTheClient)}</Pill>;
                      return (
                        <span className="flex items-center justify-end gap-1.5">
                          {stage?.canEdit && a.documentId && (
                            <ApprovalAction
                              icon={PencilLine}
                              title={intl.formatMessage(m.editCodingHint)}
                              onClick={() => {
                                const doc = documents.find((d) => d.id === a.documentId);
                                if (doc) setPreview(doc);
                              }}
                            />
                          )}
                          <ApprovalAction
                            icon={XIcon}
                            title={intl.formatMessage(m.rejectItemHint)}
                            tone="red"
                            onClick={async () => {
                              const ok = await confirm({
                                tone: 'red',
                                title: intl.formatMessage(m.rejectTitle, { supplier: a.supplier }),
                                detail: intl.formatMessage(m.rejectDetail, { amount: currency(a.total), category: a.category }),
                                consequence: intl.formatMessage(m.rejectConsequence),
                                confirmLabel: intl.formatMessage(m.rejectConfirmLabel),
                              });
                              if (ok) rejectApproval(a.id, intl.formatMessage(m.rejectReason));
                            }}
                          />
                          <ApprovalAction
                            icon={CheckCircle}
                            title={intl.formatMessage(m.approveHint, { stage: a.stage })}
                            tone="brand"
                            onClick={async () => {
                              const ok = await confirm({
                                title: intl.formatMessage(m.approveTitle, {
                                  stage: a.stage.replace(/^Stage \d+ — /, ''),
                                  supplier: a.supplier,
                                }),
                                detail: intl.formatMessage(m.approveDetail, { amount: currency(a.total), category: a.category }),
                                consequence: intl.formatMessage(m.approveConsequence),
                                confirmLabel: intl.formatMessage(m.approveConfirmLabel),
                              });
                              if (ok) advanceApproval(a.id);
                            }}
                          />
                        </span>
                      );
                    },
                  },
                ]}
                rows={clientApprovals}
                rowId={(a) => a.id}
                selectable
                emptyMessage={intl.formatMessage(
                  clientWorkflows.length === 0 ? m.approvalsEmptyNoWorkflow : m.approvalsEmpty,
                )}
                bulkActions={[
                  {
                    label: intl.formatMessage(m.approveSelected), icon: CheckCircle, primary: true,
                    // Acted on here rather than in chat — the rows are already
                    // picked, so there is nothing left to ask the agent.
                    onClick: async (sel) => {
                      const mine = sel.filter(
                        (a) => a.state === 'pending' && !approvalWorkflows.find((w) => w.id === a.workflowId)?.stages[a.stageIndex]?.clientSide,
                      );
                      if (mine.length === 0) {
                        await confirm({
                          tone: 'red',
                          title: intl.formatMessage(m.nothingYoursTitle),
                          detail: intl.formatMessage(m.nothingYoursDetail),
                          confirmLabel: intl.formatMessage(commonActions.close),
                        });
                        return;
                      }
                      const ok = await confirm({
                        title: intl.formatMessage(m.bulkApproveTitle, { count: mine.length }),
                        detail: mine
                          .map((a) => intl.formatMessage(m.itemSummary, { supplier: a.supplier, amount: currency(a.total) }))
                          .slice(0, 4)
                          .join(' · '),
                        consequence: intl.formatMessage(m.bulkApproveConsequence),
                        confirmLabel: intl.formatMessage(m.approveConfirmLabel),
                      });
                      if (ok) mine.forEach((a) => advanceApproval(a.id));
                    },
                  },
                ]}
              />

              <div>
                <div className="flex items-center justify-between gap-4 mb-4 flex-wrap">
                  <div>
                    <h3 className="font-sans font-bold text-lg text-white tracking-tight">{intl.formatMessage(m.workflowsHeading)}</h3>
                    <p className="text-[12px] text-zinc-500 mt-0.5">
                      {intl.formatMessage(m.workflowsIntro)}
                    </p>
                  </div>
                  <button
                    onClick={() => setEditingWorkflow(blankWorkflow())}
                    className="flex items-center gap-2 px-5 py-2.5 rounded-full text-[13px] font-bold text-white bg-brand hover:bg-brand-hover transition-colors shadow-glow-btn"
                  >
                    <Plus size={15} strokeWidth={2.5} />
                    {intl.formatMessage(m.newWorkflow)}
                  </button>
                </div>
                <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
                  {approvalWorkflows.map((w) => (
                    <WorkflowCard
                      key={w.id}
                      workflow={w}
                      usage={clientApprovals.filter((a) => a.workflowId === w.id).length}
                      onEdit={() => setEditingWorkflow(w)}
                      onToggle={() => saveWorkflow({ ...w, active: !w.active })}
                      onDelete={async () => {
                        const ok = await confirm({
                          tone: 'red',
                          title: intl.formatMessage(m.deleteWorkflowTitle, { name: w.name }),
                          detail: intl.formatMessage(m.deleteWorkflowDetail, {
                            count: w.stages.length,
                            appliesTo: w.appliesTo,
                          }),
                          consequence: intl.formatMessage(m.deleteWorkflowConsequence),
                          confirmLabel: intl.formatMessage(m.deleteWorkflowConfirmLabel),
                        });
                        if (ok) deleteWorkflow(w.id);
                      }}
                    />
                  ))}
                </div>
              </div>
            </div>
          )}

          {tab === 'Documents' && (
            <DataTable<Document>
              className="max-w-none"
              columns={docColumns}
              rows={docs}
              rowId={(d) => d.id}
              selectable
              onRowClick={(d) => setPreview(d)}
              emptyMessage={intl.formatMessage(m.documentsEmpty)}
              bulkActions={[
                { label: intl.formatMessage(m.bulkPreview), icon: Eye, onClick: (sel) => sel[0] && setPreview(sel[0]) },
                { label: intl.formatMessage(m.download), icon: Download, primary: true, onClick: (sel) => downloadDocuments(sel, client.name) },
                {
                  label: intl.formatMessage(m.bulkRetryFailed), icon: RefreshCw,
                  onClick: async (sel) => {
                    const failed = sel.filter((d) => d.status === 'rejected');
                    if (failed.length === 0) return;
                    const ok = await confirm({
                      title: intl.formatMessage(m.retryTitle, { count: failed.length }),
                      detail: intl.formatMessage(m.retryDetail),
                      confirmLabel: intl.formatMessage(m.retryConfirmLabel),
                    });
                    if (ok) failed.forEach((d) => retryDocument(d.id));
                  },
                },
              ]}
              footer={intl.formatMessage(m.documentsFooter, { total: docs.length, published: s.published, rejected: s.rejected })}
            />
          )}

          {tab === 'Users' && (
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
              <Panel title={intl.formatMessage(m.panelBusinessUsers)} icon={Users}>
                <p className="text-[13px] text-zinc-500 leading-relaxed mb-5">
                  {intl.formatMessage(m.businessUsersIntro, { client: client.name })}
                </p>

                <div className="flex flex-col gap-2">
                  {businessMembers.length === 0 && (
                    <p className="text-[13px] text-zinc-500 py-2">
                      {intl.formatMessage(m.businessUsersEmpty)}
                    </p>
                  )}
                  {businessMembers.map((member) => (
                    <div key={member.id} className="p-4 rounded-2xl bg-ground/60 border border-white/5 flex items-center gap-4">
                      <div className="w-10 h-10 rounded-xl bg-raised border border-white/5 flex items-center justify-center overflow-hidden font-bold text-white shrink-0">
                        {member.avatarDataUrl
                          ? <img src={member.avatarDataUrl} alt="" className="w-full h-full object-cover" />
                          : (member.name.trim().charAt(0).toUpperCase() || '?')}
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="text-sm font-bold text-white truncate">{member.name || intl.formatMessage(m.memberUnnamed)}</div>
                        <div className="text-[12px] text-zinc-500 truncate">
                          {member.status === 'pending-client-approval'
                            ? intl.formatMessage(m.memberProposed, { at: member.invitedAt ?? '' })
                            : member.status === 'declined'
                            ? member.declinedReason
                              ? intl.formatMessage(m.memberDeclinedWithReason, { reason: member.declinedReason })
                              : intl.formatMessage(m.memberDeclined)
                            : member.status === 'invited'
                            ? intl.formatMessage(m.memberInvited, {
                                approver: member.approvedBy ?? intl.formatMessage(m.memberApproverFallback),
                                channel: intl.formatMessage(channelLabel('user-invite')),
                                email: member.email || intl.formatMessage(m.memberEmailFallback),
                              })
                            : member.email || member.mobile || intl.formatMessage(m.memberNoContact)}
                        </div>
                      </div>
                      <div className="flex items-center gap-2 shrink-0 flex-wrap justify-end">
                        <Pill tone={member.role === 'Owner' ? 'blue' : 'neutral'}>{member.role}</Pill>
                        {member.status === 'pending-client-approval'
                          ? <Pill tone="amber">{intl.formatMessage(m.pillWaitingClientApproval)}</Pill>
                          : member.status === 'declined'
                          ? <Pill tone="red">{intl.formatMessage(m.pillDeclinedByClient)}</Pill>
                          : member.status === 'invited'
                          ? <Pill tone="amber">{intl.formatMessage(m.pillAwaitingMemberRegistration)}</Pill>
                          : <Pill tone="green">{intl.formatMessage(m.pillRegistered)}</Pill>}
                        {/* Demo affordance: open the link as that person. */}
                        {member.status === 'invited' && businessAccount && (
                          <button
                            onClick={() => openRegistrationLink(businessAccount.id, member.id)}
                            className="px-3 py-1.5 rounded-full text-[11px] font-bold text-white bg-brand hover:bg-brand-hover transition-colors"
                          >
                            {intl.formatMessage(m.openRegistrationLink)}
                          </button>
                        )}
                      </div>
                    </div>
                  ))}

                  <button
                    onClick={() => setInviting(true)}
                    className="flex items-center justify-center gap-2 p-3.5 rounded-2xl border border-dashed border-white/10 text-[13px] font-bold text-zinc-400 hover:text-white hover:border-white/25 transition-colors"
                  >
                    <Plus size={15} />
                    {intl.formatMessage(m.addUser)}
                  </button>
                </div>
              </Panel>

              <Panel title={intl.formatMessage(m.panelContacts)} icon={Users}>
                <div className="flex flex-col gap-3">
                  <ContactRow
                    name={client.contactName ?? intl.formatMessage(m.rowPrimaryContact)}
                    detail={client.mobile ?? intl.formatMessage(m.contactNoMobile)}
                    role={intl.formatMessage(m.contactPrimaryRole)}
                  />
                  <ContactRow
                    name={intl.formatMessage(m.contactInboxName)}
                    detail={intl.formatMessage(m.contactInboxDetail, { email: settings.docEmail })}
                    role={intl.formatMessage(m.contactInboxRole)}
                  />
                </div>
                <p className="text-[12px] text-zinc-500 mt-5 leading-relaxed">
                  {intl.formatMessage(m.contactsNote)}
                </p>
              </Panel>
            </div>
          )}

          {tab === 'Integrations' && (
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
              <Panel title={intl.formatMessage(m.panelConnections)} icon={Link2}>
                <div className="flex flex-col gap-3">
                  <ConnectionRow
                    name={intl.formatMessage(m.accountingSoftware)}
                    detail={intl.formatMessage(m.connectionLedgerDetail)}
                    connected={client.xeroConnected}
                    requested={setupLink?.tasks.includes('ledger') ?? false}
                  />
                  <ConnectionRow
                    name={intl.formatMessage(m.connectionBankName)}
                    detail={intl.formatMessage(client.bankConnected ? m.connectionBankConnected : m.connectionBankFallback)}
                    connected={client.bankConnected}
                    requested={setupLink?.tasks.includes('bank') ?? false}
                  />
                </div>
                <p className="text-[12px] text-zinc-500 mt-5 leading-relaxed">
                  {intl.formatMessage(m.connectionsNote)}
                </p>
              </Panel>

              <Panel title={intl.formatMessage(m.panelSetupLink)} icon={Smartphone}>
                {setupLink ? (
                  <>
                    <div className="flex flex-col gap-2.5 text-[13px]">
                      <Row label={intl.formatMessage(m.rowSentTo)} value={intl.formatMessage(m.setupSentToValue, { name: setupLink.recipientName, mobile: setupLink.recipientMobile })} />
                      <Row label={intl.formatMessage(m.rowSent)} value={setupLink.sentAt} />
                      <Row label={intl.formatMessage(m.rowExpires)} value={intl.formatMessage(m.setupExpiresValue, { hours: setupLink.expiresInHours })} />
                      <Row
                        label={intl.formatMessage(m.rowResent)}
                        value={
                          setupLink.resendCount === 0
                            ? intl.formatMessage(m.setupNotResent)
                            : intl.formatMessage(m.setupResentCount, { count: setupLink.resendCount })
                        }
                      />
                    </div>
                    <div className="flex flex-col gap-2 mt-4">
                      {setupLink.tasks.map((t) => (
                        <div key={t} className="flex items-center justify-between gap-3 p-3 rounded-2xl bg-ground/60 border border-white/5">
                          <span className="text-[13px] font-semibold text-white">
                            {intl.formatMessage(
                              t === 'profile' ? m.setupTaskProfile : t === 'ledger' ? m.accountingSoftware : m.bankFeed,
                            )}
                          </span>
                          {setupLink.completed.includes(t) ? (
                            <Pill tone="green">
                              {intl.formatMessage(t === 'profile' ? m.setupTaskDoneProfile : m.setupTaskDoneConnection)}
                            </Pill>
                          ) : (
                            <Pill tone="amber">{intl.formatMessage(m.waitingOnClient)}</Pill>
                          )}
                        </div>
                      ))}
                    </div>
                    <button
                      onClick={async () => {
                        const ok = await confirm({
                          title: intl.formatMessage(m.resendTitle, { name: setupLink.recipientName }),
                          detail: intl.formatMessage(m.resendSetupDetail, { sentAt: setupLink.sentAt }),
                          confirmLabel: intl.formatMessage(m.resendConfirmLabel),
                        });
                        if (ok) resendOnboardingLink(setupLink.id);
                      }}
                      className="mt-4 flex items-center gap-2 px-5 py-2.5 rounded-full text-[13px] font-bold text-white bg-brand hover:bg-brand-hover transition-colors"
                    >
                      <Send size={15} />
                      {intl.formatMessage(m.resendSetupLink)}
                    </button>
                  </>
                ) : (
                  <>
                    <p className="text-[13px] text-zinc-500 leading-relaxed">
                      {intl.formatMessage(pendingTasks.length === 0 ? m.setupAllConnected : m.setupNoLinkSent)}
                    </p>
                    {pendingTasks.length > 0 && (
                      <button
                        onClick={() => sendOnboardingLink(client, pendingTasks)}
                        disabled={!client.mobile}
                        className="mt-4 flex items-center gap-2 px-5 py-2.5 rounded-full text-[13px] font-bold text-white bg-brand hover:bg-brand-hover disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                      >
                        <Send size={15} />
                        {intl.formatMessage(m.sendSetupLink)}
                      </button>
                    )}
                    {pendingTasks.length > 0 && !client.mobile && (
                      <p className="text-[12px] text-amber-400 font-semibold mt-3">
                        {intl.formatMessage(m.setupNeedsMobile)}
                      </p>
                    )}
                  </>
                )}
              </Panel>

              <Panel title={intl.formatMessage(m.panelIntegrationHealth)} icon={Landmark}>
                <div className="flex flex-col gap-2.5 text-[13px]">
                  <Row
                    label={intl.formatMessage(m.rowLedgerToken)}
                    value={intl.formatMessage(client.xeroConnected ? m.ledgerTokenValid : m.ledgerTokenNone)}
                  />
                  <Row label={intl.formatMessage(m.rowBankReauth)} value={client.bankConnected ? intl.formatMessage(m.bankReauthValue) : '—'} />
                  <Row label={intl.formatMessage(m.rowPublishFailures)} value={String(s.rejected)} />
                </div>
              </Panel>
            </div>
          )}

          {tab === 'Settings' && (
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
              <ClientDetailsPanel
                client={client}
                pending={pendingChanges}
                onPropose={proposeClientDetailChanges}
              />
            </div>
          )}
        </motion.div>
      </div>

      <AnimatePresence>
        {chasing && (
          <Modal onClose={() => setChasing(null)}>
            <div className="w-full flex flex-col items-center gap-3">
              <div className="w-full max-w-xl flex items-center justify-between gap-4 px-5 py-3 rounded-[20px] border border-white/5 bg-card shadow-2xl">
                <p className="text-[12px] text-zinc-500">
                  {intl.formatMessage(m.chaseReviewNote)}
                </p>
                <button
                  onClick={() => setChasing(null)}
                  className="shrink-0 px-4 py-1.5 rounded-full text-[12px] font-bold text-zinc-400 hover:text-white transition-colors"
                >
                  {intl.formatMessage(m.chaseDone)}
                </button>
              </div>
              <ChaseComposer clientIds={[client.id]} missingItemIds={chasing} />
            </div>
          </Modal>
        )}
        {addingTask && (
          <AddTaskForm
            client={client}
            colleagues={colleagues}
            existing={clientTasks}
            onAdd={(task) => { addTask(task); setAddingTask(false); }}
            onClose={() => setAddingTask(false)}
          />
        )}
        {inviting && (
          <InviteBusinessUser
            clientName={client.name}
            onSend={(invite) => { inviteBusinessUser(client.id, invite); setInviting(false); }}
            onClose={() => setInviting(false)}
          />
        )}
        {editingWorkflow && (
          <WorkflowEditor
            workflow={editingWorkflow}
            onSave={(w) => { saveWorkflow(w); setEditingWorkflow(null); }}
            onClose={() => setEditingWorkflow(null)}
          />
        )}
        {preview && (
          <Modal onClose={() => setPreview(null)}>
            <div className="w-full flex flex-col items-center gap-3">
              {/* Toolbar sits above the card so Download is reachable without
                  scrolling past a long extraction list. */}
              {/* pr-12 keeps the Download button clear of the modal's close button. */}
              <div className="w-full max-w-3xl flex items-center justify-between gap-4 pl-5 pr-12 py-3 rounded-[20px] border border-white/5 bg-card shadow-2xl">
                <p className="text-[12px] text-zinc-500 truncate">
                  {intl.formatMessage(m.previewNote)}
                </p>
                <button
                  onClick={() => downloadDocuments([preview], client.name)}
                  className="shrink-0 flex items-center gap-2 px-5 py-2 rounded-full text-[13px] font-bold text-white bg-brand hover:bg-brand-hover transition-colors shadow-glow-btn"
                >
                  <Download size={15} strokeWidth={2.5} />
                  {intl.formatMessage(m.download)}
                </button>
              </div>
              {/* Kept live from state so a correction made here shows immediately. */}
              <DocumentPreview document={documents.find((d) => d.id === preview.id) ?? preview} />
            </div>
          </Modal>
        )}
      </AnimatePresence>
    </div>
  );
}

/**
 * CSV of the selected documents — one row per document, with its extracted
 * fields and line items flattened so the file is useful on its own.
 */
function downloadDocuments(rows: Document[], clientName: string) {
  if (rows.length === 0) return;

  const esc = (v: string | number) => `"${String(v).replace(/"/g, '""')}"`;
  const header = 'Supplier,Date,Category,Status,Channel,Uploader,Currency,Total,Line items,Extracted fields\n';
  const body = rows
    .map((d) =>
      [
        esc(d.supplier), esc(d.date), esc(d.category), esc(d.status), esc(d.source), esc(d.uploader), esc(d.currency), d.total,
        esc(d.lineItems.map((l) => `${l.description} x${l.quantity} = ${l.total}`).join(' | ')),
        esc(d.fields.map((f) => `${f.label}: ${f.value}`).join(' | ')),
      ].join(','),
    )
    .join('\n');

  const blob = new Blob([header + body], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  // A single row always has rows[0]; a supplier that slugs to nothing already
  // falls back to "document", so the same fallback covers the lookup.
  a.download =
    rows.length === 1
      ? `${slug(clientName) || 'client'}-${slug(rows[0]?.supplier ?? '') || 'document'}.csv`
      : `${slug(clientName) || 'client'}-documents.csv`;
  a.click();
  URL.revokeObjectURL(url);
}


/**
 * One figure from the wireframe's pipeline snapshot. The whole tile drills to
 * the tab that can act on the number; `action` adds the one case where the
 * wireframe puts a verb on the line itself ("Missing docs: 14 → chase").
 */
function Tile({
  label,
  value,
  tone = 'plain',
  hint,
  onClick,
  action,
}: {
  label: string;
  value: number;
  tone?: 'plain' | 'red';
  hint?: string;
  onClick?: () => void;
  action?: { label: string; onClick: () => void };
}) {
  return (
    <div className="bg-card border border-white/5 rounded-[24px] shadow-2xl flex flex-col hover:border-white/15 transition-colors">
      <button onClick={onClick} className="p-5 pb-3 text-left">
        <div className="text-[11px] font-bold text-zinc-500 uppercase tracking-widest leading-tight">{label}</div>
        <div className={`mt-2 text-3xl font-bold tracking-tight tabular-nums ${tone === 'red' && value > 0 ? 'text-red-400' : 'text-white'}`}>
          {value}
        </div>
        {hint && <div className="text-[11px] text-zinc-600 font-semibold mt-1">{hint}</div>}
      </button>
      {action && (
        <button
          onClick={action.onClick}
          className="mx-3 mb-3 mt-auto px-3 py-1.5 rounded-full text-[12px] font-bold text-brand bg-brand/10 border border-brand/20 hover:bg-brand/20 transition-colors"
        >
          {action.label}
        </button>
      )}
    </div>
  );
}

const detailsPanelMessages = defineMessages({
  panelTitle: { id: 'clients.clientDetailsPanel.panelTitle', defaultMessage: 'Client details' },
  fieldName: { id: 'clients.clientDetailsPanel.fieldName', defaultMessage: 'Legal name' },
  fieldIndustry: { id: 'clients.clientDetailsPanel.fieldIndustry', defaultMessage: 'Industry' },
  fieldContactName: { id: 'clients.clientDetailsPanel.fieldContactName', defaultMessage: 'Primary contact' },
  fieldMobileHint: {
    id: 'clients.clientDetailsPanel.fieldMobileHint',
    defaultMessage: 'Every chase, approval and sign-in code goes here',
  },
  fieldHint: { id: 'clients.clientDetailsPanel.fieldHint', defaultMessage: '— {hint}' },
  pendingHeading: {
    id: 'clients.clientDetailsPanel.pendingHeading',
    defaultMessage: '{count, plural, one {# change} other {# changes}} waiting on {client}',
  },
  pendingChange: { id: 'clients.clientDetailsPanel.pendingChange', defaultMessage: '{label}: {from} → {to}' },
  sentHeading: { id: 'clients.clientDetailsPanel.sentHeading', defaultMessage: 'Sent to {client} for approval' },
  sentDetail: {
    id: 'clients.clientDetailsPanel.sentDetail',
    defaultMessage:
      '{count, plural, one {# change} other {# changes}} are waiting for them to confirm. Nothing on the record has changed yet — it updates the moment they approve.',
  },
  sendChanges: {
    id: 'clients.clientDetailsPanel.sendChanges',
    defaultMessage: 'Send {count, plural, one {# change} other {# changes}} for approval',
  },
  sendChangesNone: { id: 'clients.clientDetailsPanel.sendChangesNone', defaultMessage: 'Send changes for approval' },
  nothingChanged: { id: 'clients.clientDetailsPanel.nothingChanged', defaultMessage: 'Nothing changed yet' },
  changingFields: { id: 'clients.clientDetailsPanel.changingFields', defaultMessage: 'Changing: {fields}' },
  editDetails: { id: 'clients.clientDetailsPanel.editDetails', defaultMessage: 'Edit details' },
  footnote: {
    id: 'clients.clientDetailsPanel.footnote',
    defaultMessage:
      "These are the business's own facts, so {client} confirms any change before it takes effect. It appears in their portal alongside anything else waiting on them.",
  },
});

/**
 * The client's own record. Editing it here is a proposal, not a write: a legal
 * name, a primary contact and the mobile that every chase goes to are the
 * business's facts, and a wrong mobile means the next chase reaches a stranger.
 * So the accountant fills the form and the business confirms.
 */
function ClientDetailsPanel({ client, pending, onPropose }: {
  client: Client;
  pending: ClientDetailChange[];
  onPropose: (
    clientId: string,
    changes: { field: ClientDetailChange['field']; label: string; to: string }[],
  ) => number;
}) {
  const intl = useIntl();

  // Descriptors, not copy: the label doubles as the wording the client sees on
  // the proposal, so it is formatted where it is used rather than at module
  // scope, where no hook can reach.
  const FIELDS: { field: ClientDetailChange['field']; label: MessageDescriptor; hint?: MessageDescriptor }[] = [
    { field: 'name', label: detailsPanelMessages.fieldName },
    { field: 'industry', label: detailsPanelMessages.fieldIndustry },
    { field: 'contactName', label: detailsPanelMessages.fieldContactName },
    { field: 'mobile', label: commonLabels.mobile, hint: detailsPanelMessages.fieldMobileHint },
    { field: 'vatNumber', label: commonLabels.vatNumber },
    { field: 'deadline', label: commonLabels.nextDeadline },
  ];

  const current = () =>
    Object.fromEntries(FIELDS.map((f) => [f.field, String(client[f.field] ?? '')])) as Record<string, string>;

  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<Record<string, string>>(current);
  const [sent, setSent] = useState(0);

  /**
   * The draft is seeded from `current()`, which writes an entry for every
   * FIELDS key, and editing only overwrites them — so a FIELDS lookup is always
   * set, and the empty fallback reads the same as a field the client left blank.
   */
  const drafted = (field: ClientDetailChange['field']) => draft[field] ?? '';

  const changed = FIELDS.filter((f) => drafted(f.field).trim() !== String(client[f.field] ?? '').trim());

  return (
    <Panel title={intl.formatMessage(detailsPanelMessages.panelTitle)} icon={SettingsIcon}>
      {/* What is already with the client, so a second edit is not proposed
          blindly on top of the first. */}
      {pending.length > 0 && (
        <div className="mb-5 p-4 rounded-2xl border border-amber-400/25 bg-amber-400/[0.07] flex items-start gap-3">
          <Clock size={15} className="text-amber-400 mt-0.5 shrink-0" />
          <div className="min-w-0">
            <div className="text-[13px] font-bold text-amber-400">
              {intl.formatMessage(detailsPanelMessages.pendingHeading, { count: pending.length, client: client.name })}
            </div>
            <div className="text-[12px] text-zinc-400 mt-1 leading-relaxed">
              {pending
                .map((c) => intl.formatMessage(detailsPanelMessages.pendingChange, { label: c.label, from: c.from, to: c.to }))
                .join(' · ')}
            </div>
          </div>
        </div>
      )}

      {sent > 0 && !editing && (
        <div className="mb-5 p-4 rounded-2xl border border-brand/25 bg-brand/[0.07] flex items-start gap-3">
          <Check size={15} className="text-brand mt-0.5 shrink-0" strokeWidth={3} />
          <div className="min-w-0">
            <div className="text-[13px] font-bold text-white">
              {intl.formatMessage(detailsPanelMessages.sentHeading, { client: client.name })}
            </div>
            <p className="text-[12px] text-zinc-400 mt-1 leading-relaxed">
              {intl.formatMessage(detailsPanelMessages.sentDetail, { count: sent })}
            </p>
          </div>
        </div>
      )}

      <div className="flex flex-col gap-4">
        {FIELDS.map((f) => (
          <div key={f.field}>
            <div className="text-[11px] font-bold text-zinc-500 uppercase tracking-widest mb-2">
              {intl.formatMessage(f.label)}
              {f.hint && (
                <span className="ml-2 normal-case tracking-normal text-zinc-600">
                  {intl.formatMessage(detailsPanelMessages.fieldHint, { hint: intl.formatMessage(f.hint) })}
                </span>
              )}
            </div>
            {editing ? (
              <input
                value={draft[f.field]}
                onChange={(e) => setDraft({ ...draft, [f.field]: e.target.value })}
                className="w-full bg-ground border border-white/5 rounded-xl px-4 py-2.5 text-sm text-white placeholder:text-zinc-600 focus:outline-none focus:border-brand transition-colors"
              />
            ) : (
              <div className="w-full bg-ground/60 border border-white/5 rounded-xl px-4 py-2.5 text-sm text-zinc-300">
                {String(client[f.field] ?? '') || '—'}
              </div>
            )}
          </div>
        ))}
      </div>

      <div className="flex items-center gap-3 mt-5 flex-wrap">
        {editing ? (
          <>
            <button
              onClick={() => {
                const n = onPropose(
                  client.id,
                  changed.map((f) => ({ field: f.field, label: intl.formatMessage(f.label), to: drafted(f.field) })),
                );
                setSent(n);
                setEditing(false);
              }}
              disabled={changed.length === 0}
              className="px-6 py-2.5 rounded-full text-[13px] font-bold text-white bg-brand hover:bg-brand-hover disabled:opacity-40 disabled:cursor-not-allowed transition-colors shadow-glow-btn"
            >
              {changed.length === 0
                ? intl.formatMessage(detailsPanelMessages.sendChangesNone)
                : intl.formatMessage(detailsPanelMessages.sendChanges, { count: changed.length })}
            </button>
            <button
              onClick={() => { setDraft(current()); setEditing(false); }}
              className="px-5 py-2.5 rounded-full text-[13px] font-bold text-zinc-400 hover:text-white transition-colors"
            >
              {intl.formatMessage(commonActions.cancel)}
            </button>
            <span className="text-[12px] text-zinc-500 font-semibold">
              {changed.length === 0
                ? intl.formatMessage(detailsPanelMessages.nothingChanged)
                : intl.formatMessage(detailsPanelMessages.changingFields, {
                    fields: changed.map((f) => intl.formatMessage(f.label)).join(', '),
                  })}
            </span>
          </>
        ) : (
          <button
            onClick={() => { setDraft(current()); setSent(0); setEditing(true); }}
            className="flex items-center gap-2 px-5 py-2.5 rounded-full text-[13px] font-bold text-zinc-300 border border-white/10 hover:text-white hover:border-white/25 transition-colors"
          >
            <PencilLine size={15} />
            {intl.formatMessage(detailsPanelMessages.editDetails)}
          </button>
        )}
      </div>

      <p className="text-[12px] text-zinc-500 leading-relaxed mt-4">
        {intl.formatMessage(detailsPanelMessages.footnote, { client: client.name })}
      </p>
    </Panel>
  );
}

const addTaskMessages = defineMessages({
  assigneeFallback: { id: 'clients.addTaskForm.assigneeFallback', defaultMessage: 'You' },
  problemTitle: { id: 'clients.addTaskForm.problemTitle', defaultMessage: 'Say what needs doing.' },
  problemAssignee: { id: 'clients.addTaskForm.problemAssignee', defaultMessage: 'Give it an owner.' },
  problemDue: {
    id: 'clients.addTaskForm.problemDue',
    defaultMessage: 'Give it a due date — an undated task never becomes urgent.',
  },
  heading: { id: 'clients.addTaskForm.heading', defaultMessage: 'Add a task' },
  subheading: { id: 'clients.addTaskForm.subheading', defaultMessage: 'On {client}' },
  titleLabel: { id: 'clients.addTaskForm.titleLabel', defaultMessage: 'What needs doing' },
  titlePlaceholder: { id: 'clients.addTaskForm.titlePlaceholder', defaultMessage: 'Chase the missing Brakes invoice' },
  assignTo: { id: 'clients.addTaskForm.assignTo', defaultMessage: 'Assign to' },
  noColleagues: {
    id: 'clients.addTaskForm.noColleagues',
    defaultMessage: 'No active colleagues to assign to — add one under Team first.',
  },
  dueLabel: { id: 'clients.addTaskForm.dueLabel', defaultMessage: 'Due' },
  duePlaceholder: { id: 'clients.addTaskForm.duePlaceholder', defaultMessage: '12 Aug 2026' },
  blockedBy: { id: 'clients.addTaskForm.blockedBy', defaultMessage: 'Blocked by' },
  blockedByOptional: { id: 'clients.addTaskForm.blockedByOptional', defaultMessage: '(optional)' },
  blockedByNone: { id: 'clients.addTaskForm.blockedByNone', defaultMessage: 'Nothing — it can start now' },
  blockedByNote: {
    id: 'clients.addTaskForm.blockedByNote',
    defaultMessage: 'A blocked task cannot be ticked until the one before it is done.',
  },
  submit: { id: 'clients.addTaskForm.submit', defaultMessage: 'Add the task' },
});

/**
 * A one-off task on a client, alongside the recurring checklist. Everything a
 * task needs to be actionable is asked for: what it is, who owns it, when it is
 * due, and whether something has to happen first — a task with no owner is a
 * note, and a note does not get done.
 */
function AddTaskForm({ client, colleagues, existing, onAdd, onClose }: {
  client: Client;
  colleagues: Colleague[];
  existing: WorkflowTask[];
  onAdd: (task: WorkflowTask) => void;
  onClose: () => void;
}) {
  const intl = useIntl();
  const eligible = colleagues.filter((c) => c.active);
  const [title, setTitle] = useState('');
  const [assignee, setAssignee] = useState(eligible[0]?.name ?? intl.formatMessage(addTaskMessages.assigneeFallback));
  const [due, setDue] = useState(client.deadline !== '—' ? client.deadline : '');
  const [dependsOn, setDependsOn] = useState('');

  const problem = !title.trim()
    ? intl.formatMessage(addTaskMessages.problemTitle)
    : !assignee
    ? intl.formatMessage(addTaskMessages.problemAssignee)
    : !due.trim()
    ? intl.formatMessage(addTaskMessages.problemDue)
    : '';

  return (
    <Modal onClose={onClose}>
      <div className="w-full max-w-lg border border-white/5 rounded-[32px] bg-card shadow-2xl overflow-hidden">
        <div className="p-6 border-b border-white/5">
          <h3 className="font-sans font-bold text-xl text-white tracking-tight">{intl.formatMessage(addTaskMessages.heading)}</h3>
          <p className="text-[12px] text-zinc-500 mt-1 font-semibold uppercase tracking-wider">
            {intl.formatMessage(addTaskMessages.subheading, { client: client.name })}
          </p>
        </div>

        <div className="p-6 flex flex-col gap-5">
          <Field
            label={intl.formatMessage(addTaskMessages.titleLabel)}
            value={title}
            onChange={setTitle}
            placeholder={intl.formatMessage(addTaskMessages.titlePlaceholder)}
          />

          <div>
            <div className="text-[11px] font-bold text-zinc-500 uppercase tracking-widest mb-2">{intl.formatMessage(addTaskMessages.assignTo)}</div>
            <div className="flex flex-wrap gap-2">
              {eligible.map((c) => (
                <button
                  key={c.id}
                  onClick={() => setAssignee(c.name)}
                  className={`px-4 py-2.5 rounded-xl border text-[13px] font-bold transition-colors ${
                    assignee === c.name
                      ? 'bg-brand/10 border-brand/40 text-brand'
                      : 'bg-ground border-white/5 text-zinc-400 hover:text-white'
                  }`}
                >
                  {c.name}
                  <span className="block text-[10px] font-semibold text-zinc-600 mt-0.5">{c.role}</span>
                </button>
              ))}
            </div>
            {eligible.length === 0 && (
              <p className="text-[13px] text-amber-400 font-semibold mt-2">
                {intl.formatMessage(addTaskMessages.noColleagues)}
              </p>
            )}
          </div>

          <Field
            label={intl.formatMessage(addTaskMessages.dueLabel)}
            value={due}
            onChange={setDue}
            placeholder={intl.formatMessage(addTaskMessages.duePlaceholder)}
          />

          <div>
            <div className="text-[11px] font-bold text-zinc-500 uppercase tracking-widest mb-2">
              {intl.formatMessage(addTaskMessages.blockedBy)}{' '}
              <span className="text-zinc-600 normal-case tracking-normal font-semibold">{intl.formatMessage(addTaskMessages.blockedByOptional)}</span>
            </div>
            <select
              value={dependsOn}
              onChange={(e) => setDependsOn(e.target.value)}
              className="w-full bg-ground border border-white/5 rounded-xl px-4 py-2.5 text-sm text-white focus:outline-none focus:border-brand transition-colors appearance-none"
            >
              <option value="" className="bg-card">{intl.formatMessage(addTaskMessages.blockedByNone)}</option>
              {existing.map((t) => (
                <option key={t.id} value={t.id} className="bg-card">{t.title}</option>
              ))}
            </select>
            <p className="text-[12px] text-zinc-500 mt-2 leading-relaxed">
              {intl.formatMessage(addTaskMessages.blockedByNote)}
            </p>
          </div>

          {problem && <p className="text-[13px] text-amber-400 font-semibold">{problem}</p>}
        </div>

        <div className="p-4 bg-raised/50 flex items-center gap-3 justify-end">
          <button onClick={onClose} className="px-5 py-2.5 rounded-full text-[13px] font-bold text-zinc-400 hover:text-white transition-colors">
            {intl.formatMessage(commonActions.cancel)}
          </button>
          <button
            onClick={() =>
              onAdd({
                id: `task-${client.id}-${Date.now()}`,
                clientId: client.id,
                clientName: client.name,
                title: title.trim(),
                assignee,
                due: due.trim(),
                status: 'open',
                // Only the generated checklist steps can be answered from
                // pipeline state; a hand-written one is nobody's guess.
                aiPrefilled: false,
                dependsOn: dependsOn || undefined,
              })
            }
            disabled={!!problem}
            className="flex items-center gap-2 px-6 py-2.5 rounded-full text-[13px] font-bold text-white bg-brand hover:bg-brand-hover disabled:opacity-40 disabled:cursor-not-allowed transition-colors shadow-glow-btn"
          >
            <Plus size={15} strokeWidth={2.5} />
            {intl.formatMessage(addTaskMessages.submit)}
          </button>
        </div>
      </div>
    </Modal>
  );
}

const inviteMessages = defineMessages({
  problemName: { id: 'clients.inviteBusinessUser.problemName', defaultMessage: 'Add their name.' },
  problemEmail: {
    id: 'clients.inviteBusinessUser.problemEmail',
    defaultMessage: 'Add an email — their invite goes {channel}.',
  },
  problemEmailInvalid: {
    id: 'clients.inviteBusinessUser.problemEmailInvalid',
    defaultMessage: 'That email does not look right.',
  },
  problemMobile: {
    id: 'clients.inviteBusinessUser.problemMobile',
    defaultMessage: 'A mobile is required — chases and approvals reach them by SMS.',
  },
  heading: { id: 'clients.inviteBusinessUser.heading', defaultMessage: 'Add a user at {client}' },
  subheading: {
    id: 'clients.inviteBusinessUser.subheading',
    defaultMessage: 'They finish their own details from the link',
  },
  roleHintOwner: {
    id: 'clients.inviteBusinessUser.roleHintOwner',
    defaultMessage: 'Full access to the portal, its settings and the figures.',
  },
  roleHintManager: {
    id: 'clients.inviteBusinessUser.roleHintManager',
    defaultMessage: 'Sends documents and sees what is outstanding.',
  },
  roleHintStaff: {
    id: 'clients.inviteBusinessUser.roleHintStaff',
    defaultMessage: 'Sends documents only — the day-to-day receipt handler.',
  },
  roleHintCustom: {
    id: 'clients.inviteBusinessUser.roleHintCustom',
    defaultMessage: 'A role of your own. Set what they can do below.',
  },
  fieldName: { id: 'clients.inviteBusinessUser.fieldName', defaultMessage: 'Name' },
  fieldNamePlaceholder: { id: 'clients.inviteBusinessUser.fieldNamePlaceholder', defaultMessage: 'Tom Whyte' },
  fieldEmailPlaceholder: {
    id: 'clients.inviteBusinessUser.fieldEmailPlaceholder',
    defaultMessage: 'tom@americanburger.co.uk',
  },
  channelNote: {
    id: 'clients.inviteBusinessUser.channelNote',
    defaultMessage:
      'Both are needed and they do different jobs. Their invite and anything routine go {inviteChannel}; chases, reminders and approvals go {chaseChannel}, because those have to reach someone who has installed nothing.',
  },
  permUploadLabel: { id: 'clients.inviteBusinessUser.permUploadLabel', defaultMessage: 'Can send documents' },
  permUploadHint: {
    id: 'clients.inviteBusinessUser.permUploadHint',
    defaultMessage: 'Upload and photograph paperwork for the business.',
  },
  permTotalsLabel: { id: 'clients.inviteBusinessUser.permTotalsLabel', defaultMessage: 'Can see totals' },
  permTotalsHint: {
    id: 'clients.inviteBusinessUser.permTotalsHint',
    defaultMessage: 'Amounts and what is outstanding. Usually off for staff photographing receipts.',
  },
  approvalHeading: { id: 'clients.inviteBusinessUser.approvalHeading', defaultMessage: '{client} approves this first' },
  approvalNote: {
    id: 'clients.inviteBusinessUser.approvalNote',
    defaultMessage:
      'Nothing is sent to {name} until someone at the business agrees. It appears in their portal to approve, and shows here as waiting on them. If they approve, the invite goes {channel} and the person adds their own photo and details.',
  },
  approvalNoteUnnamed: { id: 'clients.inviteBusinessUser.approvalNoteUnnamed', defaultMessage: 'them' },
  submit: { id: 'clients.inviteBusinessUser.submit', defaultMessage: 'Ask {client} to approve' },
});

/**
 * Inviting someone at the business, from the practice side. Deliberately three
 * things only: what they may do, who they are, and where the link goes. Their
 * email and photo are theirs to add on the link — the practice guessing them
 * is how a record ends up subtly wrong and nobody notices.
 */
function InviteBusinessUser({ clientName, onSend, onClose }: {
  clientName: string;
  onSend: (invite: { name: string; email: string; mobile: string; role: BusinessMemberRole; canUpload: boolean; canSeeTotals: boolean }) => void;
  onClose: () => void;
}) {
  const intl = useIntl();
  const [role, setRole] = useState<BusinessMemberRole>('Staff');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [mobile, setMobile] = useState('');
  // Defaults follow the role, and stay overridable.
  const [canUpload, setCanUpload] = useState(true);
  const [canSeeTotals, setCanSeeTotals] = useState(false);

  // The two permissions follow the role as a starting point, and stay
  // overridable. A custom role gets the conservative pair.
  const pickRole = (r: BusinessMemberRole) => {
    setRole(r);
    setCanUpload(true);
    setCanSeeTotals(r === 'Owner' || r === 'Manager');
  };

  const problem = !name.trim()
    ? intl.formatMessage(inviteMessages.problemName)
    : !email.trim()
    ? intl.formatMessage(inviteMessages.problemEmail, { channel: intl.formatMessage(channelLabel('user-invite')) })
    : !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())
    ? intl.formatMessage(inviteMessages.problemEmailInvalid)
    : !mobile.trim()
    ? intl.formatMessage(inviteMessages.problemMobile)
    : '';

  return (
    <Modal onClose={onClose}>
      <div className="w-full max-w-lg border border-white/5 rounded-[32px] bg-card shadow-2xl overflow-hidden">
        <div className="p-6 border-b border-white/5">
          <h3 className="font-sans font-bold text-xl text-white tracking-tight">{intl.formatMessage(inviteMessages.heading, { client: clientName })}</h3>
          <p className="text-[12px] text-zinc-500 mt-1 font-semibold uppercase tracking-wider">
            {intl.formatMessage(inviteMessages.subheading)}
          </p>
        </div>

        <div className="p-6 flex flex-col gap-5">
          <RolePicker
            value={role}
            onChange={pickRole}
            hint={intl.formatMessage(
              role === 'Owner'
                ? inviteMessages.roleHintOwner
                : role === 'Manager'
                ? inviteMessages.roleHintManager
                : role === 'Staff'
                ? inviteMessages.roleHintStaff
                : inviteMessages.roleHintCustom,
            )}
          />

          <div className="grid grid-cols-2 gap-4">
            <Field
              label={intl.formatMessage(inviteMessages.fieldName)}
              value={name}
              onChange={setName}
              placeholder={intl.formatMessage(inviteMessages.fieldNamePlaceholder)}
            />
            <Field
              label={intl.formatMessage(commonLabels.email)}
              value={email}
              onChange={setEmail}
              placeholder={intl.formatMessage(inviteMessages.fieldEmailPlaceholder)}
            />
          </div>
          <Field
            label={intl.formatMessage(commonLabels.mobile)}
            value={mobile}
            onChange={setMobile}
            placeholder={intl.formatMessage(commonPlaceholders.ukMobile)}
          />
          <p className="text-[12px] text-zinc-500 leading-relaxed -mt-2">
            {intl.formatMessage(inviteMessages.channelNote, {
              inviteChannel: intl.formatMessage(channelLabel('user-invite')),
              chaseChannel: intl.formatMessage(channelLabel('chase')),
            })}
          </p>

          <div className="flex flex-col gap-2">
            <PermissionToggle
              label={intl.formatMessage(inviteMessages.permUploadLabel)}
              hint={intl.formatMessage(inviteMessages.permUploadHint)}
              value={canUpload}
              onChange={setCanUpload}
            />
            <PermissionToggle
              label={intl.formatMessage(inviteMessages.permTotalsLabel)}
              hint={intl.formatMessage(inviteMessages.permTotalsHint)}
              value={canSeeTotals}
              onChange={setCanSeeTotals}
            />
          </div>

          {/* The practice does not get to decide who works at the business. */}
          <div className="flex items-start gap-3 p-4 rounded-2xl border border-brand/20 bg-brand/[0.06] shadow-inner">
            <ShieldCheck size={16} className="text-brand mt-0.5 shrink-0" />
            <div className="min-w-0">
              <div className="text-[13px] font-bold text-white">{intl.formatMessage(inviteMessages.approvalHeading, { client: clientName })}</div>
              <p className="text-[12px] text-zinc-500 mt-1 leading-relaxed">
                {intl.formatMessage(inviteMessages.approvalNote, {
                  name: name.trim() || intl.formatMessage(inviteMessages.approvalNoteUnnamed),
                  channel: intl.formatMessage(channelLabel('user-invite')),
                })}
              </p>
            </div>
          </div>

          {problem && <p className="text-[13px] text-amber-400 font-semibold">{problem}</p>}
        </div>

        <div className="p-4 bg-raised/50 flex items-center gap-3 justify-end">
          <button onClick={onClose} className="px-5 py-2.5 rounded-full text-[13px] font-bold text-zinc-400 hover:text-white transition-colors">
            {intl.formatMessage(commonActions.cancel)}
          </button>
          <button
            onClick={() => onSend({ name, email, mobile, role, canUpload, canSeeTotals })}
            disabled={!!problem}
            className="flex items-center gap-2 px-6 py-2.5 rounded-full text-[13px] font-bold text-white bg-brand hover:bg-brand-hover disabled:opacity-40 disabled:cursor-not-allowed transition-colors shadow-glow-btn"
          >
            <Send size={15} />
            {intl.formatMessage(inviteMessages.submit, { client: clientName })}
          </button>
        </div>
      </div>
    </Modal>
  );
}

/** One row-level approval verb, in this site's icon-button language. */
function ApprovalAction({ icon: Icon, title, onClick, tone = 'plain' }: {
  icon: typeof CheckCircle;
  title: string;
  onClick: () => void;
  tone?: 'plain' | 'red' | 'brand';
}) {
  return (
    <button
      onClick={(e) => { e.stopPropagation(); onClick(); }}
      title={title}
      aria-label={title}
      className={`p-2 rounded-lg border transition-colors ${
        tone === 'brand'
          ? 'text-brand border-brand/25 bg-brand/10 hover:bg-brand/20'
          : tone === 'red'
          ? 'text-red-400 border-red-400/20 bg-red-400/10 hover:bg-red-400/20'
          : 'text-zinc-400 border-white/5 hover:text-white hover:border-white/20 hover:bg-white/5'
      }`}
    >
      <Icon size={14} />
    </button>
  );
}

function PermissionToggle({ label, hint, value, onChange }: {
  label: string; hint: string; value: boolean; onChange: (v: boolean) => void;
}) {
  return (
    <button
      onClick={() => onChange(!value)}
      className="bg-ground/60 border border-white/5 rounded-2xl p-4 flex items-center justify-between gap-4 shadow-inner hover:border-white/10 transition-colors text-left"
    >
      <div>
        <div className="text-sm font-bold text-white">{label}</div>
        <div className="text-[12px] text-zinc-500 mt-0.5">{hint}</div>
      </div>
      <div className={`w-11 h-6 rounded-full shrink-0 transition-colors relative ${value ? 'bg-brand' : 'bg-white/10'}`}>
        <div className={`absolute top-1 w-4 h-4 rounded-full bg-white transition-all ${value ? 'left-6' : 'left-1'}`} />
      </div>
    </button>
  );
}

function Field({ label, value, onChange, placeholder }: {
  label: string; value: string; onChange: (v: string) => void; placeholder?: string;
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
    </div>
  );
}

function Panel({ title, icon: Icon, children }: { title: string; icon: LucideIcon; children: React.ReactNode }) {
  return (
    <div className="border border-white/5 rounded-[32px] bg-card shadow-2xl overflow-hidden">
      <div className="p-6 pb-4 flex items-center gap-3 border-b border-white/5">
        <div className="w-9 h-9 rounded-xl bg-raised border border-white/5 flex items-center justify-center text-zinc-400 shadow-inner">
          <Icon size={16} />
        </div>
        <h3 className="font-sans font-bold text-lg text-white tracking-tight">{title}</h3>
      </div>
      <div className="p-6">{children}</div>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between items-center gap-4">
      <span className="text-zinc-500 font-medium">{label}</span>
      <span className="text-white font-bold text-right">{value}</span>
    </div>
  );
}

function ContactRow({ name, detail, role }: { name: string; detail: string; role: string }) {
  return (
    <div className="p-4 border border-white/5 rounded-2xl bg-ground/60 shadow-inner">
      <div className="text-sm font-bold text-white">{name}</div>
      <div className="text-[12px] text-zinc-400 mt-0.5">{detail}</div>
      <div className="text-[11px] text-zinc-600 font-semibold uppercase tracking-wider mt-2">{role}</div>
    </div>
  );
}

/**
 * Status only — there is deliberately no Connect button here. The practice
 * cannot make either connection; it can only ask the client to.
 */
function ConnectionRow({ name, detail, connected, requested }: { name: string; detail: string; connected: boolean; requested: boolean }) {
  const intl = useIntl();

  return (
    <div className="flex items-center justify-between gap-4 p-4 border border-white/5 rounded-2xl bg-ground/60 shadow-inner">
      <div className="min-w-0">
        <div className="text-sm font-bold text-white">{name}</div>
        <div className="text-[12px] text-zinc-500">{detail}</div>
      </div>
      {connected ? (
        <Pill tone="green">{intl.formatMessage(m.connectionConnected)}</Pill>
      ) : requested ? (
        <Pill tone="amber">{intl.formatMessage(m.connectionRequested)}</Pill>
      ) : (
        <Pill tone="red">{intl.formatMessage(m.connectionNotConnected)}</Pill>
      )}
    </div>
  );
}
