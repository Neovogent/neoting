import { PencilLine } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import { defineMessages, useIntl } from 'react-intl';
import type { UpdateCodingPayload } from '@neoting/contracts/model';
import { useAppContext } from '../../context/AppContext';
import { refreshDocument, updateCodingProposal } from '../../api/document-detail';
import { ReviewGate, ReviewRows, ReviewSection } from './ReviewGate';
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
      'Approving files this as a correction: the value becomes human-confirmed, the original stays immutable, and the server refuses an approval whose review was never opened.',
  },
  approve: { id: 'documents.codingProposal.approve', defaultMessage: 'Approve change' },
  success: {
    id: 'documents.codingProposal.success',
    defaultMessage: 'Correction approved — {field} is now human-confirmed.',
  },
  auditAction: { id: 'documents.codingProposal.auditAction', defaultMessage: 'Corrected document coding' },
  auditScope: { id: 'documents.codingProposal.auditScope', defaultMessage: '{supplier} · {field}: {from} → {to}' },
  failedAudit: { id: 'documents.codingProposal.failedAudit', defaultMessage: 'Coding correction was refused' },
  supplierUnread: { id: 'documents.codingProposal.supplierUnread', defaultMessage: 'No supplier read' },
  customerUnread: { id: 'documents.codingProposal.customerUnread', defaultMessage: 'No customer read' },
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
 * `document.update-coding` proposal — created, reviewed, approved — through
 * the same `ReviewGate` every state change in the workspace uses, so Approve
 * cannot mount before Read review here either.
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
  fields,
  onEdit,
}: {
  document: Document;
  fieldLabel: string;
  currentValue: string;
  nextValue: string;
  fields: UpdateCodingPayload['fields'];
  /**
   * Makes [Edit] mean something: the host takes the correction back to the
   * field it came from. Without it the button only collapses the review, which
   * reads as a dead control (see `ReviewGate`).
   */
  onEdit?: () => void;
}) {
  const intl = useIntl();
  const { updateDocumentField, logAudit } = useAppContext();
  const queryClient = useQueryClient();

  // One substitution point, so the subtitle and the audit line can never
  // disagree about which document was corrected.
  const party = UNREAD_PARTY.has(doc.supplier.trim())
    ? intl.formatMessage(doc.kind === 'sales' ? m.customerUnread : m.supplierUnread)
    : doc.supplier;

  const approve = () => {
    // Optimistic: every surface deriving from the documents array agrees at
    // once. The refetch below re-asserts server truth either way.
    updateDocumentField(doc.id, fieldLabel, nextValue);
    void updateCodingProposal({ businessId: doc.clientId, documentId: doc.id, fields })
      .catch((error: unknown) => {
        logAudit({
          action: intl.formatMessage(m.failedAudit),
          scope: `${fieldLabel} — ${error instanceof Error ? error.message : 'unknown error'}`,
          reviewOpened: true,
        });
      })
      .finally(() => {
        void refreshDocument(queryClient, doc.id);
      });
  };

  return (
    <ReviewGate
      icon={PencilLine}
      title={intl.formatMessage(m.title)}
      subtitle={intl.formatMessage(m.subtitle, { supplier: party, field: fieldLabel })}
      detail={
        <ReviewSection title={intl.formatMessage(m.changeHeading)}>
          <ReviewRows
            rows={[
              { label: intl.formatMessage(m.rowField), value: fieldLabel },
              { label: intl.formatMessage(m.rowCurrent), value: currentValue },
              { label: intl.formatMessage(m.rowNew), value: nextValue },
            ]}
          />
          <p className="mt-3 text-[12px] text-zinc-500 leading-relaxed">{intl.formatMessage(m.enforcement)}</p>
        </ReviewSection>
      }
      approveLabel={intl.formatMessage(m.approve)}
      successMessage={intl.formatMessage(m.success, { field: fieldLabel })}
      auditAction={intl.formatMessage(m.auditAction)}
      auditScope={intl.formatMessage(m.auditScope, { supplier: party, field: fieldLabel, from: currentValue, to: nextValue })}
      onApprove={approve}
      {...(onEdit ? { onEdit } : {})}
    />
  );
}
