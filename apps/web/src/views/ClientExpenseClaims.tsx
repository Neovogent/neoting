import { useRef, useState } from 'react';
import { Plus, Send, Trash2, Check, Banknote, AlertTriangle, X, FileText, ShieldCheck, Clock, Paperclip, Sparkles, Eye } from 'lucide-react';
import { motion } from 'motion/react';
import { defineMessages, useIntl, type MessageDescriptor } from 'react-intl';
import { commonActions, commonPlaceholders } from '../i18n/common';
import { useAppContext } from '../context/AppContext';
import { Pill } from '../components/DynamicComponents/DataTable';
import { currency } from '../lib/resolver';
import { useConfirm } from '../components/DynamicComponents/ConfirmProvider';
import { useEscape } from '../lib/useEscape';
import type { Client, Document, ExpenseClaim, ExpenseClaimItem, ExpenseClaimStatus } from '../lib/types';

/**
 * Employee-submitted spend, grouped into a claim for reimbursement. A claim is
 * not a document — it is a wrapper around several, plus the one thing a
 * document cannot carry: who is out of pocket and whether they have been paid.
 */
// 'neutral' is what a Pill draws with no tone at all, so the two stages that
// carry no signal name it rather than leaving a hole in the map.
const STATUS_TONE: Record<ExpenseClaimStatus, 'green' | 'amber' | 'red' | 'blue' | 'neutral'> = {
  draft: 'neutral',
  submitted: 'neutral',
  'internally-approved': 'amber',
  approved: 'blue',
  reimbursed: 'green',
  rejected: 'red',
};

/** Descriptors, not text — a hook cannot be called at module scope. */
const STATUS_LABEL: Record<ExpenseClaimStatus, MessageDescriptor> = defineMessages({
  draft: { id: 'analytics.expenseClaimStatus.draft', defaultMessage: 'Being drafted' },
  submitted: {
    id: 'analytics.expenseClaimStatus.submitted',
    defaultMessage: 'With the business to approve',
  },
  'internally-approved': {
    id: 'analytics.expenseClaimStatus.internallyApproved',
    defaultMessage: 'Waiting on you',
  },
  approved: { id: 'analytics.expenseClaimStatus.approved', defaultMessage: 'Approved — not yet paid' },
  reimbursed: { id: 'analytics.expenseClaimStatus.reimbursed', defaultMessage: 'Reimbursed' },
  rejected: { id: 'analytics.expenseClaimStatus.rejected', defaultMessage: 'Rejected' },
});

/**
 * The lead paragraph is three whole messages rather than one with a tail
 * appended, for the reason ActionCard's empty state is two: a translator handed
 * a sentence that may or may not continue has to reason about both endings at
 * once, and where the clause lands is exactly what differs between languages.
 */
const m = defineMessages({
  intro: {
    id: 'analytics.clientExpenseClaims.intro',
    defaultMessage:
      "Spend an employee paid for personally, grouped so it can be reimbursed in one go. A claim only reaches you once someone at the business has approved it — whether a spend was legitimate is the employer's call, not the bookkeeper's. Nothing is currently owed.",
  },
  introOwed: {
    id: 'analytics.clientExpenseClaims.introOwed',
    defaultMessage:
      "Spend an employee paid for personally, grouped so it can be reimbursed in one go. A claim only reaches you once someone at the business has approved it — whether a spend was legitimate is the employer's call, not the bookkeeper's. {amount} owed back.",
  },
  introOwedWaiting: {
    id: 'analytics.clientExpenseClaims.introOwedWaiting',
    defaultMessage:
      "Spend an employee paid for personally, grouped so it can be reimbursed in one go. A claim only reaches you once someone at the business has approved it — whether a spend was legitimate is the employer's call, not the bookkeeper's. {amount} owed back, {waiting} waiting on you.",
  },
  newClaim: { id: 'analytics.clientExpenseClaims.newClaim', defaultMessage: 'New claim' },
  empty: {
    id: 'analytics.clientExpenseClaims.empty',
    defaultMessage:
      'No claims for {client}. Start one when someone has paid for something out of their own pocket.',
  },
  unnamedClaimant: {
    id: 'analytics.clientExpenseClaims.unnamedClaimant',
    defaultMessage: 'Unnamed claimant',
  },
  claimMeta: {
    id: 'analytics.clientExpenseClaims.claimMeta',
    defaultMessage: '{period} · {count, plural, one {# item} other {# items}}',
  },
  claimMetaSubmitted: {
    id: 'analytics.clientExpenseClaims.claimMetaSubmitted',
    defaultMessage: '{period} · {count, plural, one {# item} other {# items}} · submitted {submittedAt}',
  },
  approvedBy: {
    id: 'analytics.clientExpenseClaims.approvedBy',
    defaultMessage: 'Approved by {by} · {role}',
  },
  // No leading space in the message: `formatjs extract` trims message edges, so
  // a message that starts with one renders differently from its own catalogue.
  // The separating space stays in the JSX.
  approvedAt: { id: 'analytics.clientExpenseClaims.approvedAt', defaultMessage: '· {at}' },
  approvalNote: { id: 'analytics.clientExpenseClaims.approvalNote', defaultMessage: '“{note}”' },
  waitingOnBusiness: {
    id: 'analytics.clientExpenseClaims.waitingOnBusiness',
    defaultMessage: 'Waiting on a manager, owner or HR at {client} — not yours to action yet.',
  },
  noLines: { id: 'analytics.clientExpenseClaims.noLines', defaultMessage: 'No lines on this claim yet.' },
  openReceipt: {
    id: 'analytics.clientExpenseClaims.openReceipt',
    defaultMessage: 'Open the receipt — {supplier}, sent by {uploader} via {source}',
  },
  noReceipt: {
    id: 'analytics.clientExpenseClaims.noReceipt',
    defaultMessage: 'No receipt attached — this line cannot be reclaimed against VAT',
  },
  readFrom: {
    id: 'analytics.clientExpenseClaims.readFrom',
    defaultMessage: 'Read from {supplier} · {date} · VAT {vat} · sent by {uploader}',
  },
  categorisedBy: {
    id: 'analytics.clientExpenseClaims.categorisedBy',
    defaultMessage: 'Categorised by extraction · {percent}% confident',
  },
  uncategorised: { id: 'analytics.clientExpenseClaims.uncategorised', defaultMessage: 'Uncategorised' },
  viewAction: { id: 'analytics.clientExpenseClaims.viewAction', defaultMessage: 'View' },
  unevidencedLines: {
    id: 'analytics.clientExpenseClaims.unevidencedLines',
    defaultMessage:
      '{count, plural, one {# line} other {# lines}} without a receipt — no VAT reclaim on those.',
  },
  editAction: { id: 'analytics.clientExpenseClaims.editAction', defaultMessage: 'Edit' },

  sendAction: { id: 'analytics.clientExpenseClaims.sendAction', defaultMessage: 'Send for approval' },
  sendTitle: {
    id: 'analytics.clientExpenseClaims.sendTitle',
    defaultMessage: "Send {claimant}'s claim for approval?",
  },
  sendDetail: {
    id: 'analytics.clientExpenseClaims.sendDetail',
    defaultMessage:
      '{amount} across {count, plural, one {# line} other {# lines}}. It goes to a manager, owner or HR at {client}.',
  },
  sendConfirm: { id: 'analytics.clientExpenseClaims.sendConfirm', defaultMessage: 'Yes, send it' },

  withTheBusiness: {
    id: 'analytics.clientExpenseClaims.withTheBusiness',
    defaultMessage: 'With the business',
  },

  queryAction: { id: 'analytics.clientExpenseClaims.queryAction', defaultMessage: 'Query' },
  queryTitle: {
    id: 'analytics.clientExpenseClaims.queryTitle',
    defaultMessage: "Query {claimant}'s claim?",
  },
  queryDetail: {
    id: 'analytics.clientExpenseClaims.queryDetail',
    defaultMessage: '{amount} goes back to {client} unpaid.',
  },
  queryConsequence: {
    id: 'analytics.clientExpenseClaims.queryConsequence',
    defaultMessage: 'Their manager already approved it, so someone will have to explain why you did not.',
  },
  queryConfirm: { id: 'analytics.clientExpenseClaims.queryConfirm', defaultMessage: 'Yes, query it' },

  acceptAction: { id: 'analytics.clientExpenseClaims.acceptAction', defaultMessage: 'Accept for the books' },
  acceptTitle: {
    id: 'analytics.clientExpenseClaims.acceptTitle',
    defaultMessage: "Accept {claimant}'s claim for the books?",
  },
  acceptDetail: {
    id: 'analytics.clientExpenseClaims.acceptDetail',
    defaultMessage: '{amount} across {count, plural, one {# line} other {# lines}}.',
  },
  acceptConsequence: {
    id: 'analytics.clientExpenseClaims.acceptConsequence',
    defaultMessage: 'Some lines have no receipt — those cannot be reclaimed against VAT.',
  },
  acceptConfirm: { id: 'analytics.clientExpenseClaims.acceptConfirm', defaultMessage: 'Yes, accept it' },

  reimburseAction: { id: 'analytics.clientExpenseClaims.reimburseAction', defaultMessage: 'Mark reimbursed' },
  reimburseTitle: {
    id: 'analytics.clientExpenseClaims.reimburseTitle',
    defaultMessage: 'Mark {amount} as reimbursed?',
  },
  reimburseDetail: {
    id: 'analytics.clientExpenseClaims.reimburseDetail',
    defaultMessage: 'Records that {claimant} has been paid back.',
  },
  reimburseConsequence: {
    id: 'analytics.clientExpenseClaims.reimburseConsequence',
    defaultMessage: 'This does not move any money — do the payment in the bank first.',
  },
  reimburseConfirm: {
    id: 'analytics.clientExpenseClaims.reimburseConfirm',
    defaultMessage: 'Yes, it has been paid',
  },

  deleteAction: { id: 'analytics.clientExpenseClaims.deleteAction', defaultMessage: 'Delete' },
  deleteTitle: {
    id: 'analytics.clientExpenseClaims.deleteTitle',
    defaultMessage: "Delete {claimant}'s claim?",
  },
  deleteDetail: {
    id: 'analytics.clientExpenseClaims.deleteDetail',
    defaultMessage: '{amount} · {period} · {status}.',
  },
  deleteConsequence: {
    id: 'analytics.clientExpenseClaims.deleteConsequence',
    defaultMessage: 'The record of who was paid what goes with it. The receipts stay in the pipeline.',
  },
  deleteConfirm: { id: 'analytics.clientExpenseClaims.deleteConfirm', defaultMessage: 'Yes, delete it' },
});

export function ClientExpenseClaims({ client, onPreview }: {
  client: Client;
  onPreview?: (doc: Document) => void;
}) {
  const { expenseClaims, saveExpenseClaim, setExpenseClaimStatus, deleteExpenseClaim, ingest, documents } = useAppContext();
  const [editing, setEditing] = useState<ExpenseClaim | null>(null);
  const confirm = useConfirm();
  const intl = useIntl();

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
    // The real current month (Europe/London), not the synthetic dataset's
    // frozen one — a claim the user creates is their data (launch M8).
    period: new Intl.DateTimeFormat('en-GB', { month: 'long', year: 'numeric', timeZone: 'Europe/London' }).format(new Date()),
    items: [],
    status: 'draft',
  });

  return (
    <div className="flex flex-col gap-5">
      <div data-tour="ec-header" className="flex items-center justify-between gap-4 flex-wrap">
        <p className="text-[13px] text-zinc-500 leading-relaxed max-w-2xl">
          {intl.formatMessage(owed > 0 ? (awaitingUs > 0 ? m.introOwedWaiting : m.introOwed) : m.intro, {
            amount: currency(owed),
            waiting: awaitingUs,
          })}
        </p>
        <button
          onClick={() => setEditing(blank())}
          className="shrink-0 flex items-center gap-2 px-5 py-2.5 rounded-full text-sm font-bold text-white bg-brand hover:bg-brand-hover transition-colors shadow-glow-btn-soft"
        >
          <Plus size={16} strokeWidth={2.5} />
          {intl.formatMessage(m.newClaim)}
        </button>
      </div>

      {mine.length === 0 ? (
        <div className="border border-white/5 rounded-[32px] bg-card p-4 md:p-10 text-center shadow-2xl">
          <p className="text-[13px] text-zinc-500 leading-relaxed max-w-md mx-auto">
            {intl.formatMessage(m.empty, { client: client.name })}
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
          {mine.map((c) => {
            const unevidenced = c.items.filter((i) => !i.documentId).length;
            return (
              <div key={c.id} className="border border-white/5 rounded-[28px] bg-card shadow-2xl overflow-hidden flex flex-col">
                <div className="p-5 flex items-start justify-between gap-4 border-b border-white/5">
                  <div className="min-w-0">
                    <div className="text-[15px] font-bold text-white truncate">{c.claimant || intl.formatMessage(m.unnamedClaimant)}</div>
                    <div className="text-[12px] text-zinc-500 mt-0.5">
                      {intl.formatMessage(c.submittedAt ? m.claimMetaSubmitted : m.claimMeta, {
                        period: c.period,
                        count: c.items.length,
                        submittedAt: c.submittedAt,
                      })}
                    </div>
                  </div>
                  <div className="text-right shrink-0">
                    <div className="text-lg font-bold text-white tabular-nums">{currency(total(c))}</div>
                    <div className="mt-1"><Pill tone={STATUS_TONE[c.status]}>{intl.formatMessage(STATUS_LABEL[c.status])}</Pill></div>
                  </div>
                </div>

                {/* Who at the business signed it off. A claim with no approval
                    has not left the company yet, and the practice has nothing
                    to do with it. */}
                {c.approval ? (
                  <div className="px-5 py-3 bg-brand/[0.06] border-b border-brand/15 flex items-start gap-2.5">
                    <ShieldCheck size={14} className="text-brand mt-0.5 shrink-0" />
                    <div className="min-w-0 text-[12px]">
                      <span className="text-white font-semibold">
                        {intl.formatMessage(m.approvedBy, { by: c.approval.by, role: c.approval.role })}
                      </span>
                      <span className="text-zinc-500"> {intl.formatMessage(m.approvedAt, { at: c.approval.at })}</span>
                      {c.approval.note && <div className="text-zinc-500 mt-0.5">{intl.formatMessage(m.approvalNote, { note: c.approval.note })}</div>}
                    </div>
                  </div>
                ) : c.status === 'submitted' ? (
                  <div className="px-5 py-3 bg-ground/60 border-b border-white/5 flex items-center gap-2.5">
                    <Clock size={14} className="text-zinc-500 shrink-0" />
                    <span className="text-[12px] text-zinc-400">
                      {intl.formatMessage(m.waitingOnBusiness, { client: client.name })}
                    </span>
                  </div>
                ) : null}

                <div className="p-5 flex flex-col gap-2 flex-1">
                  {c.items.length === 0 && <p className="text-[13px] text-zinc-500">{intl.formatMessage(m.noLines)}</p>}
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
                              title: intl.formatMessage(m.openReceipt, {
                                supplier: doc.supplier,
                                uploader: doc.uploader,
                                source: doc.source,
                              }),
                            }
                          : {})}
                        className={`group w-full text-left flex items-center gap-3 text-[13px] -mx-2 px-2 py-1.5 rounded-xl transition-colors ${
                          doc ? 'hover:bg-white/[0.04] cursor-pointer' : ''
                        }`}
                      >
                        {doc ? (
                          <span className="shrink-0 w-7 h-8 rounded-lg bg-brand/10 border border-brand/25 flex items-center justify-center text-brand group-hover:bg-brand/20 transition-colors">
                            <FileText size={13} />
                          </span>
                        ) : (
                          // No receipt means no VAT reclaim, so it is flagged
                          // rather than quietly totalled in.
                          <span
                            title={intl.formatMessage(m.noReceipt)}
                            className="shrink-0 w-7 h-8 rounded-lg bg-amber-400/10 border border-amber-400/25 flex items-center justify-center text-amber-400"
                          >
                            <AlertTriangle size={13} />
                          </span>
                        )}
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-zinc-300">{i.description}</span>
                          {doc && read && (
                            <span className="block text-[11px] text-zinc-600 truncate">
                              {intl.formatMessage(m.readFrom, {
                                supplier: doc.supplier,
                                date: read.date,
                                vat: read.vat ?? '—',
                                uploader: doc.uploader,
                              })}
                            </span>
                          )}
                        </span>
                        {/* The AI's own reading of what this spend is, with how
                            sure it was — a low number is the cue to open it. */}
                        {read?.categoryConfidence !== undefined ? (
                          <span
                            title={intl.formatMessage(m.categorisedBy, { percent: Math.round(read.categoryConfidence * 100) })}
                            className={`shrink-0 inline-flex items-center gap-1 text-[11px] font-semibold ${
                              read.categoryConfidence < 0.6 ? 'text-amber-400' : 'text-zinc-500'
                            }`}
                          >
                            <Sparkles size={10} />
                            {category === '—' ? intl.formatMessage(m.uncategorised) : category}
                          </span>
                        ) : (
                          <span className="text-[11px] text-zinc-600 shrink-0">{category}</span>
                        )}
                        <span className="text-white font-bold tabular-nums shrink-0">{currency(total)}</span>
                        {/* Says the row is openable without shouting on every line. */}
                        {doc && (
                          <span className="shrink-0 inline-flex items-center gap-1 text-[11px] font-bold text-zinc-600 group-hover:text-brand transition-colors">
                            <Eye size={13} />
                            {intl.formatMessage(m.viewAction)}
                          </span>
                        )}
                      </Line>
                    );
                  })}
                  {unevidenced > 0 && (
                    <p className="text-[12px] text-amber-400 font-semibold mt-1">
                      {intl.formatMessage(m.unevidencedLines, { count: unevidenced })}
                    </p>
                  )}
                  {c.note && <p className="text-[12px] text-zinc-500 mt-1 leading-relaxed">{c.note}</p>}
                </div>

                <div className="p-4 bg-raised/50 flex items-center gap-2 flex-wrap">
                  <button
                    onClick={() => setEditing(c)}
                    className="px-4 py-2 rounded-full text-[12px] font-bold text-zinc-400 border border-white/5 hover:text-white hover:border-white/15 transition-colors"
                  >
                    {intl.formatMessage(m.editAction)}
                  </button>
                  <span className="flex-1" />
                  {c.status === 'draft' && (
                    <ClaimAction
                      icon={Send} label={intl.formatMessage(m.sendAction)} primary
                      onClick={async () => {
                        const ok = await confirm({
                          title: intl.formatMessage(m.sendTitle, { claimant: c.claimant }),
                          detail: intl.formatMessage(m.sendDetail, {
                            amount: currency(total(c)),
                            count: c.items.length,
                            client: client.name,
                          }),
                          confirmLabel: intl.formatMessage(m.sendConfirm),
                        });
                        if (ok) setExpenseClaimStatus(c.id, 'submitted');
                      }}
                    />
                  )}
                  {/* Nothing for the practice to do while it is still inside
                      the business. */}
                  {c.status === 'submitted' && (
                    <span className="text-[12px] text-zinc-600 font-semibold">{intl.formatMessage(m.withTheBusiness)}</span>
                  )}
                  {c.status === 'internally-approved' && (
                    <>
                      <ClaimAction
                        icon={X} label={intl.formatMessage(m.queryAction)}
                        onClick={async () => {
                          const ok = await confirm({
                            tone: 'red',
                            title: intl.formatMessage(m.queryTitle, { claimant: c.claimant }),
                            detail: intl.formatMessage(m.queryDetail, { amount: currency(total(c)), client: client.name }),
                            consequence: intl.formatMessage(m.queryConsequence),
                            confirmLabel: intl.formatMessage(m.queryConfirm),
                          });
                          if (ok) setExpenseClaimStatus(c.id, 'rejected');
                        }}
                      />
                      <ClaimAction
                        icon={Check} label={intl.formatMessage(m.acceptAction)} primary
                        onClick={async () => {
                          const ok = await confirm({
                            title: intl.formatMessage(m.acceptTitle, { claimant: c.claimant }),
                            detail: intl.formatMessage(m.acceptDetail, { amount: currency(total(c)), count: c.items.length }),
                            ...(c.items.some((i) => !i.documentId)
                              ? { consequence: intl.formatMessage(m.acceptConsequence) }
                              : {}),
                            confirmLabel: intl.formatMessage(m.acceptConfirm),
                          });
                          if (ok) setExpenseClaimStatus(c.id, 'approved');
                        }}
                      />
                    </>
                  )}
                  {c.status === 'approved' && (
                    <ClaimAction
                      icon={Banknote} label={intl.formatMessage(m.reimburseAction)} primary
                      onClick={async () => {
                        const ok = await confirm({
                          title: intl.formatMessage(m.reimburseTitle, { amount: currency(total(c)) }),
                          detail: intl.formatMessage(m.reimburseDetail, { claimant: c.claimant }),
                          consequence: intl.formatMessage(m.reimburseConsequence),
                          confirmLabel: intl.formatMessage(m.reimburseConfirm),
                        });
                        if (ok) setExpenseClaimStatus(c.id, 'reimbursed');
                      }}
                    />
                  )}
                  {(c.status === 'reimbursed' || c.status === 'rejected') && (
                    <ClaimAction
                      icon={Trash2} label={intl.formatMessage(m.deleteAction)}
                      onClick={async () => {
                        const ok = await confirm({
                          tone: 'red',
                          title: intl.formatMessage(m.deleteTitle, { claimant: c.claimant }),
                          detail: intl.formatMessage(m.deleteDetail, {
                            amount: currency(total(c)),
                            period: c.period,
                            status: intl.formatMessage(STATUS_LABEL[c.status]).toLowerCase(),
                          }),
                          consequence: intl.formatMessage(m.deleteConsequence),
                          confirmLabel: intl.formatMessage(m.deleteConfirm),
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
          ? 'text-white bg-brand hover:bg-brand-hover'
          : 'text-zinc-400 border border-white/5 hover:text-white hover:border-white/15'
      }`}
    >
      <Icon size={13} />
      {label}
    </button>
  );
}

const mEditor = defineMessages({
  headingNew: { id: 'analytics.claimEditor.headingNew', defaultMessage: 'New expense claim' },
  headingFallback: { id: 'analytics.claimEditor.headingFallback', defaultMessage: 'Expense claim' },
  subheading: {
    id: 'analytics.claimEditor.subheading',
    defaultMessage: 'Who paid, what for, and what backs it up',
  },
  claimantLabel: { id: 'analytics.claimEditor.claimantLabel', defaultMessage: 'Claimant' },
  periodLabel: { id: 'analytics.claimEditor.periodLabel', defaultMessage: 'Period' },
  periodPlaceholder: { id: 'analytics.claimEditor.periodPlaceholder', defaultMessage: 'August 2026' },
  linesHeading: { id: 'analytics.claimEditor.linesHeading', defaultMessage: 'Lines' },
  addLine: { id: 'analytics.claimEditor.addLine', defaultMessage: '+ Add line' },
  descriptionPlaceholder: {
    id: 'analytics.claimEditor.descriptionPlaceholder',
    defaultMessage: 'What was it for?',
  },
  // A number format, not a decoration: the decimal separator is a full stop in
  // en-GB and a comma in most of Europe, so the sample amount has to be
  // translatable rather than typed into the markup.
  totalPlaceholder: { id: 'analytics.claimEditor.totalPlaceholder', defaultMessage: '0.00' },
  removeLine: { id: 'analytics.claimEditor.removeLine', defaultMessage: 'Remove line' },
  categoryLabel: { id: 'analytics.claimEditor.categoryLabel', defaultMessage: 'Category' },
  amountLabel: { id: 'analytics.claimEditor.amountLabel', defaultMessage: 'Amount' },
  receiptsHeading: { id: 'analytics.claimEditor.receiptsHeading', defaultMessage: 'Receipts' },
  receiptsHint: {
    id: 'analytics.claimEditor.receiptsHint',
    defaultMessage: 'Attaching them sends each one through extraction like any other document.',
  },
  attachAction: { id: 'analytics.claimEditor.attachAction', defaultMessage: 'Attach' },
  problemClaimant: { id: 'analytics.claimEditor.problemClaimant', defaultMessage: 'Name whoever is out of pocket.' },
  problemNoLines: { id: 'analytics.claimEditor.problemNoLines', defaultMessage: 'Add at least one line.' },
  problemDescription: {
    id: 'analytics.claimEditor.problemDescription',
    defaultMessage: 'Every line needs a description.',
  },
  saveAction: { id: 'analytics.claimEditor.saveAction', defaultMessage: 'Save claim' },
});

function ClaimEditor({ claim, onSave, onClose, onAttach }: {
  claim: ExpenseClaim;
  onSave: (c: ExpenseClaim) => void;
  onClose: () => void;
  onAttach: (files: { name: string; size: number }[]) => void;
}) {
  const [draft, setDraft] = useState(claim);
  const fileRef = useRef<HTMLInputElement>(null);
  const intl = useIntl();
  useEscape(onClose);

  const addItem = () =>
    setDraft({
      ...draft,
      items: [
        ...draft.items,
        {
          id: `item-${Date.now()}`,
          description: '',
          date: new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Europe/London' }).format(new Date()),
          total: 0,
          category: 'Travel',
        },
      ],
    });

  const setItem = (id: string, patch: Partial<ExpenseClaimItem>) =>
    setDraft({ ...draft, items: draft.items.map((i) => (i.id === id ? { ...i, ...patch } : i)) });

  const problem = !draft.claimant.trim()
    ? intl.formatMessage(mEditor.problemClaimant)
    : draft.items.length === 0
    ? intl.formatMessage(mEditor.problemNoLines)
    : draft.items.some((i) => !i.description.trim())
    ? intl.formatMessage(mEditor.problemDescription)
    : '';

  return (
    // The backdrop is not a button — role="presentation" says so; keyboard
    // dismissal is Escape (useEscape above). The dialog is named by its own
    // heading rather than a duplicated label expression.
    <div
      className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm flex items-start justify-center overflow-y-auto p-8 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      onClick={onClose}
      role="presentation"
    >
      <motion.div
        initial={{ opacity: 0, y: 20, scale: 0.97 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="claim-editor-heading"
        className="w-full max-w-2xl border border-white/5 rounded-[32px] bg-card shadow-2xl overflow-hidden my-auto"
      >
        <div className="p-6 border-b border-white/5">
          <h3 id="claim-editor-heading" className="font-sans font-bold text-xl text-white tracking-tight">
            {claim.items.length === 0 && !claim.claimant
              ? intl.formatMessage(mEditor.headingNew)
              : draft.claimant || intl.formatMessage(mEditor.headingFallback)}
          </h3>
          <p className="text-[12px] text-zinc-500 mt-1 font-semibold uppercase tracking-wider">
            {intl.formatMessage(mEditor.subheading)}
          </p>
        </div>

        <div className="p-6 flex flex-col gap-5 max-h-[55dvh] overflow-y-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <Field label={intl.formatMessage(mEditor.claimantLabel)} value={draft.claimant} onChange={(v) => setDraft({ ...draft, claimant: v })} placeholder={intl.formatMessage(commonPlaceholders.personName)} />
            <Field label={intl.formatMessage(mEditor.periodLabel)} value={draft.period} onChange={(v) => setDraft({ ...draft, period: v })} placeholder={intl.formatMessage(mEditor.periodPlaceholder)} />
          </div>

          <div>
            <div className="flex items-center justify-between mb-3">
              <span className="text-[11px] font-bold text-zinc-500 uppercase tracking-widest">{intl.formatMessage(mEditor.linesHeading)}</span>
              <button onClick={addItem} className="text-[12px] font-bold text-brand hover:underline">
                {intl.formatMessage(mEditor.addLine)}
              </button>
            </div>
            <div className="flex flex-col gap-2">
              {draft.items.map((i) => (
                <div key={i.id} className="flex items-center gap-2 p-3 rounded-2xl bg-ground/60 border border-white/5 flex-wrap">
                  <input
                    value={i.description}
                    onChange={(e) => setItem(i.id, { description: e.target.value })}
                    placeholder={intl.formatMessage(mEditor.descriptionPlaceholder)}
                    className="flex-1 min-w-[10rem] basis-full sm:basis-auto bg-transparent text-[13px] font-semibold text-white placeholder:text-zinc-600 focus:outline-none py-1"
                  />
                  <input
                    value={i.category}
                    aria-label={intl.formatMessage(mEditor.categoryLabel)}
                    onChange={(e) => setItem(i.id, { category: e.target.value })}
                    className="flex-1 sm:flex-none min-w-0 sm:w-28 bg-card border border-white/5 rounded-lg px-2 py-1.5 text-[12px] text-zinc-300 focus:outline-none focus:border-brand"
                  />
                  <input
                    type="number"
                    value={i.total || ''}
                    onChange={(e) => setItem(i.id, { total: Number(e.target.value) })}
                    placeholder={intl.formatMessage(mEditor.totalPlaceholder)}
                    inputMode="decimal"
                    aria-label={intl.formatMessage(mEditor.amountLabel)}
                    className="w-24 bg-card border border-white/5 rounded-lg px-2 py-1.5 text-[12px] text-white text-right tabular-nums focus:outline-none focus:border-brand"
                  />
                  <button
                    onClick={() => setDraft({ ...draft, items: draft.items.filter((x) => x.id !== i.id) })}
                    className="hit-area p-1.5 rounded-lg text-zinc-600 hover:text-red-400 transition-colors shrink-0"
                    aria-label={intl.formatMessage(mEditor.removeLine)}
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
              ))}
            </div>
          </div>

          {/* Receipts enter the normal pipeline, so they are extracted, coded
              and matched like anything else rather than living only here. */}
          <div className="p-4 rounded-2xl border border-white/5 bg-ground/60 shadow-inner flex items-center justify-between gap-4">
            <div className="min-w-0">
              <div className="text-sm font-bold text-white">{intl.formatMessage(mEditor.receiptsHeading)}</div>
              <div className="text-[12px] text-zinc-500 mt-0.5">
                {intl.formatMessage(mEditor.receiptsHint)}
              </div>
            </div>
            <button
              onClick={() => fileRef.current?.click()}
              className="shrink-0 flex items-center gap-2 px-4 py-2 rounded-full text-[12px] font-bold text-zinc-300 border border-white/10 hover:text-white hover:border-white/25 transition-colors"
            >
              <Paperclip size={13} />
              {intl.formatMessage(mEditor.attachAction)}
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

        <div className="p-4 bg-raised/50 flex items-center gap-2 sm:gap-3 justify-end flex-wrap [&>button]:flex-1 [&>button]:basis-[8rem] sm:[&>button]:flex-none sm:[&>button]:basis-auto [&>button]:justify-center">
          <button onClick={onClose} className="px-5 py-2.5 rounded-full text-[13px] font-bold text-zinc-400 hover:text-white transition-colors">
            {intl.formatMessage(commonActions.cancel)}
          </button>
          <button
            onClick={() => onSave(draft)}
            disabled={!!problem}
            className="px-6 py-2.5 rounded-full text-[13px] font-bold text-white bg-brand hover:bg-brand-hover disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          >
            {intl.formatMessage(mEditor.saveAction)}
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
        className="w-full bg-ground border border-white/5 rounded-xl px-4 py-2.5 text-sm text-white placeholder:text-zinc-600 focus:outline-none focus:border-brand transition-colors"
      />
    </div>
  );
}
