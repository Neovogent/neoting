import type { Business, BusinessMember, BusinessSubscription, Invite, WorkspaceRole } from '@neoting/contracts/model';
import type {
  Business as PrismaBusiness,
  Invite as PrismaInvite,
  Membership as PrismaMembership,
  User as PrismaUser,
} from '@prisma/client';

import { readBusinessProfile } from './business-profile.js';

/**
 * Prisma rows → the contract's shapes. One place, so the write surface and any
 * later read surface cannot start disagreeing about what a client is — the same
 * reason `common/documents/document-response.ts` exists for documents.
 *
 * Everything here is pure and takes a row, never a client: a projection that can
 * query is a projection that can query unscoped.
 */

export type BusinessRow = PrismaBusiness;
export type MembershipRow = PrismaMembership & { readonly user: Pick<PrismaUser, 'id' | 'email' | 'firstName' | 'lastName'> };
export type InviteRow = PrismaInvite;

/**
 * The client record (`Business`).
 *
 * `subscription` is projected from the four `businesses.subscription_*` columns
 * (D48) and is **read-only here** — Stripe is the source of truth and `POST
 * /webhooks/stripe` is the only writer (the schema says so). A client that has
 * not been through checkout has no status, and the contract's word for that is
 * `null`, not an invented "none".
 */
export function toBusiness(row: BusinessRow): Business {
  return {
    id: row.id,
    practiceId: row.practiceId,
    name: row.name,
    tradingName: row.tradingName,
    companyNumber: row.companyNumber,
    industry: row.industry,
    vatRegistered: row.vatRegistered,
    vatNumber: row.vatNumber,
    countryCode: row.countryCode,
    baseCurrency: row.baseCurrency,
    contextQuestionnaire: readBusinessProfile(row.contextQuestionnaire),
    subscription: toSubscription(row),
    isActive: row.isActive,
    // UTC in storage, ISO-8601 on the wire. Europe/London is a RENDERING
    // concern and belongs to whatever draws the screen (Governance §12).
    createdAt: row.createdAt.toISOString(),
  };
}

function toSubscription(row: BusinessRow): BusinessSubscription | null {
  if (row.subscriptionStatus === null) return null;
  return {
    status: row.subscriptionStatus,
    plan: row.plan,
    currentPeriodEnd: row.subscriptionCurrentPeriodEnd?.toISOString() ?? null,
  };
}

/**
 * One person who can reach this workspace.
 *
 * `scope` says **how** they reach it: a practice-wide membership (`practice`) or
 * one on this client alone (`business`). The contract's own note explains why it
 * matters — it is the difference between what "remove from this client" can and
 * cannot do, and a screen that cannot tell them apart will offer to remove
 * someone it is unable to remove.
 */
export function toBusinessMember(row: MembershipRow): BusinessMember {
  return {
    membershipId: row.id,
    userId: row.userId,
    email: row.user.email,
    firstName: row.user.firstName,
    lastName: row.user.lastName,
    role: row.role,
    scope: row.businessId === null ? 'practice' : 'business',
    hideFinancialFields: row.hideFinancialFields,
    isOwner: row.isOwner,
    createdAt: row.createdAt.toISOString(),
  };
}

/**
 * An outstanding invitation. **Never the token** — `tokenHash` is not read here
 * and the plaintext never existed outside the send. An invite readable from an
 * API response is an invite anyone with read access can accept.
 */
export function toInvite(row: InviteRow): Invite {
  return {
    id: row.id,
    businessId: row.businessId,
    practiceId: row.practiceId,
    email: row.email,
    role: row.role as WorkspaceRole,
    expiresAt: row.expiresAt.toISOString(),
    acceptedAt: row.acceptedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}
