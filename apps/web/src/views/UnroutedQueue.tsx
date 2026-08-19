import { useState } from 'react';
import { Inbox as InboxIcon, Send } from 'lucide-react';
import { AnimatePresence } from 'motion/react';
import { defineMessages, useIntl } from 'react-intl';
import type { CreateActionProposalRequest, Inbox as ApiInbox } from '@neoting/contracts/model';
import { useAppContext } from '../context/AppContext';
import { ProposalFlowModal } from '../components/DynamicComponents/ProposalFlowModal';
import type { Document } from '../lib/types';

const m = defineMessages({
  heading: { id: 'inboxes.unroutedQueue.heading', defaultMessage: 'Unrouted — {count}' },
  explainer: {
    id: 'inboxes.unroutedQueue.explainer',
    defaultMessage:
      'Arrived from a sender routing does not recognise, so no client owns them yet. Assigning one is a state change — it goes through Review → Approve like everything else.',
  },
  inboxCosts: { id: 'inboxes.unroutedQueue.inboxCosts', defaultMessage: 'Costs' },
  inboxSales: { id: 'inboxes.unroutedQueue.inboxSales', defaultMessage: 'Sales' },
  clientLabel: { id: 'inboxes.unroutedQueue.clientLabel', defaultMessage: 'Route to client' },
  inboxLabel: { id: 'inboxes.unroutedQueue.inboxLabel', defaultMessage: 'Inbox' },
  routeAction: { id: 'inboxes.unroutedQueue.routeAction', defaultMessage: 'Route' },
});

/**
 * The Unrouted queue (METH Stage 12): documents the router could not place —
 * `inbox=UNROUTED` on the wire, which this app sees as the contract's empty
 * `businessId` (`''`, the projection's documented placeholder for "no
 * business yet"). One-click assign opens a real `document.route` proposal;
 * the executor lands it in the chosen client's inbox and the documents poll
 * shows it moving.
 */
export function UnroutedQueue({ documents, onRouted }: { documents: Document[]; onRouted: () => void }) {
  const intl = useIntl();
  const { clients, serverClientIdFor } = useAppContext();
  const [choices, setChoices] = useState<Record<string, { clientId: string; inbox: ApiInbox }>>({});
  /** Held in state so the modal's request is referentially stable. */
  const [routing, setRouting] = useState<{ request: CreateActionProposalRequest; clientName: string } | null>(null);

  const choiceFor = (docId: string) => choices[docId] ?? { clientId: clients[0]?.id ?? '', inbox: 'COSTS' as ApiInbox };

  const openRoute = (doc: Document) => {
    const choice = choiceFor(doc.id);
    const client = clients.find((c) => c.id === choice.clientId);
    if (!client) return;
    setRouting({
      request: {
        kind: 'document.route',
        businessId: null,
        payload: {
          documentId: doc.id,
          inbox: choice.inbox,
          toBusinessId: serverClientIdFor(client.id),
        },
      },
      clientName: client.name,
    });
  };

  return (
    <div className="w-full mb-4 rounded-[28px] bg-card border border-amber-500/20 shadow-2xl overflow-hidden">
      <div className="px-6 pt-5 pb-4 flex items-start gap-3 border-b border-white/5">
        <div className="w-9 h-9 rounded-xl bg-amber-500/10 border border-amber-500/20 flex items-center justify-center text-amber-400 shrink-0">
          <InboxIcon size={16} />
        </div>
        <div className="min-w-0">
          <h3 className="font-sans font-bold text-lg text-white tracking-tight">
            {intl.formatMessage(m.heading, { count: documents.length })}
          </h3>
          <p className="text-[12px] text-zinc-500 mt-0.5">{intl.formatMessage(m.explainer)}</p>
        </div>
      </div>

      <div className="divide-y divide-white/5">
        {documents.map((doc) => {
          const choice = choiceFor(doc.id);
          return (
            <div key={doc.id} className="px-6 py-4 flex items-center justify-between gap-4 flex-wrap">
              <div className="min-w-0">
                <div className="text-sm font-bold text-white truncate">{doc.supplier}</div>
                <div className="text-[12px] text-zinc-500">{doc.date} · {doc.source} · {doc.uploader}</div>
              </div>
              <div className="flex items-center gap-2 flex-wrap">
                <label className="flex items-center gap-2 text-[11px] font-bold text-zinc-500 uppercase tracking-wider">
                  {intl.formatMessage(m.clientLabel)}
                  <select
                    value={choice.clientId}
                    onChange={(e) => setChoices((prev) => ({ ...prev, [doc.id]: { ...choice, clientId: e.target.value } }))}
                    className="bg-ground border border-white/5 rounded-xl px-3 py-2 text-[13px] font-semibold text-white focus:outline-none focus:border-brand"
                  >
                    {clients.map((c) => (
                      <option key={c.id} value={c.id} className="bg-card">{c.name}</option>
                    ))}
                  </select>
                </label>
                <label className="flex items-center gap-2 text-[11px] font-bold text-zinc-500 uppercase tracking-wider">
                  {intl.formatMessage(m.inboxLabel)}
                  <select
                    value={choice.inbox}
                    onChange={(e) => setChoices((prev) => ({ ...prev, [doc.id]: { ...choice, inbox: e.target.value as ApiInbox } }))}
                    className="bg-ground border border-white/5 rounded-xl px-3 py-2 text-[13px] font-semibold text-white focus:outline-none focus:border-brand"
                  >
                    <option value="COSTS" className="bg-card">{intl.formatMessage(m.inboxCosts)}</option>
                    <option value="SALES" className="bg-card">{intl.formatMessage(m.inboxSales)}</option>
                  </select>
                </label>
                <button
                  onClick={() => openRoute(doc)}
                  className="flex items-center gap-2 px-5 py-2 rounded-full text-[12px] font-bold text-white bg-brand hover:bg-brand-hover transition-colors"
                >
                  <Send size={13} />
                  {intl.formatMessage(m.routeAction)}
                </button>
              </div>
            </div>
          );
        })}
      </div>

      <AnimatePresence>
        {routing && (
          <ProposalFlowModal
            request={routing.request}
            clientName={routing.clientName}
            onExecuted={onRouted}
            onClose={() => setRouting(null)}
          />
        )}
      </AnimatePresence>
    </div>
  );
}
