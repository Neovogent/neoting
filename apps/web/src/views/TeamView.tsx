import { useMemo, useRef, useState } from 'react';
import {
  Shield, Plus, Trash2, Check, CircleSlash, AlertTriangle, Sparkles, MapPin, Users,
  KeyRound, ImagePlus, X, UserPlus, Pencil, LucideIcon,
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { useAppContext } from '../context/AppContext';
import { fromSlug, slug, useSegment } from '../lib/router';
import { useConfirm } from '../components/DynamicComponents/ConfirmProvider';
import { DataTable, Pill, type Column } from '../components/DynamicComponents/DataTable';
import { Modal, Field, Toggle } from './ApprovalsView';
import type { Colleague, ColleagueRole, Team, WorkflowTask } from '../lib/types';

const TABS = ['Colleagues', 'Teams', 'Tasks'] as const;
type Tab = (typeof TABS)[number];

const ROLES: ColleagueRole[] = ['Practice Admin', 'Client Admin', 'Standard User'];
const PERMISSIONS = ['Publish', 'Approve', 'Chase', 'Connect bank', 'Export', 'Delete'];

export function TeamView() {
  const {
    colleagues, teams, tasks, clients, statsFor, saveColleague, removeColleague,
    sendPasswordReset, saveTeam, removeTeam, setTaskStatus, assignTask, addTask,
    startConversation, logAudit,
  } = useAppContext();

  // The sub-tab is the second path segment, so every one has a link.
  const confirm = useConfirm();
  const [tabSlug, setTabSlug] = useSegment(1);
  const tab: Tab = fromSlug(tabSlug, TABS) ?? 'Colleagues';
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
        map[t.id] = { done: !!client?.bankConnected, why: client?.bankConnected ? 'Feed is live' : 'No feed — statement fallback' };
      } else if (t.title.startsWith('Chase missing')) {
        map[t.id] = { done: s.missing === 0, why: s.missing === 0 ? 'Nothing outstanding' : `${s.missing} still unchased` };
      } else if (t.title.startsWith('Approve')) {
        map[t.id] = { done: s.approvals === 0, why: s.approvals === 0 ? 'Queue is clear' : `${s.approvals} awaiting approval` };
      }
    });
    return map;
  }, [tasks, statsFor, clients]);

  const scopedTasks = tasks.filter((t) => taskClient === 'all' || t.clientId === taskClient);

  const colleagueColumns: Column<Colleague>[] = [
    {
      key: 'name', label: 'Colleague', sortValue: (c) => c.name,
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
      key: 'role', label: 'Role', sortValue: (c) => c.role,
      render: (c) => <Pill tone={c.role === 'Practice Admin' ? 'blue' : 'neutral'}>{c.role}</Pill>,
    },
    { key: 'location', label: 'Location', sortValue: (c) => c.location, render: (c) => <span className="inline-flex items-center gap-1.5 text-zinc-400"><MapPin size={12} />{c.location}</span> },
    {
      key: 'clients', label: 'Client access', align: 'right', sortValue: (c) => c.clientIds.length,
      render: (c) => (c.role === 'Standard User' ? <span className="tabular-nums text-zinc-300">{c.clientIds.length}</span> : <Pill>All</Pill>),
    },
    {
      key: 'permissions', label: 'Permissions',
      render: (c) => (
        <span className="flex flex-wrap gap-1">
          {c.permissions.slice(0, 3).map((p) => <Pill key={p}>{p}</Pill>)}
          {c.permissions.length > 3 && <Pill>+{c.permissions.length - 3}</Pill>}
        </span>
      ),
    },
    {
      key: 'hide', label: 'Fields',
      render: (c) => (c.hideFinanceFields ? <Pill tone="amber">Finance hidden</Pill> : <span className="text-zinc-700">—</span>),
    },
    {
      key: 'active', label: 'Status', align: 'right', sortValue: (c) => String(c.active),
      render: (c) => (c.active ? <Pill tone="green">Active</Pill> : <Pill tone="red">Deactivated</Pill>),
    },
  ];

  return (
    <div className="flex-1 flex flex-col min-w-0 bg-ground h-full overflow-hidden">
      <header className="px-10 pt-8 pb-5 shrink-0">
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div className="flex items-center gap-4">
            <div className="w-12 h-12 rounded-2xl bg-raised flex items-center justify-center text-white border border-white/5 shadow-inner">
              <Shield size={22} />
            </div>
            <div>
              <h1 className="font-sans text-3xl font-semibold text-white tracking-tight">Team</h1>
              <p className="text-[12px] text-zinc-500 mt-1 font-semibold uppercase tracking-wider">
                {colleagues.filter((c) => c.active).length} active · {teams.length} teams · {tasks.filter((t) => t.status === 'open').length} open tasks
              </p>
            </div>
          </div>
          {tab === 'Colleagues' && (
            <button
              onClick={() => setEditing(blankColleague())}
              className="flex items-center gap-2 px-6 py-2.5 bg-brand text-white text-sm font-bold rounded-full hover:bg-brand-hover transition-all shadow-[0_0_15px_rgba(20,227,196,0.2)]"
            >
              <Plus size={16} strokeWidth={2.5} />
              Invite colleague
            </button>
          )}
          {tab === 'Teams' && (
            <button
              onClick={() => setEditingTeam(blankTeam())}
              className="flex items-center gap-2 px-6 py-2.5 bg-brand text-white text-sm font-bold rounded-full hover:bg-brand-hover transition-all shadow-[0_0_15px_rgba(20,227,196,0.2)]"
            >
              <Plus size={16} strokeWidth={2.5} />
              Create team
            </button>
          )}
          {tab === 'Tasks' && (
            <div className="flex items-center gap-3">
              <select
                value={taskClient}
                onChange={(e) => setTaskClient(e.target.value)}
                className="bg-card border border-white/5 rounded-full py-2.5 px-4 text-sm font-semibold text-zinc-300 focus:outline-none focus:border-brand shadow-inner"
              >
                <option value="all">All clients</option>
                {clients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
              <button
                onClick={() => setNewTask(true)}
                className="flex items-center gap-2 px-6 py-2.5 bg-brand text-white text-sm font-bold rounded-full hover:bg-brand-hover transition-all shadow-[0_0_15px_rgba(20,227,196,0.2)]"
              >
                <Plus size={16} strokeWidth={2.5} />
                New task
              </button>
            </div>
          )}
        </div>
      </header>

      <div className="px-10 pb-5 flex items-center gap-2 shrink-0">
        {TABS.map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`px-4 py-2 rounded-full text-[13px] font-bold transition-all border ${
              tab === t
                ? 'bg-brand text-white border-brand shadow-[0_0_12px_rgba(20,227,196,0.25)]'
                : 'bg-card text-zinc-400 border-white/5 hover:text-white hover:border-white/15'
            }`}
          >
            {t}
          </button>
        ))}
      </div>

      <div className="flex-1 overflow-y-auto px-10 pb-10 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        <motion.div key={tab} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }}>
          {tab === 'Colleagues' && (
            <DataTable<Colleague>
              className="max-w-none"
              columns={colleagueColumns}
              rows={colleagues}
              rowId={(c) => c.id}
              onRowClick={(c) => setEditing(c)}
              emptyMessage="No colleagues yet."
              footer="The account owner cannot be deactivated · roles are set per account"
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
                      <Pill>{team.memberIds.length} members</Pill>
                      <button
                        onClick={() => setEditingTeam(team)}
                        title="Edit team"
                        className="w-8 h-8 rounded-lg border border-white/5 text-zinc-500 hover:text-white hover:border-white/20 flex items-center justify-center transition-colors"
                      >
                        <Pencil size={13} />
                      </button>
                    </div>
                  </div>
                  <div className="p-6 flex flex-col gap-2">
                    {team.memberIds.length === 0 && (
                      <p className="text-[13px] text-zinc-500 py-4 text-center">No members yet — edit the team to add some.</p>
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
                <div className="border border-white/5 rounded-[32px] bg-card p-10 text-center text-zinc-500 lg:col-span-2">
                  No teams yet. Create one to group colleagues and scope their client access.
                </div>
              )}
            </div>
          )}

          {tab === 'Tasks' && (
            <DataTable<WorkflowTask>
              className="max-w-none"
              columns={[
                {
                  key: 'title', label: 'Task', sortValue: (t) => t.title,
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
                { key: 'clientName', label: 'Client', sortValue: (t) => t.clientName },
                {
                  key: 'assignee', label: 'Assigned to', sortValue: (t) => t.assignee,
                  render: (t) => (
                    <select
                      value={assignees.includes(t.assignee) ? t.assignee : ''}
                      onClick={(e) => e.stopPropagation()}
                      onChange={(e) => {
                        assignTask(t.id, e.target.value);
                        logAudit({ action: 'Assigned a task', scope: `${t.title} → ${e.target.value}`, reviewOpened: false });
                      }}
                      className="bg-ground border border-white/5 rounded-lg py-1.5 px-2.5 text-[12px] font-semibold text-zinc-300 focus:outline-none focus:border-brand"
                    >
                      {!assignees.includes(t.assignee) && <option value="">{t.assignee || 'Unassigned'}</option>}
                      {assignees.map((a) => <option key={a} value={a} className="bg-card">{a}</option>)}
                    </select>
                  ),
                },
                { key: 'due', label: 'Due', sortValue: (t) => t.due },
                {
                  key: 'status', label: 'Status', align: 'right', sortValue: (t) => t.status,
                  render: (t) => {
                    // Engine-answered tasks show their derived state until a human overrides it.
                    const derived = prefill[t.id];
                    if (t.status === 'open' && derived) {
                      return derived.done ? <Pill tone="green">Done (auto)</Pill> : <Pill tone="amber">Blocked</Pill>;
                    }
                    return t.status === 'complete' ? <Pill tone="green">Complete</Pill>
                      : t.status === 'complete-with-issues' ? <Pill tone="amber">With issues</Pill>
                      : t.status === 'not-applicable' ? <Pill>N/A</Pill>
                      : <Pill>Open</Pill>;
                  },
                },
                {
                  key: 'actions', label: '', align: 'right',
                  render: (t) => (
                    <span className="flex items-center gap-1.5 justify-end">
                      <IconBtn icon={Check} title="Complete" onClick={() => setTaskStatus(t.id, 'complete')} />
                      <IconBtn icon={AlertTriangle} title="Complete with issues" onClick={() => setTaskStatus(t.id, 'complete-with-issues')} />
                      <IconBtn icon={CircleSlash} title="Not applicable" onClick={() => setTaskStatus(t.id, 'not-applicable')} />
                    </span>
                  ),
                },
              ]}
              rows={scopedTasks}
              rowId={(t) => t.id}
              selectable
              emptyMessage="No tasks for this scope."
              bulkActions={[
                { label: 'Mark complete', icon: Check, onClick: (sel) => sel.forEach((t) => setTaskStatus(t.id, 'complete')) },
                {
                  label: 'Assign to…',
                  icon: UserPlus,
                  onClick: (sel) => setBulkAssign(sel.map((t) => t.id)),
                },
                {
                  label: 'Ask AI about workload',
                  icon: Sparkles,
                  primary: true,
                  onClick: () => startConversation(taskClient === 'all' ? [] : [taskClient]),
                },
              ]}
              footer="Recurring per-client checklists scoped to this product's job"
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
              logAudit({ action: 'Saved colleague', scope: `${c.name} — ${c.role}`, reviewOpened: true });
              setEditing(null);
            }}
            onRemove={async () => {
              const ok = await confirm({
                tone: 'red',
                title: `Remove ${editing.name}?`,
                detail: `${editing.role} · ${editing.clientIds.length} client${editing.clientIds.length === 1 ? '' : 's'}.`,
                consequence: 'Their access ends immediately. Approvals they already gave stay on the record.',
                confirmLabel: 'Yes, remove them',
              });
              if (!ok) return;
              removeColleague(editing.id);
              setEditing(null);
            }}
            onResetPassword={() => {
              sendPasswordReset(editing.id);
              logAudit({ action: 'Sent a password reset link', scope: `${editing.name || 'new colleague'} — ${editing.email}`, reviewOpened: true });
            }}
            onClose={() => setEditing(null)}
          />
        )}

        {editingTeam && (
          <TeamEditor
            team={editingTeam}
            onSave={(t) => {
              saveTeam(t);
              logAudit({ action: 'Saved team', scope: `${t.name} — ${t.memberIds.length} member(s)`, reviewOpened: true });
              setEditingTeam(null);
            }}
            onRemove={async () => {
              const ok = await confirm({
                tone: 'red',
                title: `Delete the "${editingTeam.name}" team?`,
                detail: `${editingTeam.memberIds.length} member${editingTeam.memberIds.length === 1 ? '' : 's'} · ${editingTeam.accessLevel}.`,
                consequence: 'Members keep their own client access; only the grouping goes.',
                confirmLabel: 'Yes, delete it',
              });
              if (!ok) return;
              removeTeam(editingTeam.id);
              logAudit({ action: 'Deleted team', scope: editingTeam.name, reviewOpened: true });
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
              logAudit({ action: 'Created a task', scope: `${t.title} — ${t.clientName} → ${t.assignee}`, reviewOpened: true });
              setNewTask(false);
            }}
            onClose={() => setNewTask(false)}
          />
        )}

        {bulkAssign && (
          <Modal onClose={() => setBulkAssign(null)}>
            <div className="w-full max-w-sm border border-white/5 rounded-[32px] bg-card shadow-2xl overflow-hidden">
              <div className="p-6 border-b border-white/5">
                <h3 className="font-sans font-bold text-xl text-white tracking-tight">Assign to</h3>
                <p className="text-[12px] text-zinc-500 mt-1 font-semibold uppercase tracking-wider">
                  {bulkAssign.length} task{bulkAssign.length === 1 ? '' : 's'}
                </p>
              </div>
              <div className="p-4 flex flex-col gap-1">
                {assignees.map((a) => (
                  <button
                    key={a}
                    onClick={() => {
                      bulkAssign.forEach((id) => assignTask(id, a));
                      logAudit({ action: 'Assigned tasks', scope: `${bulkAssign.length} task(s) → ${a}`, reviewOpened: true });
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

/** Create or edit a team: name, how much client access it carries, members. */
function TeamEditor({ team, onSave, onRemove, onClose }: {
  team: Team; onSave: (t: Team) => void; onRemove: () => void; onClose: () => void;
}) {
  const { colleagues } = useAppContext();
  const [draft, setDraft] = useState(team);
  const isNew = !team.name;

  return (
    <Modal onClose={onClose}>
      <div className="w-full max-w-lg border border-white/5 rounded-[32px] bg-card shadow-2xl overflow-hidden">
        <div className="p-6 border-b border-white/5">
          <h3 className="font-sans font-bold text-xl text-white tracking-tight">{team.name || 'Create team'}</h3>
          <p className="text-[12px] text-zinc-500 mt-1 font-semibold uppercase tracking-wider">
            Groups colleagues and scopes the clients they can reach
          </p>
        </div>

        <div className="p-6 flex flex-col gap-5 max-h-[55vh] overflow-y-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          <Field label="Team name" value={draft.name} onChange={(v) => setDraft({ ...draft, name: v })} placeholder="Hospitality team" />

          <div>
            <Label>Client access</Label>
            <div className="flex flex-wrap gap-2">
              {(['All clients', 'Assigned clients only'] as Team['accessLevel'][]).map((level) => (
                <Chip key={level} active={draft.accessLevel === level} onClick={() => setDraft({ ...draft, accessLevel: level })}>
                  {level}
                </Chip>
              ))}
            </div>
          </div>

          <div>
            <Label>Members ({draft.memberIds.length})</Label>
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
              Delete team
            </button>
          )}
          <button
            onClick={() => onSave({ ...draft, name: draft.name.trim() || 'Untitled team' })}
            className="px-6 py-2.5 rounded-full text-sm font-bold text-white bg-brand hover:bg-brand-hover transition-all"
          >
            {isNew ? 'Create team' : 'Save'}
          </button>
        </div>
      </div>
    </Modal>
  );
}

/** Raise a one-off task and put it on someone's desk. */
function TaskComposer({ assignees, defaultClientId, onCreate, onClose }: {
  assignees: string[];
  defaultClientId: string;
  onCreate: (t: WorkflowTask) => void;
  onClose: () => void;
}) {
  const { clients } = useAppContext();
  const [title, setTitle] = useState('');
  const [clientId, setClientId] = useState(defaultClientId);
  const [assignee, setAssignee] = useState(assignees[0] ?? 'You');
  const [due, setDue] = useState('');

  const client = clients.find((c) => c.id === clientId);

  return (
    <Modal onClose={onClose}>
      <div className="w-full max-w-lg border border-white/5 rounded-[32px] bg-card shadow-2xl overflow-hidden">
        <div className="p-6 border-b border-white/5">
          <h3 className="font-sans font-bold text-xl text-white tracking-tight">New task</h3>
          <p className="text-[12px] text-zinc-500 mt-1 font-semibold uppercase tracking-wider">
            Scoped to one client and one owner
          </p>
        </div>

        <div className="p-6 flex flex-col gap-5">
          <Field label="What needs doing" value={title} onChange={setTitle} placeholder="Chase missing July receipts" />

          <div>
            <Label>Client</Label>
            <select
              value={clientId}
              onChange={(e) => setClientId(e.target.value)}
              className="w-full bg-ground border border-white/5 rounded-xl px-4 py-2.5 text-sm text-white focus:outline-none focus:border-brand"
            >
              {clients.map((c) => <option key={c.id} value={c.id} className="bg-card">{c.name}</option>)}
            </select>
          </div>

          <div>
            <Label>Assign to</Label>
            <div className="flex flex-wrap gap-2">
              {assignees.map((a) => (
                <Chip key={a} active={assignee === a} onClick={() => setAssignee(a)}>{a}</Chip>
              ))}
            </div>
          </div>

          <Field label="Due" value={due} onChange={setDue} placeholder="31 Aug 2026" />
        </div>

        <div className="p-4 bg-raised/50 flex justify-end gap-3">
          <button onClick={onClose} className="px-5 py-2.5 rounded-full text-sm font-bold text-zinc-400 hover:text-white transition-colors">
            Cancel
          </button>
          <button
            onClick={() =>
              onCreate({
                id: `task-${Date.now()}`,
                clientId,
                clientName: client?.name ?? '—',
                title: title.trim() || 'Untitled task',
                assignee,
                due: due.trim() || '—',
                status: 'open',
                aiPrefilled: false,
              })
            }
            disabled={!title.trim()}
            className="px-6 py-2.5 rounded-full text-sm font-bold text-white bg-brand hover:bg-brand-hover disabled:opacity-40 disabled:cursor-not-allowed transition-all"
          >
            Create task
          </button>
        </div>
      </div>
    </Modal>
  );
}

/** Profile picture for a colleague, stored as a data URI. */
function AvatarPicker({ value, name, onChange }: { value: string; name: string; onChange: (v: string) => void }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [error, setError] = useState('');

  return (
    <div>
      <Label>Profile picture</Label>
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
            {value ? 'Replace' : 'Upload'}
          </button>
          {value && (
            <button
              onClick={() => onChange('')}
              className="flex items-center gap-1.5 px-3 py-2 rounded-full text-[13px] font-bold text-zinc-500 hover:text-white transition-colors"
            >
              <X size={14} />
              Remove
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
            if (!file.type.startsWith('image/')) { setError('That is not an image file.'); return; }
            if (file.size > 2 * 1024 * 1024) { setError('Pictures must be under 2MB.'); return; }
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

function ColleagueEditor({ colleague, onSave, onRemove, onResetPassword, onClose }: {
  colleague: Colleague;
  onSave: (c: Colleague) => void;
  onRemove: () => void;
  onResetPassword: () => void;
  onClose: () => void;
}) {
  const { clients } = useAppContext();
  const [draft, setDraft] = useState(colleague);
  const [resetSent, setResetSent] = useState(false);
  const set = <K extends keyof Colleague>(k: K, v: Colleague[K]) => setDraft({ ...draft, [k]: v });
  const isAdmin = draft.role !== 'Standard User';

  return (
    <Modal onClose={onClose}>
      <div className="w-full max-w-lg border border-white/5 rounded-[32px] bg-card shadow-2xl overflow-hidden">
        <div className="p-6 border-b border-white/5">
          <h3 className="font-sans font-bold text-xl text-white tracking-tight">{colleague.name || 'Invite colleague'}</h3>
          <p className="text-[12px] text-zinc-500 mt-1 font-semibold uppercase tracking-wider">
            Role, per-permission toggles and client access
          </p>
        </div>

        <div className="p-6 flex flex-col gap-5 max-h-[55vh] overflow-y-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          <AvatarPicker
            value={draft.avatarDataUrl ?? ''}
            name={draft.name}
            onChange={(v) => set('avatarDataUrl', v || undefined)}
          />
          <div className="grid grid-cols-2 gap-4">
            <Field label="Name" value={draft.name} onChange={(v) => set('name', v)} placeholder="Sam Patel" />
            <Field label="Email" value={draft.email} onChange={(v) => set('email', v)} placeholder="sam@practice.co.uk" />
          </div>
          <div className="grid grid-cols-2 gap-4">
            <Field label="Job title" value={draft.jobTitle ?? ''} onChange={(v) => set('jobTitle', v)} placeholder="Senior bookkeeper" />
            <Field label="Mobile" value={draft.mobile ?? ''} onChange={(v) => set('mobile', v)} placeholder="+44 7700 900123" />
          </div>
          <Field label="Location" value={draft.location} onChange={(v) => set('location', v)} placeholder="London" />

          {/* Sign-in is the colleague's own; the practice can only start a reset. */}
          <div className="p-4 rounded-2xl border border-white/5 bg-ground/60 shadow-inner flex items-center justify-between gap-4">
            <div className="min-w-0">
              <div className="text-sm font-bold text-white">Password</div>
              <div className="text-[12px] text-zinc-500 mt-0.5">
                {resetSent
                  ? `Reset link sent to ${draft.email || 'their email'} just now.`
                  : draft.passwordResetSentAt
                    ? `Last reset link sent ${draft.passwordResetSentAt}.`
                    : 'You cannot see or set it — send a reset link instead.'}
              </div>
            </div>
            <button
              onClick={() => { onResetPassword(); setResetSent(true); }}
              disabled={!draft.email}
              className="shrink-0 flex items-center gap-2 px-4 py-2 rounded-full text-[12px] font-bold text-zinc-300 border border-white/10 hover:text-white hover:border-white/25 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            >
              <KeyRound size={13} />
              {resetSent ? 'Sent' : 'Send reset link'}
            </button>
          </div>

          <div>
            <Label>Role</Label>
            <div className="flex flex-wrap gap-2">
              {ROLES.map((r) => (
                <Chip key={r} active={draft.role === r} onClick={() => set('role', r)}>{r}</Chip>
              ))}
            </div>
          </div>

          <div>
            <Label>Permissions</Label>
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
              <Label>Client access</Label>
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
            label="Hide finance fields"
            hint="For non-finance submitters — they see capture, not coding."
            value={draft.hideFinanceFields}
            onChange={(v) => set('hideFinanceFields', v)}
          />
          <Toggle label="Active" value={draft.active} onChange={(v) => set('active', v)} />
        </div>

        <div className="p-4 bg-raised/50 flex justify-between gap-3">
          <button onClick={onRemove} className="flex items-center gap-2 px-4 py-2.5 rounded-full text-sm font-bold text-zinc-500 hover:text-red-400 hover:bg-white/5 transition-colors">
            <Trash2 size={15} />
            Remove
          </button>
          <button onClick={() => onSave(draft)} className="px-6 py-2.5 rounded-full text-sm font-bold text-white bg-brand hover:bg-brand-hover transition-all">
            Save
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
          ? 'bg-brand text-white border-brand shadow-[0_0_12px_rgba(20,227,196,0.25)]'
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
