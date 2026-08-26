import { UploadCloud, AlertTriangle } from 'lucide-react';
import { defineMessages, useIntl } from 'react-intl';
import { useAppContext } from '../../context/AppContext';
import { currency } from '../../lib/resolver';
import { isPublishable, missingMandatory } from '../../lib/selectors';
import { ReviewGate, ReviewRows, ReviewSection } from './ReviewGate';
import { Pill } from './DataTable';

/**
 * Released, never "posted" or "sent" (D42): Published means approved and
 * released for export, and the destination is always the VT import file the
 * accountant downloads — nothing is transmitted anywhere.
 *
 * `heldBack` keeps the bold count and the explanation in one message, joined by
 * a rich text tag, because they are one sentence — splitting at the `</span>`
 * would hand a translator a fragment starting with an em dash.
 *
 * `auditScope` does NOT pluralise. Neither did the string it replaces, and this
 * is an extraction: see the note in the report about "1 items, gross £12.00".
 */
const m = defineMessages({
  nothingReady: {
    id: 'shell.publishCard.nothingReady',
    defaultMessage: 'Nothing ready to release for this scope.',
  },
  previewSection: { id: 'shell.publishCard.previewSection', defaultMessage: 'Release preview' },
  destination: { id: 'shell.publishCard.destination', defaultMessage: 'Destination' },
  destinationValue: { id: 'shell.publishCard.destinationValue', defaultMessage: 'VT Transaction+ import file' },
  items: { id: 'shell.publishCard.items', defaultMessage: 'Items' },
  grossTotal: { id: 'shell.publishCard.grossTotal', defaultMessage: 'Gross total' },
  vatTotal: { id: 'shell.publishCard.vatTotal', defaultMessage: 'VAT total' },
  sends: { id: 'shell.publishCard.sends', defaultMessage: 'Each line carries' },
  sendsValue: {
    id: 'shell.publishCard.sendsValue',
    defaultMessage: 'Extracted data + a link back to the source document',
  },
  itemisedSection: { id: 'shell.publishCard.itemisedSection', defaultMessage: 'Itemised' },
  itemisedRow: { id: 'shell.publishCard.itemisedRow', defaultMessage: '{supplier} · {category}' },
  nothingPasses: { id: 'shell.publishCard.nothingPasses', defaultMessage: 'Nothing passes the checks yet.' },
  heldBack: {
    id: 'shell.publishCard.heldBack',
    defaultMessage:
      '<strong>{count, plural, one {# item held back} other {# items held back}}</strong> — mandatory fields are missing, so they cannot be released:',
  },
  heldRow: { id: 'shell.publishCard.heldRow', defaultMessage: '{supplier} — missing {fields}' },
  heldMore: { id: 'shell.publishCard.heldMore', defaultMessage: '…and {count} more' },
  archivePill: { id: 'shell.publishCard.archivePill', defaultMessage: 'Published items auto-archive' },
  title: {
    id: 'shell.publishCard.title',
    defaultMessage:
      '{count, plural, one {Release # item for export} other {Release # items for export}}',
  },
  subtitle: { id: 'shell.publishCard.subtitle', defaultMessage: 'gross {gross} • VAT {vat}' },
  approveLabel: { id: 'shell.publishCard.approveLabel', defaultMessage: 'Approve & release' },
  successMessage: {
    id: 'shell.publishCard.successMessage',
    defaultMessage:
      '{count, plural, one {# item released for export and archived.} other {# items released for export and archived.}}',
  },
  auditAction: { id: 'shell.publishCard.auditAction', defaultMessage: 'Released for export' },
  auditScope: { id: 'shell.publishCard.auditScope', defaultMessage: '{count} items, gross {gross}' },
});

/**
 * Release preview (PRD stage 10). Counts plus gross/VAT totals are always shown
 * before a bulk release, and items failing mandatory-field configuration are
 * held back rather than failing silently in the export.
 */
export function PublishCard({ clientIds }: { clientIds: string[] }) {
  const { documents, publishDocuments, mandatoryFields } = useAppContext();
  const intl = useIntl();

  const scoped = documents.filter(
    (d) => (clientIds.length ? clientIds.includes(d.clientId) : true) && (d.status === 'ready' || d.status === 'review'),
  );
  // Ready items still failing a mandatory-field check are held back with the rest.
  const publishable = scoped.filter((d) => isPublishable(d, mandatoryFields));
  const held = scoped
    .filter((d) => !isPublishable(d, mandatoryFields))
    .map((d) => ({ ...d, blockedBy: missingMandatory(d, mandatoryFields) }));

  const gross = publishable.reduce((n, d) => n + d.total, 0);
  const vat = publishable.reduce((n, d) => n + d.total * 0.2, 0);

  if (publishable.length === 0 && held.length === 0) {
    return (
      <div className="w-full max-w-xl border border-white/5 rounded-[24px] bg-card p-5 text-sm text-zinc-400">
        {intl.formatMessage(m.nothingReady)}
      </div>
    );
  }

  const detail = (
    <>
      <ReviewSection title={intl.formatMessage(m.previewSection)}>
        <ReviewRows
          rows={[
            { label: intl.formatMessage(m.destination), value: intl.formatMessage(m.destinationValue) },
            { label: intl.formatMessage(m.items), value: `${publishable.length}` },
            { label: intl.formatMessage(m.grossTotal), value: currency(gross) },
            { label: intl.formatMessage(m.vatTotal), value: currency(vat) },
            { label: intl.formatMessage(m.sends), value: intl.formatMessage(m.sendsValue) },
          ]}
        />
      </ReviewSection>

      <ReviewSection title={intl.formatMessage(m.itemisedSection)}>
        <div className="bg-card border border-white/5 rounded-2xl divide-y divide-white/5 shadow-inner max-h-52 overflow-y-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          {publishable.map((d) => (
            <div key={d.id} className="px-4 py-2.5 flex items-center justify-between gap-3 text-[13px]">
              <span className="text-zinc-400 truncate">
                {intl.formatMessage(m.itemisedRow, { supplier: d.supplier, category: d.category })}
              </span>
              <span className="text-white font-bold shrink-0">{currency(d.total)}</span>
            </div>
          ))}
          {publishable.length === 0 && (
            <div className="px-4 py-4 text-[13px] text-zinc-500">{intl.formatMessage(m.nothingPasses)}</div>
          )}
        </div>
      </ReviewSection>

      {held.length > 0 && (
        <div className="flex items-start gap-3 bg-amber-500/10 border border-amber-500/20 rounded-2xl p-4">
          <AlertTriangle size={18} className="text-amber-400 shrink-0 mt-0.5" />
          <div className="text-[13px] text-amber-200/90 leading-relaxed">
            {intl.formatMessage(m.heldBack, {
              count: held.length,
              strong: (chunks) => <span className="font-bold text-amber-400">{chunks}</span>,
            })}
            <div className="mt-2 flex flex-col gap-1">
              {held.slice(0, 8).map((d) => (
                <span key={d.id} className="text-amber-200/70">
                  {intl.formatMessage(m.heldRow, { supplier: d.supplier, fields: d.blockedBy.join(', ') })}
                </span>
              ))}
              {held.length > 8 && (
                <span className="text-amber-200/50">{intl.formatMessage(m.heldMore, { count: held.length - 8 })}</span>
              )}
            </div>
          </div>
        </div>
      )}

      <div className="flex flex-wrap gap-2">
        <Pill>{intl.formatMessage(m.archivePill)}</Pill>
      </div>
    </>
  );

  return (
    <ReviewGate
      icon={UploadCloud}
      title={intl.formatMessage(m.title, { count: publishable.length })}
      subtitle={intl.formatMessage(m.subtitle, { gross: currency(gross), vat: currency(vat) })}
      detail={detail}
      approveLabel={intl.formatMessage(m.approveLabel)}
      successMessage={intl.formatMessage(m.successMessage, { count: publishable.length })}
      auditAction={intl.formatMessage(m.auditAction)}
      auditScope={intl.formatMessage(m.auditScope, { count: publishable.length, gross: currency(gross) })}
      onApprove={() => publishDocuments(publishable.map((d) => d.id))}
    />
  );
}
