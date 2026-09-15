import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  createIntegrationAuthorisation,
  disconnectIntegration,
  listIntegrations,
  syncIntegration,
} from '@neoting/contracts/client';
import { listIntegrationsResponse, syncIntegrationResponse } from '@neoting/contracts/zod';
import type { Integration, IntegrationList, LedgerVendor } from '@neoting/contracts/model';

import { unwrapBody } from './envelope';

/**
 * The ledger connection boundary (D50).
 *
 * ## ⚠ Nothing on this lane publishes anything
 *
 * Connecting is not publishing. A document still reaches a client's books only
 * through an approved `publish.batch` proposal, server-enforced, and there is no
 * publish endpoint for a screen to call. Every string this module and its panel
 * puts on screen has to survive that reading: **"Connected"**, never "syncing
 * your documents"; **"Connect"**, never "publish to Xero".
 *
 * ## What changes for the release lane, and the sentence that has to be true
 *
 * A client with a live connection publishes to their BOOKS on approval; a client
 * without one is released for EXPORT, exactly as before. ⚠ Export is not
 * retired and never will be — VT Transaction+ has no API — so this panel must
 * never imply that connecting is an upgrade away from something broken.
 *
 * ## This module must stay OFF the bundle floor
 *
 * Imported by the lazy client-detail chunk only, never by `AppContext` — the
 * shared floor has ~5.5 kB of headroom (`apps/web/CLAUDE.md`, *Bundle*). That is
 * also why the plain generated functions are used inside a hand-rolled
 * `useQuery` rather than the generated hooks: the marginal cost is per-EXPORT
 * touched from a generated module, and the hook machinery is most of it.
 */

export type { Integration, IntegrationList, LedgerVendor };

function drift(issues: { path: (string | number)[]; message: string }[]): string {
  return issues
    .slice(0, 3)
    .map((issue) => `${issue.path.join('.') || 'response'}: ${issue.message}`)
    .join('; ');
}

export interface UseIntegrationsOptions {
  /** Off entirely when the app is running on seed data or has no session. */
  enabled: boolean;
  businessId: string;
}

/**
 * One client's connections, and what else could be connected.
 *
 * **Polled slowly, and only while the panel is open.** A connection's health
 * changes when a vendor revokes it — which happens outside this browser — so a
 * screen that never re-read would keep saying "Connected" about a connection
 * that has stopped working. Sixty seconds, because the thing being watched
 * changes on a human timescale, not a machine one.
 */
export function useIntegrations({ enabled, businessId }: UseIntegrationsOptions) {
  const query = useQuery({
    queryKey: ['integrations', businessId] as const,
    queryFn: () => listIntegrations({ businessId }),
    enabled: enabled && businessId !== '',
    refetchInterval: 60_000,
  });

  const parsed = useMemo(() => {
    const empty = { data: [] as Integration[], connectable: [] as IntegrationList['connectable'], invalid: null as string | null };
    if (!query.data) return empty;
    const result = listIntegrationsResponse.safeParse(unwrapBody(query.data));
    if (!result.success) return { ...empty, invalid: drift(result.error.issues) };
    return { data: result.data.data as Integration[], connectable: result.data.connectable, invalid: null };
  }, [query.data]);

  return {
    integrations: parsed.data,
    connectable: parsed.connectable,
    /** Set when the server's answer did not match the contract. */
    contractError: parsed.invalid,
    isLoading: query.isLoading,
    isFetching: query.isFetching,
    error: query.error,
    refetch: query.refetch,
  };
}

/**
 * Start a consent journey and hand back where the browser must go.
 *
 * ⚠ **The caller navigates the TOP-LEVEL window.** Every one of the four vendors
 * serves a sign-in page, and a sign-in page will not render in an iframe or a
 * popup that a browser has decided is an ad. `window.location.assign` is the
 * only reliable answer, and the panel says so before the button is pressed.
 *
 * `Idempotency-Key` is not set here: `ntFetch` attaches a fresh UUID to every
 * mutation, which is the point of the mutator — a caller cannot forget it,
 * because a caller never sets it.
 */
export async function startConnection(businessId: string, vendor: LedgerVendor): Promise<string> {
  const body = unwrapBody(await createIntegrationAuthorisation({ businessId, vendor }));
  if (typeof body !== 'object' || body === null || typeof (body as { authorisationUrl?: unknown }).authorisationUrl !== 'string') {
    // A drift THROWS rather than returning a half-parsed answer: navigating the
    // window to a value we could not validate is the one mistake on this lane
    // with a blast radius outside the product.
    throw new Error('The server did not return a usable connection link.');
  }
  return (body as { authorisationUrl: string }).authorisationUrl;
}

/** Re-read the client's own accounts, suppliers and tax rates. */
export async function syncConnection(integrationId: string): Promise<Integration> {
  const body = unwrapBody(await syncIntegration(integrationId));
  return syncIntegrationResponse.parse(body) as Integration;
}

/**
 * Disconnect.
 *
 * ⚠ The panel confirms first, and the confirmation says what does NOT happen:
 * nothing already published is removed from the client's books. A practice
 * hesitating over this button is usually asking exactly that.
 */
export async function disconnectConnection(integrationId: string): Promise<Integration> {
  const body = unwrapBody(await disconnectIntegration(integrationId));
  return syncIntegrationResponse.parse(body) as Integration;
}
