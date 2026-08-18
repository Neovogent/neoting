/**
 * The sender→workspace map that turns a recognised sender into a routed
 * document (METH Stage 5, SoT §4 Stage 1 step 1). `decideRouting` was written
 * pure over a supplied map and, until this, was ALWAYS called with an empty one
 * — so every email landed Unrouted. This is the wiring that fills the map from
 * the practice's own contacts, without touching `decideRouting` or the schema.
 *
 * A sender is recognised by the identity they wrote FROM: the email address or
 * (later, WhatsApp) the E164 phone of a `Contact` on one of the practice's
 * businesses. The value is a list of businessIds because the same identity may
 * legitimately belong to more than one workspace — `decideRouting` renders that
 * as the "Which company?" prompt rather than guessing.
 *
 * Two halves, deliberately split:
 *  - `buildSenderMap` is PURE — rows in, map out, no Prisma, unit-testable
 *    offline. It is where the key-normalisation rules live, in one place, so
 *    email look-up and phone look-up cannot disagree about what a key is.
 *  - `PrismaSenderMapLoader` reads those rows through `scopedDb` under the
 *    practice's SYSTEM context — the SAME privileged-but-policed path the sink
 *    and the duplicate detector use — and hands them to `buildSenderMap`.
 */

import type { PrismaClient } from '../../../../common/db/prisma.js';
import { resolveSystemActor } from '../../../../common/db/resolve-system-actor.js';
import { systemContext } from '../../../../common/db/scope-context.js';
import { scopedDb } from '../../../../common/db/scoped-db.js';

/** One contact identity row, as `buildSenderMap` needs it — nothing more. */
export interface SenderMapRow {
  readonly email: string | null;
  readonly mobileE164: string | null;
  readonly businessId: string;
}

/**
 * Build the sender→businessIds map from contact rows. PURE.
 *
 * Keys on BOTH the lower-cased email AND the E164 phone, so a sender is matched
 * whichever identity they arrive under. `processEmail` lower-cases `email.from`
 * before the look-up (email-intake.ts), so the email key MUST be lower-cased here
 * to meet it — an email header's casing is not significant and must not decide
 * routing. The phone is keyed BOTH with and without a leading `+`: a stored E164
 * carries it, but a WhatsApp `wa_id`/`from` arrives without it, so both forms are
 * keys or a WhatsApp sender could never match.
 *
 * Duplicates collapse: two contacts on the same business sharing an identity, or
 * the same identity listed twice, yield ONE businessId in the list, not two. A
 * repeated businessId would make `decideRouting` see `length > 1` and raise a
 * spurious "Which company?" for what is really one workspace.
 */
export function buildSenderMap(rows: readonly SenderMapRow[]): ReadonlyMap<string, readonly string[]> {
  // A Set per key while building, so duplicate businessIds collapse; frozen to
  // plain arrays at the end so the value matches `decideRouting`'s signature.
  const building = new Map<string, Set<string>>();

  const add = (rawKey: string | null, businessId: string): void => {
    if (rawKey === null) return;
    const key = rawKey.trim();
    if (key === '') return;
    const businesses = building.get(key) ?? new Set<string>();
    businesses.add(businessId);
    building.set(key, businesses);
  };

  for (const row of rows) {
    add(row.email === null ? null : row.email.toLowerCase(), row.businessId);
    // A phone is a stable token (not lower-cased, only trimmed). Key it BOTH as
    // stored (`+447700900001`) and without the leading `+` (`447700900001`),
    // because Meta sends a WhatsApp `from`/`wa_id` without the `+` while a stored
    // E164 carries it — so a WhatsApp sender matches either way.
    add(row.mobileE164, row.businessId);
    if (row.mobileE164 !== null && row.mobileE164.trim().startsWith('+')) {
      add(row.mobileE164.trim().slice(1), row.businessId);
    }
  }

  const map = new Map<string, readonly string[]>();
  for (const [key, businesses] of building) {
    map.set(key, [...businesses]);
  }
  return map;
}

/**
 * Loads the sender map for a practice. An interface so the runner can be tested
 * with a fake (no DB) and the real path is DI-selected, not import-selected —
 * the house pattern.
 */
export interface SenderMapLoader {
  load(practiceId: string): Promise<ReadonlyMap<string, readonly string[]>>;
}

/**
 * The offline fixture: every practice resolves to an empty map, which is exactly
 * today's behaviour (everything Unrouted). It exists so a test — or a run with
 * no contacts to speak of — has a loader to inject that touches no database.
 */
export class EmptySenderMapLoader implements SenderMapLoader {
  async load(_practiceId: string): Promise<ReadonlyMap<string, readonly string[]>> {
    return new Map<string, readonly string[]>();
  }
}

/**
 * The real loader: read the practice's contacts through `scopedDb` under the
 * practice's SYSTEM context, then `buildSenderMap`.
 *
 * Contacts reach their tenant through the business (`contacts.business_id`), and
 * the `contacts` RLS policy is `app_can_access_business(business_id)` — whose
 * practice-membership branch admits a SYSTEM actor whose practice owns the
 * business (rls.sql, the same branch the sink and detector rely on). So a
 * practice-only system context sees exactly this practice's contacts and no
 * other's — the query does not filter by practice by hand; RLS does, and a bug
 * in the WHERE clause cannot widen it.
 *
 * A contact with neither an email nor a phone contributes nothing (the WHERE
 * skips it), so it never becomes a null key.
 */
export class PrismaSenderMapLoader implements SenderMapLoader {
  constructor(private readonly prisma: PrismaClient) {}

  async load(practiceId: string): Promise<ReadonlyMap<string, readonly string[]>> {
    const systemUserId = await resolveSystemActor(this.prisma, practiceId);

    const rows = await scopedDb(this.prisma, systemContext(practiceId, systemUserId), (db) =>
      db.contact.findMany({
        where: { OR: [{ email: { not: null } }, { mobileE164: { not: null } }] },
        select: { email: true, mobileE164: true, businessId: true },
      }),
    );

    return buildSenderMap(rows);
  }
}
