import { useMemo, useState } from 'react';
import { UploadCloud } from 'lucide-react';
import { defineMessages, useIntl } from 'react-intl';
import type { CreateActionProposalRequest } from '@neoting/contracts/model';
import { useAppContext } from '../../context/AppContext';
import { currency } from '../../lib/resolver';
import { LiveProposalFlow } from './LiveProposalFlow';
import { ReviewSection } from './ReviewGate';
import { Pill } from './DataTable';

const m = defineMessages({
  title: {
    id: 'shell.livePublishCard.title',
    defaultMessage: '{count, plural, one {Release # item for export} other {Release # items for export}}',
  },
  subtitle: {
    id: 'shell.livePublishCard.subtitle',
    defaultMessage: '{client} · every Ready cost with its minimum fields. The review shows the server-computed totals.',
  },
  pickClient: { id: 'shell.livePublishCard.pickClient', defaultMessage: 'Which client is this batch for?' },
  itemsSection: { id: 'shell.livePublishCard.itemsSection', defaultMessage: 'Batch' },
  itemRow: { id: 'shell.livePublishCard.itemRow', defaultMessage: '{supplier} · {category}' },
  nothingReady: {
    id: 'shell.livePublishCard.nothingReady',
    defaultMessage: 'Nothing is Ready to release for this client yet.',
  },
  heldBack: {
    id: 'shell.livePublishCard.heldBack',
    defaultMessage:
      '{count, plural, one {# Ready item is held back} other {# Ready items are held back}} — the publish minimum (Total + Supplier + Category) is not met, and the server refuses half-coded books.',
  },
  draftTotal: { id: 'shell.livePublishCard.draftTotal', defaultMessage: 'Draft gross (display only)' },
  serverNote: {
    id: 'shell.livePublishCard.serverNote',
    defaultMessage: 'Read review renders the item count, gross and VAT the SERVER computed at proposal time — never these draft figures.',
  },
  lockPill: { id: 'shell.livePublishCard.lockPill', defaultMessage: 'Releasing locks and archives each item' },
  stage: { id: 'shell.livePublishCard.stage', defaultMessage: 'Stage for review' },
});

/**
 * "Publish all approved costs" (METH Stage 13, utterance 4) — the
 * batch over REAL documents: every Ready cost for the client that carries the
 * publish minimum client-side. Staging creates a real `publish.batch`
 * proposal; the engine DISCARDS the placeholder preview below and stores its
 * own server-computed one (METH S10), which is exactly what Read review
 * renders — so the figures a human approves are the server's, twice-checked
 * at execution.
 */
export function LivePublishCard({
  businessId,
  businessName,
}: {
  businessId?: string | undefined;
  businessName?: string | undefined;
}) {
  const { documents, businesses } = useAppContext();
  const intl = useIntl();

  const [chosenBusinessId, setChosenBusinessId] = useState<string | null>(businessId ?? null);
  const business = businesses.find((b) => b.id === chosenBusinessId) ?? null;
  const resolvedName = business?.name ?? businessName ?? null;

  const ready = useMemo(
    () => documents.filter((d) => d.clientId === chosenBusinessId && d.status === 'ready' && d.kind === 'cost'),
    [documents, chosenBusinessId],
  );
  // Mirror of the server's publish minimum, as a courtesy pre-filter: an item
  // without it would refuse the WHOLE batch at creation (NT-PUB-001), and the
  // demo's batch should stage clean. The server remains the judge.
  const eligible = ready.filter((d) => d.supplier !== 'Unknown' && d.category !== '—' && d.category.trim() !== '');
  const held = ready.length - eligible.length;
  const draftGross = eligible.reduce((sum, d) => sum + d.total, 0);

  const buildRequest = (): CreateActionProposalRequest => ({
    kind: 'publish.batch',
    businessId: chosenBusinessId,
    payload: {
      documentIds: eligible.map((d) => d.id),
      integrationId: null,
      // The shape requires a preview; the SERVER recomputes and stores its own
      // at creation, and Read review renders that one (METH S10).
      preview: { itemCount: eligible.length, grossPence: 0, vatPence: 0 },
    },
  });

  return (
    <div className="w-full border border-white/5 rounded-[32px] bg-card shadow-2xl overflow-hidden flex flex-col">
      <div className="p-6 flex items-center gap-4 border-b border-white/5">
        <div className="w-12 h-12 rounded-2xl flex items-center justify-center shrink-0 border shadow-inner bg-raised text-white border-white/5">
          <UploadCloud size={20} />
        </div>
        <div className="min-w-0">
          <h3 className="font-sans font-bold text-xl text-white tracking-tight truncate">
            {intl.formatMessage(m.title, { count: eligible.length })}
          </h3>
          <p className="text-[12px] text-zinc-500 mt-1 font-semibold">
            {intl.formatMessage(m.subtitle, { client: resolvedName ?? '…' })}
          </p>
        </div>
      </div>

      <div className="p-6 space-y-6">
        {chosenBusinessId === null && (
          <div className="space-y-2">
            <p className="text-[13px] font-bold text-zinc-400">{intl.formatMessage(m.pickClient)}</p>
            <div className="flex flex-wrap gap-2">
              {businesses.map((b) => (
                <button
                  key={b.id}
                  onClick={() => setChosenBusinessId(b.id)}
                  className="px-4 py-2 rounded-full text-[13px] font-semibold bg-raised text-zinc-300 border border-white/5 hover:border-white/20 transition-colors"
                >
                  {b.name}
                </button>
              ))}
            </div>
          </div>
        )}

        {chosenBusinessId !== null && (
          <>
            <ReviewSection title={intl.formatMessage(m.itemsSection)}>
              {eligible.length === 0 ? (
                <p className="text-[13px] text-zinc-500">{intl.formatMessage(m.nothingReady)}</p>
              ) : (
                <div className="bg-card border border-white/5 rounded-2xl divide-y divide-white/5 shadow-inner max-h-52 overflow-y-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
                  {eligible.map((d) => (
                    <div key={d.id} className="px-4 py-2.5 flex items-center justify-between gap-3 text-[13px]">
                      <span className="text-zinc-400 truncate">
                        {intl.formatMessage(m.itemRow, { supplier: d.supplier, category: d.category })}
                      </span>
                      <span className="text-white font-bold shrink-0 tabular-nums">{currency(d.total, d.currency)}</span>
                    </div>
                  ))}
                </div>
              )}
              {held > 0 && <p className="text-[12px] text-amber-400 mt-2">{intl.formatMessage(m.heldBack, { count: held })}</p>}
              {eligible.length > 0 && (
                <div className="mt-2 flex items-center justify-between text-[13px]">
                  <span className="text-zinc-500">{intl.formatMessage(m.draftTotal)}</span>
                  <span className="text-white font-bold tabular-nums">{currency(draftGross)}</span>
                </div>
              )}
            </ReviewSection>

            <p className="text-[12px] text-zinc-500 leading-relaxed">{intl.formatMessage(m.serverNote)}</p>

            <div className="flex flex-wrap gap-2">
              <Pill>{intl.formatMessage(m.lockPill)}</Pill>
            </div>

            <LiveProposalFlow
              buildRequest={buildRequest}
              clientName={resolvedName}
              stageLabel={intl.formatMessage(m.stage)}
              disabled={eligible.length === 0}
            />
          </>
        )}
      </div>
    </div>
  );
}
