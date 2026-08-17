import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ShieldCheck, Smartphone, ArrowLeft, ArrowRight, Check, X, FileText, Link2, Lock, MessageSquare,
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { defineMessages, useIntl } from 'react-intl';
import { useAppContext } from '../../context/AppContext';
import { DocumentPreview } from '../../components/DynamicComponents/DocumentPreview';
import { Pill } from '../../components/DynamicComponents/DataTable';
import { ConfirmStep } from '../../components/DynamicComponents/ConfirmStep';
import { currency } from '../../lib/resolver';
import type { ApprovalItem } from '../../lib/types';

const m = defineMessages({
  linkNotFoundTitle: { id: 'portal.clientApprovalView.linkNotFoundTitle', defaultMessage: 'Link not found' },
  linkNotFoundDetail: {
    id: 'portal.clientApprovalView.linkNotFoundDetail',
    defaultMessage: 'This approval link is no longer valid. Ask your accountant to send a new one.',
  },
  allDoneTitle: { id: 'portal.clientApprovalView.allDoneTitle', defaultMessage: 'All done' },
  allDoneDetail: {
    id: 'portal.clientApprovalView.allDoneDetail',
    defaultMessage:
      'Nothing left to approve for {client}. Your accountant has been notified and the items are locked — nobody can change the figures you signed off.',
  },

  otpTitle: { id: 'portal.otpChallenge.title', defaultMessage: 'Approve securely' },
  otpSmsReceived: { id: 'portal.otpChallenge.smsReceived', defaultMessage: 'SMS received' },
  otpCodeSentTo: { id: 'portal.otpChallenge.codeSentTo', defaultMessage: 'Code sent to {mobile}' },
  otpCodeAriaLabel: { id: 'portal.otpChallenge.codeAriaLabel', defaultMessage: 'One-time code' },
  // The digit shape of the code, which is a numeral and not a symbol: a locale
  // that writes numbers in another script writes this placeholder in it too.
  otpCodePlaceholder: { id: 'portal.otpChallenge.codePlaceholder', defaultMessage: '0000' },
  otpAudit: {
    id: 'portal.otpChallenge.audit',
    defaultMessage:
      'Rate-limited, and the session is logged — who the link was sent to and who acted on it are recorded separately. The link expires {hours}h after sending.',
  },
  otpAuditResent: {
    id: 'portal.otpChallenge.auditResent',
    defaultMessage:
      'Rate-limited, and the session is logged — who the link was sent to and who acted on it are recorded separately. The link expires {hours}h after sending. Resent {resendCount}×.',
  },
  otpServerSideNote: {
    id: 'portal.otpChallenge.serverSideNote',
    defaultMessage: 'Codes are issued and checked server-side — Verify continues without one here.',
  },
  otpVerifyAction: { id: 'portal.otpChallenge.verifyAction', defaultMessage: 'Verify' },
  otpResendAction: { id: 'portal.otpChallenge.resendAction', defaultMessage: 'Send a new code' },

  position: { id: 'portal.approvalCard.position', defaultMessage: 'Item {position} of {total} · approval' },
  vatLabel: { id: 'portal.approvalCard.vatLabel', defaultMessage: 'VAT {vat}' },
  sourceDocumentHeading: {
    id: 'portal.approvalCard.sourceDocumentHeading',
    defaultMessage: 'Source document',
  },
  sourceDocumentDetail: {
    id: 'portal.approvalCard.sourceDocumentDetail',
    defaultMessage: '{supplier} · uploaded by {uploader} · {date} · via {source}',
  },
  viewDocumentAction: { id: 'portal.approvalCard.viewDocumentAction', defaultMessage: 'View document' },
  noDocument: {
    id: 'portal.approvalCard.noDocument',
    defaultMessage: 'No document attached to this item.',
  },
  matchedHeading: { id: 'portal.approvalCard.matchedHeading', defaultMessage: 'Matched bank transaction' },
  matchConfidence: { id: 'portal.approvalCard.matchConfidence', defaultMessage: '{percent}% match' },
  readReviewAction: { id: 'portal.approvalCard.readReviewAction', defaultMessage: 'Read review' },
  reviewHeading: { id: 'portal.approvalCard.reviewHeading', defaultMessage: 'What you are approving' },
  rowSupplier: { id: 'portal.approvalCard.rowSupplier', defaultMessage: 'Supplier' },
  rowAmount: { id: 'portal.approvalCard.rowAmount', defaultMessage: 'Amount' },
  rowCategory: { id: 'portal.approvalCard.rowCategory', defaultMessage: 'Category' },
  rowVat: { id: 'portal.approvalCard.rowVat', defaultMessage: 'VAT' },
  rowStage: { id: 'portal.approvalCard.rowStage', defaultMessage: 'Stage' },
  rowWaiting: { id: 'portal.approvalCard.rowWaiting', defaultMessage: 'Waiting' },
  waitingDays: {
    id: 'portal.approvalCard.waitingDays',
    defaultMessage: '{count, plural, one {# day} other {# days}}',
  },
  lineItemsHeading: { id: 'portal.approvalCard.lineItemsHeading', defaultMessage: 'Line items' },
  historyHeading: { id: 'portal.approvalCard.historyHeading', defaultMessage: 'Who approved before you' },
  lastStageNote: {
    id: 'portal.approvalCard.lastStageNote',
    defaultMessage:
      'This is the last stage. Approving locks the item — the figures above can no longer be edited — and publishes it to the accounting software.',
  },
  rejectReasonLabel: {
    id: 'portal.approvalCard.rejectReasonLabel',
    defaultMessage: 'Why are you rejecting it?',
  },
  rejectReasonPlaceholder: {
    id: 'portal.approvalCard.rejectReasonPlaceholder',
    defaultMessage: 'Wrong category — this was for the Camden site',
  },
  rejectReasonHint: {
    id: 'portal.approvalCard.rejectReasonHint',
    defaultMessage: 'Your accountant sees this with the item — say what is wrong and they can fix it without asking.',
  },
  sendRejectionAction: { id: 'portal.approvalCard.sendRejectionAction', defaultMessage: 'Send rejection' },
  cancelAction: { id: 'portal.approvalCard.cancelAction', defaultMessage: 'Cancel' },
  approveAction: { id: 'portal.approvalCard.approveAction', defaultMessage: 'Approve' },
  approveGate: {
    id: 'portal.approvalCard.approveGate',
    defaultMessage: 'Read the review to approve',
  },
  rejectAction: { id: 'portal.approvalCard.rejectAction', defaultMessage: 'Reject + note' },
  leaveAction: {
    id: 'portal.approvalCard.leaveAction',
    defaultMessage: 'Leave — reminders will follow on the chase schedule',
  },
  closeViewerAction: { id: 'portal.approvalCard.closeViewerAction', defaultMessage: 'Close' },
  confirmApproveTitle: {
    id: 'portal.approvalCard.confirmApproveTitle',
    defaultMessage: 'Approve {supplier} for {amount}?',
  },
  confirmApproveDetail: {
    id: 'portal.approvalCard.confirmApproveDetail',
    defaultMessage: 'You are signing off {category} on behalf of {client}. Your name goes on the approval.',
  },
  confirmApproveConsequence: {
    id: 'portal.approvalCard.confirmApproveConsequence',
    defaultMessage:
      'This is the last stage — the item locks, the figures can no longer be changed, and it publishes to the accounting software.',
  },
  confirmApproveLabel: { id: 'portal.approvalCard.confirmApproveLabel', defaultMessage: 'Yes, approve it' },
  confirmRejectTitle: { id: 'portal.approvalCard.confirmRejectTitle', defaultMessage: 'Reject {supplier}?' },
  confirmRejectDetail: {
    id: 'portal.approvalCard.confirmRejectDetail',
    defaultMessage: 'Your accountant will see: “{note}”',
  },
  confirmRejectDetailNoReason: {
    id: 'portal.approvalCard.confirmRejectDetailNoReason',
    defaultMessage: 'No reason given — your accountant will have to ask you what was wrong.',
  },
  confirmRejectConsequence: {
    id: 'portal.approvalCard.confirmRejectConsequence',
    defaultMessage: 'The item goes back to your accountant and is not published.',
  },
  confirmRejectLabel: { id: 'portal.approvalCard.confirmRejectLabel', defaultMessage: 'Yes, reject it' },

  shellSubtitle: { id: 'portal.shell.subtitle', defaultMessage: 'No app · no password' },
  backLabel: { id: 'portal.backButton.label', defaultMessage: 'Back to the practice app' },
});

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
  const intl = useIntl();

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
      <Shell title={intl.formatMessage(m.linkNotFoundTitle)}>
        <p className="text-[14px] text-zinc-400 leading-relaxed">
          {intl.formatMessage(m.linkNotFoundDetail)}
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
      <Shell title={intl.formatMessage(m.allDoneTitle)}>
        <div className="w-14 h-14 rounded-2xl bg-brand/15 border border-brand/30 flex items-center justify-center text-brand mb-2">
          <Check size={26} strokeWidth={3} />
        </div>
        <p className="text-[14px] text-zinc-400 leading-relaxed">
          {intl.formatMessage(m.allDoneDetail, { client: request.clientName })}
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
      match={matches.find((mt) => mt.documentId === current.documentId)}
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
  const intl = useIntl();

  const masked = request.recipientMobile.replace(/(\+\d{2}\s?\d)(.*)(\d{2})$/, '$1••• •••$3');

  // Code checking is server-side, so Verify opens the session either way.
  const submit = () => onVerify(request.id, code);

  return (
    <Shell title={intl.formatMessage(m.otpTitle)}>
      {/* ① The message the approver actually received. */}
      <div className="p-4 rounded-2xl bg-ground border border-white/5 shadow-inner">
        <div className="flex items-center gap-2 text-[11px] font-bold text-zinc-500 uppercase tracking-widest mb-2">
          <MessageSquare size={12} />
          {intl.formatMessage(m.otpSmsReceived)}
        </div>
        <p className="text-[13.5px] text-zinc-300 leading-relaxed">{request.message}</p>
      </div>

      {/* ② The challenge. */}
      <div>
        <div className="text-[11px] font-bold text-zinc-500 uppercase tracking-widest mb-2">
          {intl.formatMessage(m.otpCodeSentTo, { mobile: masked })}
        </div>
        <div className="flex items-center gap-2">
          <input
            value={code}
            onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 4))}
            onKeyDown={(e) => e.key === 'Enter' && submit()}
            inputMode="numeric"
            placeholder={intl.formatMessage(m.otpCodePlaceholder)}
            aria-label={intl.formatMessage(m.otpCodeAriaLabel)}
            className="flex-1 bg-ground border border-white/5 rounded-2xl px-5 py-4 text-2xl font-bold tracking-[0.4em] text-center text-white placeholder:text-zinc-700 focus:outline-none focus:border-brand transition-colors tabular-nums"
          />
        </div>
        <p className="text-[12px] text-zinc-600 mt-3 leading-relaxed">
          {request.resendCount > 0
            ? intl.formatMessage(m.otpAuditResent, {
                hours: request.expiresInHours,
                resendCount: request.resendCount,
              })
            : intl.formatMessage(m.otpAudit, { hours: request.expiresInHours })}
        </p>
        <p className="text-[12px] text-zinc-600 mt-1">
          {intl.formatMessage(m.otpServerSideNote)}
        </p>
      </div>

      <div className="flex flex-col gap-2">
        <button
          onClick={submit}
          className="w-full flex items-center justify-center gap-2 px-6 py-3.5 rounded-full text-[14px] font-bold text-white bg-brand hover:bg-brand-hover transition-colors shadow-glow-cta"
        >
          <ShieldCheck size={16} strokeWidth={2.5} />
          {intl.formatMessage(m.otpVerifyAction)}
        </button>
        <button
          onClick={() => { onResend(request.id); setCode(''); }}
          className="w-full px-6 py-3 rounded-full text-[13px] font-bold text-zinc-400 hover:text-white transition-colors"
        >
          {intl.formatMessage(m.otpResendAction)}
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
  const intl = useIntl();

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
            {intl.formatMessage(m.position, { position, total })}
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
              {vat ? <> · {intl.formatMessage(m.vatLabel, { vat })}</> : ''}
            </div>
          </div>

          {/* The approver never approves blind — the source document is one tap
              away and stays reachable throughout. */}
          <div className="p-4 rounded-2xl bg-card border border-white/5 shadow-inner">
            <div className="flex items-center gap-2 text-[11px] font-bold text-zinc-500 uppercase tracking-widest mb-2">
              <FileText size={12} />
              {intl.formatMessage(m.sourceDocumentHeading)}
            </div>
            {document ? (
              <>
                <p className="text-[13px] text-zinc-300 leading-relaxed">
                  {intl.formatMessage(m.sourceDocumentDetail, {
                    supplier: document.supplier,
                    uploader: document.uploader,
                    date: document.date,
                    source: document.source,
                  })}
                </p>
                <button
                  onClick={() => setViewingDoc(true)}
                  className="mt-3 w-full px-4 py-2.5 rounded-full text-[13px] font-bold text-brand bg-brand/10 border border-brand/20 hover:bg-brand/20 transition-colors"
                >
                  {intl.formatMessage(m.viewDocumentAction)}
                </button>
              </>
            ) : (
              <p className="text-[13px] text-zinc-500">{intl.formatMessage(m.noDocument)}</p>
            )}
          </div>

          {/* Matched bank transaction — the evidence that it was actually paid. */}
          {(transaction || match) && (
            <div className="p-4 rounded-2xl bg-card border border-white/5 shadow-inner">
              <div className="flex items-center gap-2 text-[11px] font-bold text-zinc-500 uppercase tracking-widest mb-2">
                <Link2 size={12} />
                {intl.formatMessage(m.matchedHeading)}
              </div>
              <p className="text-[13px] text-zinc-300 leading-relaxed">
                {match?.transactionLabel ??
                  `${transaction?.description} · ${currency(Math.abs(transaction?.amount ?? 0))} · ${transaction?.date}`}
              </p>
              {match && (
                <div className="mt-2">
                  <Pill tone="green">
                    {intl.formatMessage(m.matchConfidence, { percent: Math.round(match.confidence * 100) })}
                  </Pill>
                </div>
              )}
            </div>
          )}

          {/* The review. Opening it is what unlocks Approve. */}
          {!reviewOpened ? (
            <button
              onClick={() => setReviewOpened(true)}
              className="w-full px-5 py-3.5 rounded-2xl text-[14px] font-bold text-white bg-raised border border-white/10 hover:border-white/25 transition-colors text-left flex items-center justify-between gap-3"
            >
              {intl.formatMessage(m.readReviewAction)}
              <ArrowRight size={16} strokeWidth={2.5} />
            </button>
          ) : (
            <motion.div
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: 'auto' }}
              className="p-4 rounded-2xl bg-card border border-white/5 shadow-inner overflow-hidden"
            >
              <div className="text-[11px] font-bold text-zinc-500 uppercase tracking-widest mb-3">
                {intl.formatMessage(m.reviewHeading)}
              </div>
              <div className="flex flex-col gap-2.5 text-[13px]">
                <ReviewRow label={intl.formatMessage(m.rowSupplier)} value={item.supplier} />
                <ReviewRow label={intl.formatMessage(m.rowAmount)} value={currency(item.total)} />
                <ReviewRow label={intl.formatMessage(m.rowCategory)} value={item.category} />
                {vat && <ReviewRow label={intl.formatMessage(m.rowVat)} value={vat} />}
                <ReviewRow label={intl.formatMessage(m.rowStage)} value={item.stage} />
                <ReviewRow
                  label={intl.formatMessage(m.rowWaiting)}
                  value={intl.formatMessage(m.waitingDays, { count: item.waitingDays })}
                />
              </div>

              {document && document.lineItems.length > 0 && (
                <>
                  <div className="text-[11px] font-bold text-zinc-500 uppercase tracking-widest mt-4 mb-2">
                    {intl.formatMessage(m.lineItemsHeading)}
                  </div>
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
                    {intl.formatMessage(m.historyHeading)}
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
                {intl.formatMessage(m.lastStageNote)}
              </p>
            </motion.div>
          )}

          {rejecting && (
            <div>
              <label
                htmlFor="reject-note"
                className="block text-[11px] font-bold text-zinc-500 uppercase tracking-widest mb-2"
              >
                {intl.formatMessage(m.rejectReasonLabel)}
              </label>
              <textarea
                id="reject-note"
                ref={rejectRef}
                value={note}
                onChange={(e) => setNote(e.target.value)}
                rows={3}
                placeholder={intl.formatMessage(m.rejectReasonPlaceholder)}
                className="w-full bg-ground border border-white/5 rounded-2xl px-4 py-3 text-[13.5px] text-white placeholder:text-zinc-600 focus:outline-none focus:border-brand transition-colors resize-none"
              />
              <p className="text-[12px] text-zinc-600 mt-2 leading-relaxed">
                {intl.formatMessage(m.rejectReasonHint)}
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
                {intl.formatMessage(m.sendRejectionAction)}
              </button>
              <button
                onClick={() => { setRejecting(false); setNote(''); }}
                className="w-full px-6 py-3 rounded-full text-[13px] font-bold text-zinc-400 hover:text-white transition-colors"
              >
                {intl.formatMessage(m.cancelAction)}
              </button>
            </>
          ) : (
            <>
              {reviewOpened ? (
                <button
                  onClick={() => setConfirming('approve')}
                  className="w-full flex items-center justify-center gap-2 px-6 py-3.5 rounded-full text-[14px] font-bold text-white bg-brand hover:bg-brand-hover transition-colors shadow-glow-cta"
                >
                  <Lock size={15} strokeWidth={2.5} />
                  {intl.formatMessage(m.approveAction)}
                </button>
              ) : (
                <div className="w-full px-6 py-3.5 rounded-full text-[13px] font-bold text-zinc-600 bg-ground border border-white/5 text-center">
                  {intl.formatMessage(m.approveGate)}
                </div>
              )}
              <button
                onClick={() => setRejecting(true)}
                className="w-full px-6 py-3 rounded-full text-[13px] font-bold text-zinc-400 hover:text-white border border-white/5 hover:border-white/15 transition-colors"
              >
                {intl.formatMessage(m.rejectAction)}
              </button>
            </>
          )}
          <button
            onClick={onExit}
            className="w-full px-6 py-2 rounded-full text-[12px] font-bold text-zinc-600 hover:text-zinc-400 transition-colors"
          >
            {intl.formatMessage(m.leaveAction)}
          </button>
        </div>
      </div>

      {confirming === 'approve' && (
        <ConfirmStep
          title={intl.formatMessage(m.confirmApproveTitle, {
            supplier: item.supplier,
            amount: currency(item.total),
          })}
          detail={intl.formatMessage(m.confirmApproveDetail, { category: item.category, client: clientName })}
          consequence={intl.formatMessage(m.confirmApproveConsequence)}
          confirmLabel={intl.formatMessage(m.confirmApproveLabel)}
          onConfirm={() => { setConfirming(null); onApprove(note.trim() || undefined); }}
          onCancel={() => setConfirming(null)}
        />
      )}
      {confirming === 'reject' && (
        <ConfirmStep
          tone="red"
          title={intl.formatMessage(m.confirmRejectTitle, { supplier: item.supplier })}
          detail={
            note.trim()
              ? intl.formatMessage(m.confirmRejectDetail, { note: note.trim() })
              : intl.formatMessage(m.confirmRejectDetailNoReason)
          }
          consequence={intl.formatMessage(m.confirmRejectConsequence)}
          confirmLabel={intl.formatMessage(m.confirmRejectLabel)}
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
                {intl.formatMessage(m.closeViewerAction)}
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
  const intl = useIntl();
  return (
    <div className="flex-1 flex flex-col min-w-0 h-full bg-ground overflow-y-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
      <div className="w-full max-w-md mx-auto px-5 py-10 flex flex-col gap-5">
        <div className="flex items-center gap-3">
          <div className="w-11 h-11 rounded-2xl bg-brand flex items-center justify-center text-white shrink-0 shadow-glow-tile">
            <Smartphone size={19} />
          </div>
          <div>
            <h1 className="font-sans font-bold text-xl text-white tracking-tight">{title}</h1>
            <p className="text-[11px] text-zinc-500 font-semibold uppercase tracking-wider">
              {intl.formatMessage(m.shellSubtitle)}
            </p>
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
  const intl = useIntl();
  return (
    <button
      onClick={onClick}
      className="self-start flex items-center gap-2 px-4 py-2 rounded-full text-[13px] font-bold text-zinc-500 hover:text-white transition-colors"
    >
      <ArrowLeft size={14} />
      {intl.formatMessage(m.backLabel)}
    </button>
  );
}
