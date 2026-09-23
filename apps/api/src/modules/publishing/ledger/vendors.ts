import type { IntegrationKind } from '@prisma/client';

import type { OAuthVendor } from '../../../common/oauth/oauth.js';

/**
 * The four ledgers, as data (D50).
 *
 * Every per-vendor fact that is a CONSTANT lives here — endpoints, scopes,
 * token-endpoint authentication, how long a refresh token survives being
 * ignored, what the attachment limits are. Everything that is BEHAVIOUR lives
 * in the adapter. The split is what keeps `oauth.ts` and `token-store.ts`
 * genuinely platform-agnostic: they read this table and never branch on a
 * vendor name.
 *
 * ⚠ **The endpoint URLs are the one part of this feature not taken from
 * `docs/research/ledger-api-build-reference.md`.** That document gives each
 * vendor's auth MODEL, limits and traps, and does not carry the URLs. These are
 * written from knowledge of the four APIs and are the first thing to check if a
 * connection fails at the very first redirect — a wrong authorise URL fails
 * visibly and immediately, which is the kindest way for this particular guess
 * to be wrong. QuickBooks is exempt: its endpoints are read from Intuit's
 * discovery document at runtime (see {@link QBO_DISCOVERY}), which the App
 * Assessment Questionnaire asks about by name.
 */

export type VendorSlug = 'xero' | 'quickbooks' | 'sage' | 'freeagent';

/**
 * How the token endpoint wants the client credentials presented.
 *
 * Re-exported rather than redeclared: it moved to `common/oauth/` with the flow
 * that reads it, and two copies of a two-member union is how they drift apart.
 */
export type { TokenEndpointAuth } from '../../../common/oauth/oauth.js';

/**
 * ⚠ **`extends OAuthVendor` is load-bearing, not tidiness.** The shared OAuth
 * flow in `common/oauth/oauth.ts` types against that narrower interface, so
 * this declaration is what makes "the ledger table can be handed straight to
 * the shared flow" a compile-time fact rather than a hope. Adding a field there
 * that this table does not carry breaks the build here, which is where it
 * should break.
 *
 * The fields below are the ones an OAuth flow has no business seeing — how big
 * an attachment may be, how long the vendor suppresses a duplicate, where the
 * accounting API lives.
 */
export interface VendorConfig extends OAuthVendor {
  readonly kind: IntegrationKind;
  readonly slug: VendorSlug;
  /** What a practice sees on the connection screen. */
  readonly label: string;
  /** Root of the accounting API, without a trailing slash. */
  readonly apiBase: string;
  /**
   * ⚠ Whether the refresh token ROTATES — the old one dying the moment it is
   * used. True for three of the four, and the reason `token-store.ts` persists
   * the new one inside the same transaction that clears the refresh lock.
   */
  readonly refreshRotates: boolean;
  /**
   * How long a refresh token survives with nobody using it. The clock the
   * scheduler runs against; null where the vendor states none.
   */
  readonly refreshIdleDays: number | null;
  /**
   * ⚠ The tightest limit on a single attachment. FreeAgent's 5 MB is the
   * reason `attachment.ts` downscales at all — our intake accepts photos that
   * exceed it.
   */
  readonly attachmentMaxBytes: number;
  /** Content types the vendor's attachment endpoint will accept. */
  readonly attachmentTypes: readonly string[];
  /**
   * How long a duplicate post is suppressed by the vendor's own idempotency.
   * Zero means the vendor offers none and the adapter must guard itself.
   */
  readonly idempotencySeconds: number;
}

/** PDF, JPEG, PNG — the intersection every one of the four takes. */
const COMMON_TYPES = ['application/pdf', 'image/jpeg', 'image/png'] as const;

export const VENDORS: Readonly<Record<VendorSlug, VendorConfig>> = {
  /**
   * ⚠ Xero has NO sandbox. A developer connects a real organisation, and the
   * one to use is Xero's own **Demo Company (UK)** — free, resettable, and the
   * only safe target. `LEDGER_SANDBOX=true` cannot make Xero safe, so the
   * connection screen says so instead.
   *
   * ⚠ **GRANULAR SCOPES ONLY, and `accounting.transactions` IS NOT ONE.** Our
   * app was created on 13 September 2026, after Xero's 2 March 2026 cutover, so
   * the broad scopes were never assigned to it — the Configuration page lists
   * the granular set and nothing else. Requesting the broad name is answered
   * `invalid_scope` on the authorize URL, BEFORE any sign-in, which reads like a
   * bad client id and is not one. Measured against the live app 17 Sep 2026.
   *
   * The mapping Xero publishes (documentation/guides/oauth2/scopes):
   * `accounting.transactions` → `accounting.invoices` + `.payments` +
   * `.banktransactions` + `.manualjournals`. We post ACCPAY **Invoices** and
   * touch none of the other three, so `accounting.invoices` is the whole of it.
   *
   * ⚠ **`app.connections` must NOT be requested here** even though it is on the
   * app's granted list and `resolveOrgRef` calls that endpoint. It is a
   * NON-TENANTED scope, usable only with the client-credentials grant; asking
   * for it in an authorisation-code flow is how you turn a working consent back
   * into `invalid_scope`. A normal tenanted access token reads `/connections`.
   *
   * `accounting.settings.read` rather than `accounting.settings`: Accounts and
   * TaxRates are the only things we want from it and we only ever GET them.
   *
   * ✅ `accounting.attachments` is granted, which is what makes D43 reachable
   * through the API at all.
   */
  xero: {
    kind: 'XERO',
    slug: 'xero',
    label: 'Xero',
    authorizeUrl: 'https://login.xero.com/identity/connect/authorize',
    tokenUrl: 'https://identity.xero.com/connect/token',
    scope:
      'openid profile email offline_access accounting.invoices accounting.contacts accounting.settings.read accounting.attachments',
    apiBase: 'https://api.xero.com/api.xro/2.0',
    tokenEndpointAuth: 'basic',
    refreshRotates: true,
    refreshIdleDays: 60,
    // 10 files at 10 MB each — the most generous of the four.
    attachmentMaxBytes: 10 * 1024 * 1024,
    attachmentTypes: [...COMMON_TYPES, 'image/gif', 'image/tiff'],
    // ⚠ Six minutes. Short enough that a retry after a timeout can duplicate.
    idempotencySeconds: 6 * 60,
  },

  /**
   * ⚠ `realmId` arrives on the CALLBACK, not in the token, and without it no
   * call can be routed. It is what lands in `integrations.org_ref`.
   *
   * ⚠ No idempotency of any kind. `DocNumber` is the only duplicate guard, so
   * the adapter generates and stores one itself.
   */
  quickbooks: {
    kind: 'QUICKBOOKS',
    slug: 'quickbooks',
    label: 'QuickBooks Online',
    // Overwritten from the discovery document before first use — see `oauth.ts`.
    authorizeUrl: 'https://appcenter.intuit.com/connect/oauth2',
    tokenUrl: 'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer',
    scope: 'com.intuit.quickbooks.accounting openid profile email',
    // The realm is appended per call; QBO_ENV picks sandbox or production.
    // ⚠ **PRODUCTION, and it must stay production.** `vendorConfigFor` swaps in
    // the sandbox host when `LEDGER_SANDBOX` is set, and any code path that
    // forgets to ask it gets THIS value. Until 20 Sep 2026 this line held the
    // SANDBOX base, so a forgetful path failed silently in the worst possible
    // direction: a production deployment would have posted a client's bills
    // into Intuit's sandbox and reported success. Production here means such a
    // path 401s in sandbox instead — loud, and in the safe direction.
    apiBase: 'https://quickbooks.api.intuit.com/v3/company',
    tokenEndpointAuth: 'basic',
    refreshRotates: true,
    // The refresh token itself lives 100 days; it rotates every 24 hours.
    refreshIdleDays: 100,
    attachmentMaxBytes: 100 * 1024 * 1024,
    attachmentTypes: [...COMMON_TYPES, 'image/gif', 'text/csv', 'application/xml'],
    idempotencySeconds: 0,
  },

  /**
   * ⚠ Sage Accounting **Start** cannot take purchase invoices at all, and Start
   * is the plan practices put their smallest clients on. The adapter probes the
   * capability and falls back to `other_payments` with a recorded reason.
   */
  sage: {
    kind: 'SAGE',
    slug: 'sage',
    label: 'Sage Accounting',
    authorizeUrl: 'https://www.sageone.com/oauth2/auth/central',
    tokenUrl: 'https://oauth.accounting.sage.com/token',
    scope: 'full_access',
    apiBase: 'https://api.accounting.sage.com/v3.1',
    tokenEndpointAuth: 'body',
    refreshRotates: true,
    refreshIdleDays: 31,
    // ⚠ Sage routes consent through a filter that picks which of its products
    // the grant is for. Without it the practice is offered the WRONG product
    // list and picks a subscription this app cannot then read.
    //
    // This was an `if (vendor.slug === 'sage')` inside `authorizeUrl` until
    // 21 Sep 2026, when that function moved to `common/oauth/` to be shared
    // with the Document Vault's Drive connections. A vendor branch in a
    // generic file is how the file stops being generic, so it became data.
    authorizeParams: { filter: 'apiv3.1' },
    // Sage's own UI allows 10 x 2.5 MB. Whether the API enforces the same cap
    // is listed as NOT VERIFIED in the reference doc, so the UI's number is
    // used — being wrong in the safe direction costs a downscale nobody needed.
    attachmentMaxBytes: Math.trunc(2.5 * 1024 * 1024),
    // TIFF, which no other platform here takes.
    attachmentTypes: [...COMMON_TYPES, 'image/gif', 'image/tiff'],
    // Seven days — by far the most forgiving of the four.
    idempotencySeconds: 7 * 24 * 60 * 60,
  },

  /**
   * ✅ The gentlest of the four and the right place to prove the shared layer:
   * decimal strings, a real sandbox that is a hostname swap, a refresh token
   * that effectively never expires, and the attachment on the SAME call as the
   * bill rather than a second round trip.
   */
  freeagent: {
    kind: 'FREEAGENT',
    slug: 'freeagent',
    label: 'FreeAgent',
    authorizeUrl: 'https://api.freeagent.com/v2/approve_app',
    tokenUrl: 'https://api.freeagent.com/v2/token_endpoint',
    apiBase: 'https://api.freeagent.com/v2',
    scope: '',
    tokenEndpointAuth: 'basic',
    refreshRotates: false,
    // ~20 years. Treated as "no idle clock" rather than a number to count down.
    refreshIdleDays: null,
    // ⚠ 5 MB, the tightest of the four, against an intake that accepts photos
    // well past it. Downscaling before send is not optional here.
    attachmentMaxBytes: 5 * 1024 * 1024,
    attachmentTypes: [...COMMON_TYPES],
    idempotencySeconds: 0,
  },
};

/** Intuit's discovery documents. Sandbox and production are different files. */
export const QBO_DISCOVERY = {
  sandbox: 'https://developer.api.intuit.com/.well-known/openid_sandbox_configuration',
  production: 'https://developer.api.intuit.com/.well-known/openid_configuration',
} as const;

/** QuickBooks' API host differs between sandbox and production; nothing else does. */
export const QBO_API_BASE = {
  sandbox: 'https://sandbox-quickbooks.api.intuit.com/v3/company',
  production: 'https://quickbooks.api.intuit.com/v3/company',
} as const;

/**
 * FreeAgent's sandbox is a hostname swap on the SAME application — no separate
 * registration, which is why it is the only vendor whose whole config is
 * derivable rather than duplicated.
 */
export function freeAgentHost(sandbox: boolean): string {
  return sandbox ? 'https://api.sandbox.freeagent.com' : 'https://api.freeagent.com';
}

const BY_KIND = new Map<IntegrationKind, VendorConfig>(
  Object.values(VENDORS).map((vendor) => [vendor.kind, vendor]),
);

/** Whether an `integrations` row is a LEDGER connection rather than an export destination. */
/**
 * The four as `IntegrationKind` values, for a Prisma `in` filter.
 *
 * Derived from `VENDORS` rather than typed out again, so a fifth platform is
 * added in exactly one place.
 */
export const LEDGER_KINDS: readonly IntegrationKind[] = Object.values(VENDORS).map((vendor) => vendor.kind);

export function isLedgerKind(kind: IntegrationKind): boolean {
  return BY_KIND.has(kind);
}

/** The config for a kind, or null when the kind is `VT`/`MANUAL` — an export destination. */
export function vendorForKind(kind: IntegrationKind): VendorConfig | null {
  return BY_KIND.get(kind) ?? null;
}

/** The config for a URL slug, or null. Parsed at the controller boundary, never trusted. */
export function vendorForSlug(slug: string): VendorConfig | null {
  return Object.hasOwn(VENDORS, slug) ? (VENDORS[slug as VendorSlug] ?? null) : null;
}

export const VENDOR_SLUGS = Object.keys(VENDORS) as readonly VendorSlug[];
