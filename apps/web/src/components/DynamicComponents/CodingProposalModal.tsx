import { defineMessages, useIntl } from 'react-intl';
import type { UpdateCodingPayload } from '@neoting/contracts/model';
import CodingProposalCard from './CodingProposalCard';
import { Modal } from './Modal';
import type { Document } from '../../lib/types';

const m = defineMessages({
  label: {
    id: 'documents.codingProposalModal.label',
    defaultMessage: 'Review the correction before approving it',
  },
});

/**
 * The staged correction in the one dialog frame — `ProposalFlowModal`'s shape,
 * for the flow that stages a `document.update-coding` correction.
 *
 * WHY A DIALOG. The card used to render in the document detail's right-hand
 * column, under the extracted fields and the amber Path-to-Ready panel. That
 * column is ~300 px wherever the detail is a side panel, so the review card was
 * squeezed into a strip: its title clipped to "Upd…", the supplier · field
 * subtitle wrapped to four lines and [Read review] landed on top of it. The
 * decision to correct a value deserves the whole surface, so it gets the whole
 * surface. `Modal` supplies the scrim, the close button, Escape through the
 * `useEscape` STACK and the placement — a bottom sheet on a phone, a floating
 * card from 640 up. Render it inside an `AnimatePresence` or the exit does not
 * play.
 *
 * ⚠ THIS IS A PRESENTATION CHANGE AND NOTHING ELSE. Review → Approve is
 * untouched: [Approve] is still never mounted before [Read review] has been
 * opened inside `ReviewGate`, and approving still runs the same three calls
 * (create → review → approve echoing `renderedSummaryHash`) through
 * `updateCodingProposal`. The gate is enforced server-side and again by a
 * database trigger; the dialog is a frame around it, never a shortcut past it.
 *
 * ⚠ NOTHING IS CREATED ON MOUNT — unlike `ProposalFlowModal`, which creates its
 * proposal in an effect, the correction's proposal is minted by the Approve
 * click and by nothing else. So closing this dialog undecided leaves no record
 * at all: no proposal to cancel, nothing in the Approvals queue, and the typed
 * value is simply not applied. Opening it again re-stages from the field.
 */
export default function CodingProposalModal({
  document: doc,
  fieldLabel,
  currentValue,
  nextValue,
  fields,
  onEdit,
  onClose,
}: {
  document: Document;
  fieldLabel: string;
  currentValue: string;
  nextValue: string;
  fields: UpdateCodingPayload['fields'];
  /** Take the correction back to the field it came from. */
  onEdit?: () => void;
  onClose: () => void;
}) {
  const intl = useIntl();

  return (
    <Modal onClose={onClose} width="max-w-xl" label={intl.formatMessage(m.label)}>
      <CodingProposalCard
        document={doc}
        fieldLabel={fieldLabel}
        currentValue={currentValue}
        nextValue={nextValue}
        fields={fields}
        {...(onEdit ? { onEdit } : {})}
      />
    </Modal>
  );
}
