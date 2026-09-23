import { Logger } from '@nestjs/common';
import { z } from 'zod';

import type { DriveVendor } from './drive-vendors.js';

/**
 * Talking to Google Drive and OneDrive (D51).
 *
 * Three operations, and the vault needs no more: say whose account this is,
 * make a folder, put a file in it. Nothing here reads a client's drive — the
 * scopes chosen in `drive-vendors.ts` make that structurally impossible, which
 * is the point.
 *
 * ## The rules this file inherits
 *
 * They are the ledger's, because they are about talking to somebody else's API
 * and nothing about that changed:
 *
 * 1. **No external call holds a tenant transaction open.** Every method here is
 *    called from the export runner between short `scopedDb` transactions.
 * 2. **A per-file failure is a RESULT, not a throw.** A run of four hundred
 *    documents where Google refuses one must copy the other three hundred and
 *    ninety-nine and record the one. Only `createFolder` throws, because a run
 *    with nowhere to put anything has genuinely not started.
 * 3. **Zod at the boundary.** Vendor JSON is untrusted input.
 */

/** What a file upload did. Never a throw — see rule 2. */
export type UploadResult = { readonly ok: true } | { readonly ok: false; readonly reason: string };

export interface DriveAccount {
  /** The account as the vendor names it, for the connection screen. Null where it will not say. */
  readonly label: string | null;
}

const GoogleFileSchema = z.object({ id: z.string().min(1) }).passthrough();
const GraphItemSchema = z.object({ id: z.string().min(1) }).passthrough();
const GoogleUserSchema = z
  .object({ user: z.object({ emailAddress: z.string().nullish() }).passthrough().nullish() })
  .passthrough();
const GraphUserSchema = z
  .object({ userPrincipalName: z.string().nullish(), mail: z.string().nullish() })
  .passthrough();

export class DriveAdapter {
  private readonly logger = new Logger(DriveAdapter.name);

  constructor(
    private readonly vendor: DriveVendor,
    private readonly accessToken: string,
    private readonly fetchImpl: typeof fetch = globalThis.fetch,
  ) {}

  /**
   * Whose drive this is.
   *
   * ⚠ Failure is NOT fatal and returns a null label. A client with two Google
   * accounts benefits from seeing which one they connected, and a client whose
   * profile read failed still has a working connection — refusing the whole
   * connect over a cosmetic field would be the ledger's GUID bug in reverse.
   */
  async account(): Promise<DriveAccount> {
    try {
      if (this.vendor.slug === 'google-drive') {
        const body = await this.json(`${this.vendor.apiBase}/about?fields=user(emailAddress)`);
        return { label: GoogleUserSchema.parse(body).user?.emailAddress ?? null };
      }
      const body = await this.json(`${this.vendor.apiBase}/me`);
      const user = GraphUserSchema.parse(body);
      return { label: user.mail ?? user.userPrincipalName ?? null };
    } catch (error) {
      this.logger.warn(`${this.vendor.label} would not say whose account this is: ${message(error)}`);
      return { label: null };
    }
  }

  /**
   * Make the folder this run copies into, and return its id.
   *
   * ⚠ **Always a NEW folder, never reused, and that is deliberate.** Two runs a
   * month apart must not interleave into one directory where the client cannot
   * tell which copy is which — and with `drive.file` we could not reliably find
   * an old folder anyway (see the scope note in `drive-vendors.ts`). The name
   * carries the date, so the client's drive reads as a history.
   *
   * This is the one operation that throws: a run with nowhere to put anything
   * has not partially succeeded, it has not begun.
   */
  async createFolder(name: string): Promise<string> {
    if (this.vendor.slug === 'google-drive') {
      const body = await this.json(`${this.vendor.apiBase}/files`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, mimeType: 'application/vnd.google-apps.folder' }),
      });
      return GoogleFileSchema.parse(body).id;
    }
    const body = await this.json(`${this.vendor.apiBase}/me/drive/root/children`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name,
        folder: {},
        // Microsoft's name for "if one already exists, make a differently named
        // one" — never "overwrite", which on a folder would merge two runs.
        '@microsoft.graph.conflictBehavior': 'rename',
      }),
    });
    return GraphItemSchema.parse(body).id;
  }

  /**
   * Put one document in the folder.
   *
   * ⚠ Returns a RESULT. Everything here is per-file and recoverable: a file the
   * vendor refuses is a counted failure on the run, not the end of it.
   */
  async upload(folderId: string, filename: string, contentType: string, bytes: Buffer): Promise<UploadResult> {
    if (bytes.byteLength > this.vendor.simpleUploadMaxBytes) {
      // Honest rather than silently truncating or retrying forever. Our intake
      // does not accept files this large, so this is a guard against a future
      // change upstream rather than a path anyone is expected to hit.
      return {
        ok: false,
        reason: `the file is larger than ${this.vendor.label} accepts in one piece`,
      };
    }
    try {
      if (this.vendor.slug === 'google-drive') {
        await this.googleUpload(folderId, filename, contentType, bytes);
      } else {
        await this.graphUpload(folderId, filename, contentType, bytes);
      }
      return { ok: true };
    } catch (error) {
      return { ok: false, reason: message(error) };
    }
  }

  /**
   * Google's multipart upload: one request carrying the metadata and the bytes.
   *
   * ⚠ Hand-built rather than `FormData`, because Google wants
   * `multipart/related` with a specific part order, and `FormData` emits
   * `multipart/form-data` — which Drive answers with a 400 that names nothing
   * useful.
   */
  private async googleUpload(folderId: string, filename: string, contentType: string, bytes: Buffer): Promise<void> {
    const boundary = `nt${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
    const metadata = JSON.stringify({ name: filename, parents: [folderId] });
    const body = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metadata}\r\n`, 'utf8'),
      Buffer.from(`--${boundary}\r\nContent-Type: ${contentType}\r\n\r\n`, 'utf8'),
      bytes,
      Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8'),
    ]);
    await this.json('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart', {
      method: 'POST',
      headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
      body: new Uint8Array(body),
    });
  }

  /**
   * Microsoft's simple upload.
   *
   * ⚠ The colon syntax is not optional: `items/{id}:/{name}:/content` addresses
   * a child BY NAME under a parent, which is the only way to create a new file
   * in a known folder in one call. `@microsoft.graph.conflictBehavior=rename`
   * rides the query string here rather than a body, because the body is the
   * file.
   */
  private async graphUpload(folderId: string, filename: string, contentType: string, bytes: Buffer): Promise<void> {
    const path = `${this.vendor.apiBase}/me/drive/items/${encodeURIComponent(folderId)}:/${encodeURIComponent(filename)}:/content?@microsoft.graph.conflictBehavior=rename`;
    await this.json(path, {
      method: 'PUT',
      headers: { 'Content-Type': contentType },
      body: new Uint8Array(bytes),
    });
  }

  /** One bearer, one status check, one parse. */
  private async json(url: string, init: RequestInit = {}): Promise<unknown> {
    const response = await this.fetchImpl(url, {
      ...init,
      headers: {
        ...(init.headers as Record<string, string> | undefined),
        Authorization: `Bearer ${this.accessToken}`,
        Accept: 'application/json',
      },
    });
    const text = await response.text();
    if (!response.ok) {
      // ⚠ The vendor's body is LOGGED and never returned. It quotes submitted
      // values back, and the caller's string reaches a client in their portal.
      this.logger.warn(`${this.vendor.label} refused ${new URL(url).pathname}: HTTP ${response.status} ${text}`);
      throw new Error(readableRefusal(this.vendor, response.status));
    }
    if (text === '') return {};
    try {
      return JSON.parse(text);
    } catch {
      throw new Error(`${this.vendor.label} answered with something this build cannot read.`);
    }
  }
}

/**
 * A vendor's refusal, in words a client can act on.
 *
 * Nothing from the body: the whole point is that this sentence is safe to show
 * somebody who does not work at the practice.
 */
function readableRefusal(vendor: DriveVendor, status: number): string {
  if (status === 401 || status === 403) {
    return `${vendor.label} refused the connection. Reconnect it from the Vault tab.`;
  }
  if (status === 404) return `${vendor.label} could not find the folder for this copy.`;
  if (status === 429) return `${vendor.label} is asking us to slow down. This will be tried again.`;
  if (status === 507 || status === 413) return `There is not enough space left in this ${vendor.label} account.`;
  return `${vendor.label} could not take this file (HTTP ${status}).`;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : 'the drive could not be reached';
}
