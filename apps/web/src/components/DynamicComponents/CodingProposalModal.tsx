import { useState } from 'react';
import { AlertTriangle } from 'lucide-react';
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
  warningHeading: {
    id: 'documents.codingProposalModal.warningHeading',
    defaultMessage: 'Check this correction before you go on',
  },
  warningNote: {
    id: 'documents.codingProposalModal.warningNote',
    defaultMessage:
      'These checks are advisory — you may be right and they may be wrong. Ignoring proceeds with exactly the value you typed.',
  },
  ignore: { id: 'documents.codingProposalModal.ignore', defaultMessage: 'Ignore — I’m sure' },
  goBack: { id: 'documents.codingProposalModal.goBack', defaultMessage: 'Go back and fix' },
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
 * ## The warning step (5 Sep 2026 — review items 22/46/47)
 *
 * When the deterministic checks fired on this correction
 * (`lib/correctionChecks.ts` — tax exceeding the total, a future document
 * date, figures typed onto a non-financial image), the dialog opens on the
 * WARNING, not the review card, with exactly the two actions Mubashir's ruling
 * names: **[Ignore — I'm sure]** reveals the ordinary Review → Approve card
 * and proceeds with the ORIGINAL typed value (nothing is rewritten), and
 * **[Go back and fix]** returns the value to the field it came from. The
 * checks are advisory — the human always wins ("ai also can make mistake
 * too") — and the same checks are restated server-side on the proposal review,
 * so ignoring here does not erase them from the record.
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
  warnings = [],
  onEdit,
  onClose,
}: {
  document: Document;
  fieldLabel: string;
  currentValue: string;
  nextValue: string;
  fields: UpdateCodingPayload['fields'];
  /** The deterministic checks that fired on this correction — see the header. */
  warnings?: string[];
  /** Take the correction back to the field it came from. */
  onEdit?: () => void;
  onClose: () => void;
}) {
  const intl = useIntl();
  const [ignored, setIgnored] = useState(false);
  const warningStep = warnings.length > 0 && !ignored;

  return (
    <Modal onClose={onClose} width="max-w-xl" label={intl.formatMessage(m.label)}>
      {warningStep ? (
        <div className="p-5 rounded-2xl border border-amber-400/25 bg-amber-400/5">
          <div className="flex items-start gap-3">
            <AlertTriangle size={18} className="shrink-0 mt-0.5 text-amber-400" />
            <div className="min-w-0">
              <h4 className="text-[14px] font-bold text-amber-400">{intl.formatMessage(m.warningHeading)}</h4>
              <ul className="mt-2 flex flex-col gap-2">
                {warnings.map((warning) => (
                  <li key={warning} className="text-[13px] text-zinc-300 leading-relaxed">
                    {/* The check's own sentence, verbatim — the same words the
                        server restates on the proposal review. */}
                    {warning}
                  </li>
                ))}
              </ul>
              <p className="mt-3 text-[12px] text-zinc-500 leading-relaxed">{intl.formatMessage(m.warningNote)}</p>
            </div>
          </div>
          <div className="mt-4 flex items-center justify-end gap-3 flex-wrap">
            <button
              onClick={() => (onEdit ? onEdit() : onClose())}
              className="px-4 py-2 rounded-full text-[13px] font-bold text-white bg-raised hover:bg-white/10 border border-white/5 transition-colors"
            >
              {intl.formatMessage(m.goBack)}
            </button>
            <button
              onClick={() => setIgnored(true)}
              className="px-4 py-2 rounded-full text-[13px] font-bold text-brand-on bg-brand hover:bg-brand-hover transition-colors"
            >
              {intl.formatMessage(m.ignore)}
            </button>
          </div>
        </div>
      ) : (
        <CodingProposalCard
          document={doc}
          fieldLabel={fieldLabel}
          currentValue={currentValue}
          nextValue={nextValue}
          fields={fields}
          warnings={warnings}
          {...(onEdit ? { onEdit } : {})}
        />
      )}
    </Modal>
  );
}
