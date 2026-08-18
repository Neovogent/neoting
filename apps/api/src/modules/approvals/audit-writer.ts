import type { Prisma } from '@prisma/client';

import type { ScopedClient } from '../../common/db/scoped-db.js';
import { canonicalStringify, sha256Hex } from './canonical-hash.js';

/**
 * The minimal hash-chain audit writer — METH S3 (issue #122), Governance
 * §12.3. Small and real, not a mock: `hash = sha256(prev_hash +
 * canonical_payload)`, appended in the SAME transaction as the execution it
 * records, onto a table whose RLS has no UPDATE/DELETE policy and whose
 * trigger refuses both.
 *
 * **Sequence allocation — the decision prisma/CLAUDE.md's open question 4
 * asked for.** `seq` is per business (`@@unique([businessId, seq])`), and two
 * approvals landing together must not race the `max(seq)+1` read. A
 * transaction-scoped advisory lock per chain serialises exactly the writers
 * of one chain and nobody else, and releases with the commit — no lock table,
 * no schema change. For NULL-business rows the unique constraint cannot
 * protect the pair (SQL NULLs are distinct), so the lock is the ONLY thing
 * making that chain race-free — do not remove it as an optimisation.
 *
 * ⚠ Two honest limits of the NULL-business chain, recorded rather than
 * assumed away: `audit_events` carries no practice column, and its read
 * policy makes `business_id IS NULL` rows visible tenant-wide — so the
 * NULL-business chain is one global chain, serialised by one global lock.
 * Practice-anchored proposals (`document.route` on unrouted documents) land
 * there. Fixing that is an `audit_events.practice_id` column — a G7 contract
 * change, not a quiet migration here.
 *
 * `actor_pseudonym` stays NULL: the pseudonym map is explicitly out of METH
 * S3's scope, and writing the raw actor id into a column named "pseudonym"
 * would be a lie the next reader trusts. The approver is durable on the
 * proposal row (`approved_by_user_id`) and in `outcome`.
 */
export interface AuditEntry {
  readonly businessId: string | null;
  readonly event: string;
  readonly proposalId: string;
  readonly payloadHash: string;
  readonly renderedSummaryHash: string | null;
  readonly traceId: string | null;
  /** Small, safe, storable. Never untrusted content. */
  readonly outcome: Record<string, unknown>;
}

export async function appendAuditEvent(db: ScopedClient, entry: AuditEntry): Promise<void> {
  const chain = `audit:${entry.businessId ?? '(no-business)'}`;
  // Serialise this chain's writers for the rest of the transaction. Parameter
  // is bound, never interpolated (the scoped-db rule, applied here too).
  // $executeRaw, not $queryRaw: the lock function returns `void`, which
  // Prisma's row deserializer refuses — the same shape scopedDb's set_config
  // call uses, for the same reason.
  await db.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${chain}, 0))`;

  const prev = await db.auditEvent.findFirst({
    where: { businessId: entry.businessId },
    orderBy: { seq: 'desc' },
    select: { seq: true, hash: true },
  });
  const seq = (prev?.seq ?? 0n) + 1n;
  const previousHash = prev?.hash ?? null;
  const hash = sha256Hex(
    (previousHash ?? '') +
      canonicalStringify({
        businessId: entry.businessId,
        seq: seq.toString(),
        event: entry.event,
        proposalId: entry.proposalId,
        payloadHash: entry.payloadHash,
        renderedSummaryHash: entry.renderedSummaryHash,
        outcome: entry.outcome,
      }),
  );

  await db.auditEvent.create({
    data: {
      businessId: entry.businessId,
      seq,
      previousHash,
      hash,
      event: entry.event,
      proposalId: entry.proposalId,
      payloadHash: entry.payloadHash,
      renderedSummaryHash: entry.renderedSummaryHash,
      traceId: entry.traceId,
      outcome: entry.outcome as Prisma.InputJsonObject,
    },
  });
}
