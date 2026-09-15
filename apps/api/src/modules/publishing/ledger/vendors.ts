import type { IntegrationKind } from '@prisma/client';

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

/** How the token endpoint wants the client credentials presented. */
export type TokenEndpointAuth = 'basic' | 'body';

export interface VendorConfig {
  readonly kind: IntegrationKind;
  readonly slug: VendorSlug;
  /** What a practice sees on the connection screen. */
  readonly label: string;
  readonly authorizeUrl: string;
  readonly tokenUrl: string;
  readonly scope: string;
  /** Root of the accounting API, without a trailing slash. */
  readonly apiBase: string;
  readonly tokenEndpointAuth: TokenEndpointAuth;
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
   * ⚠ Granular scopes only: our app was created on 13 September 2026, after
   * Xero's 2 March 2026 cutover. `accounting.attachments` is granted, which is
   * what makes D43 reachable through the API at all.
   */
  xero: {
    kind: 'XERO',
    slug: 'xero',
    label: 'Xero',
    authorizeUrl: 'https://login.xero.com/identity/connect/authorize',
    tokenUrl: 'https://identity.xero.com/connect/token',
    scope:
      'openid profile email offline_access accounting.transactions accounting.contacts accounting.settings accounting.attachments',
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
    apiBase: 'https://sandbox-quickbooks.api.intuit.com/v3/company',
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
