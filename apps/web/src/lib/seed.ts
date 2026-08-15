import type {
  BankTransaction,
  Client,
  Conversation,
  Document,
  ExpenseClaim,
  Match,
  MissingItem,
  Rule,
  Statement,
  SupplierStatement,
} from './types';

/**
 * The demo dataset is deliberately small: two clients and ten documents, each
 * one chosen to show a different state of the pipeline rather than to fill a
 * table. `missingDocs` and `toReview` below are the headline counts on the
 * Clients list, and they match the hand-written rows exactly — so the
 * generators in `generate.ts` have nothing left to top up and no synthetic
 * filler appears anywhere in the app.
 */
export const seedClients: Client[] = [
  {
    id: '1',
    name: 'American Burger Ltd',
    industry: 'Hospitality & Food',
    health: 85,
    missingDocs: 3,
    toReview: 1,
    deadline: '12 Aug 2026',
    xeroConnected: true,
    bankConnected: true,
    contactName: 'John Doe',
    mobile: '+44 7700 900123',
    vatNumber: 'GB 412 8875 21',
  },
  {
    id: '2',
    name: 'Cosmo Restaurants',
    industry: 'Hospitality & Food',
    health: 40,
    missingDocs: 1,
    toReview: 2,
    deadline: '20 Aug 2026',
    xeroConnected: true,
    bankConnected: false,
    contactName: 'Maria Silva',
    mobile: '+44 7700 900871',
    vatNumber: 'GB 220 4419 07',
  },
];

/**
 * Ten documents, covering every status the UI renders: review, ready,
 * processing, rejected and published — plus both a cost and a sales side, and
 * a "ready but a previous publish failed" case.
 */
export const seedDocuments: Document[] = [
  {
    id: 'd1',
    clientId: '1',
    clientName: 'American Burger Ltd',
    supplier: 'Bidfood UK',
    date: '10 Aug 2026',
    total: 1420.5,
    category: 'Cost of Sales Food',
    status: 'review',
    statusNote: 'Missing VAT',
    source: 'email',
    uploader: 'accounts@americanburger.co.uk',
    currency: 'GBP',
    kind: 'cost',
    fields: [
      { label: 'Supplier', value: 'Bidfood UK', confidence: 0.98, provenance: 'header block, page 1' },
      { label: 'Document date', value: '10 Aug 2026', confidence: 0.96, provenance: 'top-right, page 1' },
      { label: 'Invoice number', value: 'BF-2026-88412', confidence: 0.94, provenance: 'header block, page 1' },
      { label: 'Total', value: '£1,420.50', confidence: 0.99, provenance: 'totals table, page 2' },
      { label: 'Tax amount', value: '—', confidence: 0.31, provenance: 'not found on document' },
      { label: 'Category', value: 'Cost of Sales Food', confidence: 0.91, provenance: 'supplier rule: Bidfood' },
      { label: 'Currency', value: 'GBP', confidence: 0.99, provenance: 'symbol on totals line' },
      { label: 'Supplier bank details', value: 'SC 20-45-77 · 8841 2290', confidence: 0.88, provenance: 'footer, page 2' },
    ],
    lineItems: [
      { description: 'Beef patties 4oz — case of 48', quantity: 12, total: 684.0, tax: 0 },
      { description: 'Brioche buns — case of 60', quantity: 8, total: 312.5, tax: 0 },
      { description: 'Cheddar slices — 5kg', quantity: 6, total: 424.0, tax: 0 },
    ],
  },
  {
    id: 'd2',
    clientId: '1',
    clientName: 'American Burger Ltd',
    supplier: 'Uber Eats',
    date: '11 Aug 2026',
    total: 340.0,
    category: 'Cost of Sales Food',
    status: 'ready',
    source: 'email',
    uploader: 'accounts@americanburger.co.uk',
    currency: 'GBP',
    kind: 'cost',
    fields: [
      { label: 'Supplier', value: 'Uber Eats', confidence: 0.97, provenance: 'payout email body' },
      { label: 'Document date', value: '11 Aug 2026', confidence: 0.95, provenance: 'payout email body' },
      { label: 'Total', value: '£340.00', confidence: 0.97, provenance: 'payout summary' },
      { label: 'Category', value: 'Cost of Sales Food', confidence: 0.89, provenance: 'learned history' },
    ],
    lineItems: [{ description: 'Platform commission — week 32', quantity: 1, total: 340.0, tax: 68.0 }],
  },
  {
    id: 'd3',
    clientId: '2',
    clientName: 'Cosmo Restaurants',
    supplier: 'Costco',
    date: '09 Aug 2026',
    total: 850.2,
    category: '—',
    status: 'review',
    statusNote: 'Missing Category',
    source: 'whatsapp',
    uploader: '+44 7700 900871',
    currency: 'GBP',
    kind: 'cost',
    fields: [
      { label: 'Supplier', value: 'Costco', confidence: 0.93, provenance: 'logo + header, page 1' },
      { label: 'Document date', value: '09 Aug 2026', confidence: 0.9, provenance: 'receipt footer' },
      { label: 'Total', value: '£850.20', confidence: 0.95, provenance: 'receipt total line' },
      { label: 'Category', value: '—', confidence: 0.22, provenance: 'no rule matched; new vendor' },
    ],
    lineItems: [],
  },
  {
    id: 'd4',
    clientId: '1',
    clientName: 'American Burger Ltd',
    supplier: 'Currys',
    date: '09 Aug 2026',
    total: 1299.0,
    category: 'Computer Equipment',
    status: 'processing',
    statusNote: 'Extraction running — ETA 2 min',
    source: 'sms-link',
    uploader: 'John Doe (delegated session)',
    currency: 'GBP',
    kind: 'cost',
    fields: [],
    lineItems: [],
  },
  {
    id: 'd5',
    clientId: '1',
    clientName: 'American Burger Ltd',
    supplier: 'Adobe',
    date: '01 Aug 2026',
    total: 61.99,
    category: 'Software',
    status: 'rejected',
    statusNote: 'Publish to Xero failed — tax rate not found in chart of accounts',
    source: 'email',
    uploader: 'accounts@americanburger.co.uk',
    currency: 'GBP',
    kind: 'cost',
    fields: [
      { label: 'Supplier', value: 'Adobe', confidence: 0.99, provenance: 'header block, page 1' },
      { label: 'Total', value: '£61.99', confidence: 0.99, provenance: 'totals table' },
      { label: 'Tax rate', value: '20% (unmapped)', confidence: 0.45, provenance: 'inferred from gross/net' },
    ],
    lineItems: [{ description: 'Creative Cloud — All Apps', quantity: 1, total: 51.66, tax: 10.33 }],
  },
  {
    id: 'd6',
    clientId: '2',
    clientName: 'Cosmo Restaurants',
    supplier: 'Unknown',
    date: '08 Aug 2026',
    total: 0,
    category: '—',
    status: 'rejected',
    statusNote: 'Extraction failed — password-protected PDF',
    source: 'email',
    uploader: 'supplier@brakes.co.uk',
    currency: 'GBP',
    kind: 'cost',
    fields: [],
    lineItems: [],
  },
  {
    /** The archive needs real history — keyword search reaches into line items. */
    id: 'd7',
    clientId: '1',
    clientName: 'American Burger Ltd',
    supplier: 'Booker',
    date: '18 Jul 2026',
    total: 967.4,
    category: 'Cost of Sales Drink',
    status: 'published',
    source: 'email',
    uploader: 'accounts@americanburger.co.uk',
    currency: 'GBP',
    kind: 'cost',
    fields: [
      { label: 'Supplier', value: 'Booker', confidence: 0.97, provenance: 'header block, page 1' },
      { label: 'Document date', value: '18 Jul 2026', confidence: 0.96, provenance: 'top-right, page 1' },
      { label: 'Total', value: '£967.40', confidence: 0.99, provenance: 'totals table' },
      { label: 'Tax amount', value: '£161.23', confidence: 0.95, provenance: 'totals table' },
      { label: 'Category', value: 'Cost of Sales Drink', confidence: 0.92, provenance: 'supplier rule: Booker' },
    ],
    lineItems: [
      { description: 'Coca-Cola 330ml — case of 24', quantity: 20, total: 512.0, tax: 85.33 },
      { description: 'Paper napkins — 2000 count', quantity: 4, total: 168.4, tax: 28.07 },
      { description: 'Cleaning consumables', quantity: 1, total: 287.0, tax: 47.83 },
    ],
  },
  {
    id: 's1',
    clientId: '1',
    clientName: 'American Burger Ltd',
    supplier: 'Deliveroo',
    date: '11 Aug 2026',
    total: 4820.75,
    category: 'Sales — Delivery',
    status: 'ready',
    source: 'email',
    uploader: 'accounts@americanburger.co.uk',
    currency: 'GBP',
    kind: 'sales',
    fields: [
      { label: 'Customer', value: 'Deliveroo', confidence: 0.96, provenance: 'payout email body' },
      { label: 'Document date', value: '11 Aug 2026', confidence: 0.95, provenance: 'payout email body' },
      { label: 'Total', value: '£4,820.75', confidence: 0.98, provenance: 'payout summary' },
      { label: 'Category', value: 'Sales — Delivery', confidence: 0.93, provenance: 'customer rule: Deliveroo' },
    ],
    lineItems: [{ description: 'Week 32 orders, net of commission', quantity: 1, total: 4820.75, tax: 964.15 }],
  },
  {
    id: 's2',
    clientId: '2',
    clientName: 'Cosmo Restaurants',
    supplier: 'Westfield Events',
    date: '05 Aug 2026',
    total: 6240.0,
    category: 'Sales — Events',
    status: 'ready',
    /** Green Ready vs yellow Ready: this one failed a previous publish. */
    publishFailed: true,
    statusNote: 'Previous publish failed — customer not found in Xero',
    source: 'web',
    uploader: 'maria@cosmo.co.uk',
    currency: 'GBP',
    kind: 'sales',
    fields: [
      { label: 'Customer', value: 'Westfield Events', confidence: 0.94, provenance: 'bill-to block, page 1' },
      { label: 'Invoice number', value: 'CR-2026-0184', confidence: 0.98, provenance: 'header block' },
      { label: 'Total', value: '£6,240.00', confidence: 0.99, provenance: 'totals table' },
      { label: 'Category', value: 'Sales — Events', confidence: 0.9, provenance: 'customer rule' },
    ],
    lineItems: [{ description: 'Corporate catering — summer party, 180 covers', quantity: 1, total: 6240.0, tax: 1248.0 }],
  },
  {
    id: 's3',
    clientId: '2',
    clientName: 'Cosmo Restaurants',
    supplier: 'Just Eat',
    date: '09 Aug 2026',
    total: 2140.3,
    category: '—',
    status: 'review',
    statusNote: 'Missing Category',
    source: 'email',
    uploader: 'maria@cosmo.co.uk',
    currency: 'GBP',
    kind: 'sales',
    fields: [
      { label: 'Customer', value: 'Just Eat', confidence: 0.91, provenance: 'payout email body' },
      { label: 'Total', value: '£2,140.30', confidence: 0.96, provenance: 'payout summary' },
      { label: 'Category', value: '—', confidence: 0.2, provenance: 'no customer rule matched' },
    ],
    lineItems: [],
  },
];


export const seedTransactions: BankTransaction[] = [
  { id: 't1', clientId: '1', clientName: 'American Burger Ltd', description: 'CURRYS ONLINE', date: '09 Aug 2026', amount: 1299.0, isCredit: false, accountId: 'acct-1-1', missingItemId: 'mi1' },
  { id: 't2', clientId: '1', clientName: 'American Burger Ltd', description: 'BIDFOOD UK LTD', date: '12 Aug 2026', amount: 1420.5, matchedDocId: 'd1', isCredit: false, accountId: 'acct-1-1' },
  { id: 't3', clientId: '1', clientName: 'American Burger Ltd', description: 'GOOGLE ADS', date: '05 Aug 2026', amount: 600.0, isCredit: false, accountId: 'acct-1-1', missingItemId: 'mi2' },
  { id: 't4', clientId: '1', clientName: 'American Burger Ltd', description: 'BIDFOOD UK LTD REFUND', date: '14 Aug 2026', amount: -212.4, isCredit: true, accountId: 'acct-1-1' },
  { id: 't5', clientId: '2', clientName: 'Cosmo Restaurants', description: 'SQUARE UP PAYMENT', date: '07 Aug 2026', amount: 1900.0, isCredit: false, accountId: 'acct-2-1' },
];

/** Cosmo has no live feed, so its books run on uploaded statements. */
export const seedStatements: Statement[] = [
  {
    id: 'st1',
    clientId: '2',
    clientName: 'Cosmo Restaurants',
    accountId: 'acct-2-1',
    fileName: 'cosmo-june-statement.pdf',
    period: '01 Jun – 30 Jun 2026',
    openingBalance: 14204.11,
    closingBalance: 9871.4,
    rows: 218,
    status: 'extracted',
    uploadedAt: '3 days ago',
  },
  {
    id: 'st2',
    clientId: '2',
    clientName: 'Cosmo Restaurants',
    accountId: 'acct-2-1',
    fileName: 'scan_bank_aug.pdf',
    period: 'unknown',
    openingBalance: 0,
    closingBalance: 0,
    rows: 0,
    status: 'failed',
    uploadedAt: '6 hours ago',
    note: 'Scan quality too low to read balances — re-upload or export a digital PDF',
  },
];

/**
 * Supplier statements — the detection engine behind `detectedBy:
 * 'supplier-statement'`. The Brakes statement below is the one that found
 * mi3: Brakes say they invoiced £842.15 on 02 Aug and we hold nothing for it.
 */
export const seedSupplierStatements: SupplierStatement[] = [
  {
    id: 'sup-1',
    clientId: '1',
    clientName: 'American Burger Ltd',
    supplier: 'Bidfood UK',
    fileName: 'bidfood-statement-jul-2026.pdf',
    period: '01 Jul – 31 Jul 2026',
    statementTotal: 3204.8,
    lines: [
      { reference: 'BF-2026-88190', date: '04 Jul 2026', total: 912.4, documentId: 'd7' },
      { reference: 'BF-2026-88266', date: '11 Jul 2026', total: 848.9, documentId: 'd7' },
      { reference: 'BF-2026-88341', date: '19 Jul 2026', total: 731.0, documentId: 'd7' },
      { reference: 'BF-2026-88402', date: '27 Jul 2026', total: 712.5, documentId: 'd7' },
    ],
    status: 'reconciled',
    uploadedAt: '2 days ago',
  },
  {
    id: 'sup-2',
    clientId: '1',
    clientName: 'American Burger Ltd',
    supplier: 'Brakes',
    fileName: 'brakes-statement-aug-2026.pdf',
    period: '01 Aug – 12 Aug 2026',
    statementTotal: 1489.35,
    lines: [
      { reference: 'BRK-551204', date: '02 Aug 2026', total: 842.15 },
      { reference: 'BRK-551876', date: '09 Aug 2026', total: 647.2, documentId: 'd1' },
    ],
    status: 'gaps',
    uploadedAt: '6 hours ago',
  },
  {
    id: 'sup-3',
    clientId: '2',
    clientName: 'Cosmo Restaurants',
    supplier: 'Sysco',
    fileName: 'sysco-statement-aug.pdf',
    period: '01 Aug – 12 Aug 2026',
    statementTotal: 3890.0,
    lines: [
      { reference: 'SYS-90114', date: '04 Aug 2026', total: 2140.0 },
      { reference: 'SYS-90228', date: '08 Aug 2026', total: 900.0 },
      { reference: 'SYS-90301', date: '11 Aug 2026', total: 850.0, documentId: 'd3' },
    ],
    status: 'gaps',
    uploadedAt: 'Yesterday',
  },
];

/**
 * Expense claims, across the four states that behave differently: one still
 * with the employee's own manager, one signed off internally and now waiting
 * on the practice, one already paid, and one being drafted.
 *
 * Nothing reaches the practice unapproved — `exp-1` is deliberately still
 * inside the business, which is why the practice sees no action on it.
 */
export const seedExpenseClaims: ExpenseClaim[] = [
  {
    id: 'exp-1',
    clientId: '1',
    clientName: 'American Burger Ltd',
    claimant: 'Tom Whyte',
    period: 'August 2026',
    status: 'submitted',
    submittedAt: '4 hours ago',
    items: [
      { id: 'exp-1-a', description: 'Taxi — supplier meeting, Camden', date: '06 Aug 2026', total: 28.4, category: 'Travel', documentId: 'exp-doc-1' },
      { id: 'exp-1-b', description: 'Trade show entry — Restaurant Expo', date: '08 Aug 2026', total: 145.0, category: 'Marketing' },
    ],
    note: 'With Priya to approve.',
  },
  {
    id: 'exp-2',
    clientId: '1',
    clientName: 'American Burger Ltd',
    claimant: 'John Doe',
    period: 'August 2026',
    status: 'internally-approved',
    submittedAt: '2 days ago',
    approval: { by: 'Priya Nair', role: 'Manager', at: '1 day ago', note: 'Both checked against the diary.' },
    items: [
      { id: 'exp-2-a', description: 'Replacement till rolls — 20 boxes', date: '10 Aug 2026', total: 62.9, category: 'Office Supplies', documentId: 'exp-doc-2' },
      { id: 'exp-2-b', description: 'Parking — cash & carry run', date: '11 Aug 2026', total: 14.0, category: 'Travel', documentId: 'exp-doc-3' },
    ],
  },
  {
    id: 'exp-3',
    clientId: '1',
    clientName: 'American Burger Ltd',
    claimant: 'Priya Nair',
    period: 'July 2026',
    status: 'reimbursed',
    submittedAt: '3 weeks ago',
    approval: { by: 'John Doe', role: 'Owner', at: '3 weeks ago' },
    items: [
      { id: 'exp-3-a', description: 'Mileage — Croydon site visit', date: '18 Jul 2026', total: 41.85, category: 'Travel', documentId: 'exp-doc-4' },
    ],
  },
  {
    id: 'exp-4',
    clientId: '2',
    clientName: 'Cosmo Restaurants',
    claimant: 'Maria Silva',
    period: 'August 2026',
    status: 'draft',
    items: [
      { id: 'exp-4-a', description: 'Uniform replacement — 4 aprons', date: '09 Aug 2026', total: 78.0, category: 'Staff costs' },
    ],
    note: 'Waiting on the receipt for the linen order before submitting.',
  },
];

/**
 * The receipts behind those claim lines. They are ordinary documents — they
 * arrived by the same channels, were extracted the same way, and can be
 * opened from the claim exactly like anything else in the pipeline.
 */
export const seedExpenseDocuments: Document[] = [
  {
    id: 'exp-doc-1',
    clientId: '1',
    clientName: 'American Burger Ltd',
    supplier: 'Uber',
    date: '06 Aug 2026',
    total: 28.4,
    category: 'Travel',
    status: 'ready',
    source: 'whatsapp',
    uploader: 'Tom Whyte (staff)',
    currency: 'GBP',
    kind: 'cost',
    fields: [
      { label: 'Supplier', value: 'Uber', confidence: 0.96, provenance: 'receipt header' },
      { label: 'Document date', value: '06 Aug 2026', confidence: 0.95, provenance: 'receipt header' },
      { label: 'Total', value: '£28.40', confidence: 0.98, provenance: 'total line' },
      { label: 'Category', value: 'Travel', confidence: 0.93, provenance: 'supplier rule: Uber' },
    ],
    lineItems: [{ description: 'Camden → Shoreditch, 06 Aug', quantity: 1, total: 28.4, tax: 0 }],
  },
  {
    id: 'exp-doc-2',
    clientId: '1',
    clientName: 'American Burger Ltd',
    supplier: 'Amazon Business',
    date: '10 Aug 2026',
    total: 62.9,
    category: 'Office Supplies',
    status: 'ready',
    source: 'portal',
    uploader: 'John Doe (business portal)',
    currency: 'GBP',
    kind: 'cost',
    fields: [
      { label: 'Supplier', value: 'Amazon Business', confidence: 0.97, provenance: 'header block, page 1' },
      { label: 'Total', value: '£62.90', confidence: 0.99, provenance: 'order summary' },
      { label: 'Tax amount', value: '£10.48', confidence: 0.94, provenance: 'order summary' },
      { label: 'Category', value: 'Office Supplies', confidence: 0.9, provenance: 'learned history' },
    ],
    lineItems: [{ description: 'Thermal till rolls 80x80 — 20 boxes', quantity: 20, total: 62.9, tax: 10.48 }],
  },
  {
    id: 'exp-doc-3',
    clientId: '1',
    clientName: 'American Burger Ltd',
    supplier: 'NCP Car Parks',
    date: '11 Aug 2026',
    total: 14.0,
    category: 'Travel',
    status: 'review',
    statusNote: 'Missing VAT',
    source: 'whatsapp',
    uploader: 'John Doe (WhatsApp)',
    currency: 'GBP',
    kind: 'cost',
    fields: [
      { label: 'Supplier', value: 'NCP Car Parks', confidence: 0.88, provenance: 'faded receipt header' },
      { label: 'Total', value: '£14.00', confidence: 0.94, provenance: 'total line' },
      { label: 'Tax amount', value: '—', confidence: 0.24, provenance: 'not printed on this receipt' },
      { label: 'Category', value: 'Travel', confidence: 0.86, provenance: 'learned history' },
    ],
    lineItems: [],
  },
  {
    id: 'exp-doc-4',
    clientId: '1',
    clientName: 'American Burger Ltd',
    supplier: 'Mileage claim',
    date: '18 Jul 2026',
    total: 41.85,
    category: 'Travel',
    status: 'published',
    source: 'portal',
    uploader: 'Priya Nair (business portal)',
    currency: 'GBP',
    kind: 'cost',
    fields: [
      { label: 'Supplier', value: 'Mileage claim', confidence: 0.99, provenance: 'claim form' },
      { label: 'Total', value: '£41.85', confidence: 0.99, provenance: '93 miles at 45p' },
      { label: 'Category', value: 'Travel', confidence: 0.97, provenance: 'claim type' },
    ],
    lineItems: [{ description: 'Croydon site visit — 93 miles at 45p', quantity: 93, total: 41.85, tax: 0 }],
  },
];

/** One of each match kind: exact, credit note, batch/partial, and probable. */
export const seedMatches: Match[] = [
  {
    id: 'm1',
    clientName: 'American Burger Ltd',
    documentId: 'd1',
    transactionId: 't2',
    documentLabel: 'Bidfood UK · £1,420.50 · 10 Aug',
    transactionLabel: 'BIDFOOD UK LTD · £1,420.50 · 12 Aug',
    amount: 1420.5,
    confidence: 1,
    kind: 'exact',
    reason: 'Equal totals, paid 2 days after document date.',
  },
  {
    id: 'm2',
    clientName: 'American Burger Ltd',
    documentId: 'cn-1',
    transactionId: 't4',
    documentLabel: 'Bidfood credit note · −£212.40 · 13 Aug',
    transactionLabel: 'BIDFOOD UK LTD REFUND · −£212.40 · 14 Aug',
    amount: -212.4,
    confidence: 0.97,
    kind: 'credit-note',
    reason: 'Negative amount matched to refund — Dext cannot do this (266 votes).',
  },
  {
    id: 'm3',
    clientName: 'Cosmo Restaurants',
    documentId: 'batch-4',
    transactionId: 't5',
    documentLabel: '4 invoices · £1,900.00 combined',
    transactionLabel: 'SQUARE UP PAYMENT · £1,900.00 · 7 Aug',
    amount: 1900.0,
    confidence: 0.82,
    kind: 'partial',
    reason: 'Batch payment: one transaction settles four invoices.',
  },
  {
    id: 'm4',
    clientName: 'American Burger Ltd',
    documentId: 'd-unknown',
    transactionId: 't3',
    documentLabel: 'No document found',
    transactionLabel: 'GOOGLE ADS · £600.00 · 5 Aug',
    amount: 600.0,
    confidence: 0.44,
    kind: 'probable',
    reason: 'Merchant name normalised to Google Ireland Ltd — no evidence on file.',
  },
];

/**
 * The second copies that make a duplicate a duplicate. These are ordinary
 * documents — they are what detection in `dedupe.ts` finds; nothing about the
 * pairing is written down anywhere.
 *
 *  - `d1b` is the Bidfood invoice photographed as a till receipt by a different
 *    person: cross-type and cross-uploader, the two cases Dext's field rule
 *    misses and its users vote for.
 *  - `d3b` is the same Costco receipt sent twice, four days apart, by two
 *    people who each assumed the other had not.
 */
export const seedDuplicateCopies: Document[] = [
  {
    id: 'd1b',
    clientId: '1',
    clientName: 'American Burger Ltd',
    supplier: 'Bidfood UK',
    date: '10 Aug 2026',
    total: 1420.5,
    category: 'Cost of Sales Food',
    status: 'review',
    source: 'whatsapp',
    uploader: '+44 7700 900123 (John Doe)',
    currency: 'GBP',
    kind: 'cost',
    splitFrom: 'bidfood-till-receipt.jpg',
    fields: [
      { label: 'Supplier', value: 'Bidfood UK', confidence: 0.91, provenance: 'logo, top of receipt' },
      { label: 'Document date', value: '10 Aug 2026', confidence: 0.89, provenance: 'receipt footer' },
      { label: 'Invoice number', value: 'BF-2026-88412', confidence: 0.72, provenance: 'faint, receipt footer' },
      { label: 'Total', value: '£1,420.50', confidence: 0.96, provenance: 'receipt total line' },
      { label: 'Category', value: 'Cost of Sales Food', confidence: 0.9, provenance: 'supplier rule: Bidfood' },
    ],
    lineItems: [
      { description: 'Beef patties 4oz — case of 48', quantity: 12, total: 684.0, tax: 0 },
      { description: 'Brioche buns — case of 60', quantity: 8, total: 312.5, tax: 0 },
      { description: 'Cheddar slices — 5kg', quantity: 6, total: 424.0, tax: 0 },
    ],
  },
  {
    id: 'd3b',
    clientId: '2',
    clientName: 'Cosmo Restaurants',
    supplier: 'Costco',
    date: '13 Aug 2026',
    total: 850.2,
    category: '—',
    status: 'review',
    statusNote: 'Missing Category',
    source: 'email',
    uploader: 'maria@cosmo.co.uk',
    currency: 'GBP',
    kind: 'cost',
    fields: [
      { label: 'Supplier', value: 'Costco', confidence: 0.94, provenance: 'logo + header, page 1' },
      { label: 'Document date', value: '13 Aug 2026', confidence: 0.87, provenance: 'receipt footer' },
      { label: 'Total', value: '£850.20', confidence: 0.96, provenance: 'receipt total line' },
      { label: 'Category', value: '—', confidence: 0.21, provenance: 'no rule matched; new vendor' },
    ],
    lineItems: [],
  },
];

export const seedRules: Rule[] = [
  {
    id: 'r1',
    clientId: '1',
    clientName: 'American Burger Ltd',
    supplier: 'Bidfood',
    tier: 'supplier',
    conditions: [],
    sets: [
      { field: 'Category', value: 'Cost of Sales Food' },
      { field: 'Tax rate', value: '20% standard' },
    ],
    active: true,
    retroApply: false,
  },
  {
    id: 'r2',
    clientId: 'all',
    clientName: 'All clients',
    supplier: 'Amazon',
    tier: 'supplier',
    conditions: [{ field: 'Total', operator: '>', value: '£1,000' }],
    sets: [{ field: 'Flag', value: 'Fixed-asset review' }],
    active: true,
    retroApply: false,
  },
];

/**
 * Four missing items, one per detection engine that has a story to tell. One
 * per client is already chased, so the Chases view opens with two live chases
 * sitting at different stages of the schedule.
 */
export const seedMissing: MissingItem[] = [
  { id: 'mi1', clientId: '1', clientName: 'American Burger Ltd', supplier: 'Currys', date: '09 Aug 2026', amount: 1299.0, detectedBy: 'bank-transaction', chased: false },
  { id: 'mi2', clientId: '1', clientName: 'American Burger Ltd', supplier: 'Google Ads', date: '05 Aug 2026', amount: 600.0, detectedBy: 'bank-transaction', chased: false },
  { id: 'mi3', clientId: '1', clientName: 'American Burger Ltd', supplier: 'Brakes', date: '02 Aug 2026', amount: 842.15, detectedBy: 'supplier-statement', chased: true },
  { id: 'mi4', clientId: '2', clientName: 'Cosmo Restaurants', supplier: 'Sysco', date: '04 Aug 2026', amount: 2140.0, detectedBy: 'bank-transaction', chased: true },
];

export const seedConversations: Conversation[] = [
  {
    id: 'conv-1',
    title: 'July Bank Recon',
    attachedClientIds: ['1'],
    pinned: false,
    updatedAt: Date.now() - 1000 * 60 * 60 * 2,
    messages: [
      { id: 'c1m1', role: 'user', content: 'Show me the bank matches for American Burger' },
      {
        id: 'c1m2',
        role: 'assistant',
        content: 'Here are the current document ↔ transaction links, with match confidence on each.',
        intent: 'SHOW_MATCHES',
        payload: { clientIds: ['1'], clientNames: ['American Burger Ltd'] },
      },
    ],
  },
  {
    id: 'conv-2',
    title: 'Missing Docs Chase',
    attachedClientIds: ['1', '2'],
    pinned: false,
    updatedAt: Date.now() - 1000 * 60 * 60 * 26,
    messages: [
      { id: 'c2m1', role: 'user', content: 'What is still missing across my clients?' },
      {
        id: 'c2m2',
        role: 'assistant',
        content: "I've scanned bank feeds, supplier statements and recurring patterns. Here's what's missing:",
        intent: 'SHOW_MISSING',
        payload: { clientIds: [], clientNames: [] },
      },
    ],
  },
];

/** Operational counts for the analytics component (document pipeline only). */
export const seedAnalytics = {
  processed: [
    { label: 'Mon', value: 4 },
    { label: 'Tue', value: 6 },
    { label: 'Wed', value: 3 },
    { label: 'Thu', value: 5 },
    { label: 'Fri', value: 7 },
    { label: 'Sat', value: 2 },
    { label: 'Sun', value: 1 },
  ],
  stats: [
    { label: 'Documents processed', value: '28', sub: 'this week' },
    { label: 'Correction rate', value: '8.4%', sub: 'extraction accuracy' },
    { label: 'Auto-published', value: '71%', sub: 'of ready items' },
    { label: 'Median chase response', value: '4h 12m', sub: 'SMS to upload' },
    { label: 'Overdue chases', value: '1', sub: 'past escalation' },
    { label: 'Item delay', value: '6.2 days', sub: 'doc date to upload' },
  ],
};
