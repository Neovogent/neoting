/**
 * Object storage for sanitised documents (issue #16). Same interface-plus-fixture
 * shape as `VirusScanner` / `IngestQueue` / `EmailParser`, so unit tests stay
 * offline and the real S3 client drops in behind the interface.
 */

export interface StoredDocument {
  readonly key: string;
  readonly sha256: string;
  readonly byteLength: number;
}

export interface DocumentStorePutInput {
  readonly bytes: Buffer;
  readonly sha256: string;
  readonly contentType: string;
  /** The routed workspace, or null when the document is Unrouted. */
  readonly workspaceId: string | null;
}

export interface DocumentStore {
  put(input: DocumentStorePutInput): Promise<StoredDocument>;
  get(key: string): Promise<Buffer>;
}

/**
 * The reserved pseudo-workspace for Unrouted documents. Unrouted mail has no
 * workspace yet, but the object must still live SOMEWHERE under `w/` (see
 * `documentKey`). `_unrouted` sits under that prefix so the IAM policy grants it,
 * and its leading underscore cannot collide with a real workspace id (business
 * ids are cuid/uuid — never `_`-prefixed). When routing later assigns a
 * workspace, the object is re-keyed under it; nothing here deletes.
 */
export const UNROUTED_WORKSPACE = '_unrouted';

/**
 * The object key for a sanitised document. **Every key starts `w/` — this is a
 * hard constraint, not a style choice.** The staging IAM policy grants the task
 * role `<bucket>/w/*` (and `receipts/inbound/*`) and nothing else, so a key that
 * ignores the prefix passes every unit test and then `AccessDenied`s in staging
 * — the reason lives in `infra/envs/staging/policies`, which the next person
 * will not think to read, which is why it is written here.
 *
 * Content-addressed on the sha256: an identical file stored twice is one object,
 * and the key is therefore stable for identical content (what lets an SES
 * redelivery collapse rather than duplicate).
 */
export function documentKey(workspaceId: string | null, sha256: string): string {
  const workspace = workspaceId ?? UNROUTED_WORKSPACE;
  return `w/${workspace}/documents/${sha256}`;
}

/**
 * Offline fixture — an in-memory map keyed exactly as S3 would be. Non-negotiable
 * so `pnpm test` never needs Docker (issue #16).
 */
export class InMemoryDocumentStore implements DocumentStore {
  private readonly objects = new Map<string, Buffer>();

  async put(input: DocumentStorePutInput): Promise<StoredDocument> {
    const key = documentKey(input.workspaceId, input.sha256);
    this.objects.set(key, input.bytes); // content-addressed → idempotent overwrite
    return { key, sha256: input.sha256, byteLength: input.bytes.length };
  }

  async get(key: string): Promise<Buffer> {
    const bytes = this.objects.get(key);
    if (bytes === undefined) throw new Error(`no object stored at key ${key}`);
    return bytes;
  }
}
