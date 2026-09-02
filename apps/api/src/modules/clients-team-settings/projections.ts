import type {
  Business,
  BusinessMember,
  BusinessSubscription,
  Invite,
  PracticeMember,
  WorkspaceRole,
} from '@neoting/contracts/model';
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
 * One person at the FIRM, folded from every membership they hold in it.
 *
 * A colleague scoped to three clients holds three membership rows (one per
 * client, `practice_id` NULL — which is what makes RLS confine them), and a
 * team list that printed them three times would be describing memberships
 * rather than people. So the fold is the projection, and three of its rules are
 * decisions rather than mechanics:
 *
 * - **A practice-WIDE row wins and empties `businessIds`.** Holding one means
 *   RLS's practice-membership branch already reaches every client, so listing
 *   the businesses they also hold rows on would understate their access. Empty
 *   means "all", which is what the contract says and what is true.
 * - **`isOwner` is true if ANY row carries it.** It is a property of the person,
 *   not of one membership, and exactly one person per practice has it.
 * - **`role` and `hideFinancialFields` come from the EARLIEST row.** Rows
 *   created by one acceptance all agree, so the only way they can differ is a
 *   membership added by hand — and the oldest is the least surprising answer.
 */
export interface PracticeMemberRow {
  readonly id: string;
  readonly email: string | null;
  readonly firstName: string | null;
  readonly lastName: string | null;
  /** Ordered OLDEST FIRST by the caller — the fold depends on it. Never empty. */
  readonly memberships: readonly Pick<PrismaMembership, 'businessId' | 'role' | 'isOwner' | 'hideFinancialFields' | 'createdAt'>[];
}

export function toPracticeMember(row: PracticeMemberRow): PracticeMember {
  const earliest = row.memberships[0];
  // A caller that hands over a person with no memberships has asked the wrong
  // question — they are not a member of anything. Refusing loudly beats
  // inventing a role.
  if (earliest === undefined) throw new Error(`practice member ${row.id} was folded from no memberships`);

  const practiceWide = row.memberships.find((m) => m.businessId === null);
  const scoped = practiceWide === undefined ? row.memberships.flatMap((m) => (m.businessId === null ? [] : [m.businessId])) : [];

  return {
    userId: row.id,
    email: row.email,
    firstName: row.firstName,
    lastName: row.lastName,
    role: (practiceWide ?? earliest).role,
    isOwner: row.memberships.some((m) => m.isOwner),
    businessIds: scoped,
    hideFinancialFields: earliest.hideFinancialFields,
    createdAt: earliest.createdAt.toISOString(),
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
