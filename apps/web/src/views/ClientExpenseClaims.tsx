import { useRef, useState } from 'react';
import { Plus, Send, Trash2, Check, Banknote, AlertTriangle, X, FileText, ShieldCheck, Clock, Paperclip, Sparkles, Eye } from 'lucide-react';
import { motion } from 'motion/react';
import { useAppContext } from '../context/AppContext';
import { Pill } from '../components/DynamicComponents/DataTable';
import { currency } from '../lib/resolver';
import { useConfirm } from '../components/DynamicComponents/ConfirmProvider';
import type { Client, Document, ExpenseClaim, ExpenseClaimItem, ExpenseClaimStatus } from '../lib/types';

/**
 * Employee-submitted spend, grouped into a claim for reimbursement. A claim is
 * not a document — it is a wrapper around several, plus the one thing a
 * document cannot carry: who is out of pocket and whether they have been paid.
 */
const STATUS_TONE: Record<ExpenseClaimStatus, 'green' | 'amber' | 'red' | 'blue' | undefined> = {
  draft: undefined,
  submitted: undefined,
  'internally-approved': 'amber',
  approved: 'blue',
  reimbursed: 'green',
  rejected: 'red',
};

const STATUS_LABEL: Record<ExpenseClaimStatus, string> = {
  draft: 'Being drafted',
  submitted: 'With the business to approve',
  'internally-approved': 'Waiting on you',
  approved: 'Approved — not yet paid',
  reimbursed: 'Reimbursed',
  rejected: 'Rejected',
};

export function ClientExpenseClaims({ client, onPreview }: {
  client: Client;
  onPreview?: (doc: Document) => void;
}) {
  const { expenseClaims, saveExpenseClaim, setExpenseClaimStatus, deleteExpenseClaim, ingest, documents } = useAppContext();
  const [editing, setEditing] = useState<ExpenseClaim | null>(null);
  const confirm = useConfirm();

  const mine = expenseClaims.filter((c) => c.clientId === client.id);
  /** The claim is worth what its receipts say, not what was typed beside them. */
  const lineTotal = (i: ExpenseClaimItem) => {
    const doc = i.documentId ? documents.find((d) => d.id === i.documentId) : undefined;
    return doc ? doc.total : i.total;
  };
  const total = (c: ExpenseClaim) => c.items.reduce((n, i) => n + lineTotal(i), 0);
  // Only what the business has already signed off is genuinely owed by the
  // practice's reckoning — a claim still with its own manager might not survive.
  const owed = mine
    .filter((c) => c.status === 'internally-approved' || c.status === 'approved')
    .reduce((n, c) => n + total(c), 0);
  const awaitingUs = mine.filter((c) => c.status === 'internally-approved').length;

  const blank = (): ExpenseClaim => ({
    id: `exp-${Date.now()}`,
    clientId: client.id,
    clientName: client.name,
    claimant: '',
    period: 'August 2026',
    items: [],
    status: 'draft',
  });

  return (
    <div className="flex flex-col gap-5">
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <p className="text-[13px] text-zinc-500 leading-relaxed max-w-2xl">
          Spend an employee paid for personally, grouped so it can be reimbursed in one go. A claim only reaches
          you once someone at the business has approved it — whether a spend was legitimate is the employer's call,
          not the bookkeeper's.
          {owed > 0
            ? ` ${currency(owed)} owed back${awaitingUs > 0 ? `, ${awaitingUs} waiting on you` : ''}.`
            : ' Nothing is currently owed.'}
        </p>
        <button
          onClick={() => setEditing(blank())}
          className="shrink-0 flex items-center gap-2 px-5 py-2.5 rounded-full text-sm font-bold text-white bg-[#14e3c4] hover:bg-[#0fcbaf] transition-colors shadow-[0_0_15px_rgba(20,227,196,0.2)]"
        >
          <Plus size={16} strokeWidth={2.5} />
          New claim
        </button>
      </div>

      {mine.length === 0 ? (
        <div className="border border-white/5 rounded-[32px] bg-[#16161a] p-10 text-center shadow-2xl">
          <p className="text-[13px] text-zinc-500 leading-relaxed max-w-md mx-auto">
            No claims for {client.name}. Start one when someone has paid for something out of their own pocket.
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
          {mine.map((c) => {
            const unevidenced = c.items.filter((i) => !i.documentId).length;
            return (
              <div key={c.id} className="border border-white/5 rounded-[28px] bg-[#16161a] shadow-2xl overflow-hidden flex flex-col">
                <div className="p-5 flex items-start justify-between gap-4 border-b border-white/5">
                  <div className="min-w-0">
                    <div className="text-[15px] font-bold text-white truncate">{c.claimant || 'Unnamed claimant'}</div>
                    <div className="text-[12px] text-zinc-500 mt-0.5">
                      {c.period} · {c.items.length} item{c.items.length === 1 ? '' : 's'}
                      {c.submittedAt ? ` · submitted ${c.submittedAt}` : ''}
                    </div>
                  </div>
                  <div className="text-right shrink-0">
                    <div className="text-lg font-bold text-white tabular-nums">{currency(total(c))}</div>
                    <div className="mt-1"><Pill tone={STATUS_TONE[c.status]}>{STATUS_LABEL[c.status]}</Pill></div>
                  </div>
                </div>

                {/* Who at the business signed it off. A claim with no approval
                    has not left the company yet, and the practice has nothing
                    to do with it. */}
                {c.approval ? (
                  <div className="px-5 py-3 bg-[#14e3c4]/[0.06] border-b border-[#14e3c4]/15 flex items-start gap-2.5">
                    <ShieldCheck size={14} className="text-[#14e3c4] mt-0.5 shrink-0" />
                    <div className="min-w-0 text-[12px]">
                      <span className="text-white font-semibold">
                        Approved by {c.approval.by} · {c.approval.role}
                      </span>
                      <span className="text-zinc-500"> · {c.approval.at}</span>
                      {c.approval.note && <div className="text-zinc-500 mt-0.5">“{c.approval.note}”</div>}
                    </div>
                  </div>
                ) : c.status === 'submitted' ? (
                  <div className="px-5 py-3 bg-[#0a0a0c]/60 border-b border-white/5 flex items-center gap-2.5">
                    <Clock size={14} className="text-zinc-500 shrink-0" />
                    <span className="text-[12px] text-zinc-400">
                      Waiting on a manager, owner or HR at {client.name} — not yours to action yet.
                    </span>
                  </div>
                ) : null}

                <div className="p-5 flex flex-col gap-2 flex-1">
                  {c.items.length === 0 && <p className="text-[13px] text-zinc-500">No lines on this claim yet.</p>}
                  {c.items.map((i) => {
                    // The receipt the employee actually photographed or sent.
                    const doc = i.documentId ? documents.find((d) => d.id === i.documentId) : undefined;
                    // Where there is a receipt, what the extractor read off it
                    // is the truth — the claim line is a pointer, not a second
                    // set of figures that can drift from the document.
                    const read = doc ? extracted(doc) : null;
                    const total = read?.total ?? i.total;
                    const category = read?.category ?? i.category;
                    // The whole line opens the receipt, not a 28px icon — the
                    // document is the point of the row, and the previous
                    // affordance read as decoration.
                    const Line = doc ? 'button' : 'div';
                    return (
                      <Line
                        key={i.id}
                        {...(doc
                          ? {
                              onClick: () => onPreview?.(doc),
                              title: `Open the receipt — ${doc.supplier}, sent by ${doc.uploader} via ${doc.source}`,
                            }
                          : {})}
                        className={`group w-full text-left flex items-center gap-3 text-[13px] -mx-2 px-2 py-1.5 rounded-xl transition-colors ${
                          doc ? 'hover:bg-white/[0.04] cursor-pointer' : ''
                        }`}
                      >
                        {doc ? (
                          <span className="shrink-0 w-7 h-8 rounded-lg bg-[#14e3c4]/10 border border-[#14e3c4]/25 flex items-center justify-center text-[#14e3c4] group-hover:bg-[#14e3c4]/20 transition-colors">
                            <FileText size={13} />
                          </span>
                        ) : (
                          // No receipt means no VAT reclaim, so it is flagged
                          // rather than quietly totalled in.
                          <span
                            title="No receipt attached — this line cannot be reclaimed against VAT"
                            className="shrink-0 w-7 h-8 rounded-lg bg-amber-400/10 border border-amber-400/25 flex items-center justify-center text-amber-400"
                          >
                            <AlertTriangle size={13} />
                          </span>
                        )}
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-zinc-300">{i.description}</span>
                          {doc && read && (
                            <span className="block text-[11px] text-zinc-600 truncate">
                              Read from {doc.supplier} · {read.date} · VAT {read.vat ?? '—'} · sent by {doc.uploader}
                            </span>
                          )}
                        </span>
                        {/* The AI's own reading of what this spend is, with how
                            sure it was — a low number is the cue to open it. */}
                        {read?.categoryConfidence !== undefined ? (
                          <span
                            title={`Categorised by extraction · ${Math.round(read.categoryConfidence * 100)}% confident`}
                            className={`shrink-0 inline-flex items-center gap-1 text-[11px] font-semibold ${
                              read.categoryConfidence < 0.6 ? 'text-amber-400' : 'text-zinc-500'
                            }`}
                          >
                            <Sparkles size={10} />
                            {category === '—' ? 'Uncategorised' : category}
                          </span>
                        ) : (
                          <span className="text-[11px] text-zinc-600 shrink-0">{category}</span>
                        )}
                        <span className="text-white font-bold tabular-nums shrink-0">{currency(total)}</span>
                        {/* Says the row is openable without shouting on every line. */}
                        {doc && (
                          <span className="shrink-0 inline-flex items-center gap-1 text-[11px] font-bold text-zinc-600 group-hover:text-[#14e3c4] transition-colors">
                            <Eye size={13} />
                            View
                          </span>
                        )}
                      </Line>
                    );
                  })}
                  {unevidenced > 0 && (
                    <p className="text-[12px] text-amber-400 font-semibold mt-1">
                      {unevidenced} line{unevidenced === 1 ? '' : 's'} without a receipt — no VAT reclaim on those.
                    </p>
                  )}
                  {c.note && <p className="text-[12px] text-zinc-500 mt-1 leading-relaxed">{c.note}</p>}
                </div>

                <div className="p-4 bg-[#202026]/50 flex items-center gap-2 flex-wrap">
                  <button
                    onClick={() => setEditing(c)}
                    className="px-4 py-2 rounded-full text-[12px] font-bold text-zinc-400 border border-white/5 hover:text-white hover:border-white/15 transition-colors"
                  >
                    Edit
                  </button>
                  <span className="flex-1" />
                  {c.status === 'draft' && (
                    <ClaimAction
                      icon={Send} label="Send for approval" primary
                      onClick={async () => {
                        const ok = await confirm({
                          title: `Send ${c.claimant}'s claim for approval?`,
                          detail: `${currency(total(c))} across ${c.items.length} line${c.items.length === 1 ? '' : 's'}. It goes to a manager, owner or HR at ${client.name}.`,
                          confirmLabel: 'Yes, send it',
                        });
                        if (ok) setExpenseClaimStatus(c.id, 'submitted');
                      }}
                    />
                  )}
                  {/* Nothing for the practice to do while it is still inside
                      the business. */}
                  {c.status === 'submitted' && (
                    <span className="text-[12px] text-zinc-600 font-semibold">With the business</span>
                  )}
                  {c.status === 'internally-approved' && (
                    <>
                      <ClaimAction
                        icon={X} label="Query"
                        onClick={async () => {
                          const ok = await confirm({
                            tone: 'red',
                            title: `Query ${c.claimant}'s claim?`,
                            detail: `${currency(total(c))} goes back to ${client.name} unpaid.`,
                            consequence: 'Their manager already approved it, so someone will have to explain why you did not.',
                            confirmLabel: 'Yes, query it',
                          });
                          if (ok) setExpenseClaimStatus(c.id, 'rejected');
                        }}
                      />
                      <ClaimAction
                        icon={Check} label="Accept for the books" primary
                        onClick={async () => {
                          const ok = await confirm({
                            title: `Accept ${c.claimant}'s claim for the books?`,
                            detail: `${currency(total(c))} across ${c.items.length} line${c.items.length === 1 ? '' : 's'}.`,
                            consequence: c.items.some((i) => !i.documentId)
                              ? 'Some lines have no receipt — those cannot be reclaimed against VAT.'
                              : undefined,
                            confirmLabel: 'Yes, accept it',
                          });
                          if (ok) setExpenseClaimStatus(c.id, 'approved');
                        }}
                      />
                    </>
                  )}
                  {c.status === 'approved' && (
                    <ClaimAction
                      icon={Banknote} label="Mark reimbursed" primary
                      onClick={async () => {
                        const ok = await confirm({
                          title: `Mark ${currency(total(c))} as reimbursed?`,
                          detail: `Records that ${c.claimant} has been paid back.`,
                          consequence: 'This does not move any money — do the payment in the bank first.',
                          confirmLabel: 'Yes, it has been paid',
                        });
                        if (ok) setExpenseClaimStatus(c.id, 'reimbursed');
                      }}
                    />
                  )}
                  {(c.status === 'reimbursed' || c.status === 'rejected') && (
                    <ClaimAction
                      icon={Trash2} label="Delete"
                      onClick={async () => {
                        const ok = await confirm({
                          tone: 'red',
                          title: `Delete ${c.claimant}'s claim?`,
                          detail: `${currency(total(c))} · ${c.period} · ${STATUS_LABEL[c.status].toLowerCase()}.`,
                          consequence: 'The record of who was paid what goes with it. The receipts stay in the pipeline.',
                          confirmLabel: 'Yes, delete it',
                        });
                        if (ok) deleteExpenseClaim(c.id);
                      }}
                    />
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {editing && (
        <ClaimEditor
          claim={editing}
          onSave={(c) => { saveExpenseClaim(c); setEditing(null); }}
          onClose={() => setEditing(null)}
          onAttach={(files) => ingest(files, client.id, 'web', { uploader: 'Expense claim', kind: 'cost' })}
        />
      )}
    </div>
  );
}

/**
 * What extraction read off a receipt. The claim shows these rather than the
 * figures typed alongside, so a claim can never quietly disagree with the
 * document backing it.
 */
function extracted(doc: Document) {
  const field = (test: RegExp) => doc.fields.find((f) => test.test(f.label));
  const category = field(/^category$/i);
  const tax = field(/tax|vat/i);
  return {
    total: doc.total,
    date: doc.date,
    category: doc.category,
    categoryConfidence: category?.confidence,
    vat: tax && tax.value !== '—' ? tax.value : undefined,
  };
}

function ClaimAction({ icon: Icon, label, onClick, primary }: {
  icon: typeof Send; label: string; onClick: () => void; primary?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      className={`flex items-center gap-2 px-4 py-2 rounded-full text-[12px] font-bold transition-colors ${
        primary
          ? 'text-white bg-[#14e3c4] hover:bg-[#0fcbaf]'
          : 'text-zinc-400 border border-white/5 hover:text-white hover:border-white/15'
      }`}
    >
      <Icon size={13} />
      {label}
    </button>
  );
}

function ClaimEditor({ claim, onSave, onClose, onAttach }: {
  claim: ExpenseClaim;
  onSave: (c: ExpenseClaim) => void;
  onClose: () => void;
  onAttach: (files: { name: string; size: number }[]) => void;
}) {
  const [draft, setDraft] = useState(claim);
  const fileRef = useRef<HTMLInputElement>(null);

  const addItem = () =>
    setDraft({
      ...draft,
      items: [
        ...draft.items,
        { id: `item-${Date.now()}`, description: '', date: '12 Aug 2026', total: 0, category: 'Travel' },
      ],
    });

  const setItem = (id: string, patch: Partial<ExpenseClaimItem>) =>
    setDraft({ ...draft, items: draft.items.map((i) => (i.id === id ? { ...i, ...patch } : i)) });

  const problem = !draft.claimant.trim()
    ? 'Name whoever is out of pocket.'
    : draft.items.length === 0
    ? 'Add at least one line.'
    : draft.items.some((i) => !i.description.trim())
    ? 'Every line needs a description.'
    : '';

  return (
    <div
      className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm flex items-start justify-center overflow-y-auto p-8 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      onClick={onClose}
    >
      <motion.div
        initial={{ opacity: 0, y: 20, scale: 0.97 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-2xl border border-white/5 rounded-[32px] bg-[#16161a] shadow-2xl overflow-hidden my-auto"
      >
        <div className="p-6 border-b border-white/5">
          <h3 className="font-sans font-bold text-xl text-white tracking-tight">
            {claim.items.length === 0 && !claim.claimant ? 'New expense claim' : draft.claimant || 'Expense claim'}
          </h3>
          <p className="text-[12px] text-zinc-500 mt-1 font-semibold uppercase tracking-wider">
            Who paid, what for, and what backs it up
          </p>
        </div>

        <div className="p-6 flex flex-col gap-5 max-h-[55vh] overflow-y-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          <div className="grid grid-cols-2 gap-4">
            <Field label="Claimant" value={draft.claimant} onChange={(v) => setDraft({ ...draft, claimant: v })} placeholder="John Doe" />
            <Field label="Period" value={draft.period} onChange={(v) => setDraft({ ...draft, period: v })} placeholder="August 2026" />
          </div>

          <div>
            <div className="flex items-center justify-between mb-3">
              <span className="text-[11px] font-bold text-zinc-500 uppercase tracking-widest">Lines</span>
              <button onClick={addItem} className="text-[12px] font-bold text-[#14e3c4] hover:underline">
                + Add line
              </button>
            </div>
            <div className="flex flex-col gap-2">
              {draft.items.map((i) => (
                <div key={i.id} className="flex items-center gap-2 p-3 rounded-2xl bg-[#0a0a0c]/60 border border-white/5">
                  <input
                    value={i.description}
                    onChange={(e) => setItem(i.id, { description: e.target.value })}
                    placeholder="What was it for?"
                    className="flex-1 min-w-0 bg-transparent text-[13px] font-semibold text-white placeholder:text-zinc-600 focus:outline-none"
                  />
                  <input
                    value={i.category}
                    onChange={(e) => setItem(i.id, { category: e.target.value })}
                    className="w-28 bg-[#16161a] border border-white/5 rounded-lg px-2 py-1 text-[12px] text-zinc-300 focus:outline-none focus:border-[#14e3c4]"
                  />
                  <input
                    type="number"
                    value={i.total || ''}
                    onChange={(e) => setItem(i.id, { total: Number(e.target.value) })}
                    placeholder="0.00"
                    className="w-24 bg-[#16161a] border border-white/5 rounded-lg px-2 py-1 text-[12px] text-white text-right tabular-nums focus:outline-none focus:border-[#14e3c4]"
                  />
                  <button
                    onClick={() => setDraft({ ...draft, items: draft.items.filter((x) => x.id !== i.id) })}
                    className="p-1.5 rounded-lg text-zinc-600 hover:text-red-400 transition-colors shrink-0"
                    aria-label="Remove line"
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
              ))}
            </div>
          </div>

          {/* Receipts enter the normal pipeline, so they are extracted, coded
              and matched like anything else rather than living only here. */}
          <div className="p-4 rounded-2xl border border-white/5 bg-[#0a0a0c]/60 shadow-inner flex items-center justify-between gap-4">
            <div className="min-w-0">
              <div className="text-sm font-bold text-white">Receipts</div>
              <div className="text-[12px] text-zinc-500 mt-0.5">
                Attaching them sends each one through extraction like any other document.
              </div>
            </div>
            <button
              onClick={() => fileRef.current?.click()}
              className="shrink-0 flex items-center gap-2 px-4 py-2 rounded-full text-[12px] font-bold text-zinc-300 border border-white/10 hover:text-white hover:border-white/25 transition-colors"
            >
              <Paperclip size={13} />
              Attach
            </button>
            <input
              ref={fileRef}
              type="file"
              multiple
              className="hidden"
              onChange={(e) => {
                const files = Array.from(e.target.files ?? []).map((f) => ({ name: f.name, size: f.size }));
                if (files.length) onAttach(files);
                e.target.value = '';
              }}
            />
          </div>

          {problem && <p className="text-[13px] text-amber-400 font-semibold">{problem}</p>}
        </div>

        <div className="p-4 bg-[#202026]/50 flex items-center gap-3 justify-end">
          <button onClick={onClose} className="px-5 py-2.5 rounded-full text-[13px] font-bold text-zinc-400 hover:text-white transition-colors">
            Cancel
          </button>
          <button
            onClick={() => onSave(draft)}
            disabled={!!problem}
            className="px-6 py-2.5 rounded-full text-[13px] font-bold text-white bg-[#14e3c4] hover:bg-[#0fcbaf] disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          >
            Save claim
          </button>
        </div>
      </motion.div>
    </div>
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
        className="w-full bg-[#0a0a0c] border border-white/5 rounded-xl px-4 py-2.5 text-sm text-white placeholder:text-zinc-600 focus:outline-none focus:border-[#14e3c4] transition-colors"
      />
    </div>
  );
}
