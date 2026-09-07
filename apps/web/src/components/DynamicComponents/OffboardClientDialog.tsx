import { useState } from 'react';
import { AlertTriangle, X } from 'lucide-react';
import { motion } from 'motion/react';
import { defineMessages, useIntl } from 'react-intl';
import { NtProblemError, TRASH_RETENTION_DAYS } from '@neoting/contracts';
import type { OffboardDocumentScope } from '@neoting/contracts/model';
import { holdsReleaseAuthority } from '../../api/auth';
import { useAppContext } from '../../context/AppContext';
import { createProposal } from '../../api/proposals';
import { commonActions } from '../../i18n/common';
import { useEscape } from '../../lib/useEscape';

const m = defineMessages({
  title: { id: 'proposals.offboardDialog.title', defaultMessage: 'Remove {name}?' },
  /**
   * ⚠ Item 24 AND item 66 in one sentence. `business.offboard` became TIER 1
   * (matrix Part 2), so the person who confirms is not necessarily the person
   * who can approve — and the old copy said only "after it is approved", which
   * left a standard user thinking it was a formality. Both branches name the
   * authority now; neither claims one.
   */
  detailYours: {
    id: 'proposals.offboardDialog.detailYours',
    defaultMessage:
      'Removing a client goes through Review → Approve: confirming queues a removal proposal, and {name} disappears from the client list once you have read that review and approved it.',
  },
  detailNotYours: {
    id: 'proposals.offboardDialog.detailNotYours',
    defaultMessage:
      'Removing a client goes through Review → Approve: confirming queues a removal proposal for your practice’s super admin, and {name} stays on the client list until they approve it.',
  },
  retained: {
    id: 'proposals.offboardDialog.retained',
    defaultMessage: 'Documents, books and the audit trail are retained — nothing is deleted.',
  },

  /* ── The deletion scope (review item 67) ────────────────────────────────
     > "while deleting a user ask to select what they want to delete, full
     >  user and data, user only, keep files etc."

     Three options, and every one of them is reversible, because UK
     bookkeeping does not permit a fourth: D12 holds the books six years, D32
     promises reading and exporting survive a lapse, and D43 refuses to purge
     anything an export still links to. The copy therefore never uses the word
     "delete" for any of them, and `markLabel` in particular says MARKED, not
     scheduled — there is no automatic erasure date, by the owner's ruling
     (7 Sep 2026), and a label that implied one would be the product promising
     to break a practice's statutory duty on a timer. */
  scopeLegend: { id: 'proposals.offboardDialog.scopeLegend', defaultMessage: 'What happens to their documents' },
  keepLabel: { id: 'proposals.offboardDialog.keepLabel', defaultMessage: 'Keep everything' },
  keepDetail: {
    id: 'proposals.offboardDialog.keepDetail',
    defaultMessage:
      'The documents stay exactly where they are. They leave your practice-wide queues with the client and come back if you restore them.',
  },
  trashLabel: { id: 'proposals.offboardDialog.trashLabel', defaultMessage: 'Move their documents to Trash' },
  /**
   * ⚠ **"once you restore the client" is not padding** — the 7 Sep 2026
   * walkthrough found it. A removed client's own screens do not render (the
   * board's `clients` array is the ACTIVE listing, and giving
   * `ClientDetailView` a second read to resolve a removed one would put bytes
   * on the tightest route in the product to serve a screen nobody opens), so
   * its Trash is reachable again only after the client is. The earlier wording
   * — "restorable one by one from this client's Trash" — was true about the
   * documents and false about when. Nothing is lost either way: the window runs
   * from the day each document was trashed, and it is stated here.
   */
  trashDetail: {
    id: 'proposals.offboardDialog.trashDetail',
    defaultMessage:
      '{count, plural, =0 {Nothing to move — this client has no documents.} one {# document moves to Trash. Restore the client and each one is restorable from their Trash, for {days} days from today.} other {# documents move to Trash. Restore the client and each one is restorable from their Trash, for {days} days from today.}}',
  },
  markLabel: { id: 'proposals.offboardDialog.markLabel', defaultMessage: 'Mark for erasure' },
  markDetail: {
    id: 'proposals.offboardDialog.markDetail',
    defaultMessage:
      'Records that you want this client’s data erased once the six-year retention duty lapses. Nothing is erased and nothing is scheduled — it is a note on the record.',
  },
  /** The blast radius, stated before the proposal is queued and again at Read review. */
  blastRadius: {
    id: 'proposals.offboardDialog.blastRadius',
    defaultMessage:
      '{count, plural, =0 {This client has no documents.} one {This client has # document.} other {This client has # documents.}}',
  },
  reasonLabel: { id: 'proposals.offboardDialog.reasonLabel', defaultMessage: 'Reason (optional)' },
  reasonPlaceholder: {
    id: 'proposals.offboardDialog.reasonPlaceholder',
    defaultMessage: 'Client moved to another practice',
  },
  confirmAction: { id: 'proposals.offboardDialog.confirmAction', defaultMessage: 'Yes, queue the removal' },
  queuing: { id: 'proposals.offboardDialog.queuing', defaultMessage: 'Queuing…' },
  errorWithCode: { id: 'proposals.offboardDialog.errorWithCode', defaultMessage: '{message} ({code})' },
  requestFailed: { id: 'proposals.offboardDialog.requestFailed', defaultMessage: 'The request failed' },
});

/**
 * The "ask first" a client removal is behind — the ConfirmStep chrome (red
 * tone, Escape cancels, backdrop is presentation) plus the one thing
 * ConfirmStep cannot hold: the optional reason, which travels on the proposal
 * payload and is rendered back at Review. Confirming creates the
 * `business.offboard` proposal and STOPS — review and approval are the
 * Approvals queue's moves, made by a person (the createProposal contract's
 * own rule).
 *
 * Opened from the client's Settings tab (ClientDetailView) — deliberately NOT
 * from the Clients board: "to delete, the accountant firm needs to go to the
 * client and the Settings tab, not the front card" (the user's decision,
 * 31 Aug 2026). Its opener must gate on the businesses slice being live; on
 * seed data there is no server to propose the removal to and nothing mutates
 * a business client-side.
 */
/** The three scopes, in the order the dialog offers them: safest first. */
const SCOPES: readonly OffboardDocumentScope[] = ['keep', 'trash', 'mark-for-erasure'];

export function OffboardClientDialog({ client, documentCount, onQueued, onCancel }: {
  /** A live-board row — the id is the server's own business id, unbridged. */
  client: { id: string; name: string };
  /**
   * How many documents this client holds — the blast radius, stated BEFORE the
   * proposal is queued (review item 67). It comes from the caller's own board
   * counts rather than a query of this dialog's own: the number is already on
   * screen behind the dialog, and a second read that disagreed with it would be
   * worse than no second read. The server states the authoritative figure again
   * at Read review, which is the one that binds.
   */
  documentCount: number;
  /** The proposal was created — nothing has been removed yet. */
  onQueued: () => void;
  onCancel: () => void;
}) {
  const intl = useIntl();
  // D44, items 24 + 66: `business.offboard` is TIER 1 now, so the person
  // confirming is not necessarily the person who can approve. One shared
  // fact (`api/auth.ts`), so this dialog and its siblings agree.
  const { session } = useAppContext();
  const canRelease = holdsReleaseAuthority(session);
  const [reason, setReason] = useState('');
  // `keep` is the default here as it is on the server — the safe scope is what
  // "the accountant said nothing" has to mean on both sides.
  const [scope, setScope] = useState<OffboardDocumentScope>('keep');
  const [queuing, setQueuing] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  // Escape is Cancel — the safe exit, never the confirm (the ConfirmStep rule).
  useEscape(onCancel);

  const queue = async () => {
    if (queuing) return;
    setProblem(null);
    setQueuing(true);
    try {
      const trimmed = reason.trim();
      await createProposal({
        kind: 'business.offboard',
        businessId: client.id,
        // An unanswered optional is an omitted key (the intake rule): an empty
        // reason is nobody asserting anything, not an assertion of ''.
        // `documentScope` always sent, even when it is the default: the reviewer
        // is about to read a card that names a scope, and a card naming one the
        // payload never asserted would be the Review → Approve promise broken
        // at its cheapest point. An unanswered OPTIONAL is omitted (the intake
        // rule); this one is answered, by a radio that is always on something.
        payload: {
          businessId: client.id,
          documentScope: scope,
          ...(trimmed === '' ? {} : { reason: trimmed }),
        },
      });
      onQueued();
    } catch (error) {
      setQueuing(false);
      setProblem(
        error instanceof NtProblemError
          ? intl.formatMessage(m.errorWithCode, { message: error.detail ?? error.title, code: error.code })
          : error instanceof Error
            ? error.message
            : intl.formatMessage(m.requestFailed),
      );
    }
  };

  return (
    // The backdrop is not a button — role="presentation" says so; the keyboard
    // dismissal is Escape above.
    // Centred by the card's auto margins, not items-center: auto margins
    // collapse to zero when the card overflows, so a too-short viewport scrolls
    // the scrim instead of clipping the card at both ends (items 23+40).
    <div
      className="fixed inset-0 z-[60] bg-black/75 backdrop-blur-sm flex justify-center overflow-y-auto p-3 sm:p-6 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      onClick={onCancel}
      role="presentation"
    >
      <motion.div
        initial={{ opacity: 0, y: 12, scale: 0.97 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={intl.formatMessage(m.title, { name: client.name })}
        className="w-full max-w-md my-auto border border-white/10 rounded-[28px] bg-card shadow-2xl overflow-hidden"
      >
        <div className="p-6 flex flex-col gap-4">
          <div className="flex items-start gap-3.5">
            <span className="w-10 h-10 rounded-2xl flex items-center justify-center shrink-0 border bg-red-500/10 border-red-400/25 text-red-400">
              <AlertTriangle size={18} />
            </span>
            <div className="min-w-0">
              <h3 className="font-sans font-bold text-lg text-white tracking-tight leading-snug">
                {intl.formatMessage(m.title, { name: client.name })}
              </h3>
              <p className="text-[13px] text-zinc-400 mt-1.5 leading-relaxed">
                {intl.formatMessage(canRelease ? m.detailYours : m.detailNotYours, { name: client.name })}
              </p>
              <p className="text-[12.5px] text-zinc-500 mt-1.5 leading-relaxed">
                {intl.formatMessage(m.retained)}
              </p>
            </div>
          </div>

          <fieldset className="flex flex-col gap-1.5 pl-[54px]">
            <legend className="text-[11px] font-bold text-zinc-500 uppercase tracking-widest mb-1.5">
              {intl.formatMessage(m.scopeLegend)}
            </legend>
            <p className="text-[12px] text-zinc-500 leading-relaxed mb-1">
              {intl.formatMessage(m.blastRadius, { count: documentCount })}
            </p>
            {SCOPES.map((option) => (
              // Grid rather than a nested wrapper span: `label-has-associated-control`
              // counts JSX depth from the label to its text, and one more level
              // of layout div pushed the copy out of reach of the rule.
              <label
                key={option}
                className="grid grid-cols-[auto_1fr] gap-x-2.5 px-3.5 py-2.5 rounded-2xl border border-white/10 bg-ground has-[:checked]:border-brand/40 has-[:checked]:bg-brand/5 cursor-pointer transition-colors"
              >
                <input
                  type="radio"
                  name="offboard-scope"
                  checked={scope === option}
                  onChange={() => setScope(option)}
                  className="row-span-2 mt-1 accent-brand"
                />
                <span className="text-[13px] font-bold text-white min-w-0">
                  {intl.formatMessage(
                    option === 'keep' ? m.keepLabel : option === 'trash' ? m.trashLabel : m.markLabel,
                  )}
                </span>
                <span className="text-[12px] text-zinc-500 leading-relaxed mt-0.5 min-w-0">
                  {option === 'trash'
                    ? intl.formatMessage(m.trashDetail, { count: documentCount, days: TRASH_RETENTION_DAYS })
                    : intl.formatMessage(option === 'keep' ? m.keepDetail : m.markDetail)}
                </span>
              </label>
            ))}
          </fieldset>

          <label className="flex flex-col gap-1.5 pl-[54px]">
            <span className="text-[11px] font-bold text-zinc-500 uppercase tracking-widest">
              {intl.formatMessage(m.reasonLabel)}
            </span>
            <input
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              // The contract's own cap on the payload field.
              maxLength={500}
              placeholder={intl.formatMessage(m.reasonPlaceholder)}
              className="w-full bg-ground border border-white/10 rounded-2xl px-4 py-2.5 text-sm text-white placeholder:text-zinc-600 focus:outline-none focus:border-brand shadow-inner"
            />
          </label>

          {problem && (
            <p role="alert" className="pl-[54px] text-[12.5px] font-semibold text-red-400 leading-relaxed">
              {problem}
            </p>
          )}
        </div>

        <div className="p-4 bg-raised/50 flex items-center gap-2 sm:gap-3 justify-end flex-wrap [&>button]:flex-1 [&>button]:basis-[8rem] sm:[&>button]:flex-none sm:[&>button]:basis-auto [&>button]:justify-center">
          <button
            onClick={onCancel}
            className="flex items-center gap-2 px-5 py-2.5 rounded-full text-[13px] font-bold text-zinc-400 hover:text-white transition-colors"
          >
            <X size={14} />
            {intl.formatMessage(commonActions.cancel)}
          </button>
          <button
            // A modal owns focus while it is open: landing it on the primary
            // action on open is the dialog pattern, not a focus theft — the
            // rule's concern — and Escape (above) is the guarded way back out.
            // eslint-disable-next-line jsx-a11y/no-autofocus
            autoFocus
            onClick={() => void queue()}
            aria-disabled={queuing}
            className="flex items-center gap-2 px-6 py-2.5 rounded-full text-[13px] font-bold text-white bg-red-500 hover:bg-red-600 transition-colors aria-disabled:opacity-50"
          >
            {intl.formatMessage(queuing ? m.queuing : m.confirmAction)}
          </button>
        </div>
      </motion.div>
    </div>
  );
}
