import { completeDocumentUpload, createDocumentUpload, getListDocumentsQueryKey } from '@neoting/contracts/client';
import { completeDocumentUploadBody, createDocumentUploadBody } from '@neoting/contracts/zod';
import type { DocumentUploadRequest } from '@neoting/contracts/model';
import type { QueryClient } from '@tanstack/react-query';
import { defineMessages, type IntlShape } from 'react-intl';
import { z } from 'zod';
import { commonActions } from '../i18n/common';
import type { ConfirmOptions, ConfirmResult } from '../components/DynamicComponents/ConfirmProvider';
import { unwrapBody } from './envelope';
import { documentUploadShape, putBytes, sha256Hex } from './upload-transport';

/**
 * The practice-side web upload (METH S7): drag-drop or file-picker in the
 * workspace becomes a real document in the pipeline.
 *
 * Three calls, and only two are ours — the same journey the OTP portal makes
 * (`portal.ts`), at the workspace trust level:
 *
 *   POST /document-uploads                      the intent → a presigned PUT
 *   PUT  <presigned url>                        the bytes, straight to storage
 *   POST /document-uploads/{uploadId}/complete  verify + enter the pipeline
 *
 * The API never carries the file. Authentication is the httpOnly session
 * cookie `ntFetch` always sends — no token is handled here, and the presigned
 * `PUT` (via `portal.ts`'s `putBytes`, the one raw `fetch` in `src/`)
 * deliberately carries no credential at all.
 */

export interface WorkspaceUploadFile {
  filename: string;
  /** The browser's declared type. A hint only — the server sniffs magic bytes. */
  mimeType: string;
  bytes: Blob;
}

/**
 * The server id for a workspace the synthetic side calls `clientId`.
 *
 * The seed dataset's client ids ("burger") predate the API; the seeded server
 * businesses are `biz_<id>` (the same convention `clientNameFor` in
 * `AppContext` resolves in the other direction). A real, opaque id passes
 * through untouched. This mapping retires when the clients list itself reads
 * from `GET /businesses` (METH S6's hydration architecture).
 */
export function serverBusinessIdFor(clientId: string): string {
  return clientId.startsWith('biz_') ? clientId : `biz_${clientId}`;
}

/** What the caller needs back: the document now in the pipeline. */
const completedDocumentShape = z.object({ id: z.string().min(1), state: z.string() });

export interface WorkspaceUploadResult {
  documentId: string;
  /** RECEIVED or PROCESSING — extraction is a queued job, never inline. */
  state: string;
}

export async function sendWorkspaceUpload(businessId: string, file: WorkspaceUploadFile): Promise<WorkspaceUploadResult> {
  const request: DocumentUploadRequest = {
    businessId,
    channel: 'WEB_UPLOAD',
    filename: file.filename,
    mimeType: file.mimeType,
    byteSize: file.bytes.size,
  };
  // Parsed on the way out as well as in: the contract's own schema decides
  // that 255 characters and a byte count of at least 1 are the rules, and a
  // request that would be refused is better caught before the network.
  createDocumentUploadBody.parse(request);

  const intent = documentUploadShape.parse(unwrapBody(await createDocumentUpload(request)));
  await putBytes(intent, file.bytes);

  const completion = completeDocumentUploadBody.parse({ byteHash: await sha256Hex(file.bytes) });
  const document = completedDocumentShape.parse(unwrapBody(await completeDocumentUpload(intent.uploadId, completion)));
  return { documentId: document.id, state: document.state };
}

export interface WorkspaceUploadsOutcome {
  sent: number;
  /** One line per refused file — filename plus the server's own reason. */
  failures: string[];
}

/**
 * A whole drop of files into one workspace, sequentially — a drop is a handful
 * of files, and interleaving presigns buys nothing worth the harder failure
 * story. One file's refusal never stops the rest; the caller gets the tally
 * and the named failures to show. Shared by both views that take a drop, so
 * the journey exists once.
 */
export async function sendWorkspaceUploads(businessId: string, files: File[]): Promise<WorkspaceUploadsOutcome> {
  const failures: string[] = [];
  let sent = 0;
  for (const file of files) {
    try {
      await sendWorkspaceUpload(businessId, { filename: file.name, mimeType: file.type || 'application/octet-stream', bytes: file });
      sent += 1;
    } catch (error) {
      failures.push(`${file.name} — ${error instanceof Error ? error.message : 'upload failed'}`);
    }
  }
  return { sent, failures };
}

const m = defineMessages({
  failedTitle: {
    id: 'documents.workspaceUpload.failedTitle',
    defaultMessage: '{count, plural, one {# file was refused} other {# files were refused}}',
  },
});

/**
 * The whole drop plus its failure story, shared by both views that take one.
 * Not a component, so `intl` and the view's own `confirm` come in as arguments
 * — the `lib/dedupe.ts` shape §12.6 allows for a module with no hooks. Success
 * is silent here (the Processing tab is the feedback); a refusal names its
 * files and the server's reasons.
 */
export async function runWorkspaceDrop(
  intl: IntlShape,
  confirm: (options: ConfirmOptions) => Promise<ConfirmResult>,
  businessId: string,
  files: File[],
): Promise<WorkspaceUploadsOutcome> {
  const outcome = await sendWorkspaceUploads(businessId, files);
  if (outcome.failures.length > 0) {
    await confirm({
      tone: 'red',
      title: intl.formatMessage(m.failedTitle, { count: outcome.failures.length }),
      detail: outcome.failures.slice(0, 3).join(' · '),
      confirmLabel: intl.formatMessage(commonActions.close),
    });
  }
  return outcome;
}

/**
 * Nudge every documents list to refetch now rather than on the next 5-second
 * poll — the difference between a drop feeling instant and feeling queued.
 * Prefix key, so it reaches the list regardless of which params a caller used.
 */
export async function refreshDocuments(queryClient: QueryClient): Promise<void> {
  await queryClient.invalidateQueries({ queryKey: getListDocumentsQueryKey() });
}
