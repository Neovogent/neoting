import { ReactNode, useState } from 'react';
import { ChevronDown, Check, Edit2, LucideIcon } from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { useAppContext } from '../../context/AppContext';

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
  approveLabel = 'Approve',
  successMessage,
  auditAction,
  auditScope,
  onApprove,
  onEdit,
  editLabel = 'Edit',
  accent = 'blue',
}: ReviewGateProps) {
  const { logAudit } = useAppContext();
  const [isExpanded, setIsExpanded] = useState(false);
  const [isApproved, setIsApproved] = useState(false);
  const [isCancelled, setIsCancelled] = useState(false);

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
        <p className="text-sm font-bold tracking-wide">Cancelled — nothing was changed.</p>
      </div>
    );
  }

  const accentBg = accent === 'red' ? 'bg-red-500/10 text-red-500 border-red-500/20' : 'bg-raised text-white border-white/5';

  return (
    <div className="w-full max-w-xl border border-white/5 rounded-[32px] bg-card shadow-2xl overflow-hidden flex flex-col">
      {/* Header — scope only. No Approve button exists at this point. */}
      <div className="p-6 flex items-center justify-between gap-4 border-b border-white/5">
        <div className="flex items-center gap-4 min-w-0">
          <div className={`w-12 h-12 rounded-2xl flex items-center justify-center shrink-0 border shadow-inner ${accentBg}`}>
            <Icon size={20} />
          </div>
          <div className="min-w-0">
            <h3 className="font-sans font-bold text-xl text-white tracking-tight truncate">{title}</h3>
            <p className="text-[12px] text-zinc-500 mt-1 font-semibold uppercase tracking-wider">{subtitle}</p>
          </div>
        </div>
        {!isExpanded && (
          <button
            onClick={() => setIsExpanded(true)}
            className="shrink-0 flex items-center gap-2 px-4 py-2.5 text-sm font-bold text-white bg-brand rounded-full hover:bg-brand-hover transition-all shadow-[0_0_15px_rgba(20,227,196,0.2)]"
          >
            Read review
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
            <div className="p-6 space-y-6">{detail}</div>
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
            Cancel
          </button>
          <button
            onClick={() => (onEdit ? onEdit() : setIsExpanded(false))}
            className="flex items-center gap-2 px-5 py-2.5 text-sm font-bold text-white bg-raised hover:bg-white/10 border border-white/5 rounded-full transition-all shadow-inner"
          >
            <Edit2 size={16} />
            {editLabel}
          </button>
          <button
            onClick={handleApprove}
            className="flex items-center gap-2 px-6 py-2.5 text-sm font-bold text-white bg-brand hover:bg-brand-hover rounded-full transition-all shadow-[0_0_15px_rgba(20,227,196,0.3)]"
          >
            <Check size={18} strokeWidth={2.5} />
            {approveLabel}
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
    <div className="bg-card border border-white/5 rounded-2xl p-4 text-sm text-zinc-300 flex flex-col gap-3 shadow-inner">
      {rows.map((r, i) => (
        <div
          key={r.label}
          className={`flex justify-between items-center gap-4 ${i < rows.length - 1 ? 'pb-3 border-b border-white/5' : ''}`}
        >
          <span className="text-zinc-500 font-medium shrink-0">{r.label}</span>
          <span className="font-bold text-white text-right">{r.value}</span>
        </div>
      ))}
    </div>
  );
}
