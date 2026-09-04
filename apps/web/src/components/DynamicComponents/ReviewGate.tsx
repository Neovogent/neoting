import { ReactNode, useState } from 'react';
import { ChevronDown, Check, Edit2, LucideIcon } from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { defineMessages, useIntl } from 'react-intl';
import { useAppContext } from '../../context/AppContext';
import { commonActions } from '../../i18n/common';

const m = defineMessages({
  approve: { id: 'shell.reviewGate.approve', defaultMessage: 'Approve' },
  edit: { id: 'shell.reviewGate.edit', defaultMessage: 'Edit' },
  cancelled: { id: 'shell.reviewGate.cancelled', defaultMessage: 'Cancelled — nothing was changed.' },
  readReview: { id: 'shell.reviewGate.readReview', defaultMessage: 'Read review' },
});

interface ReviewGateProps {
  icon: LucideIcon;
  title: string;
  subtitle: string;
  /** Full detail of exactly what will change — rendered only after Read review. */
  detail: ReactNode;
  approveLabel?: string;
  successMessage: string;
  /** Audit-log description of the action and its scope. */
  auditAction: string;
  auditScope: string;
  onApprove: () => void;
  /**
   * Makes Edit mean something. Without it the button only collapses the
   * panel, which reads as a dead control on a screen whose whole job is to
   * let someone change what is about to be sent.
   */
  onEdit?: () => void;
  /** Label for the edit button, so it can say "Done editing" while open. */
  editLabel?: string;
  accent?: 'blue' | 'red';
}

/**
 * The universal Review -> Approve pattern (PRD section 8).
 *
 * Every state-changing action in the workspace goes through this component.
 * [Approve] is not merely disabled before [Read review] — it is never mounted,
 * so the human has provably opened what they are approving. The approval is
 * written to the audit log with who, when, and whether the review was opened.
 */
export function ReviewGate({
  icon: Icon,
  title,
  subtitle,
  detail,
  approveLabel,
  successMessage,
  auditAction,
  auditScope,
  onApprove,
  onEdit,
  editLabel,
  accent = 'blue',
}: ReviewGateProps) {
  const { logAudit } = useAppContext();
  const intl = useIntl();
  const [isExpanded, setIsExpanded] = useState(false);
  const [isApproved, setIsApproved] = useState(false);
  const [isCancelled, setIsCancelled] = useState(false);

  // The two fallbacks were parameter defaults until #65. A default is evaluated
  // in the parameter scope, before the body runs, so it cannot reach `intl` —
  // they resolve here instead, which renders the same characters either way.
  const approveText = approveLabel ?? intl.formatMessage(m.approve);
  const editText = editLabel ?? intl.formatMessage(m.edit);

  const handleApprove = () => {
    onApprove();
    logAudit({ action: auditAction, scope: auditScope, reviewOpened: true });
    setIsApproved(true);
  };

  if (isApproved) {
    return (
      <motion.div
        initial={{ opacity: 0, scale: 0.97 }}
        animate={{ opacity: 1, scale: 1 }}
        className="w-full max-w-xl border border-brand/30 bg-brand/10 rounded-[24px] p-5 flex items-center gap-4 text-brand"
      >
        <div className="w-10 h-10 rounded-2xl bg-brand/20 flex items-center justify-center shrink-0 border border-brand/30">
          <Check size={20} strokeWidth={3} />
        </div>
        <p className="text-sm font-bold tracking-wide">{successMessage}</p>
      </motion.div>
    );
  }

  if (isCancelled) {
    return (
      <div className="w-full max-w-xl border border-white/5 bg-card rounded-[24px] p-5 flex items-center gap-4 text-zinc-500">
        <p className="text-sm font-bold tracking-wide">{intl.formatMessage(m.cancelled)}</p>
      </div>
    );
  }

  const accentBg = accent === 'red' ? 'bg-red-500/10 text-red-500 border-red-500/20' : 'bg-raised text-white border-white/5';

  return (
    // ⚠ The header's breakpoints are CONTAINER queries, not viewport ones, and
    // that is the whole responsiveness of this card. It renders in places whose
    // width has nothing to do with the window's — a document detail's right-hand
    // column is ~300 px on a 1600 px desktop — and under `sm:` the row layout
    // applied there anyway: the title truncated to "Upd…", the uppercase
    // subtitle wrapped to four lines and [Read review] collided with it. `@md`
    // (28rem) reads the card's own width, so the same card stacks when it is
    // narrow and sits in a row when it is wide, wherever it is mounted.
    <div className="@container w-full max-w-xl border border-white/5 rounded-[32px] bg-card shadow-2xl overflow-hidden flex flex-col">
      {/* Header — scope only. No Approve button exists at this point. */}
      <div className="p-4 @md:p-6 flex flex-col @md:flex-row @md:items-center justify-between gap-3 @md:gap-4 border-b border-white/5">
        <div className="flex items-center gap-3 @md:gap-4 min-w-0">
          <div className={`w-10 h-10 @md:w-12 @md:h-12 rounded-2xl flex items-center justify-center shrink-0 border shadow-inner ${accentBg}`}>
            <Icon size={20} />
          </div>
          <div className="min-w-0">
            {/* Wrapped, never clipped, and both carry their full text as a
                title — the DocumentPreview discipline. */}
            <h3 title={title} className="font-sans font-bold text-lg @md:text-xl text-white tracking-tight break-words">
              {title}
            </h3>
            <p title={subtitle} className="text-[12px] text-zinc-500 mt-1 font-semibold uppercase tracking-wider break-words">
              {subtitle}
            </p>
          </div>
        </div>
        {!isExpanded && (
          <button
            onClick={() => setIsExpanded(true)}
            className="shrink-0 flex items-center justify-center gap-2 px-4 py-2.5 text-sm font-bold text-white bg-brand rounded-full w-full @md:w-auto hover:bg-brand-hover transition-all shadow-glow-btn-soft"
          >
            {intl.formatMessage(m.readReview)}
            <ChevronDown size={16} strokeWidth={2.5} />
          </button>
        )}
      </div>

      <AnimatePresence>
        {isExpanded && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            className="border-b border-white/5 bg-raised/30 overflow-hidden"
          >
            <div className="p-4 @md:p-6 space-y-6">{detail}</div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Approve only mounts once the review has been opened. */}
      {isExpanded && (
        <div className="p-4 bg-card flex justify-end gap-3 flex-wrap">
          <button
            onClick={() => setIsCancelled(true)}
            className="px-5 py-2.5 text-sm font-bold text-zinc-400 hover:text-white hover:bg-white/5 rounded-full transition-colors"
          >
            {intl.formatMessage(commonActions.cancel)}
          </button>
          <button
            onClick={() => (onEdit ? onEdit() : setIsExpanded(false))}
            className="flex items-center gap-2 px-5 py-2.5 text-sm font-bold text-white bg-raised hover:bg-white/10 border border-white/5 rounded-full transition-all shadow-inner"
          >
            <Edit2 size={16} />
            {editText}
          </button>
          <button
            onClick={handleApprove}
            className="flex items-center gap-2 px-6 py-2.5 text-sm font-bold text-white bg-brand hover:bg-brand-hover rounded-full transition-all shadow-glow-btn-strong"
          >
            <Check size={18} strokeWidth={2.5} />
            {approveText}
          </button>
        </div>
      )}
    </div>
  );
}

/** Shared label/value block used inside review detail panels. */
export function ReviewSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div>
      <h4 className="text-[11px] font-bold text-zinc-500 uppercase tracking-widest mb-3">{title}</h4>
      {children}
    </div>
  );
}

export function ReviewRows({ rows }: { rows: { label: string; value: ReactNode }[] }) {
  return (
    <div className="@container bg-card border border-white/5 rounded-2xl p-4 text-sm text-zinc-300 flex flex-col gap-3 shadow-inner">
      {rows.map((r, i) => (
        <div
          key={r.label}
          className={`flex flex-col @sm:flex-row @sm:justify-between @sm:items-center gap-1 @sm:gap-4 ${i < rows.length - 1 ? 'pb-3 border-b border-white/5' : ''}`}
        >
          <span className="text-zinc-500 font-medium shrink-0">{r.label}</span>
          <span className="font-bold text-white @sm:text-right break-words min-w-0">{r.value}</span>
        </div>
      ))}
    </div>
  );
}
