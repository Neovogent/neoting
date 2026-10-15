import { useQuery } from '@tanstack/react-query';

import { putBytes, sha256Hex } from './upload-transport';

/**
 * The practice-side Document Vault (SoT §10), full-text search, the £2 Vault
 * add-on switch and capture-tool imports — hand-rolled `fetch`, the
 * `api/vault.ts` pattern: none of these operations is in the generated client.
 *
 * Workspace calls ride the session cookie (no Authorization header); the one
 * portal call takes the bearer.
 */

export const VAULT_CATEGORIES = [
  'contract', 'lease', 'insurance', 'tax-filing', 'engagement-letter', 'mot', 'payroll', 'other',
] as const;
export type VaultCategory = (typeof VAULT_CATEGORIES)[number];

/** 100 MB — the server's cap, checked here first so nobody waits on a doomed upload. */
export const VAULT_MAX_BYTES = 100 * 1024 * 1024;

export interface VaultItem {
  id: string;
  businessId: string;
  businessName: string;
  filename: string;
  mimeType: string;
  byteSize: number;
  title: string | null;
  summary: string | null;
  category: string | null;
  tags: string[];
  financialYear: string | null;
  keyDates: { label: string; date: string }[];
  expiresAt: string | null;
  aiState: 'pending' | 'done' | 'failed';
  sourceDocumentId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface VaultItemPatch {
  title?: string;
  summary?: string;
  category?: string;
  tags?: string[];
  financialYear?: string;
  expiresAt?: string | null;
}

export interface SearchResult {
  kind: 'document' | 'vault-item';
  id: string;
  businessId: string;
  businessName: string;
  title: string;
  snippet: string;
  date: string | null;
  state: string | null;
}

export interface VaultAddOnState {
  businessId: string;
  enabled: boolean;
  available: boolean;
  subscriptionStatus: string | null;
}

export type ImportSource = 'dext' | 'hubdoc' | 'autoentry' | 'datamolino' | 'generic';
export const IMPORT_FIELDS = [
  'date', 'supplier', 'reference', 'net', 'vat', 'total', 'category', 'description', 'image', 'currency',
] as const;
export type ImportField = (typeof IMPORT_FIELDS)[number];
export type ImportMapping = Partial<Record<ImportField, string>>;

export interface ImportRow {
  rowNumber: number;
  supplierName: string | null;
  documentDate: string | null;
  reference: string | null;
  netPence: number | null;
  taxPence: number | null;
  totalPence: number | null;
  categoryCode: string | null;
  description: string | null;
  imageFilename: string | null;
  hasImage: boolean;
}

export interface ImportResult {
  importId: string;
  proposalId: string;
  rowCount: number;
  matchedImages: number;
  rows: ImportRow[];
  warnings: string[];
  columns: string[];
  mapping: Record<string, string | null>;
}

interface StagedUpload {
  uploadKey: string;
  upload: { method: 'PUT'; url: string; headers: Record<string, string> };
  expiresAt: string;
  maxBytes: number;
}

// ── Vault items ────────────────────────────────────────────────────────────

export async function listVaultItems(params: { businessId?: string; toReview?: boolean }): Promise<VaultItem[]> {
  const query = new URLSearchParams();
  if (params.businessId !== undefined) query.set('businessId', params.businessId);
  if (params.toReview === true) query.set('view', 'to-review');
  const body = (await call('GET', `/vault-items?${query.toString()}`)) as { data?: VaultItem[] };
  return body.data ?? [];
}

export const vaultItemsKey = (businessId: string | undefined, toReview: boolean) =>
  ['practice-vault', businessId ?? 'all', toReview] as const;

/** Polls every 5 s while any item is still being read by the AI, and only then. */
export function useVaultItems(businessId: string | undefined, toReview: boolean, enabled = true) {
  return useQuery({
    queryKey: vaultItemsKey(businessId, toReview),
    queryFn: () => listVaultItems({ ...(businessId === undefined ? {} : { businessId }), toReview }),
    enabled,
    staleTime: 0,
    refetchInterval: (query) => ((query.state.data ?? []).some((item) => item.aiState === 'pending') ? 5000 : false),
  });
}

/** Presign → PUT → create. Returns the new item, AI analysis still pending. */
export async function uploadVaultItem(businessId: string, file: File): Promise<VaultItem> {
  const mimeType = file.type || 'application/octet-stream';
  const staged = await stage('/vault-items/uploads', businessId, file, mimeType);
  return (await call('POST', '/vault-items', {
    businessId,
    uploadKey: staged.uploadKey,
    filename: file.name,
    mimeType,
  })) as VaultItem;
}

export async function vaultItemFromDocument(documentId: string): Promise<VaultItem> {
  return (await call('POST', '/vault-items/from-document', { documentId })) as VaultItem;
}

export async function updateVaultItem(id: string, patch: VaultItemPatch): Promise<VaultItem> {
  return (await call('PATCH', `/vault-items/${encodeURIComponent(id)}`, patch)) as VaultItem;
}

export async function reanalyseVaultItem(id: string): Promise<VaultItem> {
  return (await call('POST', `/vault-items/${encodeURIComponent(id)}/analysis`, {})) as VaultItem;
}

/** Opens the short-lived presigned link in a new tab. */
export async function previewVaultItem(id: string): Promise<void> {
  // Opened BEFORE the await so the browser still counts it as the click's own
  // window — a popup opened after a network round-trip is blocked.
  const tab = window.open('', '_blank');
  try {
    const body = (await call('GET', `/vault-items/${encodeURIComponent(id)}/preview`)) as { url?: string };
    if (typeof body.url !== 'string') throw new Error('No preview link came back.');
    if (tab === null) window.location.assign(body.url);
    else tab.location.href = body.url;
  } catch (error) {
    tab?.close();
    throw error;
  }
}

/** Archived documents of one client — the candidates for "Add from archived documents". */
export async function listArchivedDocuments(
  businessId: string,
): Promise<{ id: string; supplierName: string | null; originalFilename: string; documentDate: string | null }[]> {
  const query = new URLSearchParams({ businessId, state: 'ARCHIVED', limit: '100' });
  const body = (await call('GET', `/documents?${query.toString()}`)) as {
    data?: { id: string; supplierName?: string | null; originalFilename?: string; documentDate?: string | null }[];
  };
  return (body.data ?? []).map((d) => ({
    id: d.id,
    supplierName: d.supplierName ?? null,
    originalFilename: d.originalFilename ?? d.id,
    documentDate: d.documentDate ?? null,
  }));
}

// ── Search ─────────────────────────────────────────────────────────────────

export async function searchEverything(q: string, businessId?: string): Promise<SearchResult[]> {
  const query = new URLSearchParams({ q, limit: '25' });
  if (businessId !== undefined) query.set('businessId', businessId);
  const body = (await call('GET', `/search?${query.toString()}`)) as { results?: SearchResult[] };
  return body.results ?? [];
}

/** A snippet split on the server's « » markers — matched parts flagged, never HTML. */
export function snippetParts(snippet: string): { text: string; hit: boolean }[] {
  const parts: { text: string; hit: boolean }[] = [];
  const re = /«([^»]*)»/g;
  let last = 0;
  for (let match = re.exec(snippet); match !== null; match = re.exec(snippet)) {
    if (match.index > last) parts.push({ text: snippet.slice(last, match.index), hit: false });
    parts.push({ text: match[1] ?? '', hit: true });
    last = match.index + match[0].length;
  }
  if (last < snippet.length) parts.push({ text: snippet.slice(last), hit: false });
  return parts;
}

// ── The £2 Vault add-on ────────────────────────────────────────────────────

export async function fetchVaultAddOn(businessId: string): Promise<VaultAddOnState> {
  return (await call('GET', `/billing/vault-add-on?businessId=${encodeURIComponent(businessId)}`)) as VaultAddOnState;
}

export async function setVaultAddOn(businessId: string, enabled: boolean): Promise<{ enabled: boolean; requested: boolean }> {
  return (await call('PUT', '/billing/vault-add-on', { businessId, enabled })) as { enabled: boolean; requested: boolean };
}

// ── Imports from other capture tools ───────────────────────────────────────

export async function stageImportFile(businessId: string, file: File): Promise<string> {
  const mimeType = file.type || mimeFromName(file.name);
  return (await stage('/imports/uploads', businessId, file, mimeType)).uploadKey;
}

export async function createImport(request: {
  businessId: string;
  source: ImportSource;
  uploadKeys: string[];
  mapping?: ImportMapping;
}): Promise<ImportResult> {
  return (await call('POST', '/imports', request)) as ImportResult;
}

/** Windows hands a .csv over as `application/vnd.ms-excel` or nothing at all. */
function mimeFromName(name: string): string {
  const lower = name.toLowerCase();
  if (lower.endsWith('.csv')) return 'text/csv';
  if (lower.endsWith('.zip')) return 'application/zip';
  if (lower.endsWith('.pdf')) return 'application/pdf';
  if (lower.endsWith('.png')) return 'image/png';
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg';
  if (lower.endsWith('.heic')) return 'image/heic';
  if (lower.endsWith('.tif') || lower.endsWith('.tiff')) return 'image/tiff';
  return 'application/octet-stream';
}

// ── Transport ──────────────────────────────────────────────────────────────

async function stage(path: string, businessId: string, file: File, mimeType: string): Promise<StagedUpload> {
  if (file.size > VAULT_MAX_BYTES) throw new Error(`${file.name} is over the 100 MB limit.`);
  const staged = (await call('POST', path, {
    businessId,
    filename: file.name,
    mimeType,
    byteSize: file.size,
  })) as StagedUpload;
  // `putBytes` wants the intent shape; only `upload` is read.
  await putBytes({ uploadId: staged.uploadKey, upload: staged.upload, expiresAt: staged.expiresAt, maxBytes: staged.maxBytes }, file);
  return staged;
}

// Re-exported so a caller hashing for its own reasons does not reach into the transport.
export { sha256Hex };

async function call(method: 'GET' | 'POST' | 'PUT' | 'PATCH', path: string, body?: unknown): Promise<unknown> {
  const headers: Record<string, string> = {};
  if (method !== 'GET') {
    headers['Content-Type'] = 'application/json';
    // Every mutation takes one (Governance §3).
    headers['Idempotency-Key'] = crypto.randomUUID();
  }
  const response = await fetch(`${apiBase()}${path}`, {
    method,
    headers,
    credentials: 'include',
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!response.ok) throw new Error(await readProblem(response));
  return response.status === 204 ? {} : await response.json();
}

function apiBase(): string {
  const configured = (import.meta as unknown as { env?: Record<string, string | undefined> }).env?.VITE_API_BASE_URL;
  return `${configured ?? ''}/v1`;
}

async function readProblem(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { detail?: string; title?: string };
    return body.detail ?? body.title ?? `That did not work (${response.status}).`;
  } catch {
    return `That did not work (${response.status}).`;
  }
}
