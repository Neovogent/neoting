import type { Env } from '../../../config/env.js';
import type { VendorCredentials } from './oauth.js';
import { parseVaultKey } from './token-vault.js';
import { freeAgentHost, QBO_API_BASE, type VendorConfig, type VendorSlug, VENDORS } from './vendors.js';

/**
 * Config → the four applications, in one place.
 *
 * Two things happen here and nowhere else: an environment's variables become
 * per-vendor credentials, and the two vendors whose API HOST depends on
 * sandbox-vs-live get the right one. Everything downstream reads a
 * {@link VendorConfig} and a {@link VendorCredentials} and never sees an `Env`.
 */

/** The env slice this module needs. Narrow on purpose — it is handed a whole `Env` and reads eleven fields. */
export type LedgerEnv = Pick<
  Env,
  | 'LEDGER_ADAPTER'
  | 'LEDGER_SANDBOX'
  | 'INTEGRATION_TOKEN_KEY'
  | 'XERO_CLIENT_ID'
  | 'XERO_CLIENT_SECRET'
  | 'XERO_REDIRECT_URI'
  | 'QBO_CLIENT_ID'
  | 'QBO_CLIENT_SECRET'
  | 'QBO_REDIRECT_URI'
  | 'SAGE_CLIENT_ID'
  | 'SAGE_CLIENT_SECRET'
  | 'SAGE_REDIRECT_URI'
  | 'FREEAGENT_CLIENT_ID'
  | 'FREEAGENT_CLIENT_SECRET'
  | 'FREEAGENT_REDIRECT_URI'
>;

/**
 * Our registration for one vendor, or null when this deployment carries none.
 *
 * ⚠ Null rather than an empty-string credential: a client id of `''` produces a
 * consent URL that fails at the vendor with an unhelpful screen, and "this
 * deployment does not offer QuickBooks" is a different and more useful thing to
 * be able to say.
 */
export function credentialsFor(env: LedgerEnv, slug: VendorSlug): VendorCredentials | null {
  const pairs: Record<VendorSlug, VendorCredentials> = {
    xero: { clientId: env.XERO_CLIENT_ID, clientSecret: env.XERO_CLIENT_SECRET, redirectUri: env.XERO_REDIRECT_URI },
    quickbooks: { clientId: env.QBO_CLIENT_ID, clientSecret: env.QBO_CLIENT_SECRET, redirectUri: env.QBO_REDIRECT_URI },
    sage: { clientId: env.SAGE_CLIENT_ID, clientSecret: env.SAGE_CLIENT_SECRET, redirectUri: env.SAGE_REDIRECT_URI },
    freeagent: {
      clientId: env.FREEAGENT_CLIENT_ID,
      clientSecret: env.FREEAGENT_CLIENT_SECRET,
      redirectUri: env.FREEAGENT_REDIRECT_URI,
    },
  };
  const credentials = pairs[slug];
  if (credentials.clientId === '' || credentials.clientSecret === '' || credentials.redirectUri === '') return null;
  return credentials;
}

/**
 * The vendor's config with the sandbox hosts applied.
 *
 * ⚠ Two of the four change host between sandbox and live, and each changes a
 * DIFFERENT set of URLs: QuickBooks only its API base (its OAuth endpoints are
 * the same either way), FreeAgent all three. Getting this wrong is a connection
 * that authorises against live and then reads an empty sandbox, or worse the
 * other way round.
 */
export function vendorConfigFor(env: LedgerEnv, slug: VendorSlug): VendorConfig {
  const base = VENDORS[slug];
  if (slug === 'quickbooks') {
    return { ...base, apiBase: env.LEDGER_SANDBOX ? QBO_API_BASE.sandbox : QBO_API_BASE.production };
  }
  if (slug === 'freeagent') {
    const host = freeAgentHost(env.LEDGER_SANDBOX);
    return {
      ...base,
      authorizeUrl: `${host}/v2/approve_app`,
      tokenUrl: `${host}/v2/token_endpoint`,
      apiBase: `${host}/v2`,
    };
  }
  return base;
}

/** Which of the four this deployment can actually offer a practice. */
export function configuredVendors(env: LedgerEnv): readonly VendorSlug[] {
  return (Object.keys(VENDORS) as VendorSlug[]).filter((slug) => credentialsFor(env, slug) !== null);
}

/** The sealing key, parsed once. Throws on anything but 64 hex characters — `env.ts` gates it at boot. */
export function vaultKeyFor(env: LedgerEnv): Buffer {
  return parseVaultKey(env.INTEGRATION_TOKEN_KEY);
}
