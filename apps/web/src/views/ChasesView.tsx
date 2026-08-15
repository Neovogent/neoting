import { useMemo, useRef, useState } from 'react';
import {
  Send, Play, X, Check, MessageSquare, Clock, ShieldOff, Ban, Wand2, FileSearch, PencilLine,
  Link2, ChevronRight, SlidersHorizontal, Undo2, Upload,
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { useAppContext } from '../context/AppContext';
import { cooldownFor, describeAge, formatWait, SmsCooldownNotice } from '../components/DynamicComponents/SmsCooldown';
import { useConfirm } from '../components/DynamicComponents/ConfirmProvider';
import { Tooltip } from '../components/DynamicComponents/Tooltip';
import { detectionOf } from '../lib/detection';
import { MessageEditor } from '../components/DynamicComponents/ChaseComposer';
import { ChaseModal } from '../components/DynamicComponents/ChaseModal';
import { currency } from '../lib/resolver';
import { clampLinkTtl, LINK_TTL_PRESETS, MAX_LINK_TTL_HOURS, MIN_LINK_TTL_HOURS } from '../lib/generate';
import type { Chase, ChaseItem, ChaseItemStatus } from '../lib/types';

const STAGE_LABEL: Record<Chase['stage'], { label: string; light: string; dark: string }> = {
  sent: { label: 'Sent', light: 'bg-zinc-900 text-white', dark: 'bg-[#202026] text-zinc-300' },
  'reminder-1': { label: 'Reminder 1', light: 'bg-amber-100 text-amber-800', dark: 'bg-amber-500/10 text-amber-400' },
  'reminder-2': { label: 'Reminder 2', light: 'bg-amber-200 text-amber-900', dark: 'bg-amber-500/15 text-amber-300' },
  escalated: { label: 'Escalated', light: 'bg-[#14e3c4] text-white', dark: 'bg-[#14e3c4]/15 text-[#14e3c4]' },
  closed: { label: 'Closed', light: 'bg-emerald-100 text-emerald-700', dark: 'bg-emerald-500/10 text-emerald-400' },
};

export function ChasesView() {
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
    setChasing({ clientIds: ids, note: `${pending.length} detections across ${ids.length} client${ids.length === 1 ? '' : 's'}, grouped into one SMS each.` });
  };

  const chaseOne = (clientId: string) => {
    const ids = missing.filter((m) => m.clientId === clientId && !m.chased).map((m) => m.id);
    if (!clients.some((c) => c.id === clientId)) return;
    setChasing({
      clientIds: [clientId],
      missingItemIds: ids,
      note: ids.length
        ? undefined
        : 'Everything for this client is already requested — send a reminder from the chase detail instead.',
    });
  };

  const [chasing, setChasing] = useState<{ clientIds: string[]; missingItemIds?: string[]; note?: string } | null>(null);
  const active = chases.find((c) => c.id === openChase) ?? null;

  return (
    <div className="flex-1 flex flex-col min-w-0 bg-[#0a0a0c] h-full overflow-y-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
      <div className="px-10 py-8 shrink-0">
        <div className="flex items-start justify-between mb-8 gap-4 flex-wrap">
          <div>
            <h1 className="font-sans text-3xl font-semibold text-white tracking-tight">Missing Evidence</h1>
            <p className="text-zinc-400 mt-2">Manage requested paperwork and automated SMS chasing.</p>
          </div>
          <div className="flex items-center gap-3 flex-wrap">
            <button
              onClick={() => setMessagesOpen(true)}
              className="flex items-center gap-2 px-5 py-3 text-sm font-bold text-zinc-300 bg-[#16161a] border border-white/10 rounded-full hover:bg-white/5 transition-all shadow-lg"
            >
              <MessageSquare size={16} />
              Item messages
              {itemMessages.length > 0 && <span className="px-2 py-0.5 rounded-full bg-[#14e3c4] text-white text-[11px]">{itemMessages.length}</span>}
            </button>
            <button
              onClick={() => setPolicyOpen(true)}
              className="flex items-center gap-2 px-5 py-3 text-sm font-bold text-zinc-300 bg-[#16161a] border border-white/10 rounded-full hover:bg-white/5 transition-all shadow-lg"
            >
              <SlidersHorizontal size={16} />
              Chase policy
            </button>
            <button
              onClick={runEngine}
              disabled={totalMissing === 0}
              className="flex items-center gap-2 px-6 py-3 bg-[#14e3c4] text-white text-sm font-bold rounded-full hover:bg-[#0fcbaf] transition-all shadow-[0_0_20px_rgba(20,227,196,0.2)] disabled:opacity-40"
            >
              <Play size={16} fill="currentColor" />
              Run Chase Engine Now
            </button>
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          <StatCard
            title="Missing Documents"
            value={String(totalMissing)}
            subtitle={`Across ${clients.filter((c) => statsFor(c.id).missing > 0).length} clients`}
            trend="Not yet chased"
          />
          <StatCard
            title="Active Chases (SMS)"
            value={String(activeChases)}
            subtitle={`${awaiting} items awaiting upload`}
            trend={`${chasePolicy.reminderOneDays}/${chasePolicy.reminderTwoDays} day policy`}
          />
          <StatCard
            title="Overdue & Escalated"
            value={String(totalOverdue)}
            subtitle="Requires accountant intervention"
            trend={`${clients.filter((c) => statsFor(c.id).overdue > 0).length} client${
              clients.filter((c) => statsFor(c.id).overdue > 0).length === 1 ? '' : 's'
            } flagged`}
            alert={totalOverdue > 0}
          />
        </div>
      </div>

      <div className="flex-1 bg-white rounded-t-[40px] m-4 mt-0 p-8 shadow-2xl flex flex-col overflow-hidden border border-white/10">
        <div className="px-2 py-4 flex items-center justify-between mb-4 gap-4 flex-wrap">
          <h3 className="font-sans text-xl font-bold text-zinc-900 tracking-tight">Practice Dashboard: Chasing Status</h3>
          <div className="flex items-center gap-2 bg-[#f4f4f5] p-1.5 rounded-full">
            <button
              onClick={() => setFilter('all')}
              className={`px-5 py-2 rounded-full text-sm font-semibold transition-colors ${filter === 'all' ? 'bg-white text-black shadow-sm' : 'text-zinc-500 hover:text-black'}`}
            >
              All Clients
            </button>
            <button
              onClick={() => setFilter('overdue')}
              className={`px-5 py-2 rounded-full text-sm font-semibold transition-colors ${filter === 'overdue' ? 'bg-white text-black shadow-sm' : 'text-zinc-500 hover:text-black'}`}
            >
              Overdue
            </button>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto">
          <table className="w-full text-left text-sm whitespace-nowrap">
            <thead className="text-[11px] uppercase tracking-widest font-bold text-zinc-400">
              <tr>
                <th className="px-4 py-4">Client</th>
                <th className="px-4 py-4 text-right">Missing</th>
                <th className="px-4 py-4 text-right">Requested</th>
                <th className="px-4 py-4 text-right">Overdue</th>
                <th className="px-4 py-4">Stage</th>
                <th className="px-4 py-4">Auto-Chase Policy</th>
                <th className="px-4 py-4">Last Upload</th>
                <th className="px-4 py-4 text-right">Action</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-100">
              {rows.length === 0 && (
                <tr>
                  <td colSpan={8} className="px-4 py-16 text-center text-zinc-400 font-medium">
                    Nothing overdue — every chase is inside its policy window.
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
                    {stats.overdue > 0 ? (
                      <span className="bg-[#14e3c4] text-white px-3 py-1 rounded-full text-xs">{stats.overdue}</span>
                    ) : (
                      <span className="text-zinc-400">0</span>
                    )}
                  </td>
                  <td className="px-4 py-5">
                    {chase ? (
                      <span className={`inline-flex px-3 py-1 rounded-full text-[11px] font-bold uppercase tracking-wide ${STAGE_LABEL[chase.stage].light}`}>
                        {STAGE_LABEL[chase.stage].label}
                      </span>
                    ) : (
                      <span className="text-zinc-400 text-[13px] font-medium">No chase sent</span>
                    )}
                  </td>
                  <td className="px-4 py-5 text-zinc-600">
                    <span className="inline-flex px-3 py-1 rounded-full text-[11px] font-bold uppercase tracking-wide bg-zinc-900 text-white">
                      {chase?.policy ?? `Standard (${chasePolicy.reminderOneDays}/${chasePolicy.reminderTwoDays} days)`}
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
                          Open
                          <ChevronRight size={14} />
                        </button>
                      )}
                      <button
                        onClick={() => chaseOne(client.id)}
                        disabled={stats.missing === 0}
                        className="text-sm font-bold text-white bg-zinc-900 hover:bg-black px-4 py-2.5 rounded-full transition-colors shadow-md disabled:opacity-30 disabled:cursor-not-allowed"
                      >
                        Review &amp; Chase
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
            missingItemIds={chasing.missingItemIds}
            note={chasing.note}
            onClose={() => setChasing(null)}
          />
        )}
        {active && <ChaseDetail chase={active} onClose={() => setOpenChase(null)} />}
        {policyOpen && (
          <PolicyPanel
            policy={chasePolicy}
            onChange={(p) => { setChasePolicy(p); logAudit({ action: 'Updated chase policy', scope: `${p.reminderOneDays}/${p.reminderTwoDays} days, escalate ${p.escalateAfterDays}d`, reviewOpened: true }); }}
            onClose={() => setPolicyOpen(false)}
          />
        )}
        {messagesOpen && <ItemMessagesPanel onClose={() => setMessagesOpen(false)} />}
      </AnimatePresence>
    </div>
  );
}

function ChaseDetail({ chase, onClose }: { chase: Chase; onClose: () => void }) {
  const {
    sendReminder, escalateChase, closeChase, resendLink, setChaseItemStatus,
    revertChaseItem, logAudit, chasePolicy, ingest, setChaseMessage,
  } = useAppContext();
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
        action: 'Updated a chase',
        scope: `${chase.clientName} — ${changed.length} item(s)${closingChase ? ', chase closed' : ''}`,
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
    const answer = await confirm({
      title: 'Save your changes to this chase?',
      detail: [
        changed.length ? `${changed.length} item${changed.length === 1 ? '' : 's'}` : '',
        messageChanged ? 'the message wording' : '',
        closingChase ? 'the chase itself' : '',
      ]
        .filter(Boolean)
        .join(', ')
        .replace(/, ([^,]*)$/, ' and $1')
        .concat(' changed and not yet saved.'),
      confirmLabel: 'Save and close',
      altLabel: 'Close without saving',
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
    if (!item || !files?.length) return;
    const file = files[0];
    ingest([{ name: file.name, size: file.size, raw: file }], chase.clientId, 'web', {
      uploader: 'You (web upload)',
      kind: 'cost',
    });
    logAudit({
      action: 'Uploaded a chased document',
      scope: `${item.supplier} — ${chase.clientName}`,
      reviewOpened: true,
    });
  };
  // How long before another text may go to this person.
  const cooldown = cooldownFor(chase.lastSmsAtMs, chasePolicy.resendAfterHours);
  const outstanding = chase.items.filter((i) => i.status === 'requested');

  return (
    <Modal onClose={attemptClose}>
      <div className="w-full max-w-3xl border border-white/5 rounded-[32px] bg-[#16161a] shadow-2xl overflow-hidden">
        <input
          ref={fileRef}
          type="file"
          className="hidden"
          accept=".jpg,.jpeg,.png,.gif,.bmp,.tiff,.heic,.pdf,.doc,.docx,.odt,.rtf,.csv,.xlsx"
          onChange={(e) => { handleUpload(e.target.files); e.target.value = ''; }}
        />

        <div className="p-6 flex items-start justify-between gap-4 border-b border-white/5">
          <div className="flex items-center gap-4 min-w-0">
            <div className="w-12 h-12 rounded-2xl bg-[#202026] flex items-center justify-center text-white border border-white/5 shadow-inner shrink-0">
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
            {STAGE_LABEL[chase.stage].label}
          </span>
        </div>

        <div className="p-6 flex flex-col gap-6 max-h-[60vh] overflow-y-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          <Section title="Message sent (SMS)">
            <div className="bg-[#0a0a0c]/60 border border-white/5 rounded-2xl p-4 text-[13px] text-zinc-300 font-mono leading-relaxed shadow-inner whitespace-pre-wrap">
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
                      Wording for the next reminder
                    </span>
                    <button
                      onClick={() => setEditingMessage(false)}
                      className="text-[11px] font-bold text-zinc-400 hover:text-white transition-colors"
                    >
                      Done editing
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
                    className="inline-flex items-center gap-2 px-4 py-2 rounded-full text-[12px] font-bold text-zinc-300 bg-[#16161a] border border-white/5 hover:bg-white/5 transition-colors"
                  >
                    <PencilLine size={13} />
                    Write the next reminder yourself
                  </button>
                  {(messageChanged || chase.nextMessage) && (
                    <span className="text-[11.5px] font-bold text-amber-400">
                      {messageChanged ? 'Rewritten — unsaved' : 'Next reminder uses your wording'}
                    </span>
                  )}
                </div>
              )}
            </div>
            <div className="flex items-center gap-3 mt-3 flex-wrap text-[12px] font-semibold">
              <span className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full ${chase.linkExpiresInHours > 0 ? 'bg-[#14e3c4]/10 text-[#14e3c4]' : 'bg-red-500/10 text-red-400'}`}>
                <Link2 size={12} />
                {chase.linkExpiresInHours > 0 ? `Link valid ${chase.linkExpiresInHours}h` : 'Link expired'}
              </span>
              <span className="text-zinc-600">OTP to the registered mobile · upload-only portal · forwardable by design</span>
            </div>
          </Section>

          <Section title={`Requested items — ${outstanding.length} outstanding`}>
            <div className="bg-[#0a0a0c]/60 border border-white/5 rounded-2xl divide-y divide-white/5 shadow-inner">
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
                          <Tooltip label={`Found by: ${found.tag}`} detail={`${found.detail} Check it under ${found.where}.`}>
                            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10.5px] font-bold uppercase tracking-wide text-zinc-400 bg-white/[0.05] cursor-help">
                              <FileSearch size={10} />
                              {found.tag}
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
                        Waiting on {chase.recipientName.split(' ')[0]}
                      </span>
                      {/* The accountant often already has the receipt — it came
                          by email, or it is in their own files. Uploading it
                          here is the one thing that genuinely answers the
                          request without waiting for anybody. */}
                      <MiniBtn
                        icon={Upload}
                        label="Upload it"
                        primary
                        onClick={() => setUploadFor(item)}
                      />
                      <MiniBtn icon={ShieldOff} label="Unavailable" onClick={() => stage(item, 'unavailable')} />
                      {/* Per document, because "Close chase" in the footer
                          never said which one it meant. This stops the asking
                          for this row only; the gap stays on the missing list
                          because nothing has answered it. */}
                      <MiniBtn icon={Ban} label="Stop chasing" onClick={() => stage(item, 'dismissed')} />
                      <MiniBtn icon={Wand2} label="Cash code" onClick={() => stage(item, 'cash-coded')} />
                    </div>
                  ) : (
                    // Every call on an item is reversible: nothing here is a
                    // one-way door.
                    <div className="flex items-center gap-2 justify-end">
                      <StatusPill status={statusOf(item)} />
                      {draft[item.missingItemId] && draft[item.missingItemId] !== item.status && (
                        <span className="text-[11px] font-bold text-amber-400 whitespace-nowrap">Unsaved</span>
                      )}
                      <MiniBtn
                        icon={Undo2}
                        label="Undo"
                        onClick={() => {
                          revertChaseItem(chase.id, item.missingItemId);
                          logAudit({
                            action: 'Reverted a chased item',
                            scope: `${item.supplier} — ${chase.clientName} (was ${item.status})`,
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

          <Section title="Timeline">
            <div className="flex flex-col gap-3">
              {chase.events.map((e, i) => (
                <div key={i} className="flex items-start gap-3">
                  <div className="w-7 h-7 rounded-lg bg-[#202026] border border-white/5 flex items-center justify-center text-zinc-500 shrink-0 mt-0.5">
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

        <div className="p-4 bg-[#202026]/50 flex items-center gap-3 flex-wrap justify-end">
          {dirty && (
            <span className="mr-auto text-[12px] font-bold text-amber-400">
              {changed.length ? `${changed.length} unsaved change${changed.length === 1 ? '' : 's'}` : 'Chase will be closed'}
            </span>
          )}

          {/* Closing is a decision like any other on this screen, so it waits
              for Save with the rest rather than taking effect under the cursor. */}
          <Tooltip
            label={outstanding.length ? `Stops asking for all ${outstanding.length} outstanding item${outstanding.length === 1 ? '' : 's'}` : 'Stops this chase'}
            detail="The items stay on the missing list — closing the chase stops the asking, it does not answer anything. To stop one document only, use Stop chasing on its row."
          >
            <button
              onClick={() => setClosingChase((v) => !v)}
              className={`px-5 py-2.5 rounded-full text-sm font-bold transition-colors ${
                closingChase ? 'text-amber-400 bg-amber-400/10' : 'text-zinc-400 hover:text-white hover:bg-white/5'
              }`}
            >
              {closingChase
                ? 'Closing whole chase — undo'
                : `Close whole chase${outstanding.length ? ` (${outstanding.length})` : ''}`}
            </button>
          </Tooltip>

          <FooterAction
            icon={Link2}
            label="Re-send link"
            onClick={() => resendLink(chase.id)}
            blocked={cooldown.blocked}
            blockedTitle="The link is still live"
            blockedDetail={`It was sent ${describeAge(cooldown.sentHoursAgo)} and lasts ${chasePolicy.linkTtlHours}h, so re-sending now gives ${chase.recipientName.split(' ')[0]} the same link again. Another can go in ${formatWait(cooldown.hoursLeft)}.`}
          />

          {/* Says what it actually does today. See escalateChase in
              AppContext for the six things it has to do to be real. */}
          <FooterAction
            label="Escalate"
            onClick={() => escalateChase(chase.id)}
            title="Flags this for escalation"
            detail="Moves the chase to Overdue & Escalated so it is not lost among the routine ones. It does not yet contact anyone new — going over the contact's head to the owner or director is still to be built."
          />

          <FooterAction
            icon={Send}
            primary
            label={cooldown.blocked ? `Reminder in ${formatWait(cooldown.hoursLeft)}` : 'Send reminder now'}
            onClick={() => { sendReminder(chase.id); logAudit({ action: 'Sent chase reminder', scope: chase.clientName, reviewOpened: true }); }}
            blocked={cooldown.blocked}
            blockedTitle={`Another text can go in ${formatWait(cooldown.hoursLeft)}`}
            blockedDetail={`${chase.recipientName} was texted ${describeAge(cooldown.sentHoursAgo)}. Texting again this soon repeats the same ask — change the wait under Settings → Chasing, or use Escalate if it is not working.`}
          />

          <button
            onClick={save}
            disabled={!dirty}
            className="flex items-center gap-2 px-6 py-2.5 rounded-full text-sm font-bold text-white bg-[#14e3c4] hover:bg-[#0fcbaf] disabled:opacity-40 disabled:cursor-not-allowed transition-all shadow-[0_0_15px_rgba(20,227,196,0.3)]"
          >
            <Check size={15} />
            Save changes
          </button>
        </div>
      </div>
    </Modal>
  );
}

function PolicyPanel({ policy, onChange, onClose }: { policy: any; onChange: (p: any) => void; onClose: () => void }) {
  const [draft, setDraft] = useState(policy);
  const set = (k: string, v: any) => setDraft({ ...draft, [k]: v });

  return (
    <Modal onClose={onClose}>
      <div className="w-full max-w-lg border border-white/5 rounded-[32px] bg-[#16161a] shadow-2xl overflow-hidden">
        <div className="p-6 border-b border-white/5">
          <h3 className="font-sans font-bold text-xl text-white tracking-tight">Chase policy</h3>
          <p className="text-[12px] text-zinc-500 mt-1 font-semibold uppercase tracking-wider">SMS only — by design</p>
        </div>
        <div className="p-6 flex flex-col gap-5 max-h-[60vh] overflow-y-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          <div className="grid grid-cols-2 gap-4">
            <Num label="First chase after (hours)" value={draft.firstChaseAfterHours} onChange={(v) => set('firstChaseAfterHours', v)} />
            <Num label="Reminder 1 (days)" value={draft.reminderOneDays} onChange={(v) => set('reminderOneDays', v)} />
            <Num label="Reminder 2 (days)" value={draft.reminderTwoDays} onChange={(v) => set('reminderTwoDays', v)} />
            <Num label="Escalate after (days)" value={draft.escalateAfterDays} onChange={(v) => set('escalateAfterDays', v)} />
            <Text label="Quiet hours from" value={draft.quietHoursStart} onChange={(v) => set('quietHoursStart', v)} />
            <Text label="Quiet hours to" value={draft.quietHoursEnd} onChange={(v) => set('quietHoursEnd', v)} />
            <Text label="SMS sender ID" value={draft.senderId} onChange={(v) => set('senderId', v)} />
          </div>

          <LinkTtlField value={draft.linkTtlHours} onChange={(v) => set('linkTtlHours', v)} />

          <Toggle
            label="Auto-chase on schedule"
            hint="Approving this policy approves its future executions — any change comes back through review."
            value={draft.autoChase}
            onChange={(v) => set('autoChase', v)}
          />
          <Toggle
            label="Notify me when a client uploads"
            hint="Dext's 45-vote request. Default on."
            value={draft.notifyOnUpload}
            onChange={(v) => set('notifyOnUpload', v)}
          />

          <div className="text-[12px] text-zinc-500 leading-relaxed bg-[#0a0a0c]/60 border border-white/5 rounded-2xl p-4">
            <span className="font-bold text-zinc-400">Suppression:</span> chasing stops automatically when an item is
            received, marked unavailable, dismissed, cash-coded or exception-approved.
          </div>
        </div>
        <div className="p-4 bg-[#202026]/50 flex justify-end gap-3">
          <button onClick={onClose} className="px-5 py-2.5 rounded-full text-sm font-bold text-zinc-400 hover:text-white hover:bg-white/5 transition-colors">
            Cancel
          </button>
          <button
            onClick={() => { onChange(draft); onClose(); }}
            className="px-6 py-2.5 rounded-full text-sm font-bold text-white bg-[#14e3c4] hover:bg-[#0fcbaf] transition-all"
          >
            Save policy
          </button>
        </div>
      </div>
    </Modal>
  );
}

function ItemMessagesPanel({ onClose }: { onClose: () => void }) {
  const { itemMessages, clients, documents, sendItemMessage, logAudit } = useAppContext();
  const [clientId, setClientId] = useState(clients[0]?.id ?? '');
  const [question, setQuestion] = useState('');
  const clientDocs = documents.filter((d) => d.clientId === clientId).slice(0, 40);
  const [docLabel, setDocLabel] = useState('');

  return (
    <Modal onClose={onClose}>
      <div className="w-full max-w-lg border border-white/5 rounded-[32px] bg-[#16161a] shadow-2xl overflow-hidden">
        <div className="p-6 border-b border-white/5">
          <h3 className="font-sans font-bold text-xl text-white tracking-tight">Item messages</h3>
          <p className="text-[12px] text-zinc-500 mt-1 font-semibold uppercase tracking-wider">
            Per-document questions over the same SMS link — no app required
          </p>
        </div>

        <div className="p-6 flex flex-col gap-4">
          <div className="grid grid-cols-2 gap-4">
            <Select label="Client" value={clientId} onChange={(v) => { setClientId(v); setDocLabel(''); }} options={clients.map((c) => ({ value: c.id, label: c.name }))} />
            <Select
              label="Document"
              value={docLabel}
              onChange={setDocLabel}
              options={[{ value: '', label: 'Choose…' }, ...clientDocs.map((d) => ({ value: `${d.supplier} · ${currency(d.total)}`, label: `${d.supplier} · ${currency(d.total)}` }))]}
            />
          </div>
          <div>
            <div className="text-[11px] font-bold text-zinc-500 uppercase tracking-widest mb-2">Question</div>
            <textarea
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
              rows={3}
              placeholder="Is this £850 laptop fully business use?"
              className="w-full bg-[#0a0a0c] border border-white/5 rounded-xl px-4 py-3 text-sm text-white placeholder:text-zinc-600 focus:outline-none focus:border-[#14e3c4] transition-colors resize-none"
            />
          </div>

          {itemMessages.length > 0 && (
            <div>
              <div className="text-[11px] font-bold text-zinc-500 uppercase tracking-widest mb-2.5">Sent</div>
              <div className="flex flex-col gap-2 max-h-40 overflow-y-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
                {itemMessages.map((m) => (
                  <div key={m.id} className="p-3 rounded-2xl bg-[#0a0a0c]/60 border border-white/5">
                    <div className="text-[12px] font-bold text-white">{m.clientName} — {m.documentLabel}</div>
                    <div className="text-[12px] text-zinc-400 mt-0.5">{m.question}</div>
                    <div className="text-[11px] text-zinc-600 font-semibold mt-1">{m.sentAt} · awaiting reply</div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        <div className="p-4 bg-[#202026]/50 flex justify-end">
          <button
            disabled={!question.trim() || !docLabel}
            onClick={() => {
              sendItemMessage(clientId, docLabel, question.trim());
              logAudit({ action: 'Sent item message', scope: `${docLabel} — ${clients.find((c) => c.id === clientId)?.name}`, reviewOpened: true });
              setQuestion('');
            }}
            className="flex items-center gap-2 px-6 py-2.5 rounded-full text-sm font-bold text-white bg-[#14e3c4] hover:bg-[#0fcbaf] transition-all disabled:opacity-40"
          >
            <Send size={15} />
            Send by SMS
          </button>
        </div>
      </div>
    </Modal>
  );
}

function StatCard({ title, value, subtitle, trend, alert = false }: { title: string; value: string; subtitle: string; trend: string; alert?: boolean }) {
  return (
    <div className="p-6 rounded-[32px] bg-[#16161a] border border-white/5 flex flex-col relative overflow-hidden group hover:border-[#14e3c4]/30 transition-colors">
      {alert && <div className="absolute top-0 left-0 w-full h-1 bg-[#14e3c4]" />}
      <div className="flex justify-between items-start mb-6 gap-3">
        <h3 className="text-[13px] font-semibold text-zinc-400 tracking-wide">{title}</h3>
        <span className="text-[11px] font-bold text-white bg-[#14e3c4] px-2.5 py-1 rounded-full shrink-0">{trend}</span>
      </div>
      <div>
        <div className="text-5xl font-sans font-bold tracking-tight mb-2 text-white">{value}</div>
        <p className="text-sm text-zinc-500 font-medium">{subtitle}</p>
      </div>
    </div>
  );
}

function StatusPill({ status }: { status: ChaseItemStatus }) {
  const map: Record<ChaseItemStatus, { label: string; cls: string }> = {
    requested: { label: 'Requested', cls: 'bg-[#202026] text-zinc-300' },
    received: { label: 'Received', cls: 'bg-emerald-500/10 text-emerald-400' },
    unavailable: { label: 'Unavailable', cls: 'bg-amber-500/10 text-amber-400' },
    dismissed: { label: 'Dismissed', cls: 'bg-zinc-800 text-zinc-500' },
    'cash-coded': { label: 'Cash coded', cls: 'bg-[#14e3c4]/15 text-[#14e3c4]' },
  };
  const s = map[status];
  return <span className={`px-3 py-1.5 rounded-full text-[11px] font-bold tracking-wide ${s.cls}`}>{s.label}</span>;
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
  icon?: any;
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
          ? 'text-white bg-[#14e3c4] hover:bg-[#0fcbaf] shadow-[0_0_15px_rgba(20,227,196,0.3)]'
          : 'text-zinc-300 bg-[#16161a] border border-white/5 hover:bg-white/5'
      } ${blocked ? 'opacity-40 cursor-not-allowed hover:bg-inherit' : ''}`}
    >
      {Icon && <Icon size={15} />}
      {label}
    </button>
  );

  const label_ = blocked ? blockedTitle : title;
  const detail_ = blocked ? blockedDetail : detail;
  return label_ ? <Tooltip label={label_} detail={detail_}>{button}</Tooltip> : button;
}

function MiniBtn({ icon: Icon, label, onClick, primary }: { icon: any; label: string; onClick: () => void; primary?: boolean }) {
  return (
    <button
      onClick={onClick}
      className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full text-[12px] font-bold transition-colors ${
        primary ? 'text-white bg-[#14e3c4] hover:bg-[#0fcbaf]' : 'text-zinc-400 hover:text-white hover:bg-white/5 border border-white/5'
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
        <button onClick={onClose} className="absolute -top-3 -right-3 z-10 p-2 bg-[#16161a] hover:bg-[#202026] text-zinc-400 hover:text-white rounded-full border border-white/10 transition-colors shadow-lg">
          <X size={18} />
        </button>
        {children}
      </motion.div>
    </motion.div>
  );
}

/**
 * Secure-link lifetime: any value the practice wants, up to a week. The cap is
 * enforced here and again in the context, so it holds however the value is set.
 */
export function LinkTtlField({ value, onChange }: { value: number; onChange: (v: number) => void }) {
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
      <div className="text-[11px] font-bold text-zinc-500 uppercase tracking-widest mb-2">Secure link expires after</div>
      <div className="flex items-center gap-2 flex-wrap mb-2.5">
        {LINK_TTL_PRESETS.map((p) => (
          <button
            key={p.hours}
            onClick={() => { setReduced(false); onChange(p.hours); }}
            className={`px-3.5 py-2 rounded-full text-[12px] font-bold border transition-all ${
              value === p.hours
                ? 'bg-[#14e3c4] text-white border-[#14e3c4]'
                : 'bg-[#0a0a0c] text-zinc-400 border-white/5 hover:text-white hover:border-white/15'
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
          className={`w-28 bg-[#0a0a0c] border rounded-xl px-4 py-2.5 text-sm text-white focus:outline-none transition-colors ${
            reduced ? 'border-amber-500/50' : 'border-white/5 focus:border-[#14e3c4]'
          }`}
        />
        <span className="text-[13px] text-zinc-500 font-semibold">
          hours{value >= 24 ? ` · ${(value / 24).toFixed(value % 24 === 0 ? 0 : 1)} day${value >= 48 ? 's' : ''}` : ''}
        </span>
      </div>
      <div className={`text-[11px] mt-1.5 font-medium ${reduced ? 'text-amber-400' : 'text-zinc-600'}`}>
        {reduced
          ? `A link cannot outlive 7 days — kept at ${MAX_LINK_TTL_HOURS} hours.`
          : 'Anything from 1 hour up to 7 days. A link that outlives the conversation is a security risk.'}
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
        className="w-full bg-[#0a0a0c] border border-white/5 rounded-xl px-4 py-2.5 text-sm text-white focus:outline-none focus:border-[#14e3c4] transition-colors"
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
        className="w-full bg-[#0a0a0c] border border-white/5 rounded-xl px-4 py-2.5 text-sm text-white focus:outline-none focus:border-[#14e3c4] transition-colors"
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
        className="w-full bg-[#0a0a0c] border border-white/5 rounded-xl px-4 py-2.5 text-sm text-white focus:outline-none focus:border-[#14e3c4] transition-colors"
      >
        {options.map((o) => (
          <option key={o.value} value={o.value} className="bg-[#16161a]">{o.label}</option>
        ))}
      </select>
    </div>
  );
}

function Toggle({ label, hint, value, onChange }: { label: string; hint?: string; value: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      onClick={() => onChange(!value)}
      className="bg-[#0a0a0c]/60 border border-white/5 rounded-2xl p-4 flex items-center justify-between gap-4 shadow-inner hover:border-white/10 transition-colors text-left"
    >
      <div>
        <div className="text-sm font-bold text-white">{label}</div>
        {hint && <div className="text-[12px] text-zinc-500 mt-0.5">{hint}</div>}
      </div>
      <span className={`w-11 h-6 rounded-full shrink-0 transition-colors relative ${value ? 'bg-[#14e3c4]' : 'bg-white/10'}`}>
        <span className={`absolute top-1 w-4 h-4 rounded-full bg-white transition-all ${value ? 'left-6' : 'left-1'}`} />
      </span>
    </button>
  );
}
