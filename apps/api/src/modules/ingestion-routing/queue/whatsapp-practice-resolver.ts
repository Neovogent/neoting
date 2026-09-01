import type { PrismaClient } from '../../../common/db/prisma.js';
import { systemContext } from '../../../common/db/scope-context.js';
import { scopedDb } from '../../../common/db/scoped-db.js';

/**
 * phone_number_id → practice, from `Practice.whatsappPhoneNumberId` (#79's
 * promised column, landed 1 Sep 2026).
 *
 * The controller keeps resolving through `WHATSAPP_PRACTICE_MAP` — it has no
 * database and a webhook must answer Meta fast — so the env map WINS when set.
 * This resolver is the worker's fallback for a number the env never named:
 * before this, such a job could only dead-letter with "set
 * WHATSAPP_PRACTICE_MAP", turning a one-column fact into an ECS task-definition
 * edit.
 *
 * The lookup is the sanctioned sweep (`resolveChase` / `resolveInvite`'s
 * pattern): ONE unscoped read over `memberships` joined to `users` — the actor
 * tables that carry no RLS — yields each practice's SYSTEM actor, and each
 * candidate context is asked for ITS OWN practice row's number. RLS answers,
 * not a filter: a practice-scoped context can read exactly its own practice.
 * The column is UNIQUE, so at most one practice answers. It runs once per
 * unmapped inbound message, never on a hot path, and the worker's job is
 * already the async spine where a few queries cost nothing anyone waits on.
 */
export interface WhatsAppPracticeResolver {
  byPhoneNumberId(phoneNumberId: string): Promise<string | null>;
}

/** The offline fixture: nothing maps, which is exactly the pre-column behaviour. */
export class EmptyWhatsAppPracticeResolver implements WhatsAppPracticeResolver {
  async byPhoneNumberId(_phoneNumberId: string): Promise<string | null> {
    return null;
  }
}

export class PrismaWhatsAppPracticeResolver implements WhatsAppPracticeResolver {
  constructor(private readonly prisma: PrismaClient) {}

  async byPhoneNumberId(phoneNumberId: string): Promise<string | null> {
    const rows = await this.prisma.membership.findMany({
      where: { practiceId: { not: null }, user: { kind: 'SYSTEM' } },
      select: { practiceId: true, userId: true },
      orderBy: { createdAt: 'asc' },
    });

    const seen = new Set<string>();
    for (const row of rows) {
      if (row.practiceId === null || seen.has(row.practiceId)) continue;
      seen.add(row.practiceId);
      const practice = await scopedDb(this.prisma, systemContext(row.practiceId, row.userId), (db) =>
        db.practice.findUnique({ where: { id: row.practiceId as string }, select: { whatsappPhoneNumberId: true } }),
      );
      if (practice?.whatsappPhoneNumberId === phoneNumberId) return row.practiceId;
    }
    return null;
  }
}
