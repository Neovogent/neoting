import { useMemo, useRef, useState, type ReactNode } from 'react';
import {
  Send, Play, X, Check, MessageSquare, Clock, ShieldOff, Ban, Wand2, FileSearch, PencilLine,
  Link2, ChevronRight, SlidersHorizontal, Undo2, Upload, LucideIcon,
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { defineMessages, useIntl, type MessageDescriptor } from 'react-intl';
import { useAppContext } from '../context/AppContext';
import { API_ENABLED } from '../api/config';
import { useChases, useSmsOutbox } from '../api/chases';
import { errorLabel, sliceStatus } from '../api/slices';
import { DataSourceBadge } from '../components/DataSourceBadge';
import { ChasesLiveBoard } from './ChasesLiveBoard';
import { cooldownFor, describeAge, formatWait, SmsCooldownNotice } from '../components/DynamicComponents/SmsCooldown';
import { useConfirm } from '../components/DynamicComponents/ConfirmProvider';
import { Tooltip } from '../components/DynamicComponents/Tooltip';
import { detectionOf } from '../lib/detection';
import { MessageEditor } from '../components/DynamicComponents/ChaseComposer';
import { ChaseModal } from '../components/DynamicComponents/ChaseModal';
import { currency } from '../lib/resolver';
import { clampLinkTtl, LINK_TTL_PRESETS, MAX_LINK_TTL_HOURS, MIN_LINK_TTL_HOURS } from '../lib/generate';
import type { Chase, ChaseItem, ChaseItemStatus, ChasePolicy } from '../lib/types';
import { commonActions, commonLabels } from '../i18n/common';

/** Stage names, shared by the practice table and the chase header. */
const mStage = defineMessages({
  sent: { id: 'chase.stageLabel.sent', defaultMessage: 'Sent' },
  reminderOne: { id: 'chase.stageLabel.reminderOne', defaultMessage: 'Reminder 1' },
  reminderTwo: { id: 'chase.stageLabel.reminderTwo', defaultMessage: 'Reminder 2' },
  escalated: { id: 'chase.stageLabel.escalated', defaultMessage: 'Escalated' },
  closed: { id: 'chase.stageLabel.closed', defaultMessage: 'Closed' },
});

// The table holds descriptors, not text: a hook cannot be called at module
// scope, so each label is formatted where it is rendered.
const STAGE_LABEL: Record<Chase['stage'], { label: MessageDescriptor; light: string; dark: string }> = {
  sent: { label: mStage.sent, light: 'bg-zinc-900 text-white', dark: 'bg-raised text-zinc-300' },
  'reminder-1': { label: mStage.reminderOne, light: 'bg-amber-100 text-amber-800', dark: 'bg-amber-500/10 text-amber-400' },
  'reminder-2': { label: mStage.reminderTwo, light: 'bg-amber-200 text-amber-900', dark: 'bg-amber-500/15 text-amber-300' },
  escalated: { label: mStage.escalated, light: 'bg-brand text-white', dark: 'bg-brand/15 text-brand' },
  closed: { label: mStage.closed, light: 'bg-emerald-100 text-emerald-700', dark: 'bg-emerald-500/10 text-emerald-400' },
};

const m = defineMessages({
  heading: { id: 'chase.chasesView.heading', defaultMessage: 'Missing Evidence' },
  subheading: {
    id: 'chase.chasesView.subheading',
    defaultMessage: 'Manage requested paperwork and automated SMS chasing.',
  },
  itemMessagesAction: { id: 'chase.chasesView.itemMessagesAction', defaultMessage: 'Item messages' },
  policyAction: { id: 'chase.chasesView.policyAction', defaultMessage: 'Chase policy' },
  runEngineAction: { id: 'chase.chasesView.runEngineAction', defaultMessage: 'Run Chase Engine Now' },
  runEngineNote: {
    id: 'chase.chasesView.runEngineNote',
    defaultMessage: '{detections} detections across {clients, plural, one {# client} other {# clients}}, grouped into one SMS each.',
  },
  alreadyRequestedNote: {
    id: 'chase.chasesView.alreadyRequestedNote',
    defaultMessage: 'Everything for this client is already requested — send a reminder from the chase detail instead.',
  },
  statMissingTitle: { id: 'chase.chasesView.statMissingTitle', defaultMessage: 'Missing Documents' },
  statMissingSubtitle: { id: 'chase.chasesView.statMissingSubtitle', defaultMessage: 'Across {count} clients' },
  statMissingTrend: { id: 'chase.chasesView.statMissingTrend', defaultMessage: 'Not yet chased' },
  statChasesTitle: { id: 'chase.chasesView.statChasesTitle', defaultMessage: 'Active Chases (SMS)' },
  statChasesSubtitle: { id: 'chase.chasesView.statChasesSubtitle', defaultMessage: '{count} items awaiting upload' },
  statChasesTrend: { id: 'chase.chasesView.statChasesTrend', defaultMessage: '{first}/{second} day policy' },
  statOverdueTitle: { id: 'chase.chasesView.statOverdueTitle', defaultMessage: 'Overdue & Escalated' },
  statOverdueSubtitle: {
    id: 'chase.chasesView.statOverdueSubtitle',
    defaultMessage: 'Requires accountant intervention',
  },
  statOverdueTrend: {
    id: 'chase.chasesView.statOverdueTrend',
    defaultMessage: '{count, plural, one {# client} other {# clients}} flagged',
  },
  tableHeading: { id: 'chase.chasesView.tableHeading', defaultMessage: 'Practice Dashboard: Chasing Status' },
  filterAll: { id: 'chase.chasesView.filterAll', defaultMessage: 'All Clients' },
  filterOverdue: { id: 'chase.chasesView.filterOverdue', defaultMessage: 'Overdue' },
  columnMissing: { id: 'chase.chasesView.columnMissing', defaultMessage: 'Missing' },
  columnRequested: { id: 'chase.chasesView.columnRequested', defaultMessage: 'Requested' },
  columnOverdue: { id: 'chase.chasesView.columnOverdue', defaultMessage: 'Overdue' },
  columnStage: { id: 'chase.chasesView.columnStage', defaultMessage: 'Stage' },
  columnPolicy: { id: 'chase.chasesView.columnPolicy', defaultMessage: 'Auto-Chase Policy' },
  columnLastUpload: { id: 'chase.chasesView.columnLastUpload', defaultMessage: 'Last Upload' },
  columnAction: { id: 'chase.chasesView.columnAction', defaultMessage: 'Action' },
  emptyRows: {
    id: 'chase.chasesView.emptyRows',
    defaultMessage: 'Nothing overdue — every chase is inside its policy window.',
  },
  noChaseSent: { id: 'chase.chasesView.noChaseSent', defaultMessage: 'No chase sent' },
  standardPolicy: { id: 'chase.chasesView.standardPolicy', defaultMessage: 'Standard ({first}/{second} days)' },
  openAction: { id: 'chase.chasesView.openAction', defaultMessage: 'Open' },
  reviewAndChaseAction: { id: 'chase.chasesView.reviewAndChaseAction', defaultMessage: 'Review & Chase' },
  policyAudit: { id: 'chase.chasesView.policyAudit', defaultMessage: 'Updated chase policy' },
  policyAuditScope: {
    id: 'chase.chasesView.policyAuditScope',
    defaultMessage: '{first}/{second} days, escalate {escalate}d',
  },
});

/**
 * The Chases surface (METH Stage 12). Two boards behind one route:
 *
 *   LIVE — `ChasesLiveBoard`, when the API is on and the session answered:
 *   the server's chases and the demo SMS outbox, both polled. The synthetic
 *   composer below is NOT mapped onto server rows, because its actions
 *   (reminders, staging, policy) have no contract yet and buttons whose
 *   writes the next poll reverts are worse than absent.
 *
 *   SYNTHETIC — everything below, exactly as it always ran; also the
 *   fallback when the live query fails, wearing the dev-only badge
 *   (METH_MODE §8: degrade to fixtures, never to blank).
 *
 * The context `chases` array stays seed-driven either way — hydrating it
 * would put the chases client on the bundle floor, which has no headroom
 * (apps/web/CLAUDE.md, Bundle); `slices.chases` in AppContext says 'seed'
 * about exactly that array, and THIS view's own query status is the live
 * surface's truth.
 */
export function ChasesView() {
  const { session } = useAppContext();
  const liveOn = API_ENABLED && session.status === 'authenticated';
  const live = useChases({ enabled: liveOn });
  const outbox = useSmsOutbox({ enabled: liveOn });
  const status = sliceStatus(liveOn, live);

  if (status.source === 'api') {
    return (
      <ChasesLiveBoard
        chases={live.chases}
        loading={status.loading}
        outbox={outbox.messages}
        outboxError={outbox.contractError ?? errorLabel(outbox.error)}
      />
    );
  }
  return <SyntheticChasesBoard badge={<DataSourceBadge slice="chases" status={status} />} />;
}

function SyntheticChasesBoard({ badge }: { badge?: ReactNode }) {
  const intl = useIntl();
  const {
    clients, chases, missing, statsFor, chasePolicy, setChasePolicy, itemMessages,
    logAudit,
  } = useAppContext();

  const [filter, setFilter] = useState<'all' | 'overdue'>('all');
  const [openChase, setOpenChase] = useState<string | null>(null);
  const [policyOpen, setPolicyOpen] = useState(false);
  const [messagesOpen, setMessagesOpen] = useState(false);

  const rows = useMemo(
    () =>
      clients
        .map((client) => ({
          client,
          stats: statsFor(client.id),
          chase: chases.find((c) => c.clientId === client.id),
        }))
        .filter((r) => (filter === 'overdue' ? r.stats.overdue > 0 : true)),
    [clients, chases, statsFor, filter],
  );

  const totalMissing = clients.reduce((n, c) => n + statsFor(c.id).missing, 0);
  const totalOverdue = clients.reduce((n, c) => n + statsFor(c.id).overdue, 0);
  const activeChases = chases.filter((c) => c.stage !== 'closed').length;
  const awaiting = chases.filter((c) => c.stage !== 'closed').reduce((n, c) => n + c.items.filter((i) => i.status === 'requested').length, 0);

  /**
   * "Run the engine" gathers every unchased detection across all clients and
   * takes them through Review → Approve in the workspace before anything sends.
   */
  const runEngine = () => {
    const pending = missing.filter((m) => !m.chased);
    const ids = [...new Set(pending.map((m) => m.clientId))];
    if (ids.length === 0) return;
    setChasing({
      clientIds: ids,
      note: intl.formatMessage(m.runEngineNote, { detections: pending.length, clients: ids.length }),
    });
  };

  const chaseOne = (clientId: string) => {
    const ids = missing.filter((m) => m.clientId === clientId && !m.chased).map((m) => m.id);
    if (!clients.some((c) => c.id === clientId)) return;
    setChasing({
      clientIds: [clientId],
      missingItemIds: ids,
      // No note is an absent note, not a `note: undefined` the modal would
      // still have to reason about.
      ...(ids.length ? {} : { note: intl.formatMessage(m.alreadyRequestedNote) }),
    });
  };

  const [chasing, setChasing] = useState<{ clientIds: string[]; missingItemIds?: string[]; note?: string } | null>(null);
  const active = chases.find((c) => c.id === openChase) ?? null;

  return (
    <div className="flex-1 flex flex-col min-w-0 bg-ground h-full overflow-y-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
      <div className="px-10 py-8 shrink-0">
        <div className="flex items-start justify-between mb-8 gap-4 flex-wrap">
          <div>
            <h1 className="font-sans text-3xl font-semibold text-white tracking-tight">{intl.formatMessage(m.heading)}</h1>
            <p className="text-zinc-400 mt-2">{intl.formatMessage(m.subheading)}</p>
          </div>
          <div className="flex items-center gap-3 flex-wrap">
            {badge}
            <button
              onClick={() => setMessagesOpen(true)}
              className="flex items-center gap-2 px-5 py-3 text-sm font-bold text-zinc-300 bg-card border border-white/10 rounded-full hover:bg-white/5 transition-all shadow-lg"
            >
              <MessageSquare size={16} />
              {intl.formatMessage(m.itemMessagesAction)}
              {itemMessages.length > 0 && <span className="px-2 py-0.5 rounded-full bg-brand text-white text-[11px]">{itemMessages.length}</span>}
            </button>
            <button
              onClick={() => setPolicyOpen(true)}
              className="flex items-center gap-2 px-5 py-3 text-sm font-bold text-zinc-300 bg-card border border-white/10 rounded-full hover:bg-white/5 transition-all shadow-lg"
            >
              <SlidersHorizontal size={16} />
              {intl.formatMessage(m.policyAction)}
            </button>
            <button
              onClick={runEngine}
              disabled={totalMissing === 0}
              className="flex items-center gap-2 px-6 py-3 bg-brand text-white text-sm font-bold rounded-full hover:bg-brand-hover transition-all shadow-glow-cta-soft disabled:opacity-40"
            >
              <Play size={16} fill="currentColor" />
              {intl.formatMessage(m.runEngineAction)}
            </button>
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          <StatCard
            title={intl.formatMessage(m.statMissingTitle)}
            value={String(totalMissing)}
            subtitle={intl.formatMessage(m.statMissingSubtitle, {
              count: clients.filter((c) => statsFor(c.id).missing > 0).length,
            })}
            trend={intl.formatMessage(m.statMissingTrend)}
          />
          <StatCard
            title={intl.formatMessage(m.statChasesTitle)}
            value={String(activeChases)}
            subtitle={intl.formatMessage(m.statChasesSubtitle, { count: awaiting })}
            trend={intl.formatMessage(m.statChasesTrend, {
              first: chasePolicy.reminderOneDays,
              second: chasePolicy.reminderTwoDays,
            })}
          />
          <StatCard
            title={intl.formatMessage(m.statOverdueTitle)}
            value={String(totalOverdue)}
            subtitle={intl.formatMessage(m.statOverdueSubtitle)}
            trend={intl.formatMessage(m.statOverdueTrend, {
              count: clients.filter((c) => statsFor(c.id).overdue > 0).length,
            })}
            alert={totalOverdue > 0}
          />
        </div>
      </div>

      <div className="flex-1 bg-white rounded-t-[40px] m-4 mt-0 p-8 shadow-2xl flex flex-col overflow-hidden border border-white/10">
        <div className="px-2 py-4 flex items-center justify-between mb-4 gap-4 flex-wrap">
          <h3 className="font-sans text-xl font-bold text-zinc-900 tracking-tight">{intl.formatMessage(m.tableHeading)}</h3>
          <div className="flex items-center gap-2 bg-pale p-1.5 rounded-full">
            <button
              onClick={() => setFilter('all')}
              className={`px-5 py-2 rounded-full text-sm font-semibold transition-colors ${filter === 'all' ? 'bg-white text-black shadow-sm' : 'text-zinc-500 hover:text-black'}`}
            >
              {intl.formatMessage(m.filterAll)}
            </button>
            <button
              onClick={() => setFilter('overdue')}
              className={`px-5 py-2 rounded-full text-sm font-semibold transition-colors ${filter === 'overdue' ? 'bg-white text-black shadow-sm' : 'text-zinc-500 hover:text-black'}`}
            >
              {intl.formatMessage(m.filterOverdue)}
            </button>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto">
          <table className="w-full text-left text-sm whitespace-nowrap">
            <thead className="text-[11px] uppercase tracking-widest font-bold text-zinc-400">
              <tr>
                <th className="px-4 py-4">{intl.formatMessage(commonLabels.client)}</th>
                <th className="px-4 py-4 text-right">{intl.formatMessage(m.columnMissing)}</th>
                <th className="px-4 py-4 text-right">{intl.formatMessage(m.columnRequested)}</th>
                <th className="px-4 py-4 text-right">{intl.formatMessage(m.columnOverdue)}</th>
                <th className="px-4 py-4">{intl.formatMessage(m.columnStage)}</th>
                <th className="px-4 py-4">{intl.formatMessage(m.columnPolicy)}</th>
                <th className="px-4 py-4">{intl.formatMessage(m.columnLastUpload)}</th>
                <th className="px-4 py-4 text-right">{intl.formatMessage(m.columnAction)}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-100">
              {rows.length === 0 && (
                <tr>
                  <td colSpan={8} className="px-4 py-16 text-center text-zinc-400 font-medium">
                    {intl.formatMessage(m.emptyRows)}
                  </td>
                </tr>
              )}
              {rows.map(({ client, stats, chase }) => (
                <tr key={client.id} className="hover:bg-zinc-50 transition-colors group">
                  <td className="px-4 py-5">
                    <div className="flex items-center gap-3">
                      <div className="w-10 h-10 rounded-xl bg-zinc-100 flex items-center justify-center font-bold text-zinc-900 border border-zinc-200">
                        {client.name.charAt(0)}
                      </div>
                      <span className="text-zinc-900 font-bold text-[15px]">{client.name}</span>
                    </div>
                  </td>
                  <td className="px-4 py-5 text-right font-semibold text-zinc-900">{stats.missing}</td>
                  <td className="px-4 py-5 text-right font-medium text-zinc-500">{stats.requested}</td>
                  <td className="px-4 py-5 text-right font-bold">
                    {/* Both arms render the same count — the branch is styling,
                        not content. The zero used to be typed out as a literal,
                        which is a numeral the locale should format, not copy. */}
                    {stats.overdue > 0 ? (
                      <span className="bg-brand text-white px-3 py-1 rounded-full text-xs">{stats.overdue}</span>
                    ) : (
                      <span className="text-zinc-400">{stats.overdue}</span>
                    )}
                  </td>
                  <td className="px-4 py-5">
                    {chase ? (
                      <span className={`inline-flex px-3 py-1 rounded-full text-[11px] font-bold uppercase tracking-wide ${STAGE_LABEL[chase.stage].light}`}>
                        {intl.formatMessage(STAGE_LABEL[chase.stage].label)}
                      </span>
                    ) : (
                      <span className="text-zinc-400 text-[13px] font-medium">{intl.formatMessage(m.noChaseSent)}</span>
                    )}
                  </td>
                  <td className="px-4 py-5 text-zinc-600">
                    <span className="inline-flex px-3 py-1 rounded-full text-[11px] font-bold uppercase tracking-wide bg-zinc-900 text-white">
                      {chase?.policy ??
                        intl.formatMessage(m.standardPolicy, {
                          first: chasePolicy.reminderOneDays,
                          second: chasePolicy.reminderTwoDays,
                        })}
                    </span>
                  </td>
                  <td className="px-4 py-5 text-zinc-500 text-sm font-medium">{chase?.lastUpload ?? '—'}</td>
                  <td className="px-4 py-5 text-right">
                    <div className="flex items-center gap-2 justify-end">
                      {chase && (
                        <button
                          onClick={() => setOpenChase(chase.id)}
                          className="text-sm font-bold text-zinc-600 hover:text-black px-3 py-2.5 rounded-full hover:bg-zinc-100 transition-colors inline-flex items-center gap-1"
                        >
                          {intl.formatMessage(m.openAction)}
                          <ChevronRight size={14} />
                        </button>
                      )}
                      <button
                        onClick={() => chaseOne(client.id)}
                        disabled={stats.missing === 0}
                        className="text-sm font-bold text-white bg-zinc-900 hover:bg-black px-4 py-2.5 rounded-full transition-colors shadow-md disabled:opacity-30 disabled:cursor-not-allowed"
                      >
                        {intl.formatMessage(m.reviewAndChaseAction)}
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <AnimatePresence>
        {chasing && (
          <ChaseModal
            clientIds={chasing.clientIds}
            {...(chasing.missingItemIds === undefined ? {} : { missingItemIds: chasing.missingItemIds })}
            {...(chasing.note === undefined ? {} : { note: chasing.note })}
            onClose={() => setChasing(null)}
          />
        )}
        {active && <ChaseDetail chase={active} onClose={() => setOpenChase(null)} />}
        {policyOpen && (
          <PolicyPanel
            policy={chasePolicy}
            onChange={(p) => {
              setChasePolicy(p);
              logAudit({
                action: intl.formatMessage(m.policyAudit),
                scope: intl.formatMessage(m.policyAuditScope, {
                  first: p.reminderOneDays,
                  second: p.reminderTwoDays,
                  escalate: p.escalateAfterDays,
                }),
                reviewOpened: true,
              });
            }}
            onClose={() => setPolicyOpen(false)}
          />
        )}
        {messagesOpen && <ItemMessagesPanel onClose={() => setMessagesOpen(false)} />}
      </AnimatePresence>
    </div>
  );
}

const mDetail = defineMessages({
  confirmTitle: { id: 'chase.chaseDetail.confirmTitle', defaultMessage: 'Save your changes to this chase?' },
  confirmItems: {
    id: 'chase.chaseDetail.confirmItems',
    defaultMessage: '{count, plural, one {# item} other {# items}}',
  },
  confirmWording: { id: 'chase.chaseDetail.confirmWording', defaultMessage: 'the message wording' },
  confirmChase: { id: 'chase.chaseDetail.confirmChase', defaultMessage: 'the chase itself' },
  confirmDetail: { id: 'chase.chaseDetail.confirmDetail', defaultMessage: '{changes} changed and not yet saved.' },
  confirmSave: { id: 'chase.chaseDetail.confirmSave', defaultMessage: 'Save and close' },
  confirmDiscard: { id: 'chase.chaseDetail.confirmDiscard', defaultMessage: 'Close without saving' },
  saveAudit: { id: 'chase.chaseDetail.saveAudit', defaultMessage: 'Updated a chase' },
  // "item(s)" is not a plural, it is a plural avoided — and it survives
  // translation no better than a concatenated 's' would, because the parenthesis
  // is English grammar frozen into the message. ICU asks the locale instead.
  saveAuditScope: {
    id: 'chase.chaseDetail.saveAuditScope',
    defaultMessage: '{client} — {count, plural, one {# item} other {# items}}',
  },
  saveAuditScopeClosed: {
    id: 'chase.chaseDetail.saveAuditScopeClosed',
    defaultMessage: '{client} — {count, plural, one {# item} other {# items}}, chase closed',
  },
  uploadAudit: { id: 'chase.chaseDetail.uploadAudit', defaultMessage: 'Uploaded a chased document' },
  uploadAuditScope: { id: 'chase.chaseDetail.uploadAuditScope', defaultMessage: '{supplier} — {client}' },
  messageSection: { id: 'chase.chaseDetail.messageSection', defaultMessage: 'Message sent (SMS)' },
  nextWordingLabel: { id: 'chase.chaseDetail.nextWordingLabel', defaultMessage: 'Wording for the next reminder' },
  doneEditing: { id: 'chase.chaseDetail.doneEditing', defaultMessage: 'Done editing' },
  writeNext: { id: 'chase.chaseDetail.writeNext', defaultMessage: 'Write the next reminder yourself' },
  rewritten: { id: 'chase.chaseDetail.rewritten', defaultMessage: 'Rewritten — unsaved' },
  usesYourWording: { id: 'chase.chaseDetail.usesYourWording', defaultMessage: 'Next reminder uses your wording' },
  linkValid: { id: 'chase.chaseDetail.linkValid', defaultMessage: 'Link valid {hours}h' },
  linkExpired: { id: 'chase.chaseDetail.linkExpired', defaultMessage: 'Link expired' },
  linkNote: {
    id: 'chase.chaseDetail.linkNote',
    defaultMessage: 'OTP to the registered mobile · upload-only portal · forwardable by design',
  },
  itemsSection: { id: 'chase.chaseDetail.itemsSection', defaultMessage: 'Requested items — {count} outstanding' },
  foundBy: { id: 'chase.chaseDetail.foundBy', defaultMessage: 'Found by: {tag}' },
  foundByDetail: { id: 'chase.chaseDetail.foundByDetail', defaultMessage: '{detail} Check it under {where}.' },
  waitingOn: { id: 'chase.chaseDetail.waitingOn', defaultMessage: 'Waiting on {name}' },
  uploadItAction: { id: 'chase.chaseDetail.uploadItAction', defaultMessage: 'Upload it' },
  unavailableAction: { id: 'chase.chaseDetail.unavailableAction', defaultMessage: 'Unavailable' },
  stopChasingAction: { id: 'chase.chaseDetail.stopChasingAction', defaultMessage: 'Stop chasing' },
  cashCodeAction: { id: 'chase.chaseDetail.cashCodeAction', defaultMessage: 'Cash code' },
  unsaved: { id: 'chase.chaseDetail.unsaved', defaultMessage: 'Unsaved' },
  undoAction: { id: 'chase.chaseDetail.undoAction', defaultMessage: 'Undo' },
  revertAudit: { id: 'chase.chaseDetail.revertAudit', defaultMessage: 'Reverted a chased item' },
  revertAuditScope: {
    id: 'chase.chaseDetail.revertAuditScope',
    defaultMessage: '{supplier} — {client} (was {status})',
  },
  timelineSection: { id: 'chase.chaseDetail.timelineSection', defaultMessage: 'Timeline' },
  unsavedChanges: {
    id: 'chase.chaseDetail.unsavedChanges',
    defaultMessage: '{count, plural, one {# unsaved change} other {# unsaved changes}}',
  },
  willClose: { id: 'chase.chaseDetail.willClose', defaultMessage: 'Chase will be closed' },
  closeTooltip: {
    id: 'chase.chaseDetail.closeTooltip',
    defaultMessage: 'Stops asking for all {count, plural, one {# outstanding item} other {# outstanding items}}',
  },
  closeTooltipNone: { id: 'chase.chaseDetail.closeTooltipNone', defaultMessage: 'Stops this chase' },
  closeTooltipDetail: {
    id: 'chase.chaseDetail.closeTooltipDetail',
    defaultMessage: 'The items stay on the missing list — closing the chase stops the asking, it does not answer anything. To stop one document only, use Stop chasing on its row.',
  },
  closingUndo: { id: 'chase.chaseDetail.closingUndo', defaultMessage: 'Closing whole chase — undo' },
  closeWhole: { id: 'chase.chaseDetail.closeWhole', defaultMessage: 'Close whole chase' },
  closeWholeCount: { id: 'chase.chaseDetail.closeWholeCount', defaultMessage: 'Close whole chase ({count})' },
  resendAction: { id: 'chase.chaseDetail.resendAction', defaultMessage: 'Re-send link' },
  resendBlockedTitle: { id: 'chase.chaseDetail.resendBlockedTitle', defaultMessage: 'The link is still live' },
  resendBlockedDetail: {
    id: 'chase.chaseDetail.resendBlockedDetail',
    defaultMessage: 'It was sent {age} and lasts {hours}h, so re-sending now gives {name} the same link again. Another can go in {wait}.',
  },
  escalateAction: { id: 'chase.chaseDetail.escalateAction', defaultMessage: 'Escalate' },
  escalateTitle: { id: 'chase.chaseDetail.escalateTitle', defaultMessage: 'Flags this for escalation' },
  escalateDetail: {
    id: 'chase.chaseDetail.escalateDetail',
    defaultMessage: "Moves the chase to Overdue & Escalated so it is not lost among the routine ones. It does not yet contact anyone new — going over the contact's head to the owner or director is still to be built.",
  },
  reminderAction: { id: 'chase.chaseDetail.reminderAction', defaultMessage: 'Send reminder now' },
  reminderWaitAction: { id: 'chase.chaseDetail.reminderWaitAction', defaultMessage: 'Reminder in {wait}' },
  reminderBlockedTitle: {
    id: 'chase.chaseDetail.reminderBlockedTitle',
    defaultMessage: 'Another text can go in {wait}',
  },
  reminderBlockedDetail: {
    id: 'chase.chaseDetail.reminderBlockedDetail',
    defaultMessage: '{name} was texted {age}. Texting again this soon repeats the same ask — change the wait under Settings → Chasing, or use Escalate if it is not working.',
  },
  reminderAudit: { id: 'chase.chaseDetail.reminderAudit', defaultMessage: 'Sent chase reminder' },
  saveAction: { id: 'chase.chaseDetail.saveAction', defaultMessage: 'Save changes' },
});

function ChaseDetail({ chase, onClose }: { chase: Chase; onClose: () => void }) {
  const {
    sendReminder, escalateChase, closeChase, resendLink, setChaseItemStatus,
    revertChaseItem, logAudit, chasePolicy, ingest, setChaseMessage,
  } = useAppContext();
  const intl = useIntl();
  const confirm = useConfirm();
  const fileRef = useRef<HTMLInputElement>(null);
  /** Which requested item the accountant is putting a file against. */
  const [uploadFor, setUploadForState] = useState<ChaseItem | null>(null);

  /**
   * Decisions are staged rather than applied on click.
   *
   * Marking three items unavailable used to be three irreversible writes made
   * while thinking out loud, and the only way back was Undo, one at a time.
   * Held here they are a draft: the modal shows what it would become, Save
   * commits the lot, and closing with work outstanding says so rather than
   * dropping it silently.
   */
  const [draft, setDraft] = useState<Record<string, ChaseItemStatus>>({});
  const [closingChase, setClosingChase] = useState(false);
  /**
   * A rewrite of what the next send will say.
   *
   * `undefined` means untouched. The message above it is what already reached
   * the client's phone and stays read-only — a sent text cannot be edited,
   * only the next one can.
   */
  const [messageDraft, setMessageDraft] = useState<string | undefined>(undefined);
  const [editingMessage, setEditingMessage] = useState(false);
  const currentMessage = chase.nextMessage ?? chase.message;

  const statusOf = (item: ChaseItem): ChaseItemStatus => draft[item.missingItemId] ?? item.status;
  const changed = Object.entries(draft).filter(
    ([id, status]) => chase.items.find((i) => i.missingItemId === id)?.status !== status,
  );
  const messageChanged = messageDraft !== undefined && messageDraft.trim() !== currentMessage.trim();
  const dirty = changed.length > 0 || closingChase || messageChanged;

  const stage = (item: ChaseItem, status: ChaseItemStatus) =>
    setDraft((prev) => ({ ...prev, [item.missingItemId]: status }));

  /** Writes the draft through, in one go, and says what it did. */
  const save = () => {
    for (const [missingItemId, status] of changed) {
      if (status === 'requested') revertChaseItem(chase.id, missingItemId);
      else setChaseItemStatus(chase.id, missingItemId, status);
    }
    if (messageChanged) setChaseMessage(chase.id, messageDraft);
    if (closingChase) closeChase(chase.id);
    if (changed.length || closingChase) {
      logAudit({
        action: intl.formatMessage(mDetail.saveAudit),
        scope: intl.formatMessage(closingChase ? mDetail.saveAuditScopeClosed : mDetail.saveAuditScope, {
          client: chase.clientName,
          count: changed.length,
        }),
        reviewOpened: true,
      });
    }
    setDraft({});
    setClosingChase(false);
    setMessageDraft(undefined);
    setEditingMessage(false);
  };

  /** Nothing in progress is thrown away without being offered a way to keep it. */
  const attemptClose = async () => {
    if (!dirty) { onClose(); return; }
    // The list is still assembled in code: the parts are separate messages, the
    // joining commas and " and " are not yet translatable. See #65 follow-up.
    const changes = [
      changed.length ? intl.formatMessage(mDetail.confirmItems, { count: changed.length }) : '',
      messageChanged ? intl.formatMessage(mDetail.confirmWording) : '',
      closingChase ? intl.formatMessage(mDetail.confirmChase) : '',
    ]
      .filter(Boolean)
      .join(', ')
      .replace(/, ([^,]*)$/, ' and $1');
    const answer = await confirm({
      title: intl.formatMessage(mDetail.confirmTitle),
      detail: intl.formatMessage(mDetail.confirmDetail, { changes }),
      confirmLabel: intl.formatMessage(mDetail.confirmSave),
      altLabel: intl.formatMessage(mDetail.confirmDiscard),
    });
    if (answer === true) { save(); onClose(); }
    else if (answer === 'alt') onClose();
  };

  const setUploadFor = (item: ChaseItem | null) => {
    setUploadForState(item);
    if (item) fileRef.current?.click();
  };

  /**
   * The accountant's own copy of the missing document.
   *
   * It goes in through the same door as every other upload — ingest, read,
   * filed under the client — and the chase then closes itself, because a
   * document that matches an outstanding request answers it wherever it came
   * from. Nothing here marks the item received directly; that would be the
   * app claiming evidence exists rather than reacting to evidence existing.
   */
  const handleUpload = (files: FileList | null) => {
    const item = uploadFor;
    setUploadForState(null);
    // One guard, not two: for a FileList "length > 0" and "index 0 exists" are
    // the same fact, so checking the file itself restates the invariant rather
    // than asserting past it. (The earlier form checked `files.length` and then
    // re-checked `files[0]` under a comment claiming the first check made the
    // second unnecessary — which read as a contradiction.)
    const file = files?.[0];
    if (!item || !file) return;
    ingest([{ name: file.name, size: file.size, raw: file }], chase.clientId, 'web', {
      uploader: 'You (web upload)',
      kind: 'cost',
    });
    logAudit({
      action: intl.formatMessage(mDetail.uploadAudit),
      scope: intl.formatMessage(mDetail.uploadAuditScope, { supplier: item.supplier, client: chase.clientName }),
      reviewOpened: true,
    });
  };
  // How long before another text may go to this person.
  const cooldown = cooldownFor(chase.lastSmsAtMs, chasePolicy.resendAfterHours);
  const outstanding = chase.items.filter((i) => i.status === 'requested');

  return (
    <Modal onClose={attemptClose}>
      <div className="w-full max-w-3xl border border-white/5 rounded-[32px] bg-card shadow-2xl overflow-hidden">
        <input
          ref={fileRef}
          type="file"
          className="hidden"
          accept=".jpg,.jpeg,.png,.gif,.bmp,.tiff,.heic,.pdf,.doc,.docx,.odt,.rtf,.csv,.xlsx"
          onChange={(e) => { handleUpload(e.target.files); e.target.value = ''; }}
        />

        <div className="p-6 flex items-start justify-between gap-4 border-b border-white/5">
          <div className="flex items-center gap-4 min-w-0">
            <div className="w-12 h-12 rounded-2xl bg-raised flex items-center justify-center text-white border border-white/5 shadow-inner shrink-0">
              <Send size={20} />
            </div>
            <div className="min-w-0">
              <h3 className="font-sans font-bold text-xl text-white tracking-tight truncate">{chase.clientName}</h3>
              <p className="text-[12px] text-zinc-500 mt-1 font-semibold uppercase tracking-wider truncate">
                {chase.recipientName} · {chase.recipientMobile}
              </p>
            </div>
          </div>
          <span className={`shrink-0 px-3 py-1.5 rounded-full text-[11px] font-bold uppercase tracking-wide ${STAGE_LABEL[chase.stage].dark}`}>
            {intl.formatMessage(STAGE_LABEL[chase.stage].label)}
          </span>
        </div>

        <div className="p-6 flex flex-col gap-6 max-h-[60vh] overflow-y-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          <Section title={intl.formatMessage(mDetail.messageSection)}>
            <div className="bg-ground/60 border border-white/5 rounded-2xl p-4 text-[13px] text-zinc-300 font-mono leading-relaxed shadow-inner whitespace-pre-wrap">
              {chase.message}
            </div>

            {/* What goes next, which is the only part still changeable. The
                text above has been delivered; rewriting that would be the app
                pretending a sent SMS said something else. */}
            <div className="mt-3">
              {editingMessage ? (
                <>
                  <div className="flex items-center justify-between gap-3 mb-2">
                    <span className="text-[11px] font-bold text-zinc-500 uppercase tracking-wider">
                      {intl.formatMessage(mDetail.nextWordingLabel)}
                    </span>
                    <button
                      onClick={() => setEditingMessage(false)}
                      className="text-[11px] font-bold text-zinc-400 hover:text-white transition-colors"
                    >
                      {intl.formatMessage(mDetail.doneEditing)}
                    </button>
                  </div>
                  <MessageEditor
                    value={messageDraft ?? currentMessage}
                    suggested={chase.message}
                    onChange={(text) => setMessageDraft(text)}
                    onReset={() => setMessageDraft(chase.message)}
                  />
                </>
              ) : (
                <div className="flex items-center gap-3 flex-wrap">
                  <button
                    onClick={() => { setMessageDraft(messageDraft ?? currentMessage); setEditingMessage(true); }}
                    className="inline-flex items-center gap-2 px-4 py-2 rounded-full text-[12px] font-bold text-zinc-300 bg-card border border-white/5 hover:bg-white/5 transition-colors"
                  >
                    <PencilLine size={13} />
                    {intl.formatMessage(mDetail.writeNext)}
                  </button>
                  {(messageChanged || chase.nextMessage) && (
                    <span className="text-[11.5px] font-bold text-amber-400">
                      {intl.formatMessage(messageChanged ? mDetail.rewritten : mDetail.usesYourWording)}
                    </span>
                  )}
                </div>
              )}
            </div>
            <div className="flex items-center gap-3 mt-3 flex-wrap text-[12px] font-semibold">
              <span className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full ${chase.linkExpiresInHours > 0 ? 'bg-brand/10 text-brand' : 'bg-red-500/10 text-red-400'}`}>
                <Link2 size={12} />
                {chase.linkExpiresInHours > 0
                  ? intl.formatMessage(mDetail.linkValid, { hours: chase.linkExpiresInHours })
                  : intl.formatMessage(mDetail.linkExpired)}
              </span>
              <span className="text-zinc-600">{intl.formatMessage(mDetail.linkNote)}</span>
            </div>
          </Section>

          <Section title={intl.formatMessage(mDetail.itemsSection, { count: outstanding.length })}>
            <div className="bg-ground/60 border border-white/5 rounded-2xl divide-y divide-white/5 shadow-inner">
              {chase.items.map((item) => (
                <div key={item.missingItemId} className="px-4 py-3 flex items-center justify-between gap-3 flex-wrap">
                  <div className="min-w-0">
                    <div className="text-sm font-bold text-white truncate">{item.supplier}</div>
                    <div className="text-[12px] text-zinc-500 flex items-center gap-2 flex-wrap">
                      <span>{item.date} · {item.amount ? currency(item.amount) : '—'}</span>
                      {/* Which engine found this, because five different kinds
                          of evidence were being shown as one flat list — a
                          bank line with no receipt is a fact, a recurring bill
                          that has not turned up is a guess. */}
                      {(() => {
                        const found = detectionOf(item.origin.detectedBy);
                        return (
                          <Tooltip
                            label={intl.formatMessage(mDetail.foundBy, { tag: intl.formatMessage(found.tag) })}
                            detail={intl.formatMessage(mDetail.foundByDetail, {
                              detail: intl.formatMessage(found.detail),
                              where: intl.formatMessage(found.where),
                            })}
                          >
                            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10.5px] font-bold uppercase tracking-wide text-zinc-400 bg-white/[0.05] cursor-help">
                              <FileSearch size={10} />
                              {intl.formatMessage(found.tag)}
                            </span>
                          </Tooltip>
                        );
                      })()}
                    </div>
                  </div>
                  {statusOf(item) === 'requested' ? (
                    <div className="flex items-center gap-1.5 flex-wrap justify-end">
                      {/* Waiting is the normal state and it is said out loud,
                          because the honest answer to "has it come in yet" is
                          usually no. The item closes itself the moment the
                          document turns up, from any channel. */}
                      <span className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-[11px] font-bold text-zinc-500 bg-white/[0.03] whitespace-nowrap">
                        <Clock size={11} />
                        {intl.formatMessage(mDetail.waitingOn, { name: chase.recipientName.split(' ')[0] })}
                      </span>
                      {/* The accountant often already has the receipt — it came
                          by email, or it is in their own files. Uploading it
                          here is the one thing that genuinely answers the
                          request without waiting for anybody. */}
                      <MiniBtn
                        icon={Upload}
                        label={intl.formatMessage(mDetail.uploadItAction)}
                        primary
                        onClick={() => setUploadFor(item)}
                      />
                      <MiniBtn
                        icon={ShieldOff}
                        label={intl.formatMessage(mDetail.unavailableAction)}
                        onClick={() => stage(item, 'unavailable')}
                      />
                      {/* Per document, because "Close chase" in the footer
                          never said which one it meant. This stops the asking
                          for this row only; the gap stays on the missing list
                          because nothing has answered it. */}
                      <MiniBtn
                        icon={Ban}
                        label={intl.formatMessage(mDetail.stopChasingAction)}
                        onClick={() => stage(item, 'dismissed')}
                      />
                      <MiniBtn
                        icon={Wand2}
                        label={intl.formatMessage(mDetail.cashCodeAction)}
                        onClick={() => stage(item, 'cash-coded')}
                      />
                    </div>
                  ) : (
                    // Every call on an item is reversible: nothing here is a
                    // one-way door.
                    <div className="flex items-center gap-2 justify-end">
                      <StatusPill status={statusOf(item)} />
                      {draft[item.missingItemId] && draft[item.missingItemId] !== item.status && (
                        <span className="text-[11px] font-bold text-amber-400 whitespace-nowrap">
                          {intl.formatMessage(mDetail.unsaved)}
                        </span>
                      )}
                      <MiniBtn
                        icon={Undo2}
                        label={intl.formatMessage(mDetail.undoAction)}
                        onClick={() => {
                          revertChaseItem(chase.id, item.missingItemId);
                          logAudit({
                            action: intl.formatMessage(mDetail.revertAudit),
                            scope: intl.formatMessage(mDetail.revertAuditScope, {
                              supplier: item.supplier,
                              client: chase.clientName,
                              status: item.status,
                            }),
                            reviewOpened: true,
                          });
                        }}
                      />
                    </div>
                  )}
                </div>
              ))}
            </div>
          </Section>

          <Section title={intl.formatMessage(mDetail.timelineSection)}>
            <div className="flex flex-col gap-3">
              {chase.events.map((e, i) => (
                <div key={i} className="flex items-start gap-3">
                  <div className="w-7 h-7 rounded-lg bg-raised border border-white/5 flex items-center justify-center text-zinc-500 shrink-0 mt-0.5">
                    <Clock size={13} />
                  </div>
                  <div className="min-w-0">
                    <div className="text-[13px] font-bold text-white">{e.label}</div>
                    {e.detail && <div className="text-[12px] text-zinc-500">{e.detail}</div>}
                  </div>
                  <span className="ml-auto text-[11px] text-zinc-600 font-semibold shrink-0">{e.at}</span>
                </div>
              ))}
            </div>
          </Section>
        </div>

        {/* Said before the button is pressed, not after. Escalating is
            exempt: that is the deliberate act of going over the contact's head
            because the texts have not worked. */}
        {cooldown.blocked && (
          <div className="px-4 pt-4">
            <SmsCooldownNotice cooldown={cooldown} recipient={chase.recipientName} what="chase" />
          </div>
        )}

        <div className="p-4 bg-raised/50 flex items-center gap-3 flex-wrap justify-end">
          {dirty && (
            <span className="mr-auto text-[12px] font-bold text-amber-400">
              {changed.length
                ? intl.formatMessage(mDetail.unsavedChanges, { count: changed.length })
                : intl.formatMessage(mDetail.willClose)}
            </span>
          )}

          {/* Closing is a decision like any other on this screen, so it waits
              for Save with the rest rather than taking effect under the cursor. */}
          <Tooltip
            label={
              outstanding.length
                ? intl.formatMessage(mDetail.closeTooltip, { count: outstanding.length })
                : intl.formatMessage(mDetail.closeTooltipNone)
            }
            detail={intl.formatMessage(mDetail.closeTooltipDetail)}
          >
            <button
              onClick={() => setClosingChase((v) => !v)}
              className={`px-5 py-2.5 rounded-full text-sm font-bold transition-colors ${
                closingChase ? 'text-amber-400 bg-amber-400/10' : 'text-zinc-400 hover:text-white hover:bg-white/5'
              }`}
            >
              {closingChase
                ? intl.formatMessage(mDetail.closingUndo)
                : outstanding.length
                  ? intl.formatMessage(mDetail.closeWholeCount, { count: outstanding.length })
                  : intl.formatMessage(mDetail.closeWhole)}
            </button>
          </Tooltip>

          <FooterAction
            icon={Link2}
            label={intl.formatMessage(mDetail.resendAction)}
            onClick={() => resendLink(chase.id)}
            blocked={cooldown.blocked}
            blockedTitle={intl.formatMessage(mDetail.resendBlockedTitle)}
            blockedDetail={intl.formatMessage(mDetail.resendBlockedDetail, {
              age: describeAge(intl, cooldown.sentHoursAgo),
              hours: chasePolicy.linkTtlHours,
              name: chase.recipientName.split(' ')[0],
              wait: formatWait(intl, cooldown.hoursLeft),
            })}
          />

          {/* Says what it actually does today. See escalateChase in
              AppContext for the six things it has to do to be real. */}
          <FooterAction
            label={intl.formatMessage(mDetail.escalateAction)}
            onClick={() => escalateChase(chase.id)}
            title={intl.formatMessage(mDetail.escalateTitle)}
            detail={intl.formatMessage(mDetail.escalateDetail)}
          />

          <FooterAction
            icon={Send}
            primary
            label={
              cooldown.blocked
                ? intl.formatMessage(mDetail.reminderWaitAction, { wait: formatWait(intl, cooldown.hoursLeft) })
                : intl.formatMessage(mDetail.reminderAction)
            }
            onClick={() => {
              sendReminder(chase.id);
              logAudit({ action: intl.formatMessage(mDetail.reminderAudit), scope: chase.clientName, reviewOpened: true });
            }}
            blocked={cooldown.blocked}
            blockedTitle={intl.formatMessage(mDetail.reminderBlockedTitle, { wait: formatWait(intl, cooldown.hoursLeft) })}
            blockedDetail={intl.formatMessage(mDetail.reminderBlockedDetail, {
              name: chase.recipientName,
              age: describeAge(intl, cooldown.sentHoursAgo),
            })}
          />

          <button
            onClick={save}
            disabled={!dirty}
            className="flex items-center gap-2 px-6 py-2.5 rounded-full text-sm font-bold text-white bg-brand hover:bg-brand-hover disabled:opacity-40 disabled:cursor-not-allowed transition-all shadow-glow-btn-strong"
          >
            <Check size={15} />
            {intl.formatMessage(mDetail.saveAction)}
          </button>
        </div>
      </div>
    </Modal>
  );
}

const mPolicy = defineMessages({
  heading: { id: 'chase.policyPanel.heading', defaultMessage: 'Chase policy' },
  subheading: { id: 'chase.policyPanel.subheading', defaultMessage: 'SMS only — by design' },
  firstChase: { id: 'chase.policyPanel.firstChase', defaultMessage: 'First chase after (hours)' },
  reminderOne: { id: 'chase.policyPanel.reminderOne', defaultMessage: 'Reminder 1 (days)' },
  reminderTwo: { id: 'chase.policyPanel.reminderTwo', defaultMessage: 'Reminder 2 (days)' },
  escalateAfter: { id: 'chase.policyPanel.escalateAfter', defaultMessage: 'Escalate after (days)' },
  quietFrom: { id: 'chase.policyPanel.quietFrom', defaultMessage: 'Quiet hours from' },
  quietTo: { id: 'chase.policyPanel.quietTo', defaultMessage: 'Quiet hours to' },
  senderId: { id: 'chase.policyPanel.senderId', defaultMessage: 'SMS sender ID' },
  autoChase: { id: 'chase.policyPanel.autoChase', defaultMessage: 'Auto-chase on schedule' },
  autoChaseHint: {
    id: 'chase.policyPanel.autoChaseHint',
    defaultMessage: 'Approving this policy approves its future executions — any change comes back through review.',
  },
  notifyOnUpload: { id: 'chase.policyPanel.notifyOnUpload', defaultMessage: 'Notify me when a client uploads' },
  notifyOnUploadHint: {
    id: 'chase.policyPanel.notifyOnUploadHint',
    defaultMessage: "Dext's 45-vote request. Default on.",
  },
  suppressionLabel: { id: 'chase.policyPanel.suppressionLabel', defaultMessage: 'Suppression:' },
  suppressionBody: {
    id: 'chase.policyPanel.suppressionBody',
    defaultMessage: 'chasing stops automatically when an item is received, marked unavailable, dismissed, cash-coded or exception-approved.',
  },
  save: { id: 'chase.policyPanel.save', defaultMessage: 'Save policy' },
});

function PolicyPanel({ policy, onChange, onClose }: { policy: ChasePolicy; onChange: (p: ChasePolicy) => void; onClose: () => void }) {
  const intl = useIntl();
  const [draft, setDraft] = useState(policy);
  // Keyed to the policy itself, so a field can only ever be set to the type it
  // already holds — a number field cannot write a string into the draft.
  const set = <K extends keyof ChasePolicy>(k: K, v: ChasePolicy[K]) =>
    setDraft({ ...draft, [k]: v });

  return (
    <Modal onClose={onClose}>
      <div className="w-full max-w-lg border border-white/5 rounded-[32px] bg-card shadow-2xl overflow-hidden">
        <div className="p-6 border-b border-white/5">
          <h3 className="font-sans font-bold text-xl text-white tracking-tight">{intl.formatMessage(mPolicy.heading)}</h3>
          <p className="text-[12px] text-zinc-500 mt-1 font-semibold uppercase tracking-wider">
            {intl.formatMessage(mPolicy.subheading)}
          </p>
        </div>
        <div className="p-6 flex flex-col gap-5 max-h-[60vh] overflow-y-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          <div className="grid grid-cols-2 gap-4">
            <Num label={intl.formatMessage(mPolicy.firstChase)} value={draft.firstChaseAfterHours} onChange={(v) => set('firstChaseAfterHours', v)} />
            <Num label={intl.formatMessage(mPolicy.reminderOne)} value={draft.reminderOneDays} onChange={(v) => set('reminderOneDays', v)} />
            <Num label={intl.formatMessage(mPolicy.reminderTwo)} value={draft.reminderTwoDays} onChange={(v) => set('reminderTwoDays', v)} />
            <Num label={intl.formatMessage(mPolicy.escalateAfter)} value={draft.escalateAfterDays} onChange={(v) => set('escalateAfterDays', v)} />
            <Text label={intl.formatMessage(mPolicy.quietFrom)} value={draft.quietHoursStart} onChange={(v) => set('quietHoursStart', v)} />
            <Text label={intl.formatMessage(mPolicy.quietTo)} value={draft.quietHoursEnd} onChange={(v) => set('quietHoursEnd', v)} />
            <Text label={intl.formatMessage(mPolicy.senderId)} value={draft.senderId} onChange={(v) => set('senderId', v)} />
          </div>

          <LinkTtlField value={draft.linkTtlHours} onChange={(v) => set('linkTtlHours', v)} />

          <Toggle
            label={intl.formatMessage(mPolicy.autoChase)}
            hint={intl.formatMessage(mPolicy.autoChaseHint)}
            value={draft.autoChase}
            onChange={(v) => set('autoChase', v)}
          />
          <Toggle
            label={intl.formatMessage(mPolicy.notifyOnUpload)}
            hint={intl.formatMessage(mPolicy.notifyOnUploadHint)}
            value={draft.notifyOnUpload}
            onChange={(v) => set('notifyOnUpload', v)}
          />

          {/* Two messages because the label is bold and the sentence is not:
              a tag inside one message would need a second idiom to render. */}
          <div className="text-[12px] text-zinc-500 leading-relaxed bg-ground/60 border border-white/5 rounded-2xl p-4">
            <span className="font-bold text-zinc-400">{intl.formatMessage(mPolicy.suppressionLabel)}</span>{' '}
            {intl.formatMessage(mPolicy.suppressionBody)}
          </div>
        </div>
        <div className="p-4 bg-raised/50 flex justify-end gap-3">
          <button onClick={onClose} className="px-5 py-2.5 rounded-full text-sm font-bold text-zinc-400 hover:text-white hover:bg-white/5 transition-colors">
            {intl.formatMessage(commonActions.cancel)}
          </button>
          <button
            onClick={() => { onChange(draft); onClose(); }}
            className="px-6 py-2.5 rounded-full text-sm font-bold text-white bg-brand hover:bg-brand-hover transition-all"
          >
            {intl.formatMessage(mPolicy.save)}
          </button>
        </div>
      </div>
    </Modal>
  );
}

const mItems = defineMessages({
  heading: { id: 'chase.itemMessagesPanel.heading', defaultMessage: 'Item messages' },
  subheading: {
    id: 'chase.itemMessagesPanel.subheading',
    defaultMessage: 'Per-document questions over the same SMS link — no app required',
  },
  documentLabel: { id: 'chase.itemMessagesPanel.documentLabel', defaultMessage: 'Document' },
  documentPlaceholder: { id: 'chase.itemMessagesPanel.documentPlaceholder', defaultMessage: 'Choose…' },
  questionLabel: { id: 'chase.itemMessagesPanel.questionLabel', defaultMessage: 'Question' },
  questionPlaceholder: {
    id: 'chase.itemMessagesPanel.questionPlaceholder',
    defaultMessage: 'Is this £850 laptop fully business use?',
  },
  sentHeading: { id: 'chase.itemMessagesPanel.sentHeading', defaultMessage: 'Sent' },
  awaitingReply: { id: 'chase.itemMessagesPanel.awaitingReply', defaultMessage: '{sentAt} · awaiting reply' },
  sendAction: { id: 'chase.itemMessagesPanel.sendAction', defaultMessage: 'Send by SMS' },
  sendAudit: { id: 'chase.itemMessagesPanel.sendAudit', defaultMessage: 'Sent item message' },
  sendAuditScope: { id: 'chase.itemMessagesPanel.sendAuditScope', defaultMessage: '{document} — {client}' },
});

function ItemMessagesPanel({ onClose }: { onClose: () => void }) {
  const { itemMessages, clients, documents, sendItemMessage, logAudit } = useAppContext();
  const intl = useIntl();
  const [clientId, setClientId] = useState(clients[0]?.id ?? '');
  const [question, setQuestion] = useState('');
  const clientDocs = documents.filter((d) => d.clientId === clientId).slice(0, 40);
  const [docLabel, setDocLabel] = useState('');

  return (
    <Modal onClose={onClose}>
      <div className="w-full max-w-lg border border-white/5 rounded-[32px] bg-card shadow-2xl overflow-hidden">
        <div className="p-6 border-b border-white/5">
          <h3 className="font-sans font-bold text-xl text-white tracking-tight">{intl.formatMessage(mItems.heading)}</h3>
          <p className="text-[12px] text-zinc-500 mt-1 font-semibold uppercase tracking-wider">
            {intl.formatMessage(mItems.subheading)}
          </p>
        </div>

        <div className="p-6 flex flex-col gap-4">
          <div className="grid grid-cols-2 gap-4">
            <Select label={intl.formatMessage(commonLabels.client)} value={clientId} onChange={(v) => { setClientId(v); setDocLabel(''); }} options={clients.map((c) => ({ value: c.id, label: c.name }))} />
            <Select
              label={intl.formatMessage(mItems.documentLabel)}
              value={docLabel}
              onChange={setDocLabel}
              options={[{ value: '', label: intl.formatMessage(mItems.documentPlaceholder) }, ...clientDocs.map((d) => ({ value: `${d.supplier} · ${currency(d.total)}`, label: `${d.supplier} · ${currency(d.total)}` }))]}
            />
          </div>
          <div>
            <div className="text-[11px] font-bold text-zinc-500 uppercase tracking-widest mb-2">
              {intl.formatMessage(mItems.questionLabel)}
            </div>
            <textarea
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
              rows={3}
              placeholder={intl.formatMessage(mItems.questionPlaceholder)}
              className="w-full bg-ground border border-white/5 rounded-xl px-4 py-3 text-sm text-white placeholder:text-zinc-600 focus:outline-none focus:border-brand transition-colors resize-none"
            />
          </div>

          {itemMessages.length > 0 && (
            <div>
              <div className="text-[11px] font-bold text-zinc-500 uppercase tracking-widest mb-2.5">
                {intl.formatMessage(mItems.sentHeading)}
              </div>
              <div className="flex flex-col gap-2 max-h-40 overflow-y-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
                {itemMessages.map((m) => (
                  <div key={m.id} className="p-3 rounded-2xl bg-ground/60 border border-white/5">
                    <div className="text-[12px] font-bold text-white">{m.clientName} — {m.documentLabel}</div>
                    <div className="text-[12px] text-zinc-400 mt-0.5">{m.question}</div>
                    <div className="text-[11px] text-zinc-600 font-semibold mt-1">
                      {intl.formatMessage(mItems.awaitingReply, { sentAt: m.sentAt })}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        <div className="p-4 bg-raised/50 flex justify-end">
          <button
            disabled={!question.trim() || !docLabel}
            onClick={() => {
              sendItemMessage(clientId, docLabel, question.trim());
              logAudit({
                action: intl.formatMessage(mItems.sendAudit),
                scope: intl.formatMessage(mItems.sendAuditScope, {
                  document: docLabel,
                  client: clients.find((c) => c.id === clientId)?.name,
                }),
                reviewOpened: true,
              });
              setQuestion('');
            }}
            className="flex items-center gap-2 px-6 py-2.5 rounded-full text-sm font-bold text-white bg-brand hover:bg-brand-hover transition-all disabled:opacity-40"
          >
            <Send size={15} />
            {intl.formatMessage(mItems.sendAction)}
          </button>
        </div>
      </div>
    </Modal>
  );
}

function StatCard({ title, value, subtitle, trend, alert = false }: { title: string; value: string; subtitle: string; trend: string; alert?: boolean }) {
  return (
    <div className="p-6 rounded-[32px] bg-card border border-white/5 flex flex-col relative overflow-hidden group hover:border-brand/30 transition-colors">
      {alert && <div className="absolute top-0 left-0 w-full h-1 bg-brand" />}
      <div className="flex justify-between items-start mb-6 gap-3">
        <h3 className="text-[13px] font-semibold text-zinc-400 tracking-wide">{title}</h3>
        <span className="text-[11px] font-bold text-white bg-brand px-2.5 py-1 rounded-full shrink-0">{trend}</span>
      </div>
      <div>
        <div className="text-5xl font-sans font-bold tracking-tight mb-2 text-white">{value}</div>
        <p className="text-sm text-zinc-500 font-medium">{subtitle}</p>
      </div>
    </div>
  );
}

const mStatus = defineMessages({
  requested: { id: 'chase.statusPill.requested', defaultMessage: 'Requested' },
  received: { id: 'chase.statusPill.received', defaultMessage: 'Received' },
  unavailable: { id: 'chase.statusPill.unavailable', defaultMessage: 'Unavailable' },
  dismissed: { id: 'chase.statusPill.dismissed', defaultMessage: 'Dismissed' },
  cashCoded: { id: 'chase.statusPill.cashCoded', defaultMessage: 'Cash coded' },
});

function StatusPill({ status }: { status: ChaseItemStatus }) {
  const intl = useIntl();
  const map: Record<ChaseItemStatus, { label: MessageDescriptor; cls: string }> = {
    requested: { label: mStatus.requested, cls: 'bg-raised text-zinc-300' },
    received: { label: mStatus.received, cls: 'bg-emerald-500/10 text-emerald-400' },
    unavailable: { label: mStatus.unavailable, cls: 'bg-amber-500/10 text-amber-400' },
    dismissed: { label: mStatus.dismissed, cls: 'bg-zinc-800 text-zinc-500' },
    'cash-coded': { label: mStatus.cashCoded, cls: 'bg-brand/15 text-brand' },
  };
  const s = map[status];
  return (
    <span className={`px-3 py-1.5 rounded-full text-[11px] font-bold tracking-wide ${s.cls}`}>
      {intl.formatMessage(s.label)}
    </span>
  );
}

/**
 * A footer action that explains itself when it cannot be used.
 *
 * `disabled` is deliberately not used: browsers suppress mouse events on a
 * disabled control, so the hover that would explain the block never fires and
 * the button just sits there greyed out. It is marked aria-disabled and its
 * click is ignored instead, which keeps it hoverable, keyboard-reachable, and
 * announced correctly.
 */
function FooterAction({ icon: Icon, label, onClick, blocked, blockedTitle, blockedDetail, title, detail, primary }: {
  icon?: LucideIcon;
  label: string;
  onClick: () => void;
  blocked?: boolean;
  blockedTitle?: string;
  blockedDetail?: string;
  /** Explanation shown when the button is usable. */
  title?: string;
  detail?: string;
  primary?: boolean;
}) {
  const button = (
    <button
      aria-disabled={blocked}
      onClick={() => { if (!blocked) onClick(); }}
      className={`flex items-center gap-2 px-5 py-2.5 rounded-full text-sm font-bold transition-colors ${
        primary
          ? 'text-white bg-brand hover:bg-brand-hover shadow-glow-btn-strong'
          : 'text-zinc-300 bg-card border border-white/5 hover:bg-white/5'
      } ${blocked ? 'opacity-40 cursor-not-allowed hover:bg-inherit' : ''}`}
    >
      {Icon && <Icon size={15} />}
      {label}
    </button>
  );

  const label_ = blocked ? blockedTitle : title;
  const detail_ = blocked ? blockedDetail : detail;
  // A button with no second line passes no `detail` at all, rather than one
  // that is present and undefined.
  return label_ ? <Tooltip label={label_} {...(detail_ === undefined ? {} : { detail: detail_ })}>{button}</Tooltip> : button;
}

function MiniBtn({ icon: Icon, label, onClick, primary }: { icon: LucideIcon; label: string; onClick: () => void; primary?: boolean }) {
  return (
    <button
      onClick={onClick}
      className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full text-[12px] font-bold transition-colors ${
        primary ? 'text-white bg-brand hover:bg-brand-hover' : 'text-zinc-400 hover:text-white hover:bg-white/5 border border-white/5'
      }`}
    >
      <Icon size={12} />
      {label}
    </button>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <h4 className="text-[11px] font-bold text-zinc-500 uppercase tracking-widest mb-3">{title}</h4>
      {children}
    </div>
  );
}

function Modal({ children, onClose }: { children: React.ReactNode; onClose: () => void }) {
  return (
    <motion.div
      initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
      onClick={onClose}
      className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm flex items-start justify-center overflow-y-auto p-10 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
    >
      <motion.div
        initial={{ opacity: 0, y: 24, scale: 0.97 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, y: 24, scale: 0.97 }}
        onClick={(e) => e.stopPropagation()}
        className="relative w-full max-w-3xl flex justify-center"
      >
        <button onClick={onClose} className="absolute -top-3 -right-3 z-10 p-2 bg-card hover:bg-raised text-zinc-400 hover:text-white rounded-full border border-white/10 transition-colors shadow-lg">
          <X size={18} />
        </button>
        {children}
      </motion.div>
    </motion.div>
  );
}

const mTtl = defineMessages({
  label: { id: 'chase.linkTtlField.label', defaultMessage: 'Secure link expires after' },
  hours: { id: 'chase.linkTtlField.hours', defaultMessage: 'hours' },
  // Two messages rather than one plural: the "s" is decided by the hour count
  // crossing 48, not by the day count, so a plural rule would read "1.5 days"
  // where this screen has always said "1.5 day". Extraction, not a rewrite.
  hoursWithDay: { id: 'chase.linkTtlField.hoursWithDay', defaultMessage: 'hours · {days} day' },
  hoursWithDays: { id: 'chase.linkTtlField.hoursWithDays', defaultMessage: 'hours · {days} days' },
  reduced: {
    id: 'chase.linkTtlField.reduced',
    defaultMessage: 'A link cannot outlive 7 days — kept at {hours} hours.',
  },
  hint: {
    id: 'chase.linkTtlField.hint',
    defaultMessage: 'Anything from 1 hour up to 7 days. A link that outlives the conversation is a security risk.',
  },
});

/**
 * Secure-link lifetime: any value the practice wants, up to a week. The cap is
 * enforced here and again in the context, so it holds however the value is set.
 */
export function LinkTtlField({ value, onChange }: { value: number; onChange: (v: number) => void }) {
  const intl = useIntl();
  // Clamped on every keystroke rather than on blur: a ceiling that depends on
  // the field losing focus is a ceiling that can be walked around.
  const [reduced, setReduced] = useState(false);

  const commit = (raw: string) => {
    const asked = Number(raw);
    const clamped = clampLinkTtl(asked);
    setReduced(asked > MAX_LINK_TTL_HOURS);
    onChange(clamped);
  };

  return (
    <div>
      <div className="text-[11px] font-bold text-zinc-500 uppercase tracking-widest mb-2">
        {intl.formatMessage(mTtl.label)}
      </div>
      <div className="flex items-center gap-2 flex-wrap mb-2.5">
        {LINK_TTL_PRESETS.map((p) => (
          <button
            key={p.hours}
            onClick={() => { setReduced(false); onChange(p.hours); }}
            className={`px-3.5 py-2 rounded-full text-[12px] font-bold border transition-all ${
              value === p.hours
                ? 'bg-brand text-white border-brand'
                : 'bg-ground text-zinc-400 border-white/5 hover:text-white hover:border-white/15'
            }`}
          >
            {p.label}
          </button>
        ))}
      </div>
      <div className="flex items-center gap-2">
        <input
          type="number"
          min={MIN_LINK_TTL_HOURS}
          max={MAX_LINK_TTL_HOURS}
          value={value}
          onChange={(e) => commit(e.target.value)}
          className={`w-28 bg-ground border rounded-xl px-4 py-2.5 text-sm text-white focus:outline-none transition-colors ${
            reduced ? 'border-amber-500/50' : 'border-white/5 focus:border-brand'
          }`}
        />
        <span className="text-[13px] text-zinc-500 font-semibold">
          {value >= 24
            ? intl.formatMessage(value >= 48 ? mTtl.hoursWithDays : mTtl.hoursWithDay, {
                days: (value / 24).toFixed(value % 24 === 0 ? 0 : 1),
              })
            : intl.formatMessage(mTtl.hours)}
        </span>
      </div>
      <div className={`text-[11px] mt-1.5 font-medium ${reduced ? 'text-amber-400' : 'text-zinc-600'}`}>
        {reduced
          ? intl.formatMessage(mTtl.reduced, { hours: MAX_LINK_TTL_HOURS })
          : intl.formatMessage(mTtl.hint)}
      </div>
    </div>
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

function Text({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  return (
    <div>
      <div className="text-[11px] font-bold text-zinc-500 uppercase tracking-widest mb-2">{label}</div>
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full bg-ground border border-white/5 rounded-xl px-4 py-2.5 text-sm text-white focus:outline-none focus:border-brand transition-colors"
      />
    </div>
  );
}

function Select({ label, value, onChange, options }: { label: string; value: string; onChange: (v: string) => void; options: { value: string; label: string }[] }) {
  return (
    <div>
      <div className="text-[11px] font-bold text-zinc-500 uppercase tracking-widest mb-2">{label}</div>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full bg-ground border border-white/5 rounded-xl px-4 py-2.5 text-sm text-white focus:outline-none focus:border-brand transition-colors"
      >
        {options.map((o) => (
          <option key={o.value} value={o.value} className="bg-card">{o.label}</option>
        ))}
      </select>
    </div>
  );
}

function Toggle({ label, hint, value, onChange }: { label: string; hint?: string; value: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      onClick={() => onChange(!value)}
      className="bg-ground/60 border border-white/5 rounded-2xl p-4 flex items-center justify-between gap-4 shadow-inner hover:border-white/10 transition-colors text-left"
    >
      <div>
        <div className="text-sm font-bold text-white">{label}</div>
        {hint && <div className="text-[12px] text-zinc-500 mt-0.5">{hint}</div>}
      </div>
      <span className={`w-11 h-6 rounded-full shrink-0 transition-colors relative ${value ? 'bg-brand' : 'bg-white/10'}`}>
        <span className={`absolute top-1 w-4 h-4 rounded-full bg-white transition-all ${value ? 'left-6' : 'left-1'}`} />
      </span>
    </button>
  );
}
