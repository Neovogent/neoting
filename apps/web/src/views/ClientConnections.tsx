import { useEffect, useState } from 'react';
import { AlertTriangle, Check, Link2, Plug, RefreshCw, Unplug } from 'lucide-react';
import { defineMessages, useIntl } from 'react-intl';

import { useConfirm } from '../components/DynamicComponents/ConfirmProvider';
import { API_ENABLED } from '../api/config';
import {
  disconnectConnection,
  type Integration,
  type LedgerVendor,
  startConnection,
  syncConnection,
  useIntegrations,
} from '../api/integrations';
import { useQueryParam } from '../lib/router';
import type { Client } from '../lib/types';

/**
 * Connections (D50) — where a practice connects a client's accounting software
 * once, sees whether it still works, and disconnects it.
 *
 * ## ⚠ Three sentences on this screen have to stay true
 *
 * 1. **Connecting is not publishing.** A document reaches a client's books only
 *    through an approved release, server-enforced. Nothing here posts anything.
 * 2. **Export is not retired.** A client without a connection is released for
 *    export exactly as before, permanently — VT Transaction+ has no API. So no
 *    string here may present connecting as a fix for something broken.
 * 3. **Xero has no test company.** Connecting Xero writes to a REAL
 *    organisation, so the caution renders before the button, not after.
 */

const m = defineMessages({
  intro: {
    id: 'clients.connections.intro',
    defaultMessage:
      'Connect this client’s accounting software once. After that, when you approve a release, the transaction is created in their books with the receipt attached.',
  },
  introExport: {
    id: 'clients.connections.introExport',
    defaultMessage:
      'No accounting software is connected, so approved documents are released for export and you import the file — which stays available whether or not you connect anything.',
  },
  connected: { id: 'clients.connections.connected', defaultMessage: 'Connected' },
  unfinished: { id: 'clients.connections.unfinished', defaultMessage: 'Not finished' },
  disconnected: { id: 'clients.connections.disconnected', defaultMessage: 'Disconnected' },
  needsAttention: { id: 'clients.connections.needsAttention', defaultMessage: 'Needs attention' },
  organisation: { id: 'clients.connections.organisation', defaultMessage: 'Organisation' },
  lastSync: { id: 'clients.connections.lastSync', defaultMessage: 'Lists last read' },
  never: { id: 'clients.connections.never', defaultMessage: 'never' },
  lists: {
    id: 'clients.connections.lists',
    defaultMessage:
      '{accounts, plural, one {# account} other {# accounts}} · {suppliers, plural, one {# supplier} other {# suppliers}} · {taxRates, plural, one {# tax rate} other {# tax rates}}',
  },
  connect: { id: 'clients.connections.connect', defaultMessage: 'Connect' },
  connecting: { id: 'clients.connections.connecting', defaultMessage: 'Opening {label}…' },
  sync: { id: 'clients.connections.sync', defaultMessage: 'Sync lists' },
  syncing: { id: 'clients.connections.syncing', defaultMessage: 'Reading…' },
  disconnect: { id: 'clients.connections.disconnect', defaultMessage: 'Disconnect' },
  confirmTitle: { id: 'clients.connections.confirmTitle', defaultMessage: 'Disconnect {label}?' },
  confirmBody: {
    id: 'clients.connections.confirmBody',
    defaultMessage:
      'Approved documents for this client will go back to being released for export instead. Nothing already in their books is removed or changed. You can connect again at any time.',
  },
  exportNote: {
    id: 'clients.connections.exportNote',
    defaultMessage: 'Export destination — approved documents are released for you to import.',
  },
  emptyLists: {
    id: 'clients.connections.emptyLists',
    defaultMessage: 'Their accounts have not been read yet. Press Sync lists before releasing anything.',
  },
  ownerOnly: {
    id: 'clients.connections.ownerOnly',
    defaultMessage: 'Only your practice’s super admin can connect or disconnect a client’s accounting software.',
  },
  syntheticOnly: {
    id: 'clients.connections.syntheticOnly',
    defaultMessage: 'Connections are a live-server feature. This is the demo data view.',
  },
});

/** What the health badge says, and it never says "fine" about a connection that is not. */
function statusOf(row: Integration): { tone: 'good' | 'warn' | 'idle'; key: keyof typeof m } {
  if (!row.isActive) return { tone: 'idle', key: 'disconnected' };
  if (row.isConnected !== true) return { tone: 'warn', key: 'unfinished' };
  if (row.health === 'ERROR') return { tone: 'warn', key: 'needsAttention' };
  return { tone: 'good', key: 'connected' };
}

export function ClientConnections({ client }: { client: Client }) {
  const intl = useIntl();
  const confirm = useConfirm();
  const { integrations, connectable, contractError, isLoading, refetch } = useIntegrations({
    enabled: API_ENABLED,
    businessId: client.id,
  });

  /**
   * ⚠ The callback redirects back here with `?connectionError=…` when a consent
   * journey did not complete. Rendering it is the difference between "nothing
   * happened and nobody knows why" and a sentence naming the next step — the
   * API deliberately puts no stack trace in that parameter.
   */
  const [callbackError, setCallbackError] = useQueryParam('connectionError');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (callbackError !== null && callbackError !== '') setError(callbackError);
  }, [callbackError]);

  if (!API_ENABLED) {
    return <p className="text-[13px] text-zinc-500 leading-relaxed">{intl.formatMessage(m.syntheticOnly)}</p>;
  }

  const ledgers = integrations.filter((row) => row.vendor !== null && row.vendor !== undefined);
  const exports_ = integrations.filter((row) => row.vendor === null || row.vendor === undefined);
  const live = ledgers.some((row) => row.isActive && row.isConnected === true);

  async function connect(vendor: LedgerVendor, label: string): Promise<void> {
    setBusy(vendor);
    setError(null);
    try {
      // ⚠ A TOP-LEVEL navigation, not a popup and not an iframe. Every one of
      // the four serves a sign-in page, and a sign-in page will not render in
      // either — a popup also dies to a blocker, silently, on the one click
      // that matters.
      window.location.assign(await startConnection(client.id, vendor));
    } catch (cause) {
      setBusy(null);
      setError(messageOf(cause, intl.formatMessage(m.ownerOnly), label));
    }
  }

  async function sync(row: Integration): Promise<void> {
    setBusy(row.id);
    setError(null);
    try {
      await syncConnection(row.id);
      await refetch();
    } catch (cause) {
      setError(messageOf(cause, intl.formatMessage(m.ownerOnly), row.label ?? ''));
    } finally {
      setBusy(null);
    }
  }

  async function disconnect(row: Integration): Promise<void> {
    const label = row.label ?? '';
    // ⚠ `tone: 'brand'`, not red. Red is reserved exclusively for
    // irreversibility (SoT §13/D38) and this is reversible — the confirmation
    // says so in its own words rather than borrowing a colour that would
    // contradict them.
    const ok = await confirm({
      title: intl.formatMessage(m.confirmTitle, { label }),
      detail: intl.formatMessage(m.confirmBody),
      confirmLabel: intl.formatMessage(m.disconnect),
      tone: 'brand',
    });
    if (ok !== true) return;
    setBusy(row.id);
    setError(null);
    try {
      await disconnectConnection(row.id);
      await refetch();
    } catch (cause) {
      setError(messageOf(cause, intl.formatMessage(m.ownerOnly), label));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="flex flex-col gap-5">
      <p className="text-[13px] text-zinc-500 leading-relaxed max-w-2xl">
        {intl.formatMessage(live ? m.intro : m.introExport)}
      </p>

      {error !== null && (
        <div className="flex items-start gap-3 rounded-2xl border border-amber-500/20 bg-amber-500/5 p-4 text-[13px] text-amber-200">
          <AlertTriangle size={16} className="mt-0.5 shrink-0" />
          <span className="leading-relaxed">{error}</span>
          <button
            type="button"
            className="ml-auto text-amber-200/60 hover:text-amber-100"
            onClick={() => {
              setError(null);
              if (callbackError !== null) setCallbackError(null);
            }}
          >
            ×
          </button>
        </div>
      )}

      {contractError !== null && (
        <p className="text-[13px] text-amber-300/80">{contractError}</p>
      )}

      {isLoading && <p className="text-[13px] text-zinc-500">…</p>}

      {ledgers.map((row) => {
        const status = statusOf(row);
        const counts = row.referenceCounts;
        return (
          <div key={row.id} className="border border-white/5 rounded-[28px] bg-card p-6 flex flex-col gap-4">
            <div className="flex items-center gap-3 flex-wrap">
              <div className="w-9 h-9 rounded-xl bg-raised border border-white/5 flex items-center justify-center text-zinc-400">
                <Plug size={16} />
              </div>
              <h3 className="font-sans font-bold text-lg text-white tracking-tight">{row.label}</h3>
              <span
                className={`ml-auto inline-flex items-center gap-1.5 text-[12px] px-2.5 py-1 rounded-full border ${
                  status.tone === 'good'
                    ? 'border-brand/30 bg-brand/10 text-brand'
                    : status.tone === 'warn'
                      ? 'border-amber-500/30 bg-amber-500/10 text-amber-200'
                      : 'border-white/10 bg-white/5 text-zinc-400'
                }`}
              >
                {status.tone === 'good' ? <Check size={12} /> : <AlertTriangle size={12} />}
                {intl.formatMessage(m[status.key])}
              </span>
            </div>

            <dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-2 text-[13px]">
              <Row label={intl.formatMessage(m.organisation)} value={row.connectedOrganisation ?? row.orgRef ?? '—'} />
              <Row
                label={intl.formatMessage(m.lastSync)}
                value={row.lastSyncAt == null ? intl.formatMessage(m.never) : new Date(row.lastSyncAt).toLocaleString('en-GB')}
              />
            </dl>

            {/* ⚠ The vendor's own error, as OUR sentence — the server never puts
                a vendor's prose here, because a vendor's message quotes the
                submitted figures back, which are this client's bookkeeping. */}
            {row.lastErrorMessage != null && row.lastErrorMessage !== '' && (
              <p className="text-[13px] text-amber-200/90 leading-relaxed">{row.lastErrorMessage}</p>
            )}

            {counts == null || (counts.accounts ?? 0) === 0 ? (
              <p className="text-[13px] text-zinc-500 leading-relaxed">{intl.formatMessage(m.emptyLists)}</p>
            ) : (
              <p className="text-[13px] text-zinc-500">
                {intl.formatMessage(m.lists, {
                  accounts: counts.accounts ?? 0,
                  suppliers: counts.suppliers ?? 0,
                  taxRates: counts.taxRates ?? 0,
                })}
              </p>
            )}

            <div className="flex items-center gap-2 flex-wrap">
              <button
                type="button"
                disabled={busy !== null || row.isConnected !== true}
                onClick={() => void sync(row)}
                className="inline-flex items-center gap-2 text-[13px] px-3.5 py-2 rounded-xl border border-white/10 bg-raised text-zinc-200 hover:border-white/20 disabled:opacity-40"
              >
                <RefreshCw size={14} />
                {busy === row.id ? intl.formatMessage(m.syncing) : intl.formatMessage(m.sync)}
              </button>
              <button
                type="button"
                disabled={busy !== null || !row.isActive}
                onClick={() => void disconnect(row)}
                className="inline-flex items-center gap-2 text-[13px] px-3.5 py-2 rounded-xl border border-white/10 text-zinc-400 hover:text-zinc-200 hover:border-white/20 disabled:opacity-40"
              >
                <Unplug size={14} />
                {intl.formatMessage(m.disconnect)}
              </button>
            </div>
          </div>
        );
      })}

      {connectable.map((option) => (
        <div key={option.vendor} className="border border-white/5 rounded-[28px] bg-card p-6 flex flex-col gap-4">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-xl bg-raised border border-white/5 flex items-center justify-center text-zinc-400">
              <Link2 size={16} />
            </div>
            <h3 className="font-sans font-bold text-lg text-white tracking-tight">{option.label}</h3>
          </div>
          {/* ⚠ BEFORE the button, never after: Xero has no sandbox, so pressing
              Connect writes to a real organisation. */}
          {option.caution != null && option.caution !== '' && (
            <p className="text-[13px] text-amber-200/90 leading-relaxed">{option.caution}</p>
          )}
          <div>
            <button
              type="button"
              disabled={busy !== null}
              onClick={() => void connect(option.vendor, option.label)}
              className="inline-flex items-center gap-2 text-[13px] px-3.5 py-2 rounded-xl border border-brand/30 bg-brand/10 text-brand hover:bg-brand/20 disabled:opacity-40"
            >
              <Plug size={14} />
              {busy === option.vendor ? intl.formatMessage(m.connecting, { label: option.label }) : intl.formatMessage(m.connect)}
            </button>
          </div>
        </div>
      ))}

      {exports_.map((row) => (
        <div key={row.id} className="border border-white/5 rounded-[28px] bg-card p-6 flex flex-col gap-2">
          <h3 className="font-sans font-bold text-[15px] text-zinc-200 tracking-tight">{row.label}</h3>
          <p className="text-[13px] text-zinc-500 leading-relaxed">{intl.formatMessage(m.exportNote)}</p>
        </div>
      ))}
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline gap-2">
      <dt className="text-zinc-500 shrink-0">{label}</dt>
      <dd className="text-zinc-300 truncate" title={value}>
        {value}
      </dd>
    </div>
  );
}

/**
 * The server's own sentence, or a fallback.
 *
 * A 403 here is almost always the owner-only rule, and saying so is more useful
 * than "Forbidden" — but the server's `detail` says it better when there is one,
 * so that wins.
 */
function messageOf(cause: unknown, ownerOnly: string, label: string): string {
  if (typeof cause === 'object' && cause !== null) {
    const detail = (cause as { detail?: unknown }).detail;
    if (typeof detail === 'string' && detail !== '') return detail;
    const status = (cause as { status?: unknown }).status;
    if (status === 403) return ownerOnly;
  }
  if (cause instanceof Error && cause.message !== '') return cause.message;
  return `${label} could not be reached. Try again in a moment.`;
}
