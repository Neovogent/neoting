/**
 * The invoice test set — WHAT gets generated, decided before anything is drawn.
 *
 * Every document here is defined by pointing at REAL rows of the generated bank
 * statement (`scripts/demo/bank-statement/out/statement.csv`), so the expected
 * answer is not a claim about the invoice — it is the statement line the invoice
 * was built from. That is what makes the ground truth verifiable rather than
 * asserted.
 *
 * ## The four things this set is designed to measure
 *
 * 1. **Can it match at all** — a unique amount, one document, one transaction.
 * 2. **Can it disambiguate** — Rentokil bills £95.00 thirteen times, Navitas
 *    £59.00 thirteen times, the window cleaner £35.00 thirteen times. The amount
 *    alone cannot pick the right line; only the date can. A matcher that keys on
 *    amount will look perfect on the easy cases and pick at random here.
 * 3. **Can it split a statement** — a supplier statement or a merchant
 *    settlement carries 10+ transactions in ONE document and must fan out to 10+
 *    separate bank lines, not match once on the total.
 * 4. **Does it refuse** — four negative controls. A matcher with no false-
 *    positive discipline scores 100% on the positives and is useless, because
 *    every wrong match is a receipt filed against a payment it does not evidence.
 */

/** Money out of the business is negative pence, matching `BankTransaction`. */
export interface StatementRow {
  /** 1-based line in `statement.csv`, so a human can find it by eye. */
  readonly line: number;
  /** `DD/MM/YYYY` exactly as the statement prints it. */
  readonly date: string;
  readonly description: string;
  readonly pence: number;
}

export type DocFormat = 'pdf' | 'image';

/** What the document is, which decides how it is drawn. */
export type DocShape =
  /** One purchase, one payment. A supplier invoice or a utility bill. */
  | 'invoice'
  /** A month/quarter of invoices from one supplier, settled individually. */
  | 'supplier-statement'
  /** A card acquirer's settlement schedule — many CREDITS, not debits. */
  | 'settlement-statement'
  /** A small hand-written jobbing receipt. */
  | 'handwritten-receipt';

export interface TestDoc {
  readonly id: string;
  readonly format: DocFormat;
  readonly shape: DocShape;
  readonly supplier: string;
  readonly supplierAddress: readonly string[];
  readonly reference: string;
  /** Days BEFORE the bank payment that the document is dated. */
  readonly termsDays: number;
  /** UK VAT treatment. Food wholesale is zero-rated; services are not. */
  readonly vatRate: 0 | 20;
  readonly vatNumber: string | null;
  /** The statement rows this document is evidence for. */
  readonly rows: readonly StatementRow[];
  /**
   * `true` when the amount alone cannot identify the transaction, because the
   * same amount recurs. The date is the only discriminator.
   */
  readonly ambiguousAmount: boolean;
  /** Set for a negative control: what SHOULD happen is no match at all. */
  readonly expectNoMatch: null | {
    readonly why: 'supplier-absent' | 'amount-near-miss' | 'out-of-period' | 'duplicate-of';
    readonly detail: string;
  };
  readonly notes: string;
}

/** Suppliers that appear in the statement, with the identity a document needs. */
export const SUPPLIERS: Record<
  string,
  { name: string; address: string[]; vat: string | null; vatRate: 0 | 20 }
> = {
  bidfood: {
    name: 'Bidfood UK Ltd',
    address: ['Roebuck Way', 'Knowlhill', 'Milton Keynes', 'MK5 8HL'],
    vat: 'GB 232 4457 88',
    // Ambient and chilled catering food — zero-rated.
    vatRate: 0,
  },
  aldgate: {
    name: 'Aldgate Meats Ltd',
    address: ['Unit 14, Smithfield Trade Park', 'Farringdon', 'London', 'EC1A 9PS'],
    vat: 'GB 418 9922 03',
    vatRate: 0,
  },
  valefresh: {
    name: 'Vale Fresh Produce Ltd',
    address: ['Bartlow Farm', 'Wessex Road', 'Barchester', 'BA4 7QD'],
    vat: 'GB 771 3388 21',
    vatRate: 0,
  },
  bakehouse: {
    name: 'Barchester Bakehouse Ltd',
    address: ['18 Mill Lane', 'Barchester', 'BA1 3TT'],
    vat: 'GB 552 1093 47',
    vatRate: 0,
  },
  biffa: {
    name: 'Biffa Waste Services Ltd',
    address: ['Coronation Road', 'Cressex', 'High Wycombe', 'HP12 3TZ'],
    vat: 'GB 243 5568 91',
    vatRate: 20,
  },
  britishgas: {
    name: 'British Gas Lite',
    address: ['PO Box 227', 'Rotherham', 'S98 1PD'],
    vat: 'GB 684 9376 62',
    vatRate: 20,
  },
  rentokil: {
    name: 'Rentokil Pest Control',
    address: ['Riverbank, Meadows Business Park', 'Camberley', 'GU17 9AB'],
    vat: 'GB 232 7726 15',
    vatRate: 20,
  },
  cocacola: {
    name: 'Coca-Cola Europacific Partners',
    address: ['Pemberton House', 'Bakers Road', 'Uxbridge', 'UB8 1EZ'],
    vat: 'GB 383 5561 20',
    vatRate: 20,
  },
  navitas: {
    name: 'Navitas Safety Ltd',
    address: ['Regent House', 'Princes Street', 'Ipswich', 'IP1 1QJ'],
    vat: 'GB 991 4402 76',
    vatRate: 20,
  },
  window: {
    name: 'B C Window Cleaning',
    address: ['7 Aldergate Close', 'Barchester', 'BA2 8LN'],
    vat: null,
    vatRate: 0,
  },
  heritage: {
    name: 'Heritage Craft Beers Ltd',
    address: ['The Old Maltings', 'Wharf Road', 'Barchester', 'BA5 2RN'],
    vat: 'GB 447 8821 90',
    vatRate: 20,
  },
  worldpay: {
    name: 'Worldpay (UK) Limited',
    address: ['The Walbrook Building', '25 Walbrook', 'London', 'EC4N 8AF'],
    vat: 'GB 245 0091 33',
    vatRate: 20,
  },
  thornbury: {
    name: 'Thornbury Catering Supplies Ltd',
    address: ['Bank Farm Estate', 'Thornbury', 'Bristol', 'BS35 2AZ'],
    vat: 'GB 609 3317 45',
    vatRate: 20,
  },
};

export const BUSINESS = {
  name: 'American Burger Ltd',
  address: ['42 Bridge Street', 'Barchester', 'Wessex', 'BA1 2QN'],
  companyNumber: '09112233',
  vatNumber: 'GB334455667',
};
