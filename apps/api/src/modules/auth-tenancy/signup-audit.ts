import { createHash } from 'node:crypto';

import type { Prisma } from '@prisma/client';

/**
 * The terms-acceptance audit row, appended inside the signup transaction.
 *
 * `POST /v1/practices` in `openapi.yaml`: *"Acceptance of the terms in force is
 * recorded as an `audit_events` row rather than a column: what a person agreed
 * to, and when, is an event about a person, and the audit stream is append-only
 * and hash-chained."* This is that row.
 *
 * ⚠ **THIS DUPLICATES `modules/approvals/audit-writer.ts`, KNOWINGLY.** The
 * chain formula, the advisory-lock key and the canonical field set below are
 * copied from it byte for byte, because both write into the SAME
 * `business_id IS NULL` chain and a chain whose links were computed two
 * different ways cannot be verified at all. They are not shared because
 * `modules/approvals/` has no `index.ts` public seam and A1 owns only
 * `modules/auth-tenancy/` — creating that seam is another stage's file.
 * `appendAuditEvent` would not have fitted unchanged anyway: its `AuditEntry`
 * requires a non-null `proposalId`, and a signup has no proposal.
 *
 * **Drift is pinned, not hoped for.** `practice-signup.integration.test.ts`
 * imports `approvals/canonical-hash.ts` (integration tests are exempt from the
 * module-boundary rule, by design — they are composition roots) and asserts the
 * two implementations agree digest-for-digest. When approvals grows a seam,
 * delete this file, import theirs, and that test keeps its meaning.
 *
 * **On the advisory lock:** `seq` is `@@unique([businessId, seq])`, and SQL
 * NULLs are distinct — so for the NULL-business chain the unique constraint
 * protects nothing and this lock is the ONLY thing making `max(seq)+1`
 * race-free. Two signups landing together, or a signup landing beside an
 * approval, would otherwise collide. Do not remove it as an optimisation.
 */

/** Signup is unscoped, so the row is written by the transaction client directly. */
type TransactionClient = Prisma.TransactionClient;

export interface TermsAcceptance {
  readonly practiceId: string;
  readonly userId: string;
  /** Hashed into `payload_hash`, never stored in a column — see below. */
  readonly email: string;
  readonly acceptedTermsVersion: string;
  readonly acceptedAt: Date;
  readonly traceId: string | null;
}

/** The event name. Stable — it is what a later erasure or consent query greps for. */
export const TERMS_ACCEPTED_EVENT = 'practice.terms-accepted';

export async function appendTermsAcceptanceEvent(tx: TransactionClient, acceptance: TermsAcceptance): Promise<void> {
  const chain = 'audit:(no-business)';
  // Parameter is bound, never interpolated. `$executeRaw`, not `$queryRaw`:
  // the lock function returns `void`, which Prisma's row deserializer refuses.
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${chain}, 0))`;

  const previous = await tx.auditEvent.findFirst({
    where: { businessId: null },
    orderBy: { seq: 'desc' },
    select: { seq: true, hash: true },
  });
  const seq = (previous?.seq ?? 0n) + 1n;
  const previousHash = previous?.hash ?? null;

  // The ADDRESS goes into the hash, not into a column. `audit_events` is
  // append-only by policy AND by trigger, so anything written here can never be
  // erased — and a mailbox is personal data with an erasure right attached. The
  // hash proves which address accepted, if it is ever put to us, without the
  // stream becoming a permanent copy of it. `users.email` is the erasable
  // record.
  const payloadHash = sha256Hex(
    canonicalStringify({
      practiceId: acceptance.practiceId,
      userId: acceptance.userId,
      email: acceptance.email,
      acceptedTermsVersion: acceptance.acceptedTermsVersion,
    }),
  );

  const outcome = {
    practiceId: acceptance.practiceId,
    userId: acceptance.userId,
    acceptedTermsVersion: acceptance.acceptedTermsVersion,
    acceptedAt: acceptance.acceptedAt.toISOString(),
  };

  const hash = sha256Hex(
    (previousHash ?? '') +
      canonicalStringify({
        businessId: null,
        seq: seq.toString(),
        event: TERMS_ACCEPTED_EVENT,
        proposalId: null,
        payloadHash,
        renderedSummaryHash: null,
        outcome,
      }),
  );

  await tx.auditEvent.create({
    data: {
      businessId: null,
      seq,
      previousHash,
      hash,
      event: TERMS_ACCEPTED_EVENT,
      // No proposal: signup is the one operation that PRECEDES the tenant, so
      // there is no practice for a proposal to have been reviewed inside of.
      // The account does not exist until this transaction commits.
      proposalId: null,
      payloadHash,
      renderedSummaryHash: null,
      traceId: acceptance.traceId,
      outcome: outcome as Prisma.InputJsonObject,
    },
  });
}

/**
 * Canonical JSON: keys sorted, `undefined` dropped, arrays in order. Copied from
 * `approvals/canonical-hash.ts` — see the file header for why, and for the test
 * that stops the copy from drifting.
 */
export function canonicalStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalStringify).join(',')}]`;
  const entries = Object.entries(value)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${JSON.stringify(k)}:${canonicalStringify(v)}`);
  return `{${entries.join(',')}}`;
}

/** Lower-case hex, 64 chars — the shape the contract's hash patterns pin. */
export function sha256Hex(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}
