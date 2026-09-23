import { createVaultExport, getPortalVault, listVaultExports } from '@neoting/contracts/client';
import type { PortalVault, VaultExport } from '@neoting/contracts/model';
import { getPortalVaultResponse } from '@neoting/contracts/zod';

/**
 * The Document Vault add-on, client side (D51).
 *
 * Four calls. Three go through the generated client like everything else; the
 * fourth cannot, and the reason is worth knowing before anyone "tidies" it into
 * the others.
 */

const bearer = (token: string): RequestInit => ({ headers: { Authorization: `Bearer ${token}` } });

/** What the Vault tab renders itself from. */
export async function fetchVault(token: string): Promise<PortalVault> {
  return getPortalVaultResponse.parse(await getPortalVault(bearer(token))) as PortalVault;
}

/** This client's copy-to-Drive runs, newest first. */
export async function fetchVaultExports(token: string): Promise<VaultExport[]> {
  // `unknown` first: the generated type describes orval's `{data,status}`
  // envelope, which `ntFetch` does not actually return (see apps/web/CLAUDE.md).
  const body = (await listVaultExports({ limit: 10 }, bearer(token))) as unknown as { data?: VaultExport[] };
  return body.data ?? [];
}

/** Start a copy into a connected drive. Returns the QUEUED run — or the one already in flight. */
export async function startVaultExport(token: string, kind: 'GOOGLE_DRIVE' | 'ONEDRIVE'): Promise<VaultExport> {
  return (await createVaultExport({ kind }, bearer(token))) as unknown as VaultExport;
}

/**
 * Where to send the browser to connect a drive, and how to finish afterwards.
 *
 * ⚠ **Two calls, because the vendor's redirect cannot carry a bearer.** The
 * consent page comes back to `/portal/vault/connected` in THIS app, which holds
 * the session; the code is then posted back with it. `apps/api`'s
 * `drive-connections.service.ts` carries the full argument, and the short
 * version is that a redirect straight to the API would leave the signed state
 * as the only thing authorising the connection.
 */
export async function startDriveConnection(token: string, drive: 'google-drive' | 'onedrive'): Promise<string> {
  const body = (await post(token, '/portal/vault/connections', { drive })) as { authorizeUrl?: string };
  if (typeof body.authorizeUrl !== 'string') throw new Error('The drive did not give us a sign-in address.');
  return body.authorizeUrl;
}

export async function completeDriveConnection(token: string, code: string, state: string): Promise<string | null> {
  const body = (await post(token, '/portal/vault/connections/complete', { code, state })) as {
    connectedAccount?: string | null;
  };
  return body.connectedAccount ?? null;
}

export async function disconnectDrive(token: string, kind: string): Promise<void> {
  const response = await fetch(`${apiBase()}/portal/vault/connections/${encodeURIComponent(kind)}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${token}` },
    credentials: 'include',
  });
  if (!response.ok) throw new Error(await readProblem(response));
}

/**
 * Download every document as one ZIP.
 *
 * ⚠ **A hand-rolled `fetch`, and it has to be.** `ntFetch` returns `undefined`
 * for any response that is not JSON or plain text, so the generated client
 * cannot carry bytes — and the bearer lives in a HEADER, so this can never be a
 * plain `<a href>` either. Fetching to a blob and clicking a temporary object
 * URL is the only shape that satisfies both.
 *
 * The whole archive lands in browser memory, which is the one place it has to:
 * `URL.createObjectURL` needs a complete Blob. The SERVER streams it — that is
 * where the number that matters was spent.
 */
export async function downloadVaultArchive(token: string): Promise<void> {
  const response = await fetch(`${apiBase()}/portal/vault/archive`, {
    headers: { Authorization: `Bearer ${token}` },
    credentials: 'include',
  });
  if (!response.ok) throw new Error(await readProblem(response));

  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  try {
    const link = document.createElement('a');
    link.href = url;
    link.download = filenameFrom(response.headers.get('content-disposition')) ?? 'documents.zip';
    // Firefox will not follow a click on a node that is not in the document.
    document.body.append(link);
    link.click();
    link.remove();
  } finally {
    // ⚠ Revoked in a `finally`, and only AFTER the click. Skipping it leaks the
    // whole archive for the life of the tab — which on a client with four
    // hundred receipts is the kind of leak somebody notices.
    URL.revokeObjectURL(url);
  }
}

async function post(token: string, path: string, body: unknown): Promise<unknown> {
  const response = await fetch(`${apiBase()}${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      // Every mutation takes one (Governance §3); the generated client mints
      // these itself, and a hand-rolled call has to do the same.
      'Idempotency-Key': crypto.randomUUID(),
    },
    credentials: 'include',
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(await readProblem(response));
  return response.status === 204 ? undefined : await response.json();
}

/**
 * The API root, resolved exactly as `@neoting/contracts`'s own transport does.
 *
 * ⚠ Empty in the browser by default, which means SAME ORIGIN — `VITE_API_BASE_URL`
 * is deliberately unset in the deploy so the portal's cookie and its API share a
 * host. Hardcoding a host here is the bug that shipped once already, where every
 * visitor's browser was told to call `localhost:3000` — their own machine.
 */
function apiBase(): string {
  const configured = (import.meta as unknown as { env?: Record<string, string | undefined> }).env
    ?.VITE_API_BASE_URL;
  return `${configured ?? ''}/v1`;
}

/** A problem+json sentence, or a flat one. Never the raw body. */
async function readProblem(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { detail?: string; title?: string };
    return body.detail ?? body.title ?? `That did not work (${response.status}).`;
  } catch {
    return `That did not work (${response.status}).`;
  }
}

/** The server names the file; this reads that name rather than inventing one. */
function filenameFrom(header: string | null): string | null {
  const match = header?.match(/filename="([^"]+)"/);
  return match?.[1] ?? null;
}
