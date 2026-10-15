import { z } from 'zod';

import { validateVrn, type VatNumberCheck } from './vat-number.js';

/**
 * HMRC "Check a UK VAT number" API v2.0, behind the checksum.
 *
 * Application-restricted: an OAuth2 client-credentials token, no user. The
 * token and every lookup answer are cached in-process.
 *
 * ⚠ **A checksum pass is never presented as a registration.** With no HMRC
 * credentials, or with HMRC unreachable, the verdict is `CHECKSUM_ONLY` with a
 * `note` saying why — the UI words it as "format OK, not confirmed with HMRC".
 *
 * Every HMRC response is Zod-parsed: a shape we do not recognise is treated as
 * HMRC being unavailable, never as a confirmation.
 */

export interface HmrcVatConfig {
  readonly clientId: string;
  readonly clientSecret: string;
  /** Sandbox `https://test-api.service.hmrc.gov.uk`, live `https://api.service.hmrc.gov.uk`. */
  readonly baseUrl: string;
}

const TokenResponse = z.object({ access_token: z.string().min(1), expires_in: z.number().positive() });

const LookupResponse = z.object({
  target: z.object({
    name: z.string(),
    vatNumber: z.string(),
    address: z
      .object({
        line1: z.string().optional(),
        line2: z.string().optional(),
        line3: z.string().optional(),
        line4: z.string().optional(),
        postcode: z.string().optional(),
        countryCode: z.string().optional(),
      })
      .optional(),
  }),
});

export type HmrcLookup = { readonly registered: false } | { readonly registered: true; readonly name: string; readonly address: string | null };

export class HmrcVatClient {
  private token: { value: string; expiresAt: number } | null = null;

  constructor(
    private readonly config: HmrcVatConfig,
    private readonly fetchImpl: typeof fetch = globalThis.fetch,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /** `vrn` is the nine digits. Throws on anything that is not a clean answer. */
  async lookup(vrn: string): Promise<HmrcLookup> {
    const token = await this.accessToken();
    const response = await this.fetchImpl(
      `${this.config.baseUrl}/organisations/vat/check-vat-number/lookup/${encodeURIComponent(vrn)}`,
      { headers: { Accept: 'application/vnd.hmrc.2.0+json', Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(8000) },
    );
    if (response.status === 404) return { registered: false };
    if (response.status === 401) this.token = null;
    if (!response.ok) throw new Error(`HMRC VAT lookup answered ${response.status}`);
    const parsed = LookupResponse.safeParse(await response.json());
    if (!parsed.success) throw new Error('HMRC VAT lookup answered an unrecognised shape');
    const address = parsed.data.target.address;
    const lines = address === undefined ? [] : [address.line1, address.line2, address.line3, address.line4, address.postcode];
    const joined = lines.filter((line): line is string => typeof line === 'string' && line.trim() !== '').join(', ');
    return { registered: true, name: parsed.data.target.name, address: joined === '' ? null : joined };
  }

  private async accessToken(): Promise<string> {
    if (this.token !== null && this.token.expiresAt > this.now() + 60_000) return this.token.value;
    const response = await this.fetchImpl(`${this.config.baseUrl}/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams({
        client_id: this.config.clientId,
        client_secret: this.config.clientSecret,
        grant_type: 'client_credentials',
      }).toString(),
      signal: AbortSignal.timeout(8000),
    });
    if (!response.ok) throw new Error(`HMRC token endpoint answered ${response.status}`);
    const parsed = TokenResponse.safeParse(await response.json());
    if (!parsed.success) throw new Error('HMRC token endpoint answered an unrecognised shape');
    this.token = { value: parsed.data.access_token, expiresAt: this.now() + parsed.data.expires_in * 1000 };
    return this.token.value;
  }
}

const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const CACHE_MAX = 2000;

/** The one door every VAT-number check goes through. */
export class VatNumberChecker {
  // ponytail: per-process Map cache; a shared Redis cache if lookups ever cost money or hit HMRC's rate limit.
  private readonly cache = new Map<string, { at: number; lookup: HmrcLookup }>();

  constructor(
    private readonly hmrc: Pick<HmrcVatClient, 'lookup'> | null,
    private readonly now: () => number = () => Date.now(),
  ) {}

  get hmrcConfigured(): boolean {
    return this.hmrc !== null;
  }

  async check(raw: string): Promise<VatNumberCheck> {
    const checkedAt = new Date(this.now()).toISOString();
    const validation = validateVrn(raw);
    const base = { registeredName: null, registeredAddress: null, checkedAt };
    if (!validation.valid) {
      return { ...base, vatNumber: validation.normalised, status: validation.reason, source: 'CHECKSUM', note: null };
    }
    const checksumOnly = (note: string): VatNumberCheck => ({
      ...base,
      vatNumber: validation.normalised,
      status: 'CHECKSUM_ONLY',
      source: 'CHECKSUM',
      note,
    });
    if (this.hmrc === null) return checksumOnly('HMRC lookup is not configured on this deployment — checksum only.');
    if (validation.shape !== 'STANDARD') return checksumOnly('Government and health-authority numbers are not in the HMRC lookup.');

    let lookup: HmrcLookup;
    const cached = this.cache.get(validation.digits);
    if (cached !== undefined && this.now() - cached.at < CACHE_TTL_MS) {
      lookup = cached.lookup;
    } else {
      try {
        lookup = await this.hmrc.lookup(validation.digits);
      } catch {
        return checksumOnly('HMRC could not be reached just now — checksum only.');
      }
      if (this.cache.size >= CACHE_MAX) this.cache.delete(this.cache.keys().next().value as string);
      this.cache.set(validation.digits, { at: this.now(), lookup });
    }

    return lookup.registered
      ? { vatNumber: validation.normalised, status: 'VALID', source: 'HMRC', registeredName: lookup.name, registeredAddress: lookup.address, note: null, checkedAt }
      : { ...base, vatNumber: validation.normalised, status: 'NOT_REGISTERED', source: 'HMRC', note: null };
  }
}

/** Config selection: no keys, no HMRC — checksum only, and every verdict says so. */
export function selectVatNumberChecker(env: {
  readonly HMRC_CLIENT_ID: string;
  readonly HMRC_CLIENT_SECRET: string;
  readonly HMRC_API_BASE: string;
}): VatNumberChecker {
  const configured = env.HMRC_CLIENT_ID !== '' && env.HMRC_CLIENT_SECRET !== '';
  return new VatNumberChecker(
    configured
      ? new HmrcVatClient({ clientId: env.HMRC_CLIENT_ID, clientSecret: env.HMRC_CLIENT_SECRET, baseUrl: env.HMRC_API_BASE.replace(/\/+$/, '') })
      : null,
  );
}
