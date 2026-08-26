import type { ChartAccount } from './account.js';

/**
 * **The four hardcoded business-type profiles** (launch stage A6, SoT §24.4.1).
 *
 * D47 removed the ledger connection from client onboarding, and with it the
 * ledger-synced chart of accounts. §24.4.1 says what replaces it: a
 * platform-side chart, *seeded from the business-type profile at intake and
 * owned and edited by the accountant thereafter*, and it is explicit that
 * **there is no mandated UK chart of accounts** — every package ships a
 * different default, so *the seed is a starting point, never a claim of
 * correctness.* Everything in this file is written to that standard: a sensible
 * opening picklist for an accountant, not an assertion about their client.
 *
 * ⚠ **§24.4 calls a versioned, evaluated context pack a deliverable of lane D.
 * This is not that**, and it must not grow into it by accretion. Four literal
 * objects, no configuration surface, no per-practice overrides, no model in the
 * loop. When lane D lands, this file is the seed data it consumes.
 *
 * ## Why these four
 *
 * | Profile | Who | Why it earns a profile |
 * |---|---|---|
 * | `GENERAL_BUSINESS` | everyone, and the answer when the profile is absent | The core an accountant needs whatever the trade is. Also the **base** of the other three — they are additions, never replacements |
 * | `SERVICES_WITH_STAFF` | cleaning, maintenance, care, security, landscaping | **The first paying client is a cleaning agency.** Its costs are consumables, subcontracted labour and equipment hire, none of which the general chart separates |
 * | `TRADE_AND_CONSTRUCTION` | builder, plumber, electrician, roofer, joiner | Carries the two codes a general chart cannot: materials as a cost of sale, and CIS subcontractors — which is also where the **domestic reverse charge** lives, a §24.4.6 tier-3 error that lands straight on a VAT return |
 * | `RETAIL_AND_HOSPITALITY` | shop, café, takeaway, restaurant, bar, salon | Stock for resale, and food — where the zero-rate boundary (cold takeaway versus hot or eat-in) is the single most expensive coding call a small UK business makes |
 *
 * **Professional services deliberately has no profile.** A consultant, designer
 * or agency is served by `GENERAL_BUSINESS` as it stands — software,
 * subscriptions, professional fees, travel and training are all core accounts.
 * A fourth specialist profile that added nothing would be a fourth thing to
 * maintain and a fourth thing to be wrong.
 *
 * ## Two rules taken straight from §24.4.6, visible in the data
 *
 * 1. **No catch-all.** There is no `SUNDRY` and there must not be: *a catch-all
 *    sundry code is where misclassification hides.* An uncertain document
 *    belongs in To Review, where it is visible, not in a bucket that looks
 *    coded.
 * 2. **The distinctions the outside world enforces get their own code** —
 *    business entertaining separately from staff welfare, charitable separately
 *    from political donations, depreciation, private use, and every capital
 *    item in its own ledger.
 */

export const BUSINESS_PROFILE_IDS = [
  'GENERAL_BUSINESS',
  'SERVICES_WITH_STAFF',
  'TRADE_AND_CONSTRUCTION',
  'RETAIL_AND_HOSPITALITY',
] as const;

export type BusinessProfileId = (typeof BUSINESS_PROFILE_IDS)[number];

export interface BusinessProfileDefinition {
  readonly id: BusinessProfileId;
  /** What a surface calls it when it explains where the chart came from. */
  readonly label: string;
  /**
   * Lower-case fragments matched against `businessActivity` and `typicalCosts`.
   * Empty on `GENERAL_BUSINESS` — it is the fallback, never a match.
   */
  readonly matches: readonly string[];
  /** The accounts this profile adds ON TOP of the core. Empty on the core itself. */
  readonly additions: readonly ChartAccount[];
}

// ---------------------------------------------------------------------------
// The core — every profile starts here
// ---------------------------------------------------------------------------

const CORE_ACCOUNTS: readonly ChartAccount[] = [
  // --- Sales ---------------------------------------------------------------
  {
    code: 'SALES',
    ledger: 'Sales',
    name: 'Sales',
    vatTreatment: 'STANDARD',
    taxConsequence: 'ALLOWABLE',
    keywords: ['sales', 'income', 'invoice out', 'fees charged'],
  },
  {
    code: 'OTHER_INCOME',
    ledger: 'Sales',
    name: 'Other income',
    vatTreatment: 'VARIES',
    taxConsequence: 'ALLOWABLE',
    keywords: ['other income', 'grant', 'commission received', 'rebate'],
  },

  // --- Cost of sales -------------------------------------------------------
  {
    code: 'COS_PURCHASES',
    ledger: 'Cost of sales',
    name: 'Purchases',
    vatTreatment: 'STANDARD',
    taxConsequence: 'ALLOWABLE',
    keywords: ['purchase', 'purchases', 'goods', 'supplies bought in'],
  },

  // --- Expenses: people ----------------------------------------------------
  {
    code: 'WAGES_AND_SALARIES',
    ledger: 'Expenses',
    name: 'Wages and salaries',
    vatTreatment: 'OUTSIDE_SCOPE',
    taxConsequence: 'ALLOWABLE',
    keywords: ['wage', 'wages', 'salary', 'salaries', 'payroll', 'paye', 'staff pay'],
  },
  {
    code: 'EMPLOYER_NI_AND_PENSION',
    ledger: 'Expenses',
    name: "Employer's NI and pension",
    vatTreatment: 'OUTSIDE_SCOPE',
    taxConsequence: 'ALLOWABLE',
    keywords: ['national insurance', 'employer ni', 'pension', 'auto enrolment'],
  },
  {
    code: 'STAFF_WELFARE',
    ledger: 'Expenses',
    name: 'Staff welfare',
    vatTreatment: 'STANDARD',
    taxConsequence: 'ALLOWABLE',
    keywords: ['staff welfare', 'staff refreshments', 'tea and coffee', 'staff party'],
    reviewNote:
      'Staff welfare is allowable; entertaining CUSTOMERS is not. They are two codes on purpose — §24.4.6 tier 2.',
  },
  {
    code: 'TRAINING',
    ledger: 'Expenses',
    name: 'Training',
    vatTreatment: 'STANDARD',
    taxConsequence: 'ALLOWABLE',
    keywords: ['training', 'course', 'cpd', 'certification'],
  },

  // --- Expenses: premises --------------------------------------------------
  {
    code: 'RENT',
    ledger: 'Expenses',
    name: 'Rent',
    vatTreatment: 'VARIES',
    taxConsequence: 'ALLOWABLE',
    keywords: ['rent', 'lease of premises', 'unit rent'],
    reviewNote:
      'Commercial rent is exempt unless the landlord has opted to tax, so the VAT is whatever the invoice says — never assumed.',
  },
  {
    code: 'RATES_AND_WATER',
    ledger: 'Expenses',
    name: 'Rates and water',
    vatTreatment: 'OUTSIDE_SCOPE',
    taxConsequence: 'ALLOWABLE',
    keywords: ['business rates', 'rates', 'water', 'sewerage'],
  },
  {
    code: 'LIGHT_HEAT_AND_POWER',
    ledger: 'Expenses',
    name: 'Light, heat and power',
    vatTreatment: 'VARIES',
    taxConsequence: 'ALLOWABLE',
    keywords: ['electric', 'electricity', 'gas', 'energy', 'utilities', 'heating oil'],
  },
  {
    code: 'REPAIRS_AND_MAINTENANCE',
    ledger: 'Expenses',
    name: 'Repairs and maintenance',
    vatTreatment: 'STANDARD',
    taxConsequence: 'ALLOWABLE',
    keywords: ['repair', 'repairs', 'maintenance', 'servicing'],
    reviewNote:
      'Repairs-versus-improvements is §24.4.6 tier 1: an improvement is capital, not an expense, and getting it wrong misstates both the deduction and the capital allowances.',
  },
  {
    code: 'INSURANCE',
    ledger: 'Expenses',
    name: 'Insurance',
    vatTreatment: 'ZERO_OR_EXEMPT',
    taxConsequence: 'ALLOWABLE',
    keywords: ['insurance', 'liability cover', 'indemnity'],
    reviewNote: 'Insurance is VAT-exempt — an insurance invoice showing VAT is usually a broker fee, not the premium.',
  },

  // --- Expenses: running the business -------------------------------------
  {
    code: 'MOTOR_EXPENSES',
    ledger: 'Expenses',
    name: 'Motor expenses',
    vatTreatment: 'STANDARD',
    taxConsequence: 'ALLOWABLE',
    keywords: ['fuel', 'petrol', 'diesel', 'motor', 'vehicle running', 'mot', 'tyres', 'van service'],
  },
  {
    code: 'TRAVEL_AND_SUBSISTENCE',
    ledger: 'Expenses',
    name: 'Travel and subsistence',
    vatTreatment: 'VARIES',
    taxConsequence: 'ALLOWABLE',
    keywords: ['travel', 'train', 'rail', 'hotel', 'parking', 'taxi', 'mileage', 'subsistence'],
  },
  {
    code: 'TELEPHONE_AND_INTERNET',
    ledger: 'Expenses',
    name: 'Telephone and internet',
    vatTreatment: 'STANDARD',
    taxConsequence: 'ALLOWABLE',
    keywords: ['telephone', 'phone', 'mobile', 'broadband', 'internet'],
  },
  {
    code: 'SOFTWARE_AND_SUBSCRIPTIONS',
    ledger: 'Expenses',
    name: 'Software and subscriptions',
    vatTreatment: 'STANDARD',
    taxConsequence: 'ALLOWABLE',
    keywords: ['software', 'subscription', 'saas', 'licence fee', 'hosting', 'domain'],
  },
  {
    code: 'OFFICE_COSTS',
    ledger: 'Expenses',
    name: 'Office costs',
    vatTreatment: 'STANDARD',
    taxConsequence: 'ALLOWABLE',
    keywords: ['stationery', 'postage', 'printing', 'office supplies'],
  },
  {
    code: 'ADVERTISING_AND_MARKETING',
    ledger: 'Expenses',
    name: 'Advertising and marketing',
    vatTreatment: 'STANDARD',
    taxConsequence: 'ALLOWABLE',
    keywords: ['advertising', 'marketing', 'website design', 'social media', 'leaflets'],
  },
  {
    code: 'PROFESSIONAL_FEES',
    ledger: 'Expenses',
    name: 'Accountancy and legal',
    vatTreatment: 'STANDARD',
    taxConsequence: 'ALLOWABLE',
    keywords: ['accountancy', 'accountant', 'solicitor', 'legal', 'consultancy fee', 'bookkeeping'],
  },
  {
    code: 'BANK_CHARGES',
    ledger: 'Expenses',
    name: 'Bank charges',
    vatTreatment: 'ZERO_OR_EXEMPT',
    taxConsequence: 'ALLOWABLE',
    keywords: ['bank charge', 'bank charges', 'account fee', 'overdraft fee'],
  },

  // --- Expenses: the ones that must be separately identifiable (§24.4.6) ---
  {
    code: 'BUSINESS_ENTERTAINING',
    ledger: 'Expenses',
    name: 'Entertaining (disallowable)',
    vatTreatment: 'BLOCKED',
    taxConsequence: 'DISALLOWABLE',
    keywords: ['entertaining', 'client lunch', 'client dinner', 'hospitality for customers'],
    reviewNote:
      'Business entertaining is disallowable for corporation tax AND its input VAT is blocked — §24.4.6 tiers 2 and 3 at once.',
  },
  {
    code: 'CHARITABLE_DONATIONS',
    ledger: 'Expenses',
    name: 'Charitable donations',
    vatTreatment: 'OUTSIDE_SCOPE',
    taxConsequence: 'DISALLOWABLE',
    keywords: ['charity', 'charitable', 'donation'],
    reviewNote:
      'Relieved, but not as a trading deduction — it has to be separately identifiable for the computation, which is why it is not buried in an overhead.',
  },
  {
    code: 'POLITICAL_DONATIONS',
    ledger: 'Expenses',
    name: 'Political donations (disallowable)',
    vatTreatment: 'OUTSIDE_SCOPE',
    taxConsequence: 'DISALLOWABLE',
    keywords: ['political donation', 'party donation'],
  },
  {
    code: 'FINES_AND_PENALTIES',
    ledger: 'Expenses',
    name: 'Fines and penalties (disallowable)',
    vatTreatment: 'OUTSIDE_SCOPE',
    taxConsequence: 'DISALLOWABLE',
    keywords: ['fine', 'penalty', 'pcn', 'parking ticket', 'late filing penalty'],
  },
  {
    code: 'DEPRECIATION',
    ledger: 'Expenses',
    name: 'Depreciation',
    vatTreatment: 'OUTSIDE_SCOPE',
    taxConsequence: 'DISALLOWABLE',
    keywords: ['depreciation'],
  },
  {
    code: 'PRIVATE_USE',
    ledger: 'Expenses',
    name: 'Private use (disallowable)',
    vatTreatment: 'BLOCKED',
    taxConsequence: 'DISALLOWABLE',
    keywords: ['private use', 'personal', 'own use'],
  },

  // --- Fixed assets — §24.4.6 tier 1 --------------------------------------
  {
    code: 'FA_PLANT_AND_EQUIPMENT',
    ledger: 'Fixed assets',
    name: 'Plant and equipment',
    vatTreatment: 'STANDARD',
    taxConsequence: 'CAPITAL',
    keywords: ['machinery', 'plant', 'equipment purchase'],
    reviewNote: 'Capital, not an expense. Wrong side of this line is §24.4.6 tier 1 — deduction and capital allowances both move.',
  },
  {
    code: 'FA_COMPUTER_EQUIPMENT',
    ledger: 'Fixed assets',
    name: 'Computer equipment',
    vatTreatment: 'STANDARD',
    taxConsequence: 'CAPITAL',
    keywords: ['laptop', 'computer', 'server', 'monitor', 'tablet'],
  },
  {
    code: 'FA_FIXTURES_AND_FITTINGS',
    ledger: 'Fixed assets',
    name: 'Fixtures and fittings',
    vatTreatment: 'STANDARD',
    taxConsequence: 'CAPITAL',
    keywords: ['fixtures', 'fittings', 'shelving', 'furniture'],
  },
  {
    code: 'FA_MOTOR_VEHICLES',
    ledger: 'Fixed assets',
    name: 'Motor vehicles',
    vatTreatment: 'BLOCKED',
    taxConsequence: 'CAPITAL',
    keywords: ['car purchase', 'van purchase', 'vehicle purchase'],
    reviewNote: 'Input VAT on a car is blocked; on a commercial van it usually is not. The vehicle type decides it, not the supplier.',
  },
];

// ---------------------------------------------------------------------------
// The three specialist profiles — additions only
// ---------------------------------------------------------------------------

const SERVICES_WITH_STAFF_ADDITIONS: readonly ChartAccount[] = [
  {
    code: 'COS_MATERIALS_AND_CONSUMABLES',
    ledger: 'Cost of sales',
    name: 'Materials and consumables',
    vatTreatment: 'STANDARD',
    taxConsequence: 'ALLOWABLE',
    keywords: ['cleaning material', 'cleaning materials', 'chemicals', 'consumables', 'detergent', 'janitorial'],
  },
  {
    code: 'COS_SUBCONTRACTORS',
    ledger: 'Cost of sales',
    name: 'Subcontractors',
    vatTreatment: 'STANDARD',
    taxConsequence: 'ALLOWABLE',
    keywords: ['subcontractor', 'subcontractors', 'agency staff', 'contract labour'],
  },
  {
    code: 'COS_EQUIPMENT_HIRE',
    ledger: 'Cost of sales',
    name: 'Equipment hire',
    vatTreatment: 'STANDARD',
    taxConsequence: 'ALLOWABLE',
    keywords: ['equipment hire', 'machine hire', 'hire of equipment'],
  },
  {
    code: 'UNIFORMS_AND_PPE',
    ledger: 'Expenses',
    name: 'Uniforms and protective clothing',
    vatTreatment: 'STANDARD',
    taxConsequence: 'ALLOWABLE',
    keywords: ['uniform', 'uniforms', 'ppe', 'protective clothing', 'gloves', 'workwear'],
  },
  {
    code: 'LICENCES_AND_COMPLIANCE',
    ledger: 'Expenses',
    name: 'Licences and compliance',
    vatTreatment: 'VARIES',
    taxConsequence: 'ALLOWABLE',
    keywords: ['dbs', 'licence', 'license', 'compliance check', 'accreditation', 'health and safety'],
  },
];

const TRADE_AND_CONSTRUCTION_ADDITIONS: readonly ChartAccount[] = [
  {
    code: 'COS_MATERIALS',
    ledger: 'Cost of sales',
    name: 'Materials',
    vatTreatment: 'STANDARD',
    taxConsequence: 'ALLOWABLE',
    keywords: ['materials', 'timber', 'cement', 'aggregate', 'pipe', 'cable', 'builders merchant'],
  },
  {
    code: 'COS_SUBCONTRACTORS_CIS',
    ledger: 'Cost of sales',
    name: 'Subcontractors (CIS)',
    vatTreatment: 'VARIES',
    taxConsequence: 'ALLOWABLE',
    // Deliberately CIS-specific and NOT the bare word "subcontractor": a
    // services client already has `COS_SUBCONTRACTORS`, and offering both would
    // put two subcontractor accounts on one picklist for no reason.
    keywords: ['cis', 'labour only', 'construction subcontractor'],
    reviewNote:
      'The domestic reverse charge means a construction subcontractor invoice often carries NO VAT for the customer to reclaim — the customer accounts for it. §24.4.6 tier 3, straight onto the VAT return.',
  },
  {
    code: 'COS_PLANT_AND_TOOL_HIRE',
    ledger: 'Cost of sales',
    name: 'Plant and tool hire',
    vatTreatment: 'STANDARD',
    taxConsequence: 'ALLOWABLE',
    keywords: ['plant hire', 'tool hire', 'scaffold hire', 'digger hire'],
  },
  {
    code: 'TOOLS_AND_SMALL_EQUIPMENT',
    ledger: 'Expenses',
    name: 'Tools and small equipment',
    vatTreatment: 'STANDARD',
    taxConsequence: 'ALLOWABLE',
    keywords: ['tools', 'hand tools', 'power tool', 'drill', 'small equipment'],
    reviewNote: 'A tool with a real working life is capital, not an expense — the same §24.4.6 tier-1 line as repairs.',
  },
  {
    code: 'SITE_COSTS',
    ledger: 'Expenses',
    name: 'Site costs',
    vatTreatment: 'STANDARD',
    taxConsequence: 'ALLOWABLE',
    keywords: ['skip', 'skip hire', 'site welfare', 'waste removal', 'site power'],
  },
  {
    code: 'UNIFORMS_AND_PPE',
    ledger: 'Expenses',
    name: 'Uniforms and protective clothing',
    vatTreatment: 'STANDARD',
    taxConsequence: 'ALLOWABLE',
    keywords: ['ppe', 'protective clothing', 'hi vis', 'safety boots', 'workwear'],
  },
];

const RETAIL_AND_HOSPITALITY_ADDITIONS: readonly ChartAccount[] = [
  {
    code: 'COS_STOCK_FOR_RESALE',
    ledger: 'Cost of sales',
    name: 'Stock for resale',
    vatTreatment: 'VARIES',
    taxConsequence: 'ALLOWABLE',
    keywords: ['stock', 'stock for resale', 'wholesale', 'goods for resale'],
  },
  {
    code: 'COS_FOOD_AND_DRINK',
    ledger: 'Cost of sales',
    name: 'Food and drink',
    vatTreatment: 'VARIES',
    taxConsequence: 'ALLOWABLE',
    keywords: ['food', 'drink', 'beverage', 'produce', 'catering supplies', 'butcher', 'bakery'],
    reviewNote:
      'The zero-rate boundary lives here: most cold food bought in is zero-rated, hot and eat-in supplies are standard-rated. §24.4.6 tier 3.',
  },
  {
    code: 'COS_PACKAGING',
    ledger: 'Cost of sales',
    name: 'Packaging and disposables',
    vatTreatment: 'STANDARD',
    taxConsequence: 'ALLOWABLE',
    keywords: ['packaging', 'disposables', 'cups', 'takeaway boxes', 'napkins'],
  },
  {
    code: 'CARD_AND_PLATFORM_FEES',
    ledger: 'Expenses',
    name: 'Card and platform fees',
    vatTreatment: 'VARIES',
    taxConsequence: 'ALLOWABLE',
    keywords: ['card fee', 'card fees', 'merchant service', 'stripe', 'sumup', 'deliveroo', 'just eat', 'uber eats', 'commission'],
    reviewNote:
      'Card processing is an exempt financial service; a delivery platform commission is a standard-rated supply. Two different VAT answers arriving in one statement.',
  },
  {
    code: 'CLEANING_AND_WASTE',
    ledger: 'Expenses',
    name: 'Cleaning and waste',
    vatTreatment: 'STANDARD',
    taxConsequence: 'ALLOWABLE',
    // "premises cleaning", not "cleaning": a cleaning agency's own materials are
    // a cost of sale, and the bare word would drag this overhead onto their
    // picklist beside it.
    keywords: ['premises cleaning', 'waste collection', 'refuse collection', 'hygiene service'],
  },
  {
    code: 'LICENCES_AND_COMPLIANCE',
    ledger: 'Expenses',
    name: 'Licences and compliance',
    vatTreatment: 'VARIES',
    taxConsequence: 'ALLOWABLE',
    keywords: ['alcohol licence', 'music licence', 'food hygiene', 'premises licence', 'prs', 'ppl'],
  },
];

export const BUSINESS_PROFILES: Readonly<Record<BusinessProfileId, BusinessProfileDefinition>> = {
  GENERAL_BUSINESS: {
    id: 'GENERAL_BUSINESS',
    label: 'General business',
    // Empty on purpose: it is where selection LANDS, never something it matches.
    matches: [],
    additions: [],
  },
  SERVICES_WITH_STAFF: {
    id: 'SERVICES_WITH_STAFF',
    label: 'Service business with staff or subcontractors',
    matches: [
      'clean',
      'janitorial',
      'housekeeping',
      'facilities',
      'maintenance',
      'care',
      'domiciliary',
      'security',
      'guarding',
      'landscap',
      'gardening',
      'grounds',
      'window',
      'laundry',
    ],
    additions: SERVICES_WITH_STAFF_ADDITIONS,
  },
  TRADE_AND_CONSTRUCTION: {
    id: 'TRADE_AND_CONSTRUCTION',
    label: 'Trade or construction',
    matches: [
      'build',
      'construct',
      'plumb',
      'electric',
      'roof',
      'joiner',
      'carpent',
      'plaster',
      'decorat',
      'scaffold',
      'groundwork',
      'heating engineer',
      'tiling',
      'renovation',
      'refurbish',
    ],
    additions: TRADE_AND_CONSTRUCTION_ADDITIONS,
  },
  RETAIL_AND_HOSPITALITY: {
    id: 'RETAIL_AND_HOSPITALITY',
    label: 'Retail or hospitality',
    matches: [
      'shop',
      'retail',
      'store',
      'cafe',
      'café',
      'coffee',
      'restaurant',
      'takeaway',
      'catering',
      'bakery',
      'deli',
      'bar ',
      'pub',
      'salon',
      'barber',
      'hairdress',
      'hospitality',
      'kiosk',
      'market stall',
    ],
    additions: RETAIL_AND_HOSPITALITY_ADDITIONS,
  },
};

/**
 * Selection order, and it is a **fixed list rather than `Object.keys`** so a tie
 * on keyword hits resolves the same way on every run and in every Node version.
 * A chart that depended on property order would be a chart that could differ
 * between two seeds of the same client.
 */
export const PROFILE_SELECTION_ORDER: readonly BusinessProfileId[] = [
  'SERVICES_WITH_STAFF',
  'TRADE_AND_CONSTRUCTION',
  'RETAIL_AND_HOSPITALITY',
];

/** The core, as its own export — the base of every chart and the whole of the general one. */
export function coreAccounts(): readonly ChartAccount[] {
  return CORE_ACCOUNTS;
}

/**
 * Every account this module can ever produce, deduplicated by code.
 *
 * `UNIFORMS_AND_PPE` and `LICENCES_AND_COMPLIANCE` appear in two profiles with
 * different keyword lists — the trade version knows about hi-vis, the services
 * version knows about DBS checks. First definition wins, and the other's
 * keywords still reach the catalogue through {@link accountsMatchingCost},
 * which searches profile definitions rather than this list.
 */
export function accountCatalogue(): readonly ChartAccount[] {
  const byCode = new Map<string, ChartAccount>();
  for (const account of CORE_ACCOUNTS) byCode.set(account.code, account);
  for (const id of PROFILE_SELECTION_ORDER) {
    for (const account of BUSINESS_PROFILES[id].additions) {
      if (!byCode.has(account.code)) byCode.set(account.code, account);
    }
  }
  return [...byCode.values()];
}

/**
 * Accounts anywhere in the catalogue whose keywords match one thing the client
 * typed under `typicalCosts`.
 *
 * Searches every profile's definitions, not the deduplicated catalogue, so a
 * cleaning client who says "hi vis" still reaches `UNIFORMS_AND_PPE` through
 * the trade profile's keyword list.
 */
export function accountsMatchingCost(cost: string): readonly ChartAccount[] {
  const needle = cost.toLowerCase();
  const hits = new Map<string, ChartAccount>();
  const consider = (account: ChartAccount): void => {
    if (hits.has(account.code)) return;
    if (account.keywords.some((keyword) => needle.includes(keyword))) hits.set(account.code, account);
  };
  for (const account of CORE_ACCOUNTS) consider(account);
  for (const id of PROFILE_SELECTION_ORDER) for (const account of BUSINESS_PROFILES[id].additions) consider(account);
  return [...hits.values()];
}
