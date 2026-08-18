import { createHash } from 'node:crypto';

/**
 * `Idempotency-Key` honouring (D10). A replayed key returns the ORIGINAL
 * response and does no work twice; the same key with a DIFFERENT payload is a
 * client bug and returns 409 `NT-IDM-001` rather than silently doing the wrong
 * thing to someone's books.
 *
 * MOVED here from `modules/ingestion-routing/web-upload/` when the proposal
 * engine (METH S3, issue #122) became its second consumer — the same choice
 * `document-response.ts` made in #77: one mechanism two modules share lives in
 * `common/`, because a second copy is how two surfaces start disagreeing about
 * what a replay is.
 *
 * In-memory and per-process for now — enough for one API instance and the tests.
 * A durable store (Redis/Postgres) is a follow-up; there is no idempotency table
 * (prisma/ is LAW), so this stays behind an interface to swap later.
 */
export interface IdempotencyRecord {
  readonly requestHash: string;
  readonly response: unknown;
}

export interface IdempotencyStore {
  get(key: string): Promise<IdempotencyRecord | null>;
  put(key: string, record: IdempotencyRecord): Promise<void>;
}

export class InMemoryIdempotencyStore implements IdempotencyStore {
  private readonly records = new Map<string, IdempotencyRecord>();

  async get(key: string): Promise<IdempotencyRecord | null> {
    return this.records.get(key) ?? null;
  }

  async put(key: string, record: IdempotencyRecord): Promise<void> {
    this.records.set(key, record);
  }
}

/** A stable fingerprint of a request, so a replayed key with a changed payload is caught. */
export function fingerprint(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
