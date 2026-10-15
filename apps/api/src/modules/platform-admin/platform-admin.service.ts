import { HttpStatus, Logger } from '@nestjs/common';
import type { Prisma } from '@prisma/client';

import type { PrismaClient } from '../../common/db/prisma.js';
import { createSystemActor } from '../../common/db/resolve-system-actor.js';
import { systemContext } from '../../common/db/scope-context.js';
import { type ScopedClient, scopedDb } from '../../common/db/scoped-db.js';
import { sharedFeatureFlags } from '../../common/flags/feature-flags.js';
import { AppException } from '../../common/problem/problem.js';
import { currentTraceId } from '../../common/trace/trace-context.js';
import { appendAuditEvent, canonicalStringify, sha256Hex } from '../approvals/index.js';
import { isSignInLocked, normaliseEmail, type PlatformAdmin, unlockSignInAddress } from '../auth-tenancy/index.js';
import { buildInviteLink, hashSetupToken, mintSetupToken, setupLinkExpiry } from '../clients-team-settings/index.js';
import type { NotificationsService } from '../notifications/index.js';

/**
 * The platform support console (rush/admin).
 *
 * ## How it reads across tenants WITHOUT weakening RLS
 *
 * - `practices`, `users` and `memberships` carry no RLS at all (they are the
 *   tables the policies read), so they are read with the root client — the
 *   same exemption `backfill-system-actors.ts` and `loadScopeForUser` rely on.
 * - EVERYTHING policed (businesses, documents, contacts, invites,
 *   integrations, audit, overrides) is read per practice inside
 *   `scopedDb(systemContext(practiceId, systemActor))` — the sanctioned sweep.
 *   RLS answers each question; nothing here filters by tenant by hand, and no
 *   request of a normal user is affected.
 *
 * ponytail: one scoped transaction per practice on the list — O(practices).
 * Fine at today's scale; an aggregate admin view is the upgrade.
 *
 * Every write appends an audit row naming the admin.
 */
export class PlatformAdminService {
  readonly #logger = new Logger('PlatformAdmin');

  constructor(
    private readonly prisma: PrismaClient,
    private readonly notifications: NotificationsService,
    private readonly appOrigin: string,
  ) {}

  // ── reads ────────────────────────────────────────────────────────────────

  async listPractices(query: string | undefined) {
    const [practices, memberships] = await Promise.all([
      this.prisma.practice.findMany({ select: { id: true, name: true, createdAt: true }, orderBy: { createdAt: 'desc' } }),
      this.prisma.membership.findMany({
        where: { practiceId: { not: null } },
        select: {
          practiceId: true,
          isOwner: true,
          user: { select: { id: true, kind: true, email: true, firstName: true, lastName: true, lastLoginAt: true } },
        },
      }),
    ]);

    const rows = await Promise.all(
      practices.map(async (practice) => {
        const members = memberships.filter((m) => m.practiceId === practice.id);
        const system = members.find((m) => m.user.kind === 'SYSTEM');
        const humans = members.filter((m) => m.user.kind === 'HUMAN');
        const owner = humans.find((m) => m.isOwner)?.user ?? null;
        const tenant =
          system === undefined
            ? null
            : await scopedDb(this.prisma, systemContext(practice.id, system.user.id), async (db) => {
                const [businesses, documentCount, lastDocument] = await Promise.all([
                  db.business.findMany({ select: { name: true, isActive: true, subscriptionStatus: true } }),
                  db.document.count(),
                  db.document.findFirst({ orderBy: { receivedAt: 'desc' }, select: { receivedAt: true } }),
                ]);
                return { businesses, documentCount, lastDocumentAt: lastDocument?.receivedAt ?? null };
              });
        const lastLogin = humans.reduce<Date | null>(
          (latest, m) => (m.user.lastLoginAt !== null && (latest === null || m.user.lastLoginAt > latest) ? m.user.lastLoginAt : latest),
          null,
        );
        const lastActivity = [lastLogin, tenant?.lastDocumentAt ?? null].reduce<Date | null>(
          (a, b) => (b !== null && (a === null || b > a) ? b : a),
          null,
        );
        const subscriptions: Record<string, number> = {};
        for (const b of tenant?.businesses ?? []) {
          const key = b.subscriptionStatus ?? 'NONE';
          subscriptions[key] = (subscriptions[key] ?? 0) + 1;
        }
        return {
          id: practice.id,
          name: practice.name,
          createdAt: practice.createdAt.toISOString(),
          ownerEmail: owner?.email ?? null,
          memberCount: humans.length,
          businessCount: tenant?.businesses.length ?? null,
          documentCount: tenant?.documentCount ?? null,
          lastActivityAt: lastActivity?.toISOString() ?? null,
          systemActorMissing: system === undefined,
          subscriptions,
          searchText: [
            practice.name,
            ...humans.flatMap((m) => [m.user.email ?? '', `${m.user.firstName ?? ''} ${m.user.lastName ?? ''}`]),
            ...(tenant?.businesses ?? []).map((b) => b.name),
          ]
            .join(' ')
            .toLowerCase(),
        };
      }),
    );

    const q = query?.trim().toLowerCase() ?? '';
    return rows.filter((row) => q === '' || row.searchText.includes(q)).map(({ searchText: _s, ...row }) => row);
  }

  async practiceDetail(practiceId: string) {
    const practice = await this.prisma.practice.findUnique({ where: { id: practiceId }, select: { id: true, name: true, createdAt: true } });
    if (practice === null) throw notFound('practice');

    const memberships = await this.prisma.membership.findMany({
      where: { OR: [{ practiceId }, { business: { practiceId } }] },
      select: {
        role: true,
        isOwner: true,
        hideFinancialFields: true,
        businessId: true,
        user: {
          select: { id: true, kind: true, email: true, firstName: true, lastName: true, lastLoginAt: true, deactivatedAt: true, totpEnabledAt: true },
        },
      },
    });
    const systemUserId = memberships.find((m) => m.user.kind === 'SYSTEM')?.user.id;
    const people = new Map<string, Record<string, unknown>>();
    for (const m of memberships) {
      if (m.user.kind !== 'HUMAN' || people.has(m.user.id)) continue;
      people.set(m.user.id, {
        userId: m.user.id,
        email: m.user.email,
        name: [m.user.firstName, m.user.lastName].filter(Boolean).join(' ') || null,
        role: m.role,
        isOwner: m.isOwner,
        practiceWide: m.businessId === null,
        hideFinancialFields: m.hideFinancialFields,
        lastLoginAt: m.user.lastLoginAt?.toISOString() ?? null,
        deactivated: m.user.deactivatedAt !== null,
        totpEnrolled: m.user.totpEnabledAt !== null,
        locked: m.user.email === null ? false : isSignInLocked(normaliseEmail(m.user.email)),
      });
    }

    const base = { id: practice.id, name: practice.name, createdAt: practice.createdAt.toISOString(), users: [...people.values()] };
    if (systemUserId === undefined) {
      return { ...base, systemActorMissing: true, businesses: [], invites: [], failedDocuments: [], flagOverrides: [] };
    }

    const tenant = await scopedDb(this.prisma, systemContext(practiceId, systemUserId), async (db) => {
      const [businesses, docCounts, lastDocs, invites, failed, overrides] = await Promise.all([
        db.business.findMany({
          orderBy: { name: 'asc' },
          select: {
            id: true,
            name: true,
            isActive: true,
            subscriptionStatus: true,
            plan: true,
            vaultAddon: true,
            subscriptionCurrentPeriodEnd: true,
            contacts: {
              where: { deactivatedAt: null },
              select: { id: true, firstName: true, lastName: true, email: true, mobileE164: true, isPrimary: true },
            },
            integrations: {
              select: { kind: true, isActive: true, health: true, orgName: true, lastSyncAt: true, lastErrorAt: true, lastErrorMessage: true, tokenRef: true },
            },
          },
        }),
        db.document.groupBy({ by: ['businessId', 'state'], _count: { _all: true } }),
        db.document.groupBy({ by: ['businessId'], _max: { receivedAt: true } }),
        db.invite.findMany({
          where: { acceptedAt: null },
          orderBy: { createdAt: 'desc' },
          select: { id: true, email: true, role: true, businessId: true, expiresAt: true, createdAt: true },
        }),
        db.document.findMany({
          where: { state: { in: ['FAILED', 'REJECTED'] } },
          orderBy: { updatedAt: 'desc' },
          take: 25,
          select: { id: true, businessId: true, originalFilename: true, state: true, failureCode: true, failureMessage: true, updatedAt: true },
        }),
        db.featureFlagOverride.findMany({ select: { flagKey: true, isEnabled: true } }),
      ]);
      return { businesses, docCounts, lastDocs, invites, failed, overrides };
    });

    return {
      ...base,
      systemActorMissing: false,
      businesses: tenant.businesses.map((b) => ({
        id: b.id,
        name: b.name,
        isActive: b.isActive,
        subscriptionStatus: b.subscriptionStatus,
        plan: b.plan,
        vaultAddon: b.vaultAddon,
        subscriptionCurrentPeriodEnd: b.subscriptionCurrentPeriodEnd?.toISOString() ?? null,
        documentCounts: Object.fromEntries(
          tenant.docCounts.filter((c) => c.businessId === b.id).map((c) => [c.state, c._count._all]),
        ),
        lastDocumentAt: tenant.lastDocs.find((d) => d.businessId === b.id)?._max.receivedAt?.toISOString() ?? null,
        contacts: b.contacts.map((c) => ({
          id: c.id,
          name: [c.firstName, c.lastName].filter(Boolean).join(' ') || null,
          email: c.email,
          mobile: c.mobileE164,
          isPrimary: c.isPrimary,
        })),
        // Health only — never a token. `connected` says a sealed credential exists.
        ledgerConnections: b.integrations.map((i) => ({
          kind: i.kind,
          isActive: i.isActive,
          health: i.health,
          orgName: i.orgName,
          connected: i.tokenRef !== null,
          lastSyncAt: i.lastSyncAt?.toISOString() ?? null,
          lastErrorAt: i.lastErrorAt?.toISOString() ?? null,
          lastErrorMessage: i.lastErrorMessage,
        })),
      })),
      invites: tenant.invites.map((i) => ({ ...i, expiresAt: i.expiresAt.toISOString(), createdAt: i.createdAt.toISOString() })),
      failedDocuments: tenant.failed.map((d) => ({ ...d, updatedAt: d.updatedAt.toISOString() })),
      flagOverrides: tenant.overrides,
    };
  }

  async documentLog(practiceId: string, documentId: string) {
    return this.withPractice(practiceId, async (db) => {
      const document = await db.document.findUnique({
        where: { id: documentId },
        select: {
          id: true,
          businessId: true,
          originalFilename: true,
          state: true,
          channel: true,
          failureCode: true,
          failureMessage: true,
          receivedAt: true,
          events: { orderBy: { createdAt: 'asc' }, select: { stage: true, outcome: true, durationMs: true, traceId: true, detail: true, createdAt: true } },
        },
      });
      if (document === null) throw notFound('document');
      return {
        ...document,
        receivedAt: document.receivedAt.toISOString(),
        events: document.events.map((e) => ({ ...e, createdAt: e.createdAt.toISOString() })),
      };
    });
  }

  // ── actions (every one audited) ────────────────────────────────────────────

  async resendInvite(admin: PlatformAdmin, practiceId: string, inviteId: string) {
    const setupToken = mintSetupToken();
    const expiresAt = setupLinkExpiry(Date.now());
    const { email, practiceName } = await this.withPractice(practiceId, async (db) => {
      const invite = await db.invite.findFirst({
        where: { id: inviteId, practiceId, businessId: null, acceptedAt: null },
        select: { id: true, email: true },
      });
      if (invite === null || invite.email === null) throw notFound('practice invitation');
      await db.invite.update({ where: { id: invite.id }, data: { tokenHash: hashSetupToken(setupToken), expiresAt } });
      const practice = await db.practice.findUnique({ where: { id: practiceId }, select: { name: true } });
      await audit(db, admin, 'admin.invitation.resent', { practiceId, inviteId });
      return { email: invite.email, practiceName: practice?.name ?? 'your practice' };
    });
    const outcome = await this.notifications.sendTeamInvite({
      to: email,
      practiceName,
      inviterName: 'Neo Accounting support',
      inviteLink: buildInviteLink(this.appOrigin, setupToken),
      expiresAt,
    });
    if (!outcome.sent) {
      throw new AppException('NT-RATE-001', HttpStatus.TOO_MANY_REQUESTS, 'Too many requests', 'The invitation was refreshed but the email rate limit refused the send. Try again later.');
    }
    return { inviteId, expiresAt: expiresAt.toISOString() };
  }

  async unlockUser(admin: PlatformAdmin, userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { email: true, kind: true, memberships: { select: { practiceId: true, business: { select: { practiceId: true } } } } },
    });
    if (user === null || user.kind !== 'HUMAN' || user.email === null) throw notFound('user');
    const wasLocked = unlockSignInAddress(normaliseEmail(user.email));
    const practiceId = user.memberships.map((m) => m.practiceId ?? m.business?.practiceId ?? null).find((p) => p !== null) ?? null;
    if (practiceId !== null) {
      await this.withPractice(practiceId, (db) => audit(db, admin, 'admin.user.unlocked', { userId, wasLocked }));
    } else {
      this.#logger.warn(`unlock of ${userId} by ${admin.userId} has no practice chain to audit into`);
    }
    return { userId, wasLocked };
  }

  async backfillSystemActor(admin: PlatformAdmin, practiceId: string) {
    const practice = await this.prisma.practice.findUnique({ where: { id: practiceId }, select: { id: true } });
    if (practice === null) throw notFound('practice');
    const existing = await this.systemActorFor(practiceId);
    if (existing !== null) return { practiceId, systemUserId: existing, created: false };
    // The backfill-system-actors.ts write, one practice: `users` and
    // `memberships` carry no RLS, so there is no scope to open before the actor exists.
    const systemUserId = await this.prisma.$transaction((tx) => createSystemActor(tx, practiceId));
    await this.withPractice(practiceId, (db) => audit(db, admin, 'admin.system-actor.created', { practiceId, systemUserId }));
    return { practiceId, systemUserId, created: true };
  }

  // ── feature flags ────────────────────────────────────────────────────────

  /** `feature_flags` is unpoliced platform config — read with the root client, like `practices`. */
  async listFlags() {
    const flags = await this.prisma.featureFlag.findMany({ orderBy: { key: 'asc' } });
    return flags.map((f) => ({
      key: f.key,
      isEnabled: f.isEnabled,
      description: f.description,
      owner: f.owner,
      updatedAt: f.updatedAt.toISOString(),
    }));
  }

  async upsertFlag(admin: PlatformAdmin, key: string, input: { isEnabled: boolean; description?: string | undefined }) {
    const flag = await this.prisma.featureFlag.upsert({
      where: { key },
      create: { key, isEnabled: input.isEnabled, description: input.description ?? null, owner: admin.email },
      update: { isEnabled: input.isEnabled, ...(input.description === undefined ? {} : { description: input.description }) },
    });
    sharedFeatureFlags().invalidate();
    // A global flag belongs to no practice; it lands on the (global)
    // NULL-business audit chain through any practice's SYSTEM scope.
    const anyPractice = await this.prisma.membership.findFirst({
      where: { practiceId: { not: null }, user: { kind: 'SYSTEM' } },
      select: { practiceId: true },
    });
    if (anyPractice?.practiceId) {
      await this.withPractice(anyPractice.practiceId, (db) => audit(db, admin, 'admin.flag.updated', { key, isEnabled: input.isEnabled }));
    }
    return { key: flag.key, isEnabled: flag.isEnabled };
  }

  async setPracticeOverride(admin: PlatformAdmin, practiceId: string, key: string, isEnabled: boolean | null) {
    await this.withPractice(practiceId, async (db) => {
      if (isEnabled === null) {
        await db.featureFlagOverride.deleteMany({ where: { practiceId, flagKey: key } });
      } else {
        await db.featureFlagOverride.upsert({
          where: { practiceId_flagKey: { practiceId, flagKey: key } },
          create: { practiceId, flagKey: key, isEnabled },
          update: { isEnabled },
        });
      }
      await audit(db, admin, 'admin.flag.override', { practiceId, key, isEnabled });
    });
    sharedFeatureFlags().invalidate();
    return { practiceId, key, isEnabled };
  }

  // ── impersonation ────────────────────────────────────────────────────────

  async practiceForImpersonation(practiceId: string): Promise<{ id: string; name: string }> {
    const practice = await this.prisma.practice.findUnique({ where: { id: practiceId }, select: { id: true, name: true } });
    if (practice === null) throw notFound('practice');
    if ((await this.systemActorFor(practiceId)) === null) {
      throw new AppException('NT-VAL-001', HttpStatus.CONFLICT, 'Conflict', 'This practice has no SYSTEM actor — backfill it first, then view it.');
    }
    return practice;
  }

  async auditImpersonation(admin: PlatformAdmin, practiceId: string, event: string, outcome: Record<string, unknown>) {
    await this.withPractice(practiceId, (db) => audit(db, admin, event, outcome));
  }

  // ── plumbing ─────────────────────────────────────────────────────────────

  private async systemActorFor(practiceId: string): Promise<string | null> {
    const row = await this.prisma.membership.findFirst({ where: { practiceId, user: { kind: 'SYSTEM' } }, select: { userId: true } });
    return row?.userId ?? null;
  }

  private async withPractice<T>(practiceId: string, fn: (db: ScopedClient) => Promise<T>): Promise<T> {
    const systemUserId = await this.systemActorFor(practiceId);
    if (systemUserId === null) throw notFound('practice (or its SYSTEM actor)');
    return scopedDb(this.prisma, systemContext(practiceId, systemUserId), fn);
  }
}

/** One audit row per admin act, on the practice's NULL-business chain, naming the admin. */
export async function audit(db: ScopedClient, admin: PlatformAdmin, event: string, outcome: Record<string, unknown>): Promise<void> {
  const body = { ...outcome, adminUserId: admin.userId, adminEmail: admin.email };
  await appendAuditEvent(db, {
    businessId: null,
    event,
    proposalId: null,
    payloadHash: sha256Hex(canonicalStringify(body)),
    renderedSummaryHash: null,
    traceId: currentTraceId() ?? null,
    outcome: body as Prisma.InputJsonObject,
  });
}

function notFound(what: string): AppException {
  return new AppException('NT-VAL-001', HttpStatus.NOT_FOUND, 'Not found', `No such ${what}.`);
}
