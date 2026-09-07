import { RefreshCw } from 'lucide-react';
import { defineMessages, useIntl } from 'react-intl';
import { TRASH_RETENTION_DAYS } from '@neoting/contracts';
import { useBusinesses } from '../api/businesses';
import { LiveProposalFlow } from '../components/DynamicComponents/LiveProposalFlow';
import { useAppContext } from '../context/AppContext';

const m = defineMessages({
  /* ── Review item 67, the third layer ────────────────────────────────────
     > "in the trash keep the client too for some days if any reason the
     >  client gets back the accountant can restart work form where left" */
  intro: {
    id: 'analytics.removedClients.intro',
    defaultMessage:
      'Clients your practice has removed. Their books, documents and audit trail are kept for the six-year retention requirement — removal never deleted anything — and restoring one puts them back on every working surface.',
  },
  window: {
    id: 'analytics.removedClients.window',
    defaultMessage:
      'Restore is offered here for {days} days after removal. After that nothing is erased: the client simply stops being one click away, and their records stay where they are.',
  },
  empty: {
    id: 'analytics.removedClients.empty',
    defaultMessage: 'No clients have been removed. Removing one happens on that client’s own Settings tab.',
  },
  loading: { id: 'analytics.removedClients.loading', defaultMessage: 'Loading removed clients…' },
  loadError: {
    id: 'analytics.removedClients.loadError',
    defaultMessage: 'Removed clients could not be loaded — {error}',
  },
  removedOn: { id: 'analytics.removedClients.removedOn', defaultMessage: 'Removed {date}' },
  removedUnknown: {
    id: 'analytics.removedClients.removedUnknown',
    defaultMessage: 'Removed before this product recorded the date',
  },
  daysLeft: {
    id: 'analytics.removedClients.daysLeft',
    defaultMessage: '{days, plural, one {# day left to restore in one click} other {# days left to restore in one click}}',
  },
  windowPassed: {
    id: 'analytics.removedClients.windowPassed',
    defaultMessage: 'Past the {days}-day window — still restorable, nothing was erased',
  },
  restore: { id: 'analytics.removedClients.restore', defaultMessage: 'Restore this client' },
  syntheticNote: {
    id: 'analytics.removedClients.syntheticNote',
    defaultMessage:
      'Removed clients are a live surface — the list appears when this workspace is reading from the server.',
  },
});

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * **Removed clients, and the way back — review item 67's third layer.**
 *
 * `business.offboard` shipped on 31 Aug 2026 with no undo of any kind, and
 * `assert-can.ts` said so in as many words while arguing the kind up to tier 1:
 * *"there is no `business.reactivate` kind yet, so the undo is a later
 * surface"*. A client removed by mistake could only be recovered with a hand on
 * the database, and a client who came back could not be resumed at all. This is
 * the screen that closes it, over the contract delta the owner approved on
 * 7 Sep 2026: `GET /businesses?active=false` and the `business.reactivate`
 * proposal kind.
 *
 * ## Two things it is careful not to claim
 *
 * - **Restoring does not bring documents back out of Trash.** If the offboard
 *   ran with `documentScope: 'trash'` they are still there, because
 *   `documents.deleted_at` records THAT a document was deleted and not which act
 *   deleted it — a blanket restore would resurrect everything a person had
 *   trashed deliberately beforehand. The server's review card says this; so does
 *   `KIND_NOTE['business.reactivate']`, which is what the queue renders.
 * - **The window is not a deletion.** After it lapses the client stops being
 *   offered for one-click restore and NOTHING ELSE happens — D12 holds the books
 *   for six years and the workspace stays reachable by id. The copy therefore
 *   says "still restorable, nothing was erased" rather than going quiet, because
 *   a row that simply stopped offering a button would read as a countdown to
 *   destruction.
 *
 * ## Why `LiveProposalFlow` and not a dialog of its own
 *
 * Restoring is one proposal with no options to collect — there is nothing to
 * type, and the reason is optional on a kind nobody reaches by accident. The
 * shared flow already does create → Read review → Approve with the server's own
 * card, including the super-admin fast path, so a bespoke dialog would be a
 * second implementation of the one thing that must not have two.
 */
export function RemovedClientsPanel() {
  const intl = useIntl();
  const { slices } = useAppContext();
  const live = slices.businesses.source === 'api';
  // `active: false` — the contract's Removed-clients listing. The default is
  // `true`, applied server-side, so this parameter is the only way here.
  const removed = useBusinesses({ enabled: live, params: { active: false } });

  if (!live) {
    return <p className="px-4 md:px-10 text-[13px] text-zinc-500 leading-relaxed">{intl.formatMessage(m.syntheticNote)}</p>;
  }

  const loadError = removed.contractError ?? (removed.error instanceof Error ? removed.error.message : null);

  return (
    <div className="px-4 md:px-10 pb-10 flex flex-col gap-5">
      <div className="max-w-3xl flex flex-col gap-1.5">
        <p className="text-[13px] text-zinc-400 leading-relaxed">{intl.formatMessage(m.intro)}</p>
        <p className="text-[12.5px] text-zinc-500 leading-relaxed">
          {intl.formatMessage(m.window, { days: TRASH_RETENTION_DAYS })}
        </p>
      </div>

      {(removed.isLoading || loadError !== null) && (
        <div
          className={`flex items-center gap-3 px-5 py-3 rounded-2xl border text-[13px] font-semibold ${
            loadError !== null
              ? 'bg-red-500/10 border-red-500/20 text-red-300'
              : 'bg-white/[0.03] border-white/10 text-zinc-400'
          }`}
        >
          <RefreshCw size={15} className={loadError !== null ? '' : 'animate-spin'} />
          <span className="min-w-0">
            {loadError !== null ? intl.formatMessage(m.loadError, { error: loadError }) : intl.formatMessage(m.loading)}
          </span>
        </div>
      )}

      {!removed.isLoading && loadError === null && removed.businesses.length === 0 && (
        <p className="text-[13px] text-zinc-500 leading-relaxed">{intl.formatMessage(m.empty)}</p>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {removed.businesses.map((business) => {
          // Null for a workspace offboarded before the column existed. It reads
          // as a restore offer with no countdown — the honest answer, and better
          // than back-dating a moment nobody recorded.
          const removedAt = business.offboardedAt === null || business.offboardedAt === undefined
            ? null
            : new Date(business.offboardedAt);
          const daysLeft =
            removedAt === null
              ? null
              : TRASH_RETENTION_DAYS - Math.floor((Date.now() - removedAt.getTime()) / MS_PER_DAY);
          return (
            <div
              key={business.id}
              className="p-5 rounded-[28px] border border-white/10 bg-card flex flex-col gap-3 shadow-inner"
            >
              <div className="min-w-0">
                <h3 className="font-sans text-lg font-bold text-white leading-tight truncate">{business.name}</h3>
                <p className="text-[12px] text-zinc-500 mt-1">
                  {removedAt === null
                    ? intl.formatMessage(m.removedUnknown)
                    : intl.formatMessage(m.removedOn, {
                        // Europe/London at the render, UTC in storage
                        // (Governance §12) — and the UK order, never US.
                        date: removedAt.toLocaleDateString('en-GB', { timeZone: 'Europe/London' }),
                      })}
                </p>
                {daysLeft !== null && (
                  <p className={`text-[12px] mt-0.5 font-semibold ${daysLeft > 0 ? 'text-zinc-400' : 'text-amber-400'}`}>
                    {daysLeft > 0
                      ? intl.formatMessage(m.daysLeft, { days: daysLeft })
                      : intl.formatMessage(m.windowPassed, { days: TRASH_RETENTION_DAYS })}
                  </p>
                )}
              </div>
              <LiveProposalFlow
                clientName={business.name}
                stageLabel={intl.formatMessage(m.restore)}
                buildRequest={() => ({
                  kind: 'business.reactivate',
                  businessId: business.id,
                  payload: { businessId: business.id },
                })}
                onExecuted={() => void removed.refetch()}
              />
            </div>
          );
        })}
      </div>
    </div>
  );
}

export default RemovedClientsPanel;
