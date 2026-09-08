import { useEffect, useRef, useState } from 'react';
import { AlertTriangle, Check } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import { defineMessages, useIntl } from 'react-intl';
import type { UpdateCodingPayload } from '@neoting/contracts/model';
import { useAppContext } from '../../context/AppContext';
import { refreshDocument, updateCodingProposal } from '../../api/document-detail';
import type { Document } from '../../lib/types';

const m = defineMessages({
  title: { id: 'documents.codingProposal.title', defaultMessage: 'Update coding' },
  subtitle: { id: 'documents.codingProposal.subtitle', defaultMessage: '{supplier} · {field}' },
  changeHeading: { id: 'documents.codingProposal.changeHeading', defaultMessage: 'What will change' },
  rowField: { id: 'documents.codingProposal.rowField', defaultMessage: 'Field' },
  rowCurrent: { id: 'documents.codingProposal.rowCurrent', defaultMessage: 'Current value' },
  rowNew: { id: 'documents.codingProposal.rowNew', defaultMessage: 'New value' },
  enforcement: {
    id: 'documents.codingProposal.enforcement',
    defaultMessage:
      'Filed as a correction: the value is human-confirmed, the original stays immutable, and the change is recorded against your name.',
  },
  applying: { id: 'documents.codingProposal.applying', defaultMessage: 'Applying {field}…' },
  success: {
    id: 'documents.codingProposal.success',
    defaultMessage: '{field} is now {value} — human-confirmed.',
  },
  auditAction: { id: 'documents.codingProposal.auditAction', defaultMessage: 'Corrected document coding' },
  auditScope: { id: 'documents.codingProposal.auditScope', defaultMessage: '{supplier} · {field}: {from} → {to}' },
  failedAudit: { id: 'documents.codingProposal.failedAudit', defaultMessage: 'Coding correction was refused' },
  supplierUnread: { id: 'documents.codingProposal.supplierUnread', defaultMessage: 'No supplier read' },
  customerUnread: { id: 'documents.codingProposal.customerUnread', defaultMessage: 'No customer read' },
  /**
   * 2 Sep 2026: the refusal used to go ONLY to the audit log, while the gate's
   * own banner said "Correction approved" — a green lie over a write that
   * never happened. The failure is on the card now, in front of the person
   * who has to act on it.
   */
  failedOnCard: {
    id: 'documents.codingProposal.failedOnCard',
    defaultMessage: 'That correction was NOT saved — {reason}. The value on the document is unchanged. Try again, and tell us if it keeps happening.',
  },
});

/**
 * ⚠ `Unknown` IS NOT A SUPPLIER. It is the placeholder `toLocalDocument`
 * (`api/documents.ts`) mints for a row whose `supplierName` — or
 * `customerName`, on the sales inbox — extraction has not answered:
 * `?? 'Unknown'`. Uppercased by the review header's own `uppercase` class it
 * arrived in this dialog as the shout **UNKNOWN · TYPE**, which states nothing
 * about the document and reads as the dialog having failed to load. It is also
 * a bare English literal no catalogue can translate.
 *
 * The comparison lives here rather than at the placeholder's source because
 * `toLocalDocument` feeds every list, card and table in the app; changing what
 * it mints is a far wider change than a dialog's subtitle, and the row itself
 * is not wrong — a document really does have no supplier yet.
 */
const UNREAD_PARTY = new Set(['', '—', 'Unknown']);

/**
 * The edit-a-field flow, live (METH S7): a typed correction becomes a real
 * `document.update-coding` proposal — created, reviewed, approved — driven in
 * that order behind the one click that opened this card. Since 9 Sep 2026 the
 * kind is tier 2, so there is no second signature to wait for and no gate.
 *
 * The S11 pattern: the local update is optimistic (the click feels instant),
 * the refetch afterwards replaces it with server truth, so a refusal corrects
 * the screen rather than leaving a value only this browser believes in.
 *
 * Presented by `CodingProposalModal`, which is what `DocumentPreview`
 * lazy-loads — this card and its proposal wiring are needed only at the moment
 * of a correction, and the document screens' chunks are measured against the
 * route budget. The card itself is frame-agnostic: it draws no scrim and owns
 * no Escape listener, so it renders identically inline or in the dialog.
 */
export default function CodingProposalCard({
  document: doc,
  fieldLabel,
  currentValue,
  nextValue,
  nextValueLabel,
  fields,
  warnings = [],
  onSettled,
}: {
  document: Document;
  fieldLabel: string;
  currentValue: string;
  nextValue: string;
  /** What to SHOW for the new value, when the value itself is a code. */
  nextValueLabel?: string | undefined;
  fields: UpdateCodingPayload['fields'];
  /** The deterministic checks that fired on this correction, restated here so
      the person who chose Ignore can still see what they overrode. */
  warnings?: string[];
  /**
   * Checks the person already chose to IGNORE in the warning step
   * (`CodingProposalModal`). Restated on the review itself so the last thing
   * read before Approve still carries them — the server puts the same checks
   * on the proposal's own review render.
   */
  /**
   * Makes [Edit] mean something: the host takes the correction back to the
   * field it came from. Without it the button only collapses the review, which
   * reads as a dead control (see `ReviewGate`).
   */
  /**
   * Fired when the proposal call SETTLED SUCCESSFULLY — review item 20.
   *
   * ⚠ **Not when Approve was pressed.** `ReviewGate` shows its confirmation
   * optimistically on the click, and the server answers a moment later; a
   * refusal swaps this card to its red `failedOnCard` alert. So a host that
   * dismissed on the click would throw away the one screen telling somebody
   * their correction was refused. This fires only on the success path, which
   * is why it is here and not in `ReviewGate`.
   */
  onSettled?: () => void;
}) {
  const intl = useIntl();
  const { updateDocumentField, logAudit } = useAppContext();
  const queryClient = useQueryClient();
  const [refused, setRefused] = useState<string | null>(null);
  const [applied, setApplied] = useState(false);
  /**
   * ⚠ **Applied on mount, and that is the whole change of 9 Sep 2026.**
   *
   * > *"No approval will be required for anything, except for when the document
   * > is going for publishing."* — the owner, third time of asking.
   *
   * `document.update-coding` left the release tier with that ruling, so there
   * is no second signature left to collect and a Read review → Approve dialog
   * here would be asking the same person to agree with themselves. The three
   * server calls still happen in order behind this one click — created,
   * reviewed with its hash recorded, approved echoing that hash — exactly as
   * `sendChaseNow` does since the same ruling was made for chases. What is gone
   * is the WAIT, not the record.
   *
   * The ref makes it fire at most once: this card is remounted by the modal's
   * warning step, and a correction applied twice is a second proposal.
   */
  const fired = useRef(false);

  // One substitution point, so the subtitle and the audit line can never
  // disagree about which document was corrected.
  const party = UNREAD_PARTY.has(doc.supplier.trim())
    ? intl.formatMessage(doc.kind === 'sales' ? m.customerUnread : m.supplierUnread)
    : doc.supplier;

  const apply = () => {
    setRefused(null);
    // Optimistic: the correction applies on this click now, so painting it is
    // telling the truth. The refetch below still replaces it with server truth,
    // which is what corrects the screen if the server refuses.
    updateDocumentField(doc.id, fieldLabel, nextValue);
    void updateCodingProposal({ businessId: doc.clientId, documentId: doc.id, fields }, { canRelease: true })
      .then(() => {
        // ReviewGate used to write this line on the approve it no longer shows.
        // The record is the half the owner did NOT ask to lose.
        logAudit({
          action: intl.formatMessage(m.auditAction),
          scope: intl.formatMessage(m.auditScope, { supplier: party, field: fieldLabel, from: currentValue, to: nextValue }),
          reviewOpened: true,
        });
        setApplied(true);
        onSettled?.();
      })
      .catch((error: unknown) => {
        const reason = error instanceof Error ? error.message : 'unknown error';
        // On the CARD as well as in the audit log — the gate has already shown
        // its success banner by now, and a refusal only a log can see reads as
        // a save that quietly did nothing (2 Sep 2026, the Groceries bug).
        setRefused(reason);
        logAudit({
          action: intl.formatMessage(m.failedAudit),
          scope: `${fieldLabel} — ${reason}`,
          reviewOpened: true,
        });
      })
      .finally(() => {
        void refreshDocument(queryClient, doc.id);
      });
  };

  useEffect(() => {
    if (fired.current) return;
    fired.current = true;
    apply();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (refused !== null) {
    return (
      <div role="alert" className="p-4 rounded-2xl border border-red-500/20 bg-red-500/5">
        <p className="flex items-start gap-2 text-[13px] font-semibold text-red-400 leading-relaxed">
          <AlertTriangle size={15} className="shrink-0 mt-0.5" />
          {intl.formatMessage(m.failedOnCard, { reason: refused })}
        </p>
      </div>
    );
  }

  return (
    <div className="p-4 rounded-2xl border border-white/5 bg-card">
      {/* Which document and which field — the line the review subtitle used to
          carry. It is the only thing on this card that says WHAT was corrected,
          and the "No supplier read" work exists because it has to stay true
          when the supplier was never read. */}
      <h4 className="text-[14px] font-bold text-white" title={intl.formatMessage(m.title)}>
        {intl.formatMessage(m.title)}
      </h4>
      <p
        className="text-[12px] font-semibold text-zinc-400 mb-2 mt-0.5"
        title={intl.formatMessage(m.subtitle, { supplier: party, field: fieldLabel })}
      >
        {intl.formatMessage(m.subtitle, { supplier: party, field: fieldLabel })}
      </p>
      <p className="flex items-start gap-2 text-[13px] font-semibold text-brand leading-relaxed">
        <Check size={15} className="shrink-0 mt-0.5" />
        {intl.formatMessage(applied ? m.success : m.applying, { field: fieldLabel, value: nextValueLabel ?? nextValue })}
      </p>
      {warnings.length > 0 && (
        <div role="alert" className="mt-3 rounded-xl border border-amber-400/25 bg-amber-400/5 p-3">
          {warnings.map((warning) => (
            <p key={warning} className="flex items-start gap-2 text-[12px] text-amber-400 leading-relaxed">
              <AlertTriangle size={13} className="shrink-0 mt-0.5" />
              {warning}
            </p>
          ))}
        </div>
      )}
      <p className="mt-2 text-[12px] text-zinc-500 leading-relaxed">
        {intl.formatMessage(m.enforcement)}
      </p>
    </div>
  );
}
