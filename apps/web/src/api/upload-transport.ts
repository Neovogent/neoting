import { z } from 'zod';
import { NtTransportError } from '@neoting/contracts';
import type { DocumentUpload } from '@neoting/contracts/model';

/**
 * The transport half of an upload, shared by the two surfaces that send bytes:
 * the OTP portal (`portal.ts`) and the practice workspace (`uploads.ts`).
 *
 * Its own module for a bundle reason as much as a reuse one: the practice
 * screens must not import the portal module (its journey, its schemas, its
 * copy) just to PUT a file, and the portal — the lightest surface in the
 * product — must not inherit anything of the workspace's. What both genuinely
 * share is exactly this: the 201 intent shape, the raw PUT, and the hash.
 */

/** The 201 intent shape both `POST /document-uploads` and `POST /portal/uploads` return. */
export const documentUploadShape = z.object({
  uploadId: z.string().min(1),
  upload: z.object({
    method: z.literal('PUT'),
    url: z.string().min(1),
    headers: z.record(z.string()),
  }),
  expiresAt: z.string(),
});

/**
 * The bytes, straight to object storage.
 *
 * ⚠ THE ONE RAW `fetch` IN `src/`, AND IT CANNOT BE ANYTHING ELSE. This request
 * does not go to the Neoting API: it goes to the presigned URL the API just
 * handed us, on the storage host, with a signature that covers the method, the
 * URL and the headers exactly as given. Putting it through `ntFetch` would
 * prefix `/v1`, attach `credentials: 'include'`, add an `Idempotency-Key` and
 * an `Accept`, and the signature would no longer match what was signed. The
 * headers are sent verbatim for the same reason — and no credential of ours
 * (cookie or bearer) may ever travel here.
 *
 * This is also the whole point of the presign: the API never carries the
 * photograph, so the lightest surface in the product stays light on a bad
 * connection in a car park (SoT §14).
 */
export async function putBytes(intent: DocumentUpload, bytes: Blob): Promise<void> {
  let response: Response;
  try {
    response = await fetch(intent.upload.url, {
      method: intent.upload.method,
      headers: intent.upload.headers,
      body: bytes,
    });
  } catch (cause) {
    throw new NtTransportError(cause instanceof Error ? cause.message : 'Upload failed');
  }
  if (!response.ok) throw new NtTransportError(`Upload rejected by storage (${response.status})`, response.status);
}

/**
 * SHA-256 of what was actually sent, hex, lowercase — the contract's shape for
 * `byteHash`, and the exact re-send signal dedupe keys on (SoT Stage 6).
 */
export async function sha256Hex(bytes: Blob): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', await bytes.arrayBuffer());
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}
