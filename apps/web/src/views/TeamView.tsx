import { useMemo, useRef, useState } from 'react';
import {
  Shield, Plus, Trash2, Check, CircleSlash, AlertTriangle, Sparkles, MapPin, Users,
  KeyRound, ImagePlus, X, UserPlus, Pencil, LucideIcon,
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { defineMessages, useIntl } from 'react-intl';
import { commonActions, commonLabels, commonPlaceholders } from '../i18n/common';
import { useAppContext } from '../context/AppContext';
import { fromSlug, slug, useSegment } from '../lib/router';
import { useConfirm } from '../components/DynamicComponents/ConfirmProvider';
import { DataTable, Pill, type Column } from '../components/DynamicComponents/DataTable';
import { Modal, Field, Toggle } from './ApprovalsView';
import { useScrollActiveIntoView } from '../lib/useScrollActiveIntoView';
import type { Colleague, ColleagueRole, Team, WorkflowTask } from '../lib/types';

/**
 * `TABS` is identity, not copy: it is the `Tab` union, and `slug()`/`fromSlug()`
 * turn its members into the second path segment. Translating it would rewrite
 * every tab's URL. The labels live beside it as message descriptors instead,
 * keyed by the same members so the lookup stays exhaustive.
 */
const TABS = ['Colleagues', 'Teams', 'Tasks'] as const;
type Tab = (typeof TABS)[number];

const TAB_LABELS = defineMessages({
  Colleagues: { id: 'team.teamView.tabColleagues', defaultMessage: 'Colleagues' },
  Teams: { id: 'team.teamView.tabTeams', defaultMessage: 'Teams' },
  Tasks: { id: 'team.teamView.tabTasks', defaultMessage: 'Tasks' },
});

// Not extracted, deliberately: these are the stored values of `ColleagueRole`
// and of `Colleague.permissions`, rendered straight from the record elsewhere
// in this file (`<Pill>{c.role}</Pill>`). Translating the picker but not the
// record would make one row disagree with the chip that set it.
const ROLES: ColleagueRole[] = ['Practice Admin', 'Client Admin', 'Standard User'];
const PERMISSIONS = ['Publish', 'Approve', 'Chase', 'Connect bank', 'Export', 'Delete'];

const m = defineMessages({
  heading: { id: 'team.teamView.heading', defaultMessage: 'Team' },
  subtitle: {
    id: 'team.teamView.subtitle',
    defaultMessage: '{active} active · {teams} teams · {open} open tasks',
  },
  inviteColleague: { id: 'team.teamView.inviteColleague', defaultMessage: 'Invite colleague' },
  createTeam: { id: 'team.teamView.createTeam', defaultMessage: 'Create team' },
  newTask: { id: 'team.teamView.newTask', defaultMessage: 'New task' },
  allClients: { id: 'team.teamView.allClients', defaultMessage: 'All clients' },

  // Engine-derived task explanations.
  feedLive: { id: 'team.teamView.feedLive', defaultMessage: 'Feed is live' },
  noFeed: { id: 'team.teamView.noFeed', defaultMessage: 'No feed — statement fallback' },
  nothingOutstanding: { id: 'team.teamView.nothingOutstanding', defaultMessage: 'Nothing outstanding' },
  stillUnchased: { id: 'team.teamView.stillUnchased', defaultMessage: '{count} still unchased' },
  queueClear: { id: 'team.teamView.queueClear', defaultMessage: 'Queue is clear' },
  awaitingApproval: { id: 'team.teamView.awaitingApproval', defaultMessage: '{count} awaiting approval' },

  // Colleagues table.
  colColleague: { id: 'team.teamView.colColleague', defaultMessage: 'Colleague' },
  colLocation: { id: 'team.teamView.colLocation', defaultMessage: 'Location' },
  colFields: { id: 'team.teamView.colFields', defaultMessage: 'Fields' },
  allAccess: { id: 'team.teamView.allAccess', defaultMessage: 'All' },
  financeHidden: { id: 'team.teamView.financeHidden', defaultMessage: 'Finance hidden' },
  active: { id: 'team.teamView.active', defaultMessage: 'Active' },
  deactivated: { id: 'team.teamView.deactivated', defaultMessage: 'Deactivated' },
  colleaguesEmpty: { id: 'team.teamView.colleaguesEmpty', defaultMessage: 'No colleagues yet.' },
  colleaguesFooter: {
    id: 'team.teamView.colleaguesFooter',
    defaultMessage: 'The account owner cannot be deactivated · roles are set per account',
  },

  // Teams tab.
  teamMembers: { id: 'team.teamView.teamMembers', defaultMessage: '{count} members' },
  editTeam: { id: 'team.teamView.editTeam', defaultMessage: 'Edit team' },
  teamNoMembers: {
    id: 'team.teamView.teamNoMembers',
    defaultMessage: 'No members yet — edit the team to add some.',
  },
  teamsEmpty: {
    id: 'team.teamView.teamsEmpty',
    defaultMessage: 'No teams yet. Create one to group colleagues and scope their client access.',
  },

  // Tasks table.
  colTask: { id: 'team.teamView.colTask', defaultMessage: 'Task' },
  colAssignee: { id: 'team.teamView.colAssignee', defaultMessage: 'Assigned to' },
  colDue: { id: 'team.teamView.colDue', defaultMessage: 'Due' },
  unassigned: { id: 'team.teamView.unassigned', defaultMessage: 'Unassigned' },
  statusDoneAuto: { id: 'team.teamView.statusDoneAuto', defaultMessage: 'Done (auto)' },
  statusBlocked: { id: 'team.teamView.statusBlocked', defaultMessage: 'Blocked' },
  statusComplete: { id: 'team.teamView.statusComplete', defaultMessage: 'Complete' },
  statusWithIssues: { id: 'team.teamView.statusWithIssues', defaultMessage: 'With issues' },
  statusNotApplicable: { id: 'team.teamView.statusNotApplicable', defaultMessage: 'N/A' },
  statusOpen: { id: 'team.teamView.statusOpen', defaultMessage: 'Open' },
  actionComplete: { id: 'team.teamView.actionComplete', defaultMessage: 'Complete' },
  actionCompleteWithIssues: {
    id: 'team.teamView.actionCompleteWithIssues',
    defaultMessage: 'Complete with issues',
  },
  actionNotApplicable: { id: 'team.teamView.actionNotApplicable', defaultMessage: 'Not applicable' },
  tasksEmpty: { id: 'team.teamView.tasksEmpty', defaultMessage: 'No tasks for this scope.' },
  bulkMarkComplete: { id: 'team.teamView.bulkMarkComplete', defaultMessage: 'Mark complete' },
  bulkAssignAction: { id: 'team.teamView.bulkAssignAction', defaultMessage: 'Assign to…' },
  bulkAskAi: { id: 'team.teamView.bulkAskAi', defaultMessage: 'Ask AI about workload' },
  tasksFooter: {
    id: 'team.teamView.tasksFooter',
    defaultMessage: "Recurring per-client checklists scoped to this product's job",
  },

  // Confirmations.
  removeColleagueTitle: { id: 'team.teamView.removeColleagueTitle', defaultMessage: 'Remove {name}?' },
  removeColleagueDetail: {
    id: 'team.teamView.removeColleagueDetail',
    defaultMessage: '{role} · {count, plural, one {# client} other {# clients}}.',
  },
  removeColleagueConsequence: {
    id: 'team.teamView.removeColleagueConsequence',
    defaultMessage: 'Their access ends immediately. Approvals they already gave stay on the record.',
  },
  removeColleagueConfirm: {
    id: 'team.teamView.removeColleagueConfirm',
    defaultMessage: 'Yes, remove them',
  },
  deleteTeamTitle: {
    id: 'team.teamView.deleteTeamTitle',
    defaultMessage: 'Delete the "{name}" team?',
  },
  deleteTeamDetail: {
    id: 'team.teamView.deleteTeamDetail',
    defaultMessage: '{count, plural, one {# member} other {# members}} · {accessLevel}.',
  },
  deleteTeamConsequence: {
    id: 'team.teamView.deleteTeamConsequence',
    defaultMessage: 'Members keep their own client access; only the grouping goes.',
  },
  deleteTeamConfirm: { id: 'team.teamView.deleteTeamConfirm', defaultMessage: 'Yes, delete it' },

  // Bulk-assign modal.
  bulkAssignHeading: { id: 'team.teamView.bulkAssignHeading', defaultMessage: 'Assign to' },
  bulkAssignCount: {
    id: 'team.teamView.bulkAssignCount',
    defaultMessage: '{count, plural, one {# task} other {# tasks}}',
  },

  // Audit entries. These are rendered to a human in the audit table
  // (`AuditTable` reads `action` and `scope` straight out of the log), so they
  // are copy, not machine keys — the same call the reference conversion makes
  // for the chat replies it posts.
  auditSavedColleague: { id: 'team.teamView.auditSavedColleague', defaultMessage: 'Saved colleague' },
  auditColleagueScope: { id: 'team.teamView.auditColleagueScope', defaultMessage: '{name} — {role}' },
  auditPasswordReset: {
    id: 'team.teamView.auditPasswordReset',
    defaultMessage: 'Sent a password reset link',
  },
  auditPasswordResetScope: {
    id: 'team.teamView.auditPasswordResetScope',
    defaultMessage: '{name} — {email}',
  },
  auditNewColleague: { id: 'team.teamView.auditNewColleague', defaultMessage: 'new colleague' },
  auditAssignedTask: { id: 'team.teamView.auditAssignedTask', defaultMessage: 'Assigned a task' },
  auditAssignedTaskScope: {
    id: 'team.teamView.auditAssignedTaskScope',
    defaultMessage: '{title} → {assignee}',
  },
  auditSavedTeam: { id: 'team.teamView.auditSavedTeam', defaultMessage: 'Saved team' },
  auditSavedTeamScope: {
    id: 'team.teamView.auditSavedTeamScope',
    defaultMessage: '{name} — {count} member(s)',
  },
  auditDeletedTeam: { id: 'team.teamView.auditDeletedTeam', defaultMessage: 'Deleted team' },
  auditCreatedTask: { id: 'team.teamView.auditCreatedTask', defaultMessage: 'Created a task' },
  auditCreatedTaskScope: {
    id: 'team.teamView.auditCreatedTaskScope',
    defaultMessage: '{title} — {clientName} → {assignee}',
  },
  auditAssignedTasks: { id: 'team.teamView.auditAssignedTasks', defaultMessage: 'Assigned tasks' },
  auditAssignedTasksScope: {
    id: 'team.teamView.auditAssignedTasksScope',
    defaultMessage: '{count} task(s) → {assignee}',
  },
});

export function TeamView() {
  const {
    colleagues, teams, tasks, clients, statsFor, saveColleague, removeColleague,
    sendPasswordReset, saveTeam, removeTeam, setTaskStatus, assignTask, addTask,
    startConversation, logAudit,
  } = useAppContext();

  // The sub-tab is the second path segment, so every one has a link.
  const intl = useIntl();
  const confirm = useConfirm();
  const [tabSlug, setTabSlug] = useSegment(1);
  const tab: Tab = fromSlug(tabSlug, TABS) ?? 'Colleagues';
  const tabStripRef = useScrollActiveIntoView<HTMLDivElement>(tab);
  const setTab = (next: Tab) => setTabSlug(next === 'Colleagues' ? null : slug(next));
  const [editing, setEditing] = useState<Colleague | null>(null);
  const [editingTeam, setEditingTeam] = useState<Team | null>(null);
  const [newTask, setNewTask] = useState(false);
  const [bulkAssign, setBulkAssign] = useState<string[] | null>(null);
  const [taskClient, setTaskClient] = useState('all');

  const assignees = colleagues.filter((c) => c.active).map((c) => c.name);

  /**
   * Tasks the engine can answer from real pipeline state, rather than asking a
   * human to tick a box the data already knows the answer to.
   */
  const prefill = useMemo(() => {
    const map: Record<string, { done: boolean; why: string }> = {};
    tasks.forEach((t) => {
      if (!t.aiPrefilled) return;
      const s = statsFor(t.clientId);
      const client = clients.find((c) => c.id === t.clientId);
      if (t.title.startsWith('Confirm bank feed')) {
        map[t.id] = {
          done: !!client?.bankConnected,
          why: intl.formatMessage(client?.bankConnected ? m.feedLive : m.noFeed),
        };
      } else if (t.title.startsWith('Chase missing')) {
        map[t.id] = {
          done: s.missing === 0,
          why: s.missing === 0
            ? intl.formatMessage(m.nothingOutstanding)
            : intl.formatMessage(m.stillUnchased, { count: s.missing }),
        };
      } else if (t.title.startsWith('Approve')) {
        map[t.id] = {
          done: s.approvals === 0,
          why: s.approvals === 0
            ? intl.formatMessage(m.queueClear)
            : intl.formatMessage(m.awaitingApproval, { count: s.approvals }),
        };
      }
    });
    return map;
  }, [tasks, statsFor, clients, intl]);

  const scopedTasks = tasks.filter((t) => taskClient === 'all' || t.clientId === taskClient);

  const colleagueColumns: Column<Colleague>[] = [
    {
      key: 'name', label: intl.formatMessage(m.colColleague), sortValue: (c) => c.name,
      render: (c) => (
        <span className="flex items-center gap-3">
          <span className="w-9 h-9 rounded-xl bg-raised border border-white/5 flex items-center justify-center font-bold text-white text-[13px] shrink-0 overflow-hidden">
            {c.avatarDataUrl ? <img src={c.avatarDataUrl} alt="" className="w-full h-full object-cover" /> : c.name.charAt(0)}
          </span>
          <span>
            <span className="block text-white font-semibold">{c.name}</span>
            <span className="block text-[11px] text-zinc-500">{c.jobTitle ? `${c.jobTitle} · ${c.email}` : c.email}</span>
          </span>
        </span>
      ),
    },
    {
      key: 'role', label: intl.formatMessage(commonLabels.role), sortValue: (c) => c.role,
      render: (c) => <Pill tone={c.role === 'Practice Admin' ? 'blue' : 'neutral'}>{c.role}</Pill>,
    },
    { key: 'location', label: intl.formatMessage(m.colLocation), sortValue: (c) => c.location, render: (c) => <span className="inline-flex items-center gap-1.5 text-zinc-400"><MapPin size={12} />{c.location}</span> },
    {
      key: 'clients', label: intl.formatMessage(commonLabels.clientAccess), align: 'right', sortValue: (c) => c.clientIds.length,
      render: (c) => (c.role === 'Standard User' ? <span className="tabular-nums text-zinc-300">{c.clientIds.length}</span> : <Pill>{intl.formatMessage(m.allAccess)}</Pill>),
    },
    {
      key: 'permissions', label: intl.formatMessage(commonLabels.permissions),
      render: (c) => (
        <span className="flex flex-wrap gap-1">
          {c.permissions.slice(0, 3).map((p) => <Pill key={p}>{p}</Pill>)}
          {c.permissions.length > 3 && <Pill>+{c.permissions.length - 3}</Pill>}
        </span>
      ),
    },
    {
      key: 'hide', label: intl.formatMessage(m.colFields),
      render: (c) => (c.hideFinanceFields ? <Pill tone="amber">{intl.formatMessage(m.financeHidden)}</Pill> : <span className="text-zinc-700">—</span>),
    },
    {
      key: 'active', label: intl.formatMessage(commonLabels.status), align: 'right', sortValue: (c) => String(c.active),
      render: (c) => (c.active ? <Pill tone="green">{intl.formatMessage(m.active)}</Pill> : <Pill tone="red">{intl.formatMessage(m.deactivated)}</Pill>),
    },
  ];

  return (
    <div className="flex-1 flex flex-col min-w-0 bg-ground h-full overflow-hidden">
      <header data-tour="team-header" className="px-4 md:px-10 pt-4 md:pt-8 pb-4 md:pb-5 shrink-0">
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div className="flex items-center gap-4">
            <div className="w-12 h-12 rounded-2xl bg-raised flex items-center justify-center text-white border border-white/5 shadow-inner">
              <Shield size={22} />
            </div>
            <div>
              <h1 className="font-sans text-2xl md:text-3xl font-semibold text-white tracking-tight">{intl.formatMessage(m.heading)}</h1>
              <p className="text-[12px] text-zinc-500 mt-1 font-semibold uppercase tracking-wider">
                {intl.formatMessage(m.subtitle, {
                  active: colleagues.filter((c) => c.active).length,
                  teams: teams.length,
                  open: tasks.filter((t) => t.status === 'open').length,
                })}
              </p>
            </div>
          </div>
          {tab === 'Colleagues' && (
            <button
              onClick={() => setEditing(blankColleague())}
              className="flex items-center gap-2 px-6 py-2.5 bg-brand text-white text-sm font-bold rounded-full hover:bg-brand-hover transition-all shadow-glow-btn-soft"
            >
              <Plus size={16} strokeWidth={2.5} />
              {intl.formatMessage(m.inviteColleague)}
            </button>
          )}
          {tab === 'Teams' && (
            <button
              onClick={() => setEditingTeam(blankTeam())}
              className="flex items-center gap-2 px-6 py-2.5 bg-brand text-white text-sm font-bold rounded-full hover:bg-brand-hover transition-all shadow-glow-btn-soft"
            >
              <Plus size={16} strokeWidth={2.5} />
              {intl.formatMessage(m.createTeam)}
            </button>
          )}
          {tab === 'Tasks' && (
            <div className="flex items-center gap-3">
              <select
                value={taskClient}
                onChange={(e) => setTaskClient(e.target.value)}
                className="bg-card border border-white/5 rounded-full py-2.5 px-4 text-sm font-semibold text-zinc-300 focus:outline-none focus:border-brand shadow-inner"
              >
                <option value="all">{intl.formatMessage(m.allClients)}</option>
                {clients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
              <button
                onClick={() => setNewTask(true)}
                className="flex items-center gap-2 px-6 py-2.5 bg-brand text-white text-sm font-bold rounded-full hover:bg-brand-hover transition-all shadow-glow-btn-soft"
              >
                <Plus size={16} strokeWidth={2.5} />
                {intl.formatMessage(m.newTask)}
              </button>
            </div>
          )}
        </div>
      </header>

      <div ref={tabStripRef} className="px-4 md:px-10 pb-5 flex items-center gap-2 shrink-0 scroll-x [&>button]:shrink-0 [&>button]:whitespace-nowrap">
        {TABS.map((t) => (
          <button
            key={t}
            aria-current={tab === t ? 'page' : undefined}
            onClick={() => setTab(t)}
            className={`px-4 py-2 rounded-full text-[13px] font-bold transition-all border ${
              tab === t
                ? 'bg-brand text-white border-brand shadow-glow-pill'
                : 'bg-card text-zinc-400 border-white/5 hover:text-white hover:border-white/15'
            }`}
          >
            {intl.formatMessage(TAB_LABELS[t])}
          </button>
        ))}
      </div>

      <div className="flex-1 overflow-y-auto px-4 md:px-10 pb-10 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        <motion.div key={tab} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }}>
          {tab === 'Colleagues' && (
            <DataTable<Colleague>
              className="max-w-none"
              columns={colleagueColumns}
              rows={colleagues}
              rowId={(c) => c.id}
              onRowClick={(c) => setEditing(c)}
              emptyMessage={intl.formatMessage(m.colleaguesEmpty)}
              footer={intl.formatMessage(m.colleaguesFooter)}
            />
          )}

          {tab === 'Teams' && (
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
              {teams.map((team) => (
                <div key={team.id} className="border border-white/5 rounded-[32px] bg-card shadow-2xl overflow-hidden">
                  <div className="p-6 flex items-start justify-between gap-4 border-b border-white/5">
                    <div className="flex items-center gap-3">
                      <div className="w-10 h-10 rounded-xl bg-raised border border-white/5 flex items-center justify-center text-zinc-400">
                        <Users size={17} />
                      </div>
                      <div>
                        <h3 className="font-sans font-bold text-lg text-white tracking-tight">{team.name}</h3>
                        <p className="text-[12px] text-zinc-500 font-semibold uppercase tracking-wider">{team.accessLevel}</p>
                      </div>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      <Pill>{intl.formatMessage(m.teamMembers, { count: team.memberIds.length })}</Pill>
                      <button
                        onClick={() => setEditingTeam(team)}
                        title={intl.formatMessage(m.editTeam)}
                        className="w-8 h-8 rounded-lg border border-white/5 text-zinc-500 hover:text-white hover:border-white/20 flex items-center justify-center transition-colors"
                      >
                        <Pencil size={13} />
                      </button>
                    </div>
                  </div>
                  <div className="p-6 flex flex-col gap-2">
                    {team.memberIds.length === 0 && (
                      <p className="text-[13px] text-zinc-500 py-4 text-center">{intl.formatMessage(m.teamNoMembers)}</p>
                    )}
                    {team.memberIds.map((id) => {
                      const member = colleagues.find((c) => c.id === id);
                      if (!member) return null;
                      return (
                        <div key={id} className="flex items-center gap-3 p-3 rounded-2xl bg-ground/60 border border-white/5">
                          <span className="w-8 h-8 rounded-lg bg-raised flex items-center justify-center font-bold text-white text-[12px] shrink-0 overflow-hidden">
                            {member.avatarDataUrl ? <img src={member.avatarDataUrl} alt="" className="w-full h-full object-cover" /> : member.name.charAt(0)}
                          </span>
                          <div className="min-w-0">
                            <div className="text-[13px] font-bold text-white truncate">{member.name}</div>
                            <div className="text-[11px] text-zinc-500">{member.role} · {member.location}</div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              ))}

              {teams.length === 0 && (
                <div className="border border-white/5 rounded-[32px] bg-card p-4 md:p-10 text-center text-zinc-500 lg:col-span-2">
                  {intl.formatMessage(m.teamsEmpty)}
                </div>
              )}
            </div>
          )}

          {tab === 'Tasks' && (
            <DataTable<WorkflowTask>
              className="max-w-none"
              columns={[
                {
                  key: 'title', label: intl.formatMessage(m.colTask), sortValue: (t) => t.title,
                  render: (t) => {
                    const suggestion = prefill[t.id];
                    return (
                      <span>
                        <span className="block text-white font-semibold">{t.title}</span>
                        {suggestion && (
                          <span className="inline-flex items-center gap-1.5 text-[11px] text-brand font-semibold mt-0.5">
                            <Sparkles size={10} />
                            {suggestion.why}
                          </span>
                        )}
                      </span>
                    );
                  },
                },
                { key: 'clientName', label: intl.formatMessage(commonLabels.client), sortValue: (t) => t.clientName },
                {
                  key: 'assignee', label: intl.formatMessage(m.colAssignee), sortValue: (t) => t.assignee,
                  render: (t) => (
                    <select
                      value={assignees.includes(t.assignee) ? t.assignee : ''}
                      onClick={(e) => e.stopPropagation()}
                      onChange={(e) => {
                        assignTask(t.id, e.target.value);
                        logAudit({
                          action: intl.formatMessage(m.auditAssignedTask),
                          scope: intl.formatMessage(m.auditAssignedTaskScope, { title: t.title, assignee: e.target.value }),
                          reviewOpened: false,
                        });
                      }}
                      className="bg-ground border border-white/5 rounded-lg py-1.5 px-2.5 text-[12px] font-semibold text-zinc-300 focus:outline-none focus:border-brand"
                    >
                      {!assignees.includes(t.assignee) && <option value="">{t.assignee || intl.formatMessage(m.unassigned)}</option>}
                      {assignees.map((a) => <option key={a} value={a} className="bg-card">{a}</option>)}
                    </select>
                  ),
                },
                { key: 'due', label: intl.formatMessage(m.colDue), sortValue: (t) => t.due },
                {
                  key: 'status', label: intl.formatMessage(commonLabels.status), align: 'right', sortValue: (t) => t.status,
                  render: (t) => {
                    // Engine-answered tasks show their derived state until a human overrides it.
                    const derived = prefill[t.id];
                    if (t.status === 'open' && derived) {
                      return derived.done
                        ? <Pill tone="green">{intl.formatMessage(m.statusDoneAuto)}</Pill>
                        : <Pill tone="amber">{intl.formatMessage(m.statusBlocked)}</Pill>;
                    }
                    return t.status === 'complete' ? <Pill tone="green">{intl.formatMessage(m.statusComplete)}</Pill>
                      : t.status === 'complete-with-issues' ? <Pill tone="amber">{intl.formatMessage(m.statusWithIssues)}</Pill>
                      : t.status === 'not-applicable' ? <Pill>{intl.formatMessage(m.statusNotApplicable)}</Pill>
                      : <Pill>{intl.formatMessage(m.statusOpen)}</Pill>;
                  },
                },
                {
                  key: 'actions', label: '', align: 'right',
                  render: (t) => (
                    <span className="flex items-center gap-1.5 justify-end">
                      <IconBtn icon={Check} title={intl.formatMessage(m.actionComplete)} onClick={() => setTaskStatus(t.id, 'complete')} />
                      <IconBtn icon={AlertTriangle} title={intl.formatMessage(m.actionCompleteWithIssues)} onClick={() => setTaskStatus(t.id, 'complete-with-issues')} />
                      <IconBtn icon={CircleSlash} title={intl.formatMessage(m.actionNotApplicable)} onClick={() => setTaskStatus(t.id, 'not-applicable')} />
                    </span>
                  ),
                },
              ]}
              rows={scopedTasks}
              rowId={(t) => t.id}
              selectable
              emptyMessage={intl.formatMessage(m.tasksEmpty)}
              bulkActions={[
                { label: intl.formatMessage(m.bulkMarkComplete), icon: Check, onClick: (sel) => sel.forEach((t) => setTaskStatus(t.id, 'complete')) },
                {
                  label: intl.formatMessage(m.bulkAssignAction),
                  icon: UserPlus,
                  onClick: (sel) => setBulkAssign(sel.map((t) => t.id)),
                },
                {
                  label: intl.formatMessage(m.bulkAskAi),
                  icon: Sparkles,
                  primary: true,
                  onClick: () => startConversation(taskClient === 'all' ? [] : [taskClient]),
                },
              ]}
              footer={intl.formatMessage(m.tasksFooter)}
            />
          )}
        </motion.div>
      </div>

      <AnimatePresence>
        {editing && (
          <ColleagueEditor
            colleague={editing}
            onSave={(c) => {
              saveColleague(c);
              logAudit({
                action: intl.formatMessage(m.auditSavedColleague),
                scope: intl.formatMessage(m.auditColleagueScope, { name: c.name, role: c.role }),
                reviewOpened: true,
              });
              setEditing(null);
            }}
            onRemove={async () => {
              const ok = await confirm({
                tone: 'red',
                title: intl.formatMessage(m.removeColleagueTitle, { name: editing.name }),
                detail: intl.formatMessage(m.removeColleagueDetail, { role: editing.role, count: editing.clientIds.length }),
                consequence: intl.formatMessage(m.removeColleagueConsequence),
                confirmLabel: intl.formatMessage(m.removeColleagueConfirm),
              });
              if (!ok) return;
              removeColleague(editing.id);
              setEditing(null);
            }}
            onResetPassword={() => {
              sendPasswordReset(editing.id);
              logAudit({
                action: intl.formatMessage(m.auditPasswordReset),
                scope: intl.formatMessage(m.auditPasswordResetScope, {
                  name: editing.name || intl.formatMessage(m.auditNewColleague),
                  email: editing.email,
                }),
                reviewOpened: true,
              });
            }}
            onClose={() => setEditing(null)}
          />
        )}

        {editingTeam && (
          <TeamEditor
            team={editingTeam}
            onSave={(t) => {
              saveTeam(t);
              logAudit({
                action: intl.formatMessage(m.auditSavedTeam),
                scope: intl.formatMessage(m.auditSavedTeamScope, { name: t.name, count: t.memberIds.length }),
                reviewOpened: true,
              });
              setEditingTeam(null);
            }}
            onRemove={async () => {
              const ok = await confirm({
                tone: 'red',
                title: intl.formatMessage(m.deleteTeamTitle, { name: editingTeam.name }),
                detail: intl.formatMessage(m.deleteTeamDetail, {
                  count: editingTeam.memberIds.length,
                  accessLevel: editingTeam.accessLevel,
                }),
                consequence: intl.formatMessage(m.deleteTeamConsequence),
                confirmLabel: intl.formatMessage(m.deleteTeamConfirm),
              });
              if (!ok) return;
              removeTeam(editingTeam.id);
              logAudit({ action: intl.formatMessage(m.auditDeletedTeam), scope: editingTeam.name, reviewOpened: true });
              setEditingTeam(null);
            }}
            onClose={() => setEditingTeam(null)}
          />
        )}

        {newTask && (
          <TaskComposer
            assignees={assignees}
            defaultClientId={taskClient === 'all' ? clients[0]?.id ?? '' : taskClient}
            onCreate={(t) => {
              addTask(t);
              logAudit({
                action: intl.formatMessage(m.auditCreatedTask),
                scope: intl.formatMessage(m.auditCreatedTaskScope, {
                  title: t.title,
                  clientName: t.clientName,
                  assignee: t.assignee,
                }),
                reviewOpened: true,
              });
              setNewTask(false);
            }}
            onClose={() => setNewTask(false)}
          />
        )}

        {bulkAssign && (
          <Modal onClose={() => setBulkAssign(null)}>
            <div className="w-full max-w-sm border border-white/5 rounded-[32px] bg-card shadow-2xl overflow-hidden">
              <div className="p-6 border-b border-white/5">
                <h3 className="font-sans font-bold text-xl text-white tracking-tight">{intl.formatMessage(m.bulkAssignHeading)}</h3>
                <p className="text-[12px] text-zinc-500 mt-1 font-semibold uppercase tracking-wider">
                  {intl.formatMessage(m.bulkAssignCount, { count: bulkAssign.length })}
                </p>
              </div>
              <div className="p-4 flex flex-col gap-1">
                {assignees.map((a) => (
                  <button
                    key={a}
                    onClick={() => {
                      bulkAssign.forEach((id) => assignTask(id, a));
                      logAudit({
                        action: intl.formatMessage(m.auditAssignedTasks),
                        scope: intl.formatMessage(m.auditAssignedTasksScope, { count: bulkAssign.length, assignee: a }),
                        reviewOpened: true,
                      });
                      setBulkAssign(null);
                    }}
                    className="px-4 py-3 rounded-2xl text-left text-sm font-bold text-zinc-300 hover:bg-white/5 hover:text-white transition-colors"
                  >
                    {a}
                  </button>
                ))}
              </div>
            </div>
          </Modal>
        )}
      </AnimatePresence>
    </div>
  );
}

const teamEditorM = defineMessages({
  heading: { id: 'team.teamEditor.heading', defaultMessage: 'Create team' },
  subtitle: {
    id: 'team.teamEditor.subtitle',
    defaultMessage: 'Groups colleagues and scopes the clients they can reach',
  },
  nameLabel: { id: 'team.teamEditor.nameLabel', defaultMessage: 'Team name' },
  namePlaceholder: { id: 'team.teamEditor.namePlaceholder', defaultMessage: 'Hospitality team' },
  membersLabel: { id: 'team.teamEditor.membersLabel', defaultMessage: 'Members ({count})' },
  deleteTeam: { id: 'team.teamEditor.deleteTeam', defaultMessage: 'Delete team' },
  create: { id: 'team.teamEditor.create', defaultMessage: 'Create team' },
  save: { id: 'team.teamEditor.save', defaultMessage: 'Save' },
  untitled: { id: 'team.teamEditor.untitled', defaultMessage: 'Untitled team' },
});

/** Create or edit a team: name, how much client access it carries, members. */
function TeamEditor({ team, onSave, onRemove, onClose }: {
  team: Team; onSave: (t: Team) => void; onRemove: () => void; onClose: () => void;
}) {
  const { colleagues } = useAppContext();
  const intl = useIntl();
  const [draft, setDraft] = useState(team);
  const isNew = !team.name;

  return (
    <Modal onClose={onClose}>
      <div className="w-full max-w-lg border border-white/5 rounded-[32px] bg-card shadow-2xl overflow-hidden">
        <div className="p-6 border-b border-white/5">
          <h3 className="font-sans font-bold text-xl text-white tracking-tight">{team.name || intl.formatMessage(teamEditorM.heading)}</h3>
          <p className="text-[12px] text-zinc-500 mt-1 font-semibold uppercase tracking-wider">
            {intl.formatMessage(teamEditorM.subtitle)}
          </p>
        </div>

        <div className="p-6 flex flex-col gap-5 max-h-[55dvh] overflow-y-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          <Field
            label={intl.formatMessage(teamEditorM.nameLabel)}
            value={draft.name}
            onChange={(v) => setDraft({ ...draft, name: v })}
            placeholder={intl.formatMessage(teamEditorM.namePlaceholder)}
          />

          <div>
            <Label>{intl.formatMessage(commonLabels.clientAccess)}</Label>
            <div className="flex flex-wrap gap-2">
              {(['All clients', 'Assigned clients only'] as Team['accessLevel'][]).map((level) => (
                <Chip key={level} active={draft.accessLevel === level} onClick={() => setDraft({ ...draft, accessLevel: level })}>
                  {level}
                </Chip>
              ))}
            </div>
          </div>

          <div>
            <Label>{intl.formatMessage(teamEditorM.membersLabel, { count: draft.memberIds.length })}</Label>
            <div className="flex flex-col gap-2">
              {colleagues.map((c) => {
                const member = draft.memberIds.includes(c.id);
                return (
                  <button
                    key={c.id}
                    onClick={() =>
                      setDraft({
                        ...draft,
                        memberIds: member ? draft.memberIds.filter((x) => x !== c.id) : [...draft.memberIds, c.id],
                      })
                    }
                    className={`flex items-center gap-3 p-3 rounded-2xl border transition-all text-left ${
                      member ? 'bg-brand/10 border-brand/30' : 'bg-ground/60 border-white/5 hover:border-white/15'
                    }`}
                  >
                    <span className="w-8 h-8 rounded-lg bg-raised flex items-center justify-center font-bold text-white text-[12px] shrink-0 overflow-hidden">
                      {c.avatarDataUrl ? <img src={c.avatarDataUrl} alt="" className="w-full h-full object-cover" /> : c.name.charAt(0)}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block text-[13px] font-bold text-white truncate">{c.name}</span>
                      <span className="block text-[11px] text-zinc-500">{c.role} · {c.location}</span>
                    </span>
                    {member && <Check size={15} className="text-brand shrink-0" />}
                  </button>
                );
              })}
            </div>
          </div>
        </div>

        <div className="p-4 bg-raised/50 flex justify-between gap-3">
          {isNew ? (
            <span />
          ) : (
            <button onClick={onRemove} className="flex items-center gap-2 px-4 py-2.5 rounded-full text-sm font-bold text-zinc-500 hover:text-red-400 hover:bg-white/5 transition-colors">
              <Trash2 size={15} />
              {intl.formatMessage(teamEditorM.deleteTeam)}
            </button>
          )}
          <button
            onClick={() => onSave({ ...draft, name: draft.name.trim() || intl.formatMessage(teamEditorM.untitled) })}
            className="px-6 py-2.5 rounded-full text-sm font-bold text-white bg-brand hover:bg-brand-hover transition-all"
          >
            {intl.formatMessage(isNew ? teamEditorM.create : teamEditorM.save)}
          </button>
        </div>
      </div>
    </Modal>
  );
}

const taskComposerM = defineMessages({
  heading: { id: 'team.taskComposer.heading', defaultMessage: 'New task' },
  subtitle: { id: 'team.taskComposer.subtitle', defaultMessage: 'Scoped to one client and one owner' },
  titleLabel: { id: 'team.taskComposer.titleLabel', defaultMessage: 'What needs doing' },
  titlePlaceholder: {
    id: 'team.taskComposer.titlePlaceholder',
    defaultMessage: 'Chase missing July receipts',
  },
  assigneeLabel: { id: 'team.taskComposer.assigneeLabel', defaultMessage: 'Assign to' },
  dueLabel: { id: 'team.taskComposer.dueLabel', defaultMessage: 'Due' },
  duePlaceholder: { id: 'team.taskComposer.duePlaceholder', defaultMessage: '31 Aug 2026' },
  create: { id: 'team.taskComposer.create', defaultMessage: 'Create task' },
  defaultAssignee: { id: 'team.taskComposer.defaultAssignee', defaultMessage: 'You' },
  untitled: { id: 'team.taskComposer.untitled', defaultMessage: 'Untitled task' },
});

/** Raise a one-off task and put it on someone's desk. */
function TaskComposer({ assignees, defaultClientId, onCreate, onClose }: {
  assignees: string[];
  defaultClientId: string;
  onCreate: (t: WorkflowTask) => void;
  onClose: () => void;
}) {
  const { clients } = useAppContext();
  const intl = useIntl();
  const [title, setTitle] = useState('');
  const [clientId, setClientId] = useState(defaultClientId);
  const [assignee, setAssignee] = useState(assignees[0] ?? intl.formatMessage(taskComposerM.defaultAssignee));
  const [due, setDue] = useState('');

  const client = clients.find((c) => c.id === clientId);

  return (
    <Modal onClose={onClose}>
      <div className="w-full max-w-lg border border-white/5 rounded-[32px] bg-card shadow-2xl overflow-hidden">
        <div className="p-6 border-b border-white/5">
          <h3 className="font-sans font-bold text-xl text-white tracking-tight">{intl.formatMessage(taskComposerM.heading)}</h3>
          <p className="text-[12px] text-zinc-500 mt-1 font-semibold uppercase tracking-wider">
            {intl.formatMessage(taskComposerM.subtitle)}
          </p>
        </div>

        <div className="p-6 flex flex-col gap-5">
          <Field
            label={intl.formatMessage(taskComposerM.titleLabel)}
            value={title}
            onChange={setTitle}
            placeholder={intl.formatMessage(taskComposerM.titlePlaceholder)}
          />

          <div>
            <Label>{intl.formatMessage(commonLabels.client)}</Label>
            <select
              value={clientId}
              onChange={(e) => setClientId(e.target.value)}
              className="w-full bg-ground border border-white/5 rounded-xl px-4 py-2.5 text-sm text-white focus:outline-none focus:border-brand"
            >
              {clients.map((c) => <option key={c.id} value={c.id} className="bg-card">{c.name}</option>)}
            </select>
          </div>

          <div>
            <Label>{intl.formatMessage(taskComposerM.assigneeLabel)}</Label>
            <div className="flex flex-wrap gap-2">
              {assignees.map((a) => (
                <Chip key={a} active={assignee === a} onClick={() => setAssignee(a)}>{a}</Chip>
              ))}
            </div>
          </div>

          <Field
            label={intl.formatMessage(taskComposerM.dueLabel)}
            value={due}
            onChange={setDue}
            placeholder={intl.formatMessage(taskComposerM.duePlaceholder)}
          />
        </div>

        <div className="p-4 bg-raised/50 flex justify-end gap-3">
          <button onClick={onClose} className="px-5 py-2.5 rounded-full text-sm font-bold text-zinc-400 hover:text-white transition-colors">
            {intl.formatMessage(commonActions.cancel)}
          </button>
          <button
            onClick={() =>
              onCreate({
                id: `task-${Date.now()}`,
                clientId,
                clientName: client?.name ?? '—',
                title: title.trim() || intl.formatMessage(taskComposerM.untitled),
                assignee,
                due: due.trim() || '—',
                status: 'open',
                aiPrefilled: false,
              })
            }
            disabled={!title.trim()}
            className="px-6 py-2.5 rounded-full text-sm font-bold text-white bg-brand hover:bg-brand-hover disabled:opacity-40 disabled:cursor-not-allowed transition-all"
          >
            {intl.formatMessage(taskComposerM.create)}
          </button>
        </div>
      </div>
    </Modal>
  );
}

const avatarPickerM = defineMessages({
  label: { id: 'team.avatarPicker.label', defaultMessage: 'Profile picture' },
  replace: { id: 'team.avatarPicker.replace', defaultMessage: 'Replace' },
  upload: { id: 'team.avatarPicker.upload', defaultMessage: 'Upload' },
  remove: { id: 'team.avatarPicker.remove', defaultMessage: 'Remove' },
  notAnImage: { id: 'team.avatarPicker.notAnImage', defaultMessage: 'That is not an image file.' },
  tooLarge: { id: 'team.avatarPicker.tooLarge', defaultMessage: 'Pictures must be under 2MB.' },
});

/** Profile picture for a colleague, stored as a data URI. */
function AvatarPicker({ value, name, onChange }: { value: string; name: string; onChange: (v: string) => void }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const intl = useIntl();
  const [error, setError] = useState('');

  return (
    <div>
      <Label>{intl.formatMessage(avatarPickerM.label)}</Label>
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
            {intl.formatMessage(value ? avatarPickerM.replace : avatarPickerM.upload)}
          </button>
          {value && (
            <button
              onClick={() => onChange('')}
              className="flex items-center gap-1.5 px-3 py-2 rounded-full text-[13px] font-bold text-zinc-500 hover:text-white transition-colors"
            >
              <X size={14} />
              {intl.formatMessage(avatarPickerM.remove)}
            </button>
          )}
        </div>
        <input
          ref={inputRef}
          type="file"
          accept="image/*"
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0];
            e.target.value = '';
            if (!file) return;
            if (!file.type.startsWith('image/')) { setError(intl.formatMessage(avatarPickerM.notAnImage)); return; }
            if (file.size > 2 * 1024 * 1024) { setError(intl.formatMessage(avatarPickerM.tooLarge)); return; }
            setError('');
            const reader = new FileReader();
            reader.onload = () => onChange(String(reader.result));
            reader.readAsDataURL(file);
          }}
        />
      </div>
      {error && <div className="text-[11px] text-amber-400 mt-2 font-semibold">{error}</div>}
    </div>
  );
}

function blankTeam(): Team {
  return { id: `team-${Date.now()}`, name: '', accessLevel: 'Assigned clients only', memberIds: [] };
}

const colleagueEditorM = defineMessages({
  heading: { id: 'team.colleagueEditor.heading', defaultMessage: 'Invite colleague' },
  subtitle: {
    id: 'team.colleagueEditor.subtitle',
    defaultMessage: 'Role, per-permission toggles and client access',
  },
  nameLabel: { id: 'team.colleagueEditor.nameLabel', defaultMessage: 'Name' },
  namePlaceholder: { id: 'team.colleagueEditor.namePlaceholder', defaultMessage: 'Sam Patel' },
  emailPlaceholder: { id: 'team.colleagueEditor.emailPlaceholder', defaultMessage: 'sam@practice.co.uk' },
  jobTitleLabel: { id: 'team.colleagueEditor.jobTitleLabel', defaultMessage: 'Job title' },
  jobTitlePlaceholder: {
    id: 'team.colleagueEditor.jobTitlePlaceholder',
    defaultMessage: 'Senior bookkeeper',
  },
  locationLabel: { id: 'team.colleagueEditor.locationLabel', defaultMessage: 'Location' },
  locationPlaceholder: { id: 'team.colleagueEditor.locationPlaceholder', defaultMessage: 'London' },

  // Three whole sentences rather than one with the changing clause inserted:
  // the three states say genuinely different things.
  passwordLabel: { id: 'team.colleagueEditor.passwordLabel', defaultMessage: 'Password' },
  resetJustSent: {
    id: 'team.colleagueEditor.resetJustSent',
    defaultMessage: 'Reset link sent to {email} just now.',
  },
  theirEmail: { id: 'team.colleagueEditor.theirEmail', defaultMessage: 'their email' },
  resetLastSent: {
    id: 'team.colleagueEditor.resetLastSent',
    defaultMessage: 'Last reset link sent {when}.',
  },
  resetHint: {
    id: 'team.colleagueEditor.resetHint',
    defaultMessage: 'You cannot see or set it — send a reset link instead.',
  },
  resetSentAction: { id: 'team.colleagueEditor.resetSentAction', defaultMessage: 'Sent' },
  resetAction: { id: 'team.colleagueEditor.resetAction', defaultMessage: 'Send reset link' },

  hideFinanceLabel: { id: 'team.colleagueEditor.hideFinanceLabel', defaultMessage: 'Hide finance fields' },
  hideFinanceHint: {
    id: 'team.colleagueEditor.hideFinanceHint',
    defaultMessage: 'For non-finance submitters — they see capture, not coding.',
  },
  activeLabel: { id: 'team.colleagueEditor.activeLabel', defaultMessage: 'Active' },
  remove: { id: 'team.colleagueEditor.remove', defaultMessage: 'Remove' },
  save: { id: 'team.colleagueEditor.save', defaultMessage: 'Save' },
});

function ColleagueEditor({ colleague, onSave, onRemove, onResetPassword, onClose }: {
  colleague: Colleague;
  onSave: (c: Colleague) => void;
  onRemove: () => void;
  onResetPassword: () => void;
  onClose: () => void;
}) {
  const { clients } = useAppContext();
  const intl = useIntl();
  const [draft, setDraft] = useState(colleague);
  const [resetSent, setResetSent] = useState(false);
  const set = <K extends keyof Colleague>(k: K, v: Colleague[K]) => setDraft({ ...draft, [k]: v });
  const isAdmin = draft.role !== 'Standard User';

  return (
    <Modal onClose={onClose}>
      <div className="w-full max-w-lg border border-white/5 rounded-[32px] bg-card shadow-2xl overflow-hidden">
        <div className="p-6 border-b border-white/5">
          <h3 className="font-sans font-bold text-xl text-white tracking-tight">{colleague.name || intl.formatMessage(colleagueEditorM.heading)}</h3>
          <p className="text-[12px] text-zinc-500 mt-1 font-semibold uppercase tracking-wider">
            {intl.formatMessage(colleagueEditorM.subtitle)}
          </p>
        </div>

        <div className="p-6 flex flex-col gap-5 max-h-[55dvh] overflow-y-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          <AvatarPicker
            value={draft.avatarDataUrl ?? ''}
            name={draft.name}
            onChange={(v) => set('avatarDataUrl', v || undefined)}
          />
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <Field
              label={intl.formatMessage(colleagueEditorM.nameLabel)}
              value={draft.name}
              onChange={(v) => set('name', v)}
              placeholder={intl.formatMessage(colleagueEditorM.namePlaceholder)}
            />
            <Field
              label={intl.formatMessage(commonLabels.email)}
              value={draft.email}
              onChange={(v) => set('email', v)}
              placeholder={intl.formatMessage(colleagueEditorM.emailPlaceholder)}
            />
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <Field
              label={intl.formatMessage(colleagueEditorM.jobTitleLabel)}
              value={draft.jobTitle ?? ''}
              onChange={(v) => set('jobTitle', v)}
              placeholder={intl.formatMessage(colleagueEditorM.jobTitlePlaceholder)}
            />
            <Field
              label={intl.formatMessage(commonLabels.mobile)}
              value={draft.mobile ?? ''}
              onChange={(v) => set('mobile', v)}
              placeholder={intl.formatMessage(commonPlaceholders.ukMobile)}
            />
          </div>
          <Field
            label={intl.formatMessage(colleagueEditorM.locationLabel)}
            value={draft.location}
            onChange={(v) => set('location', v)}
            placeholder={intl.formatMessage(colleagueEditorM.locationPlaceholder)}
          />

          {/* Sign-in is the colleague's own; the practice can only start a reset. */}
          <div className="p-4 rounded-2xl border border-white/5 bg-ground/60 shadow-inner flex items-center justify-between gap-4">
            <div className="min-w-0">
              <div className="text-sm font-bold text-white">{intl.formatMessage(colleagueEditorM.passwordLabel)}</div>
              <div className="text-[12px] text-zinc-500 mt-0.5">
                {resetSent
                  ? intl.formatMessage(colleagueEditorM.resetJustSent, {
                      email: draft.email || intl.formatMessage(colleagueEditorM.theirEmail),
                    })
                  : draft.passwordResetSentAt
                    ? intl.formatMessage(colleagueEditorM.resetLastSent, { when: draft.passwordResetSentAt })
                    : intl.formatMessage(colleagueEditorM.resetHint)}
              </div>
            </div>
            <button
              onClick={() => { onResetPassword(); setResetSent(true); }}
              disabled={!draft.email}
              className="shrink-0 flex items-center gap-2 px-4 py-2 rounded-full text-[12px] font-bold text-zinc-300 border border-white/10 hover:text-white hover:border-white/25 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            >
              <KeyRound size={13} />
              {intl.formatMessage(resetSent ? colleagueEditorM.resetSentAction : colleagueEditorM.resetAction)}
            </button>
          </div>

          <div>
            <Label>{intl.formatMessage(commonLabels.role)}</Label>
            <div className="flex flex-wrap gap-2">
              {ROLES.map((r) => (
                <Chip key={r} active={draft.role === r} onClick={() => set('role', r)}>{r}</Chip>
              ))}
            </div>
          </div>

          <div>
            <Label>{intl.formatMessage(commonLabels.permissions)}</Label>
            <div className="flex flex-wrap gap-2">
              {PERMISSIONS.map((p) => (
                <Chip
                  key={p}
                  active={draft.permissions.includes(p)}
                  onClick={() => set('permissions', draft.permissions.includes(p) ? draft.permissions.filter((x) => x !== p) : [...draft.permissions, p])}
                >
                  {p}
                </Chip>
              ))}
            </div>
          </div>

          {!isAdmin && (
            <div>
              <Label>{intl.formatMessage(commonLabels.clientAccess)}</Label>
              <div className="flex flex-wrap gap-2">
                {clients.map((c) => (
                  <Chip
                    key={c.id}
                    active={draft.clientIds.includes(c.id)}
                    onClick={() => set('clientIds', draft.clientIds.includes(c.id) ? draft.clientIds.filter((x) => x !== c.id) : [...draft.clientIds, c.id])}
                  >
                    {c.name}
                  </Chip>
                ))}
              </div>
            </div>
          )}

          <Toggle
            label={intl.formatMessage(colleagueEditorM.hideFinanceLabel)}
            hint={intl.formatMessage(colleagueEditorM.hideFinanceHint)}
            value={draft.hideFinanceFields}
            onChange={(v) => set('hideFinanceFields', v)}
          />
          <Toggle label={intl.formatMessage(colleagueEditorM.activeLabel)} value={draft.active} onChange={(v) => set('active', v)} />
        </div>

        <div className="p-4 bg-raised/50 flex justify-between gap-3">
          <button onClick={onRemove} className="flex items-center gap-2 px-4 py-2.5 rounded-full text-sm font-bold text-zinc-500 hover:text-red-400 hover:bg-white/5 transition-colors">
            <Trash2 size={15} />
            {intl.formatMessage(colleagueEditorM.remove)}
          </button>
          <button onClick={() => onSave(draft)} className="px-6 py-2.5 rounded-full text-sm font-bold text-white bg-brand hover:bg-brand-hover transition-all">
            {intl.formatMessage(colleagueEditorM.save)}
          </button>
        </div>
      </div>
    </Modal>
  );
}

function blankColleague(): Colleague {
  return {
    id: `u-${Date.now()}`,
    name: '',
    email: '',
    role: 'Standard User',
    location: 'London',
    clientIds: [],
    permissions: ['Chase'],
    hideFinanceFields: false,
    active: true,
  };
}

function Label({ children }: { children: React.ReactNode }) {
  return <div className="text-[11px] font-bold text-zinc-500 uppercase tracking-widest mb-2.5">{children}</div>;
}

function Chip({ children, active, onClick }: { children: React.ReactNode; active: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className={`px-3.5 py-2 rounded-full text-[13px] font-bold border transition-all ${
        active
          ? 'bg-brand text-white border-brand shadow-glow-pill'
          : 'bg-ground text-zinc-400 border-white/5 hover:text-white hover:border-white/15'
      }`}
    >
      {children}
    </button>
  );
}

function IconBtn({ icon: Icon, title, onClick }: { icon: LucideIcon; title: string; onClick: () => void }) {
  return (
    <button
      onClick={(e) => { e.stopPropagation(); onClick(); }}
      title={title}
      className="p-2 rounded-lg text-zinc-500 hover:text-white hover:bg-white/5 transition-colors"
    >
      <Icon size={14} />
    </button>
  );
}
