import { UploadCloud, AlertTriangle } from 'lucide-react';
import { useAppContext } from '../../context/AppContext';
import { currency } from '../../lib/resolver';
import { isPublishable, missingMandatory } from '../../lib/selectors';
import { ReviewGate, ReviewRows, ReviewSection } from './ReviewGate';
import { Pill } from './DataTable';

/**
 * Publish preview (PRD stage 10). Counts plus gross/VAT totals are always shown
 * before a bulk push, and items failing mandatory-field configuration are held
 * back rather than failing silently at the destination.
 */
export function PublishCard({ clientIds }: { clientIds: string[] }) {
  const { documents, clients, publishDocuments, mandatoryFields } = useAppContext();

  const scoped = documents.filter(
    (d) => (clientIds.length ? clientIds.includes(d.clientId) : true) && (d.status === 'ready' || d.status === 'review'),
  );
  // Ready items still failing a mandatory-field check are held back with the rest.
  const publishable = scoped.filter((d) => isPublishable(d, mandatoryFields));
  const held = scoped
    .filter((d) => !isPublishable(d, mandatoryFields))
    .map((d) => ({ ...d, blockedBy: missingMandatory(d, mandatoryFields) }));

  const destination = clients.find((c) => clientIds.includes(c.id))?.xeroConnected ? 'Xero' : 'QuickBooks Online';
  const gross = publishable.reduce((n, d) => n + d.total, 0);
  const vat = publishable.reduce((n, d) => n + d.total * 0.2, 0);

  if (publishable.length === 0 && held.length === 0) {
    return (
      <div className="w-full max-w-xl border border-white/5 rounded-[24px] bg-[#16161a] p-5 text-sm text-zinc-400">
        Nothing ready to publish for this scope.
      </div>
    );
  }

  const detail = (
    <>
      <ReviewSection title="Publish preview">
        <ReviewRows
          rows={[
            { label: 'Destination', value: destination },
            { label: 'Items', value: `${publishable.length}` },
            { label: 'Gross total', value: currency(gross) },
            { label: 'VAT total', value: currency(vat) },
            { label: 'Sends', value: 'Extracted data + the original document image' },
          ]}
        />
      </ReviewSection>

      <ReviewSection title="Itemised">
        <div className="bg-[#16161a] border border-white/5 rounded-2xl divide-y divide-white/5 shadow-inner max-h-52 overflow-y-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          {publishable.map((d) => (
            <div key={d.id} className="px-4 py-2.5 flex items-center justify-between gap-3 text-[13px]">
              <span className="text-zinc-400 truncate">
                {d.supplier} · {d.category}
              </span>
              <span className="text-white font-bold shrink-0">{currency(d.total)}</span>
            </div>
          ))}
          {publishable.length === 0 && <div className="px-4 py-4 text-[13px] text-zinc-500">Nothing passes the checks yet.</div>}
        </div>
      </ReviewSection>

      {held.length > 0 && (
        <div className="flex items-start gap-3 bg-amber-500/10 border border-amber-500/20 rounded-2xl p-4">
          <AlertTriangle size={18} className="text-amber-400 shrink-0 mt-0.5" />
          <div className="text-[13px] text-amber-200/90 leading-relaxed">
            <span className="font-bold text-amber-400">
              {held.length} item{held.length === 1 ? '' : 's'} held back
            </span>{' '}
            — mandatory fields are missing, so they cannot publish:
            <div className="mt-2 flex flex-col gap-1">
              {held.slice(0, 8).map((d) => (
                <span key={d.id} className="text-amber-200/70">
                  {d.supplier} — missing {d.blockedBy.join(', ')}
                </span>
              ))}
              {held.length > 8 && <span className="text-amber-200/50">…and {held.length - 8} more</span>}
            </div>
          </div>
        </div>
      )}

      <div className="flex flex-wrap gap-2">
        <Pill tone="blue">Approvals override auto-publish</Pill>
        <Pill>Published items auto-archive</Pill>
      </div>
    </>
  );

  return (
    <ReviewGate
      icon={UploadCloud}
      title={`Publish ${publishable.length} item${publishable.length === 1 ? '' : 's'} to ${destination}`}
      subtitle={`gross ${currency(gross)} • VAT ${currency(vat)}`}
      detail={detail}
      approveLabel="Approve & publish"
      successMessage={`${publishable.length} item${publishable.length === 1 ? '' : 's'} published to ${destination} and archived.`}
      auditAction={`Published to ${destination}`}
      auditScope={`${publishable.length} items, gross ${currency(gross)}`}
      onApprove={() => publishDocuments(publishable.map((d) => d.id))}
    />
  );
}
