import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ShieldCheck, Smartphone, ArrowLeft, ArrowRight, Check, X, FileText, Link2, Lock, MessageSquare,
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { useAppContext } from '../../context/AppContext';
import { DocumentPreview } from '../../components/DynamicComponents/DocumentPreview';
import { Pill } from '../../components/DynamicComponents/DataTable';
import { ConfirmStep } from '../../components/DynamicComponents/ConfirmStep';
import { currency } from '../../lib/resolver';
import type { ApprovalItem } from '../../lib/types';

/**
 * Wireframe screen 19 — client-side approvals.
 *
 * This is not a portal tab. The approver needs no app, no password and no
 * account: an SMS carries a signed short-lived link, an OTP challenge opens the
 * session, and the batch is presented one item at a time. It exists only for
 * clients whose workflow names a client-side approver, which is why the
 * accountant has to send the request before there is anything here.
 *
 * The Review → Approve gate is the same law as everywhere else: Approve stays
 * hidden until the review has actually been opened.
 */
export function ClientApprovalView() {
  const {
    approvalRequests, openApprovalRequestId, approvals, documents, transactions, matches,
    verifyApprovalCode, resendApprovalRequest, advanceApproval, rejectApproval, exitBusinessPortal,
  } = useAppContext();

  const request = approvalRequests.find((r) => r.id === openApprovalRequestId);
  const [index, setIndex] = useState(0);

  // Items are resolved live so an approval taken here immediately removes the
  // item from the batch — the same list the accountant is looking at.
  const items = useMemo(
    () => (request ? request.itemIds.map((id) => approvals.find((a) => a.id === id)).filter(Boolean) as ApprovalItem[] : []),
    [request, approvals],
  );
  const pending = items.filter((a) => a.state === 'pending');

  if (!request) {
    return (
      <Shell title="Link not found">
        <p className="text-[14px] text-zinc-400 leading-relaxed">
          This approval link is no longer valid. Ask your accountant to send a new one.
        </p>
        <BackButton onClick={exitBusinessPortal} />
      </Shell>
    );
  }

  if (!request.verified) {
    return <OtpChallenge request={request} onVerify={verifyApprovalCode} onResend={resendApprovalRequest} onExit={exitBusinessPortal} />;
  }

  // The index is clamped to the batch, so the lookup misses on exactly one
  // condition — an empty batch — which is the "all done" screen itself.
  const current = pending[Math.min(index, pending.length - 1)];

  if (!current) {
    return (
      <Shell title="All done">
        <div className="w-14 h-14 rounded-2xl bg-brand/15 border border-brand/30 flex items-center justify-center text-brand mb-2">
          <Check size={26} strokeWidth={3} />
        </div>
        <p className="text-[14px] text-zinc-400 leading-relaxed">
          Nothing left to approve for {request.clientName}. Your accountant has been notified and the items are
          locked — nobody can change the figures you signed off.
        </p>
        <BackButton onClick={exitBusinessPortal} />
      </Shell>
    );
  }

  const position = Math.min(index, pending.length - 1) + 1;

  return (
    <ApprovalCard
      key={current.id}
      item={current}
      position={position}
      total={pending.length}
      clientName={request.clientName}
      document={documents.find((d) => d.id === current.documentId)}
      transaction={transactions.find((t) => t.matchedDocId === current.documentId)}
      match={matches.find((m) => m.documentId === current.documentId)}
      onApprove={(note) => {
        advanceApproval(current.id, note, `${request.recipientName} (client, SMS session)`);
        setIndex(0);
      }}
      onReject={(reason) => {
        rejectApproval(current.id, reason, `${request.recipientName} (client, SMS session)`);
        setIndex(0);
      }}
      onExit={exitBusinessPortal}
    />
  );
}

/* ── ① SMS received → ② OTP challenge ─────────────────────────────────────── */

function OtpChallenge({
  request, onVerify, onResend, onExit,
}: {
  request: { id: string; clientName: string; recipientMobile: string; message: string; itemIds: string[]; expiresInHours: number; resendCount: number };
  onVerify: (id: string, code: string) => boolean;
  onResend: (id: string) => void;
  onExit: () => void;
}) {
  const [code, setCode] = useState('');

  const masked = request.recipientMobile.replace(/(\+\d{2}\s?\d)(.*)(\d{2})$/, '$1••• •••$3');

  // Code checking is server-side, so Verify opens the session either way.
  const submit = () => onVerify(request.id, code);

  return (
    <Shell title="Approve securely">
      {/* ① The message the approver actually received. */}
      <div className="p-4 rounded-2xl bg-ground border border-white/5 shadow-inner">
        <div className="flex items-center gap-2 text-[11px] font-bold text-zinc-500 uppercase tracking-widest mb-2">
          <MessageSquare size={12} />
          SMS received
        </div>
        <p className="text-[13.5px] text-zinc-300 leading-relaxed">{request.message}</p>
      </div>

      {/* ② The challenge. */}
      <div>
        <div className="text-[11px] font-bold text-zinc-500 uppercase tracking-widest mb-2">
          Code sent to {masked}
        </div>
        <div className="flex items-center gap-2">
          <input
            value={code}
            onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 4))}
            onKeyDown={(e) => e.key === 'Enter' && submit()}
            inputMode="numeric"
            placeholder="0000"
            aria-label="One-time code"
            className="flex-1 bg-ground border border-white/5 rounded-2xl px-5 py-4 text-2xl font-bold tracking-[0.4em] text-center text-white placeholder:text-zinc-700 focus:outline-none focus:border-brand transition-colors tabular-nums"
          />
        </div>
        <p className="text-[12px] text-zinc-600 mt-3 leading-relaxed">
          Rate-limited, and the session is logged — who the link was sent to and who acted on it are recorded
          separately. The link expires {request.expiresInHours}h after sending.
          {request.resendCount > 0 ? ` Resent ${request.resendCount}×.` : ''}
        </p>
        <p className="text-[12px] text-zinc-600 mt-1">
          Codes are issued and checked server-side — Verify continues without one here.
        </p>
      </div>

      <div className="flex flex-col gap-2">
        <button
          onClick={submit}
          className="w-full flex items-center justify-center gap-2 px-6 py-3.5 rounded-full text-[14px] font-bold text-white bg-brand hover:bg-brand-hover transition-colors shadow-[0_0_20px_rgba(20,227,196,0.25)]"
        >
          <ShieldCheck size={16} strokeWidth={2.5} />
          Verify
        </button>
        <button
          onClick={() => { onResend(request.id); setCode(''); }}
          className="w-full px-6 py-3 rounded-full text-[13px] font-bold text-zinc-400 hover:text-white transition-colors"
        >
          Send a new code
        </button>
      </div>

      <BackButton onClick={onExit} />
    </Shell>
  );
}

/* ── ③ Approval card ──────────────────────────────────────────────────────── */

function ApprovalCard({
  item, position, total, clientName, document, transaction, match, onApprove, onReject, onExit,
}: {
  item: ApprovalItem;
  position: number;
  total: number;
  clientName: string;
  /**
   * Each of these is a lookup that may legitimately find nothing — an approval
   * with no document attached, or one the bank has not matched yet — so the
   * absent case is spelled out rather than left to the caller to omit.
   */
  document?: import('../../lib/types').Document | undefined;
  transaction?: import('../../lib/types').BankTransaction | undefined;
  match?: import('../../lib/types').Match | undefined;
  onApprove: (note?: string) => void;
  onReject: (reason: string) => void;
  onExit: () => void;
}) {
  /** The universal gate — Approve does not exist until the review is opened. */
  const [reviewOpened, setReviewOpened] = useState(false);
  const [viewingDoc, setViewingDoc] = useState(false);
  const [rejecting, setRejecting] = useState(false);
  const [confirming, setConfirming] = useState<'approve' | 'reject' | null>(null);
  const rejectRef = useRef<HTMLTextAreaElement>(null);

  /**
   * The note field opens below a long card, and on a phone the thumb-reach
   * action bar hides it — so pressing Reject scrolls it into view and puts the
   * cursor in it. Without this the button appears to do nothing.
   */
  useEffect(() => {
    if (!rejecting) return;
    const field = rejectRef.current;
    if (!field) return;
    // scrollIntoView does not consult prefers-reduced-motion on its own.
    const calm = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    field.scrollIntoView({ behavior: calm ? 'auto' : 'smooth', block: 'center' });
    field.focus({ preventScroll: true });
  }, [rejecting]);
  const [note, setNote] = useState('');

  const vat = document?.fields.find((f) => f.label.toLowerCase().includes('tax'))?.value;

  return (
    <div className="flex-1 flex flex-col min-w-0 h-full bg-ground overflow-hidden">
      <header className="shrink-0 border-b border-white/5 bg-card px-5 py-4 flex items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="font-sans font-bold text-[15px] text-white tracking-tight truncate">{clientName}</div>
          <div className="text-[11px] text-zinc-500 font-semibold uppercase tracking-wider">
            Item {position} of {total} · approval
          </div>
        </div>
        <Pill tone="amber">{item.stage}</Pill>
      </header>

      <div className="flex-1 overflow-y-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {/* Mobile-first: a single column, thumb-reach actions pinned below. */}
        <div className="w-full max-w-md mx-auto px-5 py-6 flex flex-col gap-5">

          <div>
            <h1 className="font-sans text-2xl font-bold text-white tracking-tight">{item.supplier}</h1>
            <div className="text-3xl font-bold text-white tracking-tight tabular-nums mt-1">{currency(item.total)}</div>
            <div className="text-[13px] text-zinc-400 mt-2">
              {document?.date ?? '—'} · {item.category}
              {vat ? ` · VAT ${vat}` : ''}
            </div>
          </div>

          {/* The approver never approves blind — the source document is one tap
              away and stays reachable throughout. */}
          <div className="p-4 rounded-2xl bg-card border border-white/5 shadow-inner">
            <div className="flex items-center gap-2 text-[11px] font-bold text-zinc-500 uppercase tracking-widest mb-2">
              <FileText size={12} />
              Source document
            </div>
            {document ? (
              <>
                <p className="text-[13px] text-zinc-300 leading-relaxed">
                  {document.supplier} · uploaded by {document.uploader} · {document.date} · via {document.source}
                </p>
                <button
                  onClick={() => setViewingDoc(true)}
                  className="mt-3 w-full px-4 py-2.5 rounded-full text-[13px] font-bold text-brand bg-brand/10 border border-brand/20 hover:bg-brand/20 transition-colors"
                >
                  View document
                </button>
              </>
            ) : (
              <p className="text-[13px] text-zinc-500">No document attached to this item.</p>
            )}
          </div>

          {/* Matched bank transaction — the evidence that it was actually paid. */}
          {(transaction || match) && (
            <div className="p-4 rounded-2xl bg-card border border-white/5 shadow-inner">
              <div className="flex items-center gap-2 text-[11px] font-bold text-zinc-500 uppercase tracking-widest mb-2">
                <Link2 size={12} />
                Matched bank transaction
              </div>
              <p className="text-[13px] text-zinc-300 leading-relaxed">
                {match?.transactionLabel ??
                  `${transaction?.description} · ${currency(Math.abs(transaction?.amount ?? 0))} · ${transaction?.date}`}
              </p>
              {match && <div className="mt-2"><Pill tone="green">{Math.round(match.confidence * 100)}% match</Pill></div>}
            </div>
          )}

          {/* The review. Opening it is what unlocks Approve. */}
          {!reviewOpened ? (
            <button
              onClick={() => setReviewOpened(true)}
              className="w-full px-5 py-3.5 rounded-2xl text-[14px] font-bold text-white bg-raised border border-white/10 hover:border-white/25 transition-colors text-left flex items-center justify-between gap-3"
            >
              Read review
              <ArrowRight size={16} strokeWidth={2.5} />
            </button>
          ) : (
            <motion.div
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: 'auto' }}
              className="p-4 rounded-2xl bg-card border border-white/5 shadow-inner overflow-hidden"
            >
              <div className="text-[11px] font-bold text-zinc-500 uppercase tracking-widest mb-3">
                What you are approving
              </div>
              <div className="flex flex-col gap-2.5 text-[13px]">
                <ReviewRow label="Supplier" value={item.supplier} />
                <ReviewRow label="Amount" value={currency(item.total)} />
                <ReviewRow label="Category" value={item.category} />
                {vat && <ReviewRow label="VAT" value={vat} />}
                <ReviewRow label="Stage" value={item.stage} />
                <ReviewRow label="Waiting" value={`${item.waitingDays} day${item.waitingDays === 1 ? '' : 's'}`} />
              </div>

              {document && document.lineItems.length > 0 && (
                <>
                  <div className="text-[11px] font-bold text-zinc-500 uppercase tracking-widest mt-4 mb-2">Line items</div>
                  <div className="flex flex-col gap-1.5">
                    {document.lineItems.map((l, i) => (
                      <div key={i} className="flex justify-between gap-3 text-[12.5px]">
                        <span className="text-zinc-400 min-w-0 truncate">{l.description}</span>
                        <span className="text-white font-semibold tabular-nums shrink-0">{currency(l.total)}</span>
                      </div>
                    ))}
                  </div>
                </>
              )}

              {item.history.length > 0 && (
                <>
                  <div className="text-[11px] font-bold text-zinc-500 uppercase tracking-widest mt-4 mb-2">
                    Who approved before you
                  </div>
                  <div className="flex flex-col gap-1.5">
                    {item.history.map((h, i) => (
                      <div key={i} className="text-[12.5px] text-zinc-400">
                        {h.label} — {h.actor} · {h.at}
                      </div>
                    ))}
                  </div>
                </>
              )}

              <p className="text-[12px] text-zinc-600 leading-relaxed mt-4">
                This is the last stage. Approving locks the item — the figures above can no longer be edited — and
                publishes it to the accounting software.
              </p>
            </motion.div>
          )}

          {rejecting && (
            <div>
              <label
                htmlFor="reject-note"
                className="block text-[11px] font-bold text-zinc-500 uppercase tracking-widest mb-2"
              >
                Why are you rejecting it?
              </label>
              <textarea
                id="reject-note"
                ref={rejectRef}
                value={note}
                onChange={(e) => setNote(e.target.value)}
                rows={3}
                placeholder="Wrong category — this was for the Camden site"
                className="w-full bg-ground border border-white/5 rounded-2xl px-4 py-3 text-[13.5px] text-white placeholder:text-zinc-600 focus:outline-none focus:border-brand transition-colors resize-none"
              />
              <p className="text-[12px] text-zinc-600 mt-2 leading-relaxed">
                Your accountant sees this with the item — say what is wrong and they can fix it without asking.
              </p>
            </div>
          )}
        </div>
      </div>

      {/* Thumb-reach action bar — the client side is mobile-first by mandate. */}
      <div className="shrink-0 border-t border-white/5 bg-card px-5 py-4">
        <div className="w-full max-w-md mx-auto flex flex-col gap-2">
          {rejecting ? (
            <>
              <button
                onClick={() => setConfirming('reject')}
                className="w-full flex items-center justify-center gap-2 px-6 py-3.5 rounded-full text-[14px] font-bold text-white bg-red-500 hover:bg-red-600 transition-colors"
              >
                <X size={16} strokeWidth={2.5} />
                Send rejection
              </button>
              <button
                onClick={() => { setRejecting(false); setNote(''); }}
                className="w-full px-6 py-3 rounded-full text-[13px] font-bold text-zinc-400 hover:text-white transition-colors"
              >
                Cancel
              </button>
            </>
          ) : (
            <>
              {reviewOpened ? (
                <button
                  onClick={() => setConfirming('approve')}
                  className="w-full flex items-center justify-center gap-2 px-6 py-3.5 rounded-full text-[14px] font-bold text-white bg-brand hover:bg-brand-hover transition-colors shadow-[0_0_20px_rgba(20,227,196,0.25)]"
                >
                  <Lock size={15} strokeWidth={2.5} />
                  Approve
                </button>
              ) : (
                <div className="w-full px-6 py-3.5 rounded-full text-[13px] font-bold text-zinc-600 bg-ground border border-white/5 text-center">
                  Read the review to approve
                </div>
              )}
              <button
                onClick={() => setRejecting(true)}
                className="w-full px-6 py-3 rounded-full text-[13px] font-bold text-zinc-400 hover:text-white border border-white/5 hover:border-white/15 transition-colors"
              >
                Reject + note
              </button>
            </>
          )}
          <button
            onClick={onExit}
            className="w-full px-6 py-2 rounded-full text-[12px] font-bold text-zinc-600 hover:text-zinc-400 transition-colors"
          >
            Leave — reminders will follow on the chase schedule
          </button>
        </div>
      </div>

      {confirming === 'approve' && (
        <ConfirmStep
          title={`Approve ${item.supplier} for ${currency(item.total)}?`}
          detail={`You are signing off ${item.category} on behalf of ${clientName}. Your name goes on the approval.`}
          consequence="This is the last stage — the item locks, the figures can no longer be changed, and it publishes to the accounting software."
          confirmLabel="Yes, approve it"
          onConfirm={() => { setConfirming(null); onApprove(note.trim() || undefined); }}
          onCancel={() => setConfirming(null)}
        />
      )}
      {confirming === 'reject' && (
        <ConfirmStep
          tone="red"
          title={`Reject ${item.supplier}?`}
          detail={
            note.trim()
              ? `Your accountant will see: “${note.trim()}”`
              : 'No reason given — your accountant will have to ask you what was wrong.'
          }
          consequence="The item goes back to your accountant and is not published."
          confirmLabel="Yes, reject it"
          onConfirm={() => { setConfirming(null); onReject(note.trim() || 'No reason given'); }}
          onCancel={() => setConfirming(null)}
        />
      )}

      {/* Full-screen immutable viewer, one tap from every step. */}
      <AnimatePresence>
        {viewingDoc && document && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm overflow-y-auto p-5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
            onClick={() => setViewingDoc(false)}
          >
            <div className="min-h-full flex flex-col items-center justify-center gap-3" onClick={(e) => e.stopPropagation()}>
              <DocumentPreview document={document} />
              <button
                onClick={() => setViewingDoc(false)}
                className="px-6 py-2.5 rounded-full text-[13px] font-bold text-white bg-raised border border-white/10 hover:border-white/25 transition-colors"
              >
                Close
              </button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

/* ── shared chrome ────────────────────────────────────────────────────────── */

function Shell({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="flex-1 flex flex-col min-w-0 h-full bg-ground overflow-y-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
      <div className="w-full max-w-md mx-auto px-5 py-10 flex flex-col gap-5">
        <div className="flex items-center gap-3">
          <div className="w-11 h-11 rounded-2xl bg-brand flex items-center justify-center text-white shrink-0 shadow-[0_0_15px_rgba(20,227,196,0.3)]">
            <Smartphone size={19} />
          </div>
          <div>
            <h1 className="font-sans font-bold text-xl text-white tracking-tight">{title}</h1>
            <p className="text-[11px] text-zinc-500 font-semibold uppercase tracking-wider">No app · no password</p>
          </div>
        </div>
        {children}
      </div>
    </div>
  );
}

function ReviewRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between items-baseline gap-4">
      <span className="text-zinc-500">{label}</span>
      <span className="text-white font-bold text-right">{value}</span>
    </div>
  );
}

function BackButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="self-start flex items-center gap-2 px-4 py-2 rounded-full text-[13px] font-bold text-zinc-500 hover:text-white transition-colors"
    >
      <ArrowLeft size={14} />
      Back to the practice app
    </button>
  );
}
