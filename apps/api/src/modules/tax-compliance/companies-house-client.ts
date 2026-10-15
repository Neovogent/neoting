import { z } from 'zod';

/**
 * Companies House public data API — search and company profile.
 *
 * Basic auth with the API key as the username and an empty password. Every
 * response is Zod-parsed (non-strict: Companies House adds fields freely, and
 * only the ones read here matter). A shape we do not recognise throws rather
 * than autofilling a client record with half an answer.
 */

const CH_BASE = 'https://api.company-information.service.gov.uk';

const SearchResponse = z.object({
  items: z
    .array(
      z.object({
        company_number: z.string(),
        title: z.string(),
        company_status: z.string().optional(),
        company_type: z.string().optional(),
        date_of_creation: z.string().optional(),
        address_snippet: z.string().optional(),
      }),
    )
    .default([]),
});

const ProfileResponse = z.object({
  company_number: z.string(),
  company_name: z.string(),
  company_status: z.string().optional(),
  type: z.string().optional(),
  date_of_creation: z.string().optional(),
  registered_office_address: z
    .object({
      care_of: z.string().optional(),
      premises: z.string().optional(),
      address_line_1: z.string().optional(),
      address_line_2: z.string().optional(),
      locality: z.string().optional(),
      region: z.string().optional(),
      postal_code: z.string().optional(),
      country: z.string().optional(),
    })
    .optional(),
  sic_codes: z.array(z.string()).optional(),
  accounts: z
    .object({
      accounting_reference_date: z.object({ day: z.string(), month: z.string() }).optional(),
      next_due: z.string().optional(),
      next_made_up_to: z.string().optional(),
    })
    .optional(),
  confirmation_statement: z.object({ next_due: z.string().optional() }).optional(),
});

export interface CompanySearchItem {
  companyNumber: string;
  title: string;
  companyStatus: string | null;
  companyType: string | null;
  incorporatedOn: string | null;
  addressSnippet: string | null;
}

export interface CompanyProfile {
  companyNumber: string;
  companyName: string;
  companyStatus: string | null;
  companyType: string | null;
  incorporatedOn: string | null;
  registeredOfficeAddress: string | null;
  sicCodes: string[];
  yearEndDay: number | null;
  yearEndMonth: number | null;
  accountsNextDue: string | null;
  accountsNextMadeUpTo: string | null;
  confirmationStatementNextDue: string | null;
}

/** Thrown when the deployment has no key — the controller turns it into a sentence. */
export class CompaniesHouseNotConfigured extends Error {}

const isoDateOrNull = (value: string | undefined): string | null =>
  value !== undefined && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : null;

function smallInt(value: string | undefined, max: number): number | null {
  if (value === undefined || !/^\d{1,2}$/.test(value)) return null;
  const n = Number(value);
  return n >= 1 && n <= max ? n : null;
}

export class CompaniesHouseClient {
  constructor(
    private readonly apiKey: string,
    private readonly fetchImpl: typeof fetch = globalThis.fetch,
  ) {}

  get configured(): boolean {
    return this.apiKey !== '';
  }

  async search(q: string): Promise<CompanySearchItem[]> {
    const body = await this.get(`/search/companies?q=${encodeURIComponent(q)}&items_per_page=10`);
    if (body === null) return [];
    const parsed = SearchResponse.safeParse(body);
    if (!parsed.success) throw new Error('Companies House search answered an unrecognised shape');
    return parsed.data.items.slice(0, 10).map((item) => ({
      companyNumber: item.company_number,
      title: item.title,
      companyStatus: item.company_status ?? null,
      companyType: item.company_type ?? null,
      incorporatedOn: isoDateOrNull(item.date_of_creation),
      addressSnippet: item.address_snippet ?? null,
    }));
  }

  /** Null for a company number the register does not hold. */
  async profile(companyNumber: string): Promise<CompanyProfile | null> {
    const body = await this.get(`/company/${encodeURIComponent(companyNumber.toUpperCase())}`);
    if (body === null) return null;
    const parsed = ProfileResponse.safeParse(body);
    if (!parsed.success) throw new Error('Companies House profile answered an unrecognised shape');
    const p = parsed.data;
    const office = p.registered_office_address;
    const address =
      office === undefined
        ? []
        : [office.care_of, office.premises, office.address_line_1, office.address_line_2, office.locality, office.region, office.postal_code, office.country];
    const joined = address.filter((line): line is string => typeof line === 'string' && line.trim() !== '').join(', ');
    return {
      companyNumber: p.company_number,
      companyName: p.company_name,
      companyStatus: p.company_status ?? null,
      companyType: p.type ?? null,
      incorporatedOn: isoDateOrNull(p.date_of_creation),
      registeredOfficeAddress: joined === '' ? null : joined,
      sicCodes: p.sic_codes ?? [],
      yearEndDay: smallInt(p.accounts?.accounting_reference_date?.day, 31),
      yearEndMonth: smallInt(p.accounts?.accounting_reference_date?.month, 12),
      accountsNextDue: isoDateOrNull(p.accounts?.next_due),
      accountsNextMadeUpTo: isoDateOrNull(p.accounts?.next_made_up_to),
      confirmationStatementNextDue: isoDateOrNull(p.confirmation_statement?.next_due),
    };
  }

  private async get(path: string): Promise<unknown | null> {
    if (!this.configured) throw new CompaniesHouseNotConfigured();
    const response = await this.fetchImpl(`${CH_BASE}${path}`, {
      headers: { Authorization: `Basic ${Buffer.from(`${this.apiKey}:`).toString('base64')}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(8000),
    });
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`Companies House answered ${response.status}`);
    return (await response.json()) as unknown;
  }
}
