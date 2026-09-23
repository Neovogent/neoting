import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, CheckCircle2, CloudUpload, Download, Link2Off, Search, Unplug } from 'lucide-react';
import { defineMessages, useIntl } from 'react-intl';

import type { PortalVault, VaultExport } from '@neoting/contracts/model';

import {
  completeDriveConnection,
  disconnectDrive,
  downloadVaultArchive,
  fetchVault,
  startDriveConnection,
  startVaultExport,
} from '../../api/vault';
import { Panel } from './LivePortalHome';

/**
 * The Document Vault tab (D51) — the client's own paperwork, and the ways out
 * of it.
 *
 * ## Three rules this screen is built on
 *
 * - **The offer is the empty state, not a locked door.** A client who has not
 *   bought the add-on sees what it is and what it costs. Hiding the tab would
 *   make the feature undiscoverable; showing a padlock would make it feel like
 *   their own documents had been taken away. Neither is what is happening: the
 *   list, the search and opening a document were free before this existed and
 *   remain free.
 * - **Every button says what it will actually do**, including the one that
 *   cannot be undone from here. "Copy to Google Drive" copies; it does not sync,
 *   and the copy is one-way, so the words are one-way too.
 * - **A refusal is named.** The server's own sentence is rendered verbatim —
 *   it is written for this reader (`NT-BIL-003` names the price, a revoked
 *   drive says reconnect), and paraphrasing it here would be a second copy to
 *   keep in step.
 */

const m = defineMessages({
  title: { id: 'portal.vault.title', defaultMessage: 'Document Vault' },
  lead: {
    id: 'portal.vault.lead',
    defaultMessage: 'Everything you have sent, kept in one place and yours to take away whenever you want.',
  },

  offerTitle: { id: 'portal.vault.offer.title', defaultMessage: 'Add the Document Vault' },
  offerBody: {
    id: 'portal.vault.offer.body',
    defaultMessage:
      'For £2 a month you can search everything you have sent, download it all as a single ZIP, and copy it straight into your own Google Drive or OneDrive. Your documents stay exactly where they are either way — the add-on adds ways to get them out.',
  },
  offerAction: { id: 'portal.vault.offer.action', defaultMessage: 'Ask your accountant to add it' },
  offerNote: {
    id: 'portal.vault.offer.note',
    defaultMessage: 'It is added to your existing monthly bill. No new card, no second invoice.',
  },

  searchLabel: { id: 'portal.vault.search.label', defaultMessage: 'Search your documents' },
  searchPlaceholder: { id: 'portal.vault.search.placeholder', defaultMessage: 'Search by supplier…' },

  downloadTitle: { id: 'portal.vault.download.title', defaultMessage: 'Download everything' },
  downloadBody: {
    id: 'portal.vault.download.body',
    defaultMessage: 'One ZIP file with every document you have sent, named by date and supplier.',
  },
  downloadAction: { id: 'portal.vault.download.action', defaultMessage: 'Download as ZIP' },
  downloadIgnoresSearch: {
    id: 'portal.vault.download.ignoresSearch',
    defaultMessage: 'Searching does not change this — the ZIP always holds everything you have sent.',
  },
  downloadWorking: { id: 'portal.vault.download.working', defaultMessage: 'Preparing your download…' },

  drivesTitle: { id: 'portal.vault.drives.title', defaultMessage: 'Your cloud storage' },
  drivesBody: {
    id: 'portal.vault.drives.body',
    defaultMessage:
      'Connect a drive and copy your documents into it. We only ever write to a folder we create, and we never read anything else in your drive.',
  },
  connectGoogle: { id: 'portal.vault.drives.connectGoogle', defaultMessage: 'Connect Google Drive' },
  connectOneDrive: { id: 'portal.vault.drives.connectOneDrive', defaultMessage: 'Connect OneDrive' },
  copyNow: { id: 'portal.vault.drives.copy', defaultMessage: 'Copy my documents there' },
  disconnect: { id: 'portal.vault.drives.disconnect', defaultMessage: 'Disconnect' },
  needsReconnect: {
    id: 'portal.vault.drives.needsReconnect',
    defaultMessage: 'This connection stopped working. Reconnect it to copy again.',
  },

  runQueued: { id: 'portal.vault.run.queued', defaultMessage: 'Waiting to start…' },
  runRunning: {
    id: 'portal.vault.run.running',
    defaultMessage: 'Copying — {sent} of {total} done.',
  },
  runSucceeded: {
    id: 'portal.vault.run.succeeded',
    defaultMessage: 'All {total} documents copied into “{folder}”.',
  },
  runPartial: {
    id: 'portal.vault.run.partial',
    defaultMessage: '{sent} of {total} copied into “{folder}”.',
  },
  runFailed: { id: 'portal.vault.run.failed', defaultMessage: 'That copy did not finish.' },

  loading: { id: 'portal.vault.loading', defaultMessage: 'Loading your vault…' },
});

interface Props {
  readonly token: string;
  /** The current search term, owned by the parent so the document list can read it too. */
  readonly search: string;
  readonly onSearch: (next: string) => void;
  /** The client's own document list, already filtered by the server. */
  readonly children: React.ReactNode;
}

export function LivePortalVault({ token, search, onSearch, children }: Props): React.ReactElement {
  const intl = useIntl();
  const [vault, setVault] = useState<PortalVault | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // `useCallback` so the two effects below can DEPEND on it rather than
  // silencing the linter. A fresh closure every render would re-run the poll
  // effect on every state change, which is a request every keystroke.
  const reload = useCallback(async (): Promise<void> => {
    try {
      setVault(await fetchVault(token));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : null);
    }
  }, [token]);

  const guard = useCallback(async (key: string, work: () => Promise<void>): Promise<void> => {
    setBusy(key);
    setError(null);
    try {
      await work();
    } catch (cause) {
      // The server's sentence, verbatim — see the header.
      setError(cause instanceof Error ? cause.message : null);
    } finally {
      setBusy(null);
    }
  }, []);

  useEffect(() => {
    void (async () => {
      // ⚠ THE CONSENT RETURN LANDS HERE, and this is the half that makes the
      // connection safe. The vendor redirects the BROWSER back to this address
      // with `code` and `state`; the API is then called WITH the bearer, so the
      // signed state is never the only thing authorising the write. See
      // `apps/api/.../drive-connections.service.ts` for the full argument.
      const query = new URLSearchParams(window.location.search);
      const code = query.get('code');
      const state = query.get('state');
      const refused = query.get('error');

      if (refused !== null) {
        // The client pressed Cancel on the vendor's own screen. Not an error to
        // apologise for — just clear it off the address and carry on.
        stripConnectionParams();
      } else if (code !== null && state !== null) {
        await guard('connect', async () => {
          await completeDriveConnection(token, code, state);
        });
        // ⚠ Cleared whether or not it worked. A `code` is single-use, so a
        // refresh that replayed it would fail for a second, confusing reason.
        stripConnectionParams();
      }
      await reload();
    })();
    // The token is the identity of the whole screen; nothing else re-fetches it.
  }, [token, guard, reload]);

  // ⚠ A run in flight is polled, and ONLY a run in flight. A timer that keeps
  // ticking after the copy finished is a request every few seconds for the rest
  // of the session, on a phone, for no new information.
  const latest = vault?.latestExport ?? null;
  const inFlight = latest !== null && (latest.state === 'QUEUED' || latest.state === 'RUNNING');
  useEffect(() => {
    if (!inFlight) return;
    const timer = setInterval(() => void reload(), 3000);
    return () => clearInterval(timer);
  }, [inFlight, reload]);

  if (vault === null) {
    return (
      <Panel title={intl.formatMessage(m.title)}>
        <p className="text-[14px] text-zinc-400">{intl.formatMessage(m.loading)}</p>
        {error !== null && <Refusal message={error} />}
      </Panel>
    );
  }

  return (
    <div className="p-4 md:p-8 max-w-3xl mx-auto flex flex-col gap-6 pb-safe-6">
      <Panel title={intl.formatMessage(m.title)}>
        <p className="text-[14px] text-zinc-300">{intl.formatMessage(m.lead)}</p>
      </Panel>

      {error !== null && <Refusal message={error} />}

      {!vault.active && (
        <Panel title={intl.formatMessage(m.offerTitle)}>
          <p className="text-[14px] text-zinc-300">{intl.formatMessage(m.offerBody)}</p>
          <p className="mt-2 text-[12px] text-zinc-400">{intl.formatMessage(m.offerNote)}</p>
        </Panel>
      )}

      {/* ⚠ Search is OUTSIDE the `active` gate, deliberately. The list was free
          before the add-on existed and finding something in it is part of the
          list, not part of the add-on. */}
      <Panel title={intl.formatMessage(m.searchLabel)}>
        <div className="flex items-center gap-2 rounded-2xl border border-white/10 bg-raised px-4 py-3">
          <Search aria-hidden className="h-4 w-4 shrink-0 text-zinc-500" />
          <input
            type="search"
            value={search}
            onChange={(event) => onSearch(event.target.value)}
            placeholder={intl.formatMessage(m.searchPlaceholder)}
            aria-label={intl.formatMessage(m.searchLabel)}
            className="w-full bg-transparent text-[14px] text-white placeholder:text-zinc-500 outline-none"
          />
        </div>
      </Panel>

      {children}

      {vault.active && (
        <>
          <Panel title={intl.formatMessage(m.downloadTitle)}>
            <p className="text-[14px] text-zinc-300">{intl.formatMessage(m.downloadBody)}</p>
            {/* ⚠ Only while a search is active, and it is not decoration. The
                filtered list sits directly above this button — a client looking
                at three Bidfood receipts and pressing Download gets all fifteen,
                which is what "download everything" means and is NOT what the
                screen appears to offer. Found by driving it, not by reading it. */}
            {search.trim() !== '' && (
              <p className="mt-2 text-[12px] text-zinc-400">{intl.formatMessage(m.downloadIgnoresSearch)}</p>
            )}
            <button
              type="button"
              disabled={busy !== null}
              onClick={() => void guard('zip', () => downloadVaultArchive(token))}
              className="mt-3 inline-flex items-center justify-center gap-2 px-6 py-3 rounded-full text-[14px] font-bold text-brand-on bg-brand hover:bg-brand-hover disabled:opacity-40 disabled:cursor-not-allowed transition-colors shadow-glow-cta"
            >
              <Download aria-hidden className="h-4 w-4" />
              {intl.formatMessage(busy === 'zip' ? m.downloadWorking : m.downloadAction)}
            </button>
          </Panel>

          <Panel title={intl.formatMessage(m.drivesTitle)}>
            <p className="text-[14px] text-zinc-300">{intl.formatMessage(m.drivesBody)}</p>

            {vault.destinations.map((destination) => (
              <div
                key={destination.kind}
                className="mt-3 flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-white/5 bg-raised p-4"
              >
                <div>
                  <p className="text-[14px] font-bold text-white">{destination.label}</p>
                  {destination.connectedAccount !== null && destination.connectedAccount !== undefined && (
                    <p className="text-[12px] text-zinc-400">{destination.connectedAccount}</p>
                  )}
                  {!destination.healthy && (
                    <p className="mt-1 flex items-center gap-1 text-[12px] text-amber-400">
                      <Link2Off aria-hidden className="h-3 w-3" />
                      {intl.formatMessage(m.needsReconnect)}
                    </p>
                  )}
                </div>
                <div className="flex gap-2">
                  <button
                    type="button"
                    disabled={busy !== null || !destination.healthy || inFlight}
                    onClick={() =>
                      void guard('copy', async () => {
                        await startVaultExport(token, destination.kind as 'GOOGLE_DRIVE' | 'ONEDRIVE');
                        await reload();
                      })
                    }
                    className="inline-flex items-center gap-2 px-4 py-2 rounded-full text-[13px] font-bold text-brand-on bg-brand hover:bg-brand-hover disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                  >
                    <CloudUpload aria-hidden className="h-3.5 w-3.5" />
                    {intl.formatMessage(m.copyNow)}
                  </button>
                  <button
                    type="button"
                    disabled={busy !== null}
                    onClick={() =>
                      void guard('disconnect', async () => {
                        await disconnectDrive(token, destination.kind);
                        await reload();
                      })
                    }
                    className="inline-flex items-center gap-2 px-4 py-2 rounded-full text-[13px] font-bold text-zinc-300 border border-white/10 bg-raised hover:text-white hover:border-white/20 disabled:opacity-40 transition-colors"
                  >
                    <Unplug aria-hidden className="h-3.5 w-3.5" />
                    {intl.formatMessage(m.disconnect)}
                  </button>
                </div>
              </div>
            ))}

            <div className="mt-3 flex flex-wrap gap-2">
              {!vault.destinations.some((d) => d.kind === 'GOOGLE_DRIVE') && (
                <ConnectButton
                  token={token}
                  drive="google-drive"
                  label={intl.formatMessage(m.connectGoogle)}
                  disabled={busy !== null}
                  onError={setError}
                />
              )}
              {!vault.destinations.some((d) => d.kind === 'ONEDRIVE') && (
                <ConnectButton
                  token={token}
                  drive="onedrive"
                  label={intl.formatMessage(m.connectOneDrive)}
                  disabled={busy !== null}
                  onError={setError}
                />
              )}
            </div>

            {latest !== null && <RunLine run={latest} />}
          </Panel>
        </>
      )}
    </div>
  );
}

/**
 * Connecting a drive leaves this app and comes back.
 *
 * ⚠ `window.location.assign`, NOT `window.open`. A popup is blocked on most
 * phone browsers, which is where this portal lives, and a blocked popup is a
 * button that silently does nothing.
 */
function ConnectButton({
  token,
  drive,
  label,
  disabled,
  onError,
}: {
  readonly token: string;
  readonly drive: 'google-drive' | 'onedrive';
  readonly label: string;
  readonly disabled: boolean;
  readonly onError: (message: string | null) => void;
}): React.ReactElement {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={() => {
        void (async () => {
          try {
            window.location.assign(await startDriveConnection(token, drive));
          } catch (cause) {
            onError(cause instanceof Error ? cause.message : null);
          }
        })();
      }}
      className="inline-flex items-center gap-2 px-4 py-2 rounded-full text-[13px] font-bold text-zinc-300 border border-white/10 bg-raised hover:text-white hover:border-white/20 disabled:opacity-40 transition-colors"
    >
      <CloudUpload aria-hidden className="h-3.5 w-3.5" />
      {label}
    </button>
  );
}

/** How the most recent copy went, in the client's own terms. */
function RunLine({ run }: { readonly run: VaultExport }): React.ReactElement {
  const intl = useIntl();
  const values = { sent: run.sentCount, total: run.documentCount, folder: run.folderName ?? '' };

  const message =
    run.state === 'QUEUED'
      ? intl.formatMessage(m.runQueued)
      : run.state === 'RUNNING'
        ? intl.formatMessage(m.runRunning, values)
        : run.state === 'SUCCEEDED'
          ? intl.formatMessage(m.runSucceeded, values)
          : run.state === 'PARTIAL'
            ? intl.formatMessage(m.runPartial, values)
            : intl.formatMessage(m.runFailed);

  const bad = run.state === 'FAILED' || run.state === 'PARTIAL';
  return (
    <p className={`mt-3 flex items-start gap-2 text-[12px] ${bad ? 'text-amber-400' : 'text-zinc-400'}`}>
      {bad ? (
        <AlertTriangle aria-hidden className="mt-0.5 h-3.5 w-3.5 shrink-0" />
      ) : (
        <CheckCircle2 aria-hidden className="mt-0.5 h-3.5 w-3.5 shrink-0" />
      )}
      <span>
        {message}
        {/* The server's own sentence about what went wrong, never a paraphrase. */}
        {run.failureMessage !== null && run.failureMessage !== undefined && ` ${run.failureMessage}`}
      </span>
    </p>
  );
}

/**
 * Take `code`/`state`/`error` off the address without reloading the page.
 *
 * `replaceState` rather than `pushState`: the consent round trip is not a step
 * a client should be able to press Back into, and a `code` is single-use so
 * going back to it would replay a spent credential.
 */
function stripConnectionParams(): void {
  const url = new URL(window.location.href);
  for (const key of ['code', 'state', 'error', 'scope', 'authuser', 'prompt', 'session_state']) {
    url.searchParams.delete(key);
  }
  window.history.replaceState({}, '', `${url.pathname}${url.search}${url.hash}`);
}

function Refusal({ message }: { readonly message: string }): React.ReactElement {
  return (
    <div className="flex items-start gap-2 rounded-2xl border border-amber-400/20 bg-amber-400/10 p-4 text-[14px] text-amber-300">
      <AlertTriangle aria-hidden className="mt-0.5 h-4 w-4 shrink-0" />
      <span>{message}</span>
    </div>
  );
}
