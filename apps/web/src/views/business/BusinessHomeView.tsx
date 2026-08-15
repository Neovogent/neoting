import { useMemo } from 'react';
import { Camera, Upload, AlertCircle, Clock, CheckCircle2, FileText, ShieldCheck, Eye, X, UserPlus, Check } from 'lucide-react';
import { useAppContext } from '../../context/AppContext';
import { Pill } from '../../components/DynamicComponents/DataTable';
import { currency } from '../../lib/resolver';
import type { BusinessAccount } from '../../lib/types';
import { useQueryParam } from '../../lib/router';
import { DocumentPreview } from '../../components/DynamicComponents/DocumentPreview';
import { useConfirm } from '../../components/DynamicComponents/ConfirmProvider';
import { channelLabel } from '../../lib/channels';

const STATUS_TONE = {
  processing: { tone: 'blue' as const, label: 'Processing' },
  review: { tone: 'amber' as const, label: 'With your accountant' },
  ready: { tone: 'green' as const, label: 'Accepted' },
  published: { tone: 'green' as const, label: 'Filed' },
  rejected: { tone: 'red' as const, label: 'Needs another copy' },
};

/**
 * What the business sees first: what its accountant is still waiting on, and
 * what it has already sent. Everything here is the same pipeline state the
 * practice sees — phrased from the client's side of the relationship.
 */
export function BusinessHomeView({
  account,
  onGo,
}: {
  account: BusinessAccount;
  onGo: (tab: 'Home' | 'Upload' | 'Capture' | 'Settings') => void;
}) {
  const {
    missing, documents, chases,
    clientSideApprovals, approvalRequests, sendApprovalRequest, openApprovalLink, reviewProposedUser,
    clientDetailChanges, reviewClientDetailChange,
  } = useAppContext();
  const confirm = useConfirm();

  /**
   * Wireframe screen 19: "an approver who happens to have a business login
   * sees the same pending items in their workspace too — but SMS is the
   * delivery channel". This is that second view of the same queue.
   */
  // ?doc=<id> — the viewer is a link here too.
  const [previewId, setPreviewId] = useQueryParam('doc');
  const preview = previewId ? documents.find((d) => d.id === previewId) ?? null : null;

  const toApprove = clientSideApprovals(account.clientId);
  const approvalRequest = approvalRequests.find((r) => r.clientId === account.clientId);

  /**
   * People the accountant has proposed for this business. They are waiting
   * here rather than already having access, because the practice does not get
   * to decide who works at the company.
   */
  const proposedUsers = account.members.filter((m) => m.status === 'pending-client-approval');
  /** Edits the accountant wants to make to this business's own record. */
  const proposedChanges = clientDetailChanges.filter((c) => c.clientId === account.clientId && c.status === 'pending');

  const requests = useMemo(
    () => missing.filter((m) => m.clientId === account.clientId),
    [missing, account.clientId],
  );

  const myDocs = useMemo(
    () => documents.filter((d) => d.clientId === account.clientId).slice(0, 8),
    [documents, account.clientId],
  );

  const chase = chases.find((c) => c.clientId === account.clientId);
  const sent = documents.filter((d) => d.clientId === account.clientId && d.source === 'portal').length;
  const processing = documents.filter((d) => d.clientId === account.clientId && d.status === 'processing').length;
  const rejected = documents.filter((d) => d.clientId === account.clientId && d.status === 'rejected').length;

  return (
    <div className="p-8 max-w-5xl mx-auto flex flex-col gap-6">
      <div>
        <h1 className="font-sans text-2xl font-bold text-white tracking-tight">
          Hello {account.contactName.split(' ')[0] || 'there'}
        </h1>
        <p className="text-[13px] text-zinc-500 mt-1">
          {requests.length > 0
            ? `Your accountant is waiting on ${requests.length} ${requests.length === 1 ? 'document' : 'documents'}.`
            : 'Nothing outstanding — your accountant has everything they asked for.'}
        </p>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Stat icon={AlertCircle} label="Requested" value={requests.length} tone={requests.length ? 'amber' : 'zinc'} />
        <Stat icon={Upload} label="Sent from here" value={sent} tone="zinc" />
        <Stat icon={Clock} label="Processing" value={processing} tone="zinc" />
        <Stat icon={AlertCircle} label="Needs a new copy" value={rejected} tone={rejected ? 'red' : 'zinc'} />
      </div>

      {toApprove.length > 0 && (
        <div className="rounded-[24px] border border-[#14e3c4]/25 bg-[#14e3c4]/[0.07] overflow-hidden">
          <div className="p-5 flex items-start gap-3">
            <span className="w-10 h-10 rounded-2xl bg-[#14e3c4] flex items-center justify-center text-white shrink-0 shadow-[0_0_15px_rgba(20,227,196,0.3)]">
              <ShieldCheck size={18} />
            </span>
            <div className="min-w-0 flex-1">
              <div className="text-sm font-bold text-white">
                {toApprove.length} item{toApprove.length === 1 ? '' : 's'} need{toApprove.length === 1 ? 's' : ''} your approval
              </div>
              <p className="text-[12px] text-zinc-400 mt-1 leading-relaxed">
                {toApprove.map((a) => `${a.supplier} ${currency(a.total)}`).join(' · ')} — your accountant cannot
                publish these until you have signed them off.
              </p>
            </div>
          </div>
          <div className="px-5 pb-5">
            <button
              onClick={() => {
                if (!approvalRequest) sendApprovalRequest(account.clientId);
                // Sending is a state update, so the id is only knowable on the
                // next tick when this is the first time.
                setTimeout(() => openApprovalLink(approvalRequest?.id ?? `appr-req-${account.clientId}-0`), 0);
              }}
              className="w-full sm:w-auto flex items-center justify-center gap-2 px-6 py-3 rounded-full text-[13px] font-bold text-white bg-[#14e3c4] hover:bg-[#0fcbaf] transition-colors shadow-[0_0_15px_rgba(20,227,196,0.25)]"
            >
              <ShieldCheck size={15} strokeWidth={2.5} />
              Review and approve
            </button>
          </div>
        </div>
      )}

      {proposedUsers.length > 0 && (
        <div className="rounded-[24px] border border-[#14e3c4]/25 bg-[#14e3c4]/[0.07] overflow-hidden">
          <div className="p-5 flex items-start gap-3 border-b border-[#14e3c4]/15">
            <span className="w-10 h-10 rounded-2xl bg-[#14e3c4] flex items-center justify-center text-white shrink-0 shadow-[0_0_15px_rgba(20,227,196,0.3)]">
              <UserPlus size={18} />
            </span>
            <div className="min-w-0 flex-1">
              <div className="text-sm font-bold text-white">
                Your accountant wants to add {proposedUsers.length === 1 ? 'someone' : `${proposedUsers.length} people`} to your account
              </div>
              <p className="text-[12px] text-zinc-400 mt-1 leading-relaxed">
                Nothing has been sent to them. They can only send documents for {account.businessName} once you say yes.
              </p>
            </div>
          </div>

          <div className="p-5 flex flex-col gap-3">
            {proposedUsers.map((m) => (
              <div key={m.id} className="p-4 rounded-2xl bg-[#16161a] border border-white/5 flex flex-col gap-3">
                <div className="flex items-center gap-3 flex-wrap">
                  <span className="w-10 h-10 rounded-xl bg-[#202026] border border-white/5 flex items-center justify-center font-bold text-white shrink-0">
                    {m.name.trim().charAt(0).toUpperCase() || '?'}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-bold text-white truncate">{m.name}</div>
                    <div className="text-[12px] text-zinc-500 truncate">{m.email || m.mobile}</div>
                  </div>
                  <span className="flex items-center gap-2 shrink-0 flex-wrap justify-end">
                    <Pill tone="blue">{m.role}</Pill>
                    {m.canUpload && <Pill tone="green">Can send documents</Pill>}
                    {m.canSeeTotals ? <Pill tone="amber">Can see totals</Pill> : <Pill>Totals hidden</Pill>}
                  </span>
                </div>

                <p className="text-[12px] text-zinc-500 leading-relaxed">
                  Asked for by {m.invitedBy ?? 'your accountant'} {m.invitedAt ?? ''}.
                  {m.canSeeTotals
                    ? ' They will be able to see what your business spends.'
                    : ' They will not see any of your figures.'}
                </p>

                <div className="flex items-center gap-2 justify-end flex-wrap">
                  <button
                    onClick={async () => {
                      const ok = await confirm({
                        tone: 'red',
                        title: `Say no to adding ${m.name}?`,
                        detail: 'Your accountant is told, and nothing is sent to this person.',
                        confirmLabel: 'Yes, decline',
                      });
                      if (ok) reviewProposedUser(account.id, m.id, 'decline', 'Declined by the business');
                    }}
                    className="flex items-center gap-2 px-4 py-2 rounded-full text-[12px] font-bold text-zinc-400 border border-white/10 hover:text-white hover:border-white/25 transition-colors"
                  >
                    <X size={13} />
                    No, decline
                  </button>
                  <button
                    onClick={async () => {
                      const ok = await confirm({
                        title: `Let ${m.name} send documents for ${account.businessName}?`,
                        detail: `They join as ${m.role}${m.canSeeTotals ? ' and will see your figures' : ' and will not see your figures'}.`,
                        consequence: `Their invite goes ${channelLabel('user-invite')} to ${m.email || 'their email'} as soon as you approve.`,
                        confirmLabel: 'Yes, add them',
                      });
                      if (ok) reviewProposedUser(account.id, m.id, 'approve');
                    }}
                    className="flex items-center gap-2 px-5 py-2 rounded-full text-[12px] font-bold text-white bg-[#14e3c4] hover:bg-[#0fcbaf] transition-colors"
                  >
                    <Check size={13} strokeWidth={3} />
                    Approve
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {proposedChanges.length > 0 && (
        <div className="rounded-[24px] border border-[#14e3c4]/25 bg-[#14e3c4]/[0.07] overflow-hidden">
          <div className="p-5 flex items-start gap-3 border-b border-[#14e3c4]/15">
            <span className="w-10 h-10 rounded-2xl bg-[#14e3c4] flex items-center justify-center text-white shrink-0 shadow-[0_0_15px_rgba(20,227,196,0.3)]">
              <FileText size={18} />
            </span>
            <div className="min-w-0 flex-1">
              <div className="text-sm font-bold text-white">
                Your accountant wants to change {proposedChanges.length === 1 ? 'a detail' : `${proposedChanges.length} details`} on your record
              </div>
              <p className="text-[12px] text-zinc-400 mt-1 leading-relaxed">
                Nothing has changed yet. These are your business's own details, so they only update if you say yes.
              </p>
            </div>
          </div>

          <div className="p-5 flex flex-col gap-3">
            {proposedChanges.map((c) => (
              <div key={c.id} className="p-4 rounded-2xl bg-[#16161a] border border-white/5 flex flex-col gap-3">
                <div>
                  <div className="text-[11px] font-bold text-zinc-500 uppercase tracking-widest">{c.label}</div>
                  <div className="flex items-center gap-3 mt-2 flex-wrap text-[13.5px]">
                    <span className="text-zinc-500 line-through">{c.from}</span>
                    <span className="text-zinc-600">→</span>
                    <span className="text-white font-bold">{c.to}</span>
                  </div>
                  <p className="text-[12px] text-zinc-500 mt-2">
                    Asked for by {c.requestedBy} {c.requestedAt}.
                    {c.field === 'mobile' ? ' Every chase and sign-in code would go to this number instead.' : ''}
                  </p>
                </div>

                <div className="flex items-center gap-2 justify-end flex-wrap">
                  <button
                    onClick={async () => {
                      const ok = await confirm({
                        tone: 'red',
                        title: `Leave ${c.label.toLowerCase()} as it is?`,
                        detail: `Your accountant is told you declined the change to "${c.to}".`,
                        confirmLabel: 'Yes, decline',
                      });
                      if (ok) reviewClientDetailChange(c.id, 'decline', 'Declined by the business');
                    }}
                    className="flex items-center gap-2 px-4 py-2 rounded-full text-[12px] font-bold text-zinc-400 border border-white/10 hover:text-white hover:border-white/25 transition-colors"
                  >
                    <X size={13} />
                    No, keep it
                  </button>
                  <button
                    onClick={async () => {
                      const ok = await confirm({
                        title: `Change ${c.label.toLowerCase()} to "${c.to}"?`,
                        detail: `It is currently ${c.from}.`,
                        ...(c.field === 'mobile'
                          ? { consequence: 'Chases, approvals and sign-in codes will go to the new number from now on.' }
                          : {}),
                        confirmLabel: 'Yes, change it',
                      });
                      if (ok) reviewClientDetailChange(c.id, 'approve');
                    }}
                    className="flex items-center gap-2 px-5 py-2 rounded-full text-[12px] font-bold text-white bg-[#14e3c4] hover:bg-[#0fcbaf] transition-colors"
                  >
                    <Check size={13} strokeWidth={3} />
                    Approve
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <button
          onClick={() => onGo('Capture')}
          className="flex items-center gap-4 p-5 rounded-2xl border border-white/5 bg-[#16161a] hover:border-[#14e3c4]/40 transition-colors text-left group"
        >
          <span className="w-12 h-12 rounded-2xl bg-[#14e3c4] flex items-center justify-center text-white shrink-0 shadow-[0_0_15px_rgba(20,227,196,0.3)]">
            <Camera size={20} />
          </span>
          <span className="min-w-0">
            <span className="block text-sm font-bold text-white">Capture a document</span>
            <span className="block text-[12px] text-zinc-500 mt-0.5">Photograph a receipt or invoice with your camera</span>
          </span>
        </button>
        <button
          onClick={() => onGo('Upload')}
          className="flex items-center gap-4 p-5 rounded-2xl border border-white/5 bg-[#16161a] hover:border-[#14e3c4]/40 transition-colors text-left"
        >
          <span className="w-12 h-12 rounded-2xl bg-[#202026] border border-white/5 flex items-center justify-center text-zinc-300 shrink-0">
            <Upload size={20} />
          </span>
          <span className="min-w-0">
            <span className="block text-sm font-bold text-white">Upload a file</span>
            <span className="block text-[12px] text-zinc-500 mt-0.5">PDF, photo or spreadsheet from this device</span>
          </span>
        </button>
      </div>

      <Panel
        title="What your accountant is waiting for"
        subtitle={
          chase
            ? `Last chased ${chase.hoursSinceSent === 0 ? 'just now' : `${chase.hoursSinceSent}h ago`} by SMS`
            : 'Detected from your bank feed and supplier statements'
        }
      >
        {requests.length === 0 ? (
          <Empty icon={CheckCircle2} message="Nothing outstanding. You're all caught up." />
        ) : (
          <div className="flex flex-col gap-2">
            {requests.slice(0, 8).map((m) => (
              <div
                key={m.id}
                className="flex items-center justify-between gap-4 p-4 rounded-2xl bg-[#0a0a0c]/60 border border-white/5"
              >
                <div className="min-w-0">
                  <div className="text-sm font-bold text-white truncate">{m.supplier}</div>
                  <div className="text-[12px] text-zinc-500 mt-0.5">
                    {m.date} · {currency(m.amount)} · {REASON[m.detectedBy]}
                  </div>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  {m.chased ? <Pill tone="amber">Requested</Pill> : <Pill>Spotted</Pill>}
                  <button
                    onClick={() => onGo('Capture')}
                    className="px-4 py-2 rounded-full text-[12px] font-bold text-white bg-[#14e3c4] hover:bg-[#0fcbaf] transition-colors"
                  >
                    Send it
                  </button>
                </div>
              </div>
            ))}
            {requests.length > 8 && (
              <p className="text-[12px] text-zinc-600 font-semibold px-1">+ {requests.length - 8} more</p>
            )}
          </div>
        )}
      </Panel>

      <Panel title="Recently sent" subtitle="Status updates as your accountant works through them">
        {myDocs.length === 0 ? (
          <Empty icon={FileText} message="Nothing sent yet. Capture or upload your first document." />
        ) : (
          <div className="flex flex-col gap-2">
            {myDocs.map((d) => {
              const s = STATUS_TONE[d.status];
              return (
                // Openable, not a static row: it is the business's own paperwork,
                // and seeing what was read off it is how they catch a wrong total
                // before their accountant has to ask.
                <button
                  key={d.id}
                  onClick={() => setPreviewId(d.id)}
                  className="flex items-center justify-between gap-4 p-4 rounded-2xl bg-[#0a0a0c]/60 border border-white/5 hover:border-white/20 transition-colors text-left"
                >
                  <div className="min-w-0">
                    <div className="text-sm font-bold text-white truncate">{d.supplier}</div>
                    <div className="text-[12px] text-zinc-500 mt-0.5 truncate">
                      {d.date} · {d.total ? currency(d.total) : '—'} · via {d.source === 'portal' ? 'this portal' : d.source}
                    </div>
                  </div>
                  <span className="flex items-center gap-2 shrink-0">
                    <Pill tone={s.tone}>{s.label}</Pill>
                    <Eye size={15} className="text-zinc-600" />
                  </span>
                </button>
              );
            })}
          </div>
        )}
      </Panel>

      <div className="flex items-start gap-3 p-4 rounded-2xl border border-white/5 bg-[#16161a]/60">
        <ShieldCheck size={16} className="text-zinc-500 mt-0.5 shrink-0" />
        <p className="text-[12px] text-zinc-500 leading-relaxed">
          You only ever see your own business here. Your accountant handles the coding and filing — nothing you send is
          published to the accounting software until they have reviewed it.
        </p>
      </div>

      {/* The same viewer the practice sees: the original alongside every value
          read off it, with the confidence on each. */}
      {preview && (
        <div
          className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm overflow-y-auto p-6 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
          onClick={() => setPreviewId(null)}
        >
          <div className="min-h-full flex flex-col items-center justify-center gap-3" onClick={(e) => e.stopPropagation()}>
            <DocumentPreview document={preview} />
            <button
              onClick={() => setPreviewId(null)}
              className="flex items-center gap-2 px-6 py-2.5 rounded-full text-[13px] font-bold text-white bg-[#202026] border border-white/10 hover:border-white/25 transition-colors"
            >
              <X size={15} />
              Close
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

const REASON: Record<string, string> = {
  'bank-transaction': 'a payment left your account with no receipt',
  'supplier-statement': 'on a supplier statement but not sent to us',
  'statement-gap': 'a gap in your bank statements',
  'ledger-attachment': 'no copy attached in the ledger',
  recurring: 'you usually send this one every month',
};

function Stat({
  icon: Icon,
  label,
  value,
  tone,
}: {
  icon: React.ComponentType<{ size?: number; className?: string }>;
  label: string;
  value: number;
  tone: 'amber' | 'red' | 'zinc';
}) {
  const tones = {
    amber: 'text-amber-400',
    red: 'text-red-400',
    zinc: 'text-white',
  };
  return (
    <div className="p-4 rounded-2xl border border-white/5 bg-[#16161a]">
      <Icon size={16} className="text-zinc-500" />
      <div className={`text-2xl font-bold mt-3 tracking-tight ${tones[tone]}`}>{value}</div>
      <div className="text-[11px] text-zinc-500 font-bold uppercase tracking-wider mt-1">{label}</div>
    </div>
  );
}

export function Panel({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-[28px] border border-white/5 bg-[#16161a] p-6">
      <div className="mb-4">
        <h2 className="text-[15px] font-bold text-white tracking-tight">{title}</h2>
        {subtitle && <p className="text-[12px] text-zinc-500 mt-1">{subtitle}</p>}
      </div>
      {children}
    </section>
  );
}

function Empty({
  icon: Icon,
  message,
}: {
  icon: React.ComponentType<{ size?: number; className?: string }>;
  message: string;
}) {
  return (
    <div className="flex flex-col items-center justify-center py-10 text-center">
      <Icon size={24} className="text-zinc-700" />
      <p className="text-[13px] text-zinc-500 mt-3 font-medium">{message}</p>
    </div>
  );
}
