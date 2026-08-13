/**
 * Seed dataset (Kickoff 6.3) — "clone-to-running honesty".
 *
 * Every screen must have believable data on a fresh clone. An empty inbox
 * teaches nobody anything, and a demo that needs a script to explain what you
 * are looking at is not a demo.
 *
 * RULES
 *   - Synthetic only (G2). No real business, no real person, no real number.
 *     Mobile numbers use Ofcom's 07700 900xxx range, reserved for fiction.
 *     Domains use .test, reserved by RFC 2606.
 *   - Money is integer pence. If you find yourself typing a decimal point in
 *     this file, stop.
 *   - Dates are relative to today, so the data never looks stale.
 *   - Deterministic ids (doc_001, biz_burger) so tests and demo scripts can
 *     reference exact rows.
 *
 * RLS NOTE
 *   This runs as the migration role, which bypasses row-level security
 *   (superuser locally). It is the same bootstrapping exemption that real
 *   provisioning needs — see prisma/CLAUDE.md. It is NOT a licence to give the
 *   application role the same power.
 */
import { PrismaClient, Prisma } from '@prisma/client';

const prisma = new PrismaClient();

if (process.env.NODE_ENV === 'production') {
  throw new Error('The seed dataset must never run against production.');
}

// --- date helpers -----------------------------------------------------------
const DAY = 24 * 60 * 60 * 1000;
const now = new Date();
const daysAgo = (n: number) => new Date(now.getTime() - n * DAY);
const daysAhead = (n: number) => new Date(now.getTime() + n * DAY);

// --- money ------------------------------------------------------------------
/** £12.34 -> 1234. The only place a decimal is allowed anywhere near money. */
const pounds = (p: number) => Math.round(p * 100);
/** VAT-inclusive gross -> { totalPence, taxPence } at the given rate. */
const withVat = (grossPounds: number, rate = 0.2) => {
  const totalPence = pounds(grossPounds);
  const netPence = Math.round(totalPence / (1 + rate));
  return { totalPence, taxPence: totalPence - netPence };
};

async function main() {
  console.log('Clearing existing data…');
  // Order matters only for the tables TRUNCATE cannot cascade cleanly.
  await prisma.$executeRawUnsafe(`
    TRUNCATE
      practices, businesses, users, memberships, contacts, invites, sessions,
      otp_sessions, documents, extractions, document_events, duplicates,
      rules, guidance, suggestions, bank_connections, bank_accounts,
      bank_transactions, statements, supplier_statements,
      supplier_statement_lines, matches, chases, chase_messages, item_threads,
      approval_workflows, approvals, action_proposals, integrations,
      reference_syncs, publishes, vault_items, tasks, notifications, sms_log,
      imports, exports, audit_events, feature_flags
    RESTART IDENTITY CASCADE
  `);

  // =========================================================================
  // PRACTICE, PEOPLE, CLIENTS
  // =========================================================================
  console.log('Practice and people…');

  await prisma.practice.create({
    data: {
      id: 'prac_ledgerline',
      name: 'Ledgerline Accountants',
      countryCode: 'GB',
      baseCurrency: 'GBP',
      vatRegistered: true,
      vatNumber: 'GB123456789',
      yearEndMonth: 3,
      yearEndDay: 31,
      registeredAddress: {
        line1: '18 Peckett Square',
        city: 'Bristol',
        postcode: 'BS1 3ND',
        country: 'GB',
      },
    },
  });

  await prisma.user.createMany({
    data: [
      { id: 'usr_priya', email: 'priya@ledgerline.test', firstName: 'Priya', lastName: 'Raman', emailVerified: true, totpEnabledAt: daysAgo(120) },
      { id: 'usr_tom', email: 'tom@ledgerline.test', firstName: 'Tom', lastName: 'Whitfield', emailVerified: true },
      { id: 'usr_dee', email: 'dee@americanburger.test', firstName: 'Dee', lastName: 'Okafor', emailVerified: true },
      { id: 'usr_marco', email: 'marco@cosmorestaurants.test', firstName: 'Marco', lastName: 'Silva', emailVerified: true },
    ],
  });

  const clients = [
    {
      id: 'biz_burger',
      name: 'American Burger Ltd',
      industry: 'Restaurants',
      companyNumber: '09112233',
      vatNumber: 'GB334455667',
      code: 'AMB',
    },
    {
      id: 'biz_cosmo',
      name: 'Cosmo Restaurants Ltd',
      industry: 'Restaurants',
      companyNumber: '10223344',
      vatNumber: 'GB445566778',
      code: 'COS',
    },
    {
      id: 'biz_dental',
      name: 'Harbourview Dental Ltd',
      industry: 'Healthcare',
      companyNumber: '11334455',
      vatNumber: null,
      code: 'HVD',
    },
  ];

  for (const c of clients) {
    await prisma.business.create({
      data: {
        id: c.id,
        practiceId: 'prac_ledgerline',
        name: c.name,
        industry: c.industry,
        companyNumber: c.companyNumber,
        vatRegistered: c.vatNumber !== null,
        vatNumber: c.vatNumber,
        vatScheme: c.vatNumber ? 'standard' : null,
        vatFrequency: c.vatNumber ? 'quarterly' : null,
        practiceCode: c.code,
        bookkeepingManagedBy: 'practice',
        bookkeepingFrequency: 'monthly',
        nextDeadline: daysAhead(12),
        yearEndMonth: 3,
        yearEndDay: 31,
        contextQuestionnaire: {
          sells: c.industry === 'Restaurants' ? 'Food and drink, eat-in and delivery' : 'Private dental treatment',
          revenueStreams: c.industry === 'Restaurants' ? ['in-store', 'Just Eat', 'Deliveroo'] : ['private patients', 'plans'],
          typicalSuppliers: c.industry === 'Restaurants' ? ['Bidfood', 'Brakes', 'Coca-Cola'] : ['Henry Schein', 'Dental Directory'],
          companyCards: true,
          expectedUnusual: c.industry === 'Restaurants' ? 'Occasional equipment purchases over £2,000' : 'Annual GDC registration fees',
        },
      },
    });
  }

  await prisma.membership.createMany({
    data: [
      { id: 'mem_priya', userId: 'usr_priya', practiceId: 'prac_ledgerline', role: 'PRACTICE_ADMIN', isOwner: true, permissions: ['publish', 'approve', 'chase', 'connect_bank', 'export', 'delete'] },
      { id: 'mem_tom', userId: 'usr_tom', practiceId: 'prac_ledgerline', role: 'PRACTICE_STANDARD', permissions: ['chase'] },
      { id: 'mem_tom_burger', userId: 'usr_tom', practiceId: 'prac_ledgerline', businessId: 'biz_burger', role: 'PRACTICE_STANDARD', permissions: ['chase', 'publish'] },
      { id: 'mem_dee', userId: 'usr_dee', businessId: 'biz_burger', role: 'BUSINESS_ADMIN', permissions: ['export'] },
      { id: 'mem_marco', userId: 'usr_marco', businessId: 'biz_cosmo', role: 'BUSINESS_ADMIN' },
    ],
  });

  // Phone-only contacts: they receive chases and upload through OTP links
  // without ever being provisioned as users (SoT §3.3).
  await prisma.contact.createMany({
    data: [
      { id: 'con_dee', businessId: 'biz_burger', userId: 'usr_dee', firstName: 'Dee', lastName: 'Okafor', role: 'Owner', mobileE164: '+447700900123', mobileVerifiedAt: daysAgo(90), email: 'dee@americanburger.test', isPrimary: true },
      { id: 'con_sam', businessId: 'biz_burger', firstName: 'Sam', lastName: 'Boyd', role: 'Kitchen manager', mobileE164: '+447700900456', mobileVerifiedAt: daysAgo(40) },
      { id: 'con_marco', businessId: 'biz_cosmo', userId: 'usr_marco', firstName: 'Marco', lastName: 'Silva', role: 'Director', mobileE164: '+447700900789', mobileVerifiedAt: daysAgo(60), isPrimary: true },
      { id: 'con_ruth', businessId: 'biz_dental', firstName: 'Ruth', lastName: 'Ellery', role: 'Practice manager', mobileE164: '+447700900321', mobileVerifiedAt: daysAgo(15), isPrimary: true },
    ],
  });

  // =========================================================================
  // DOCUMENTS — 40, across every state and both inboxes
  // =========================================================================
  console.log('Documents…');

  type DocSpec = {
    supplier: string;
    grossPounds: number;
    daysOld: number;
    state: 'PROCESSING' | 'TO_REVIEW' | 'READY' | 'PUBLISHED' | 'ARCHIVED' | 'REJECTED' | 'FAILED';
    inbox: 'COSTS' | 'SALES' | 'UNROUTED';
    category?: string;
    channel: 'WEB_UPLOAD' | 'EMAIL' | 'WHATSAPP' | 'SMS_PORTAL' | 'CHAT_UPLOAD' | 'STRUCTURED_IMPORT';
    docType?: 'INVOICE' | 'RECEIPT' | 'CREDIT_NOTE' | 'STATEMENT' | 'OTHER';
    business: string;
    failureCode?: string;
    failureMessage?: string;
    vatRate?: number;
  };

  const specs: DocSpec[] = [
    // --- American Burger: the busy client ---------------------------------
    { supplier: 'Bidfood', grossPounds: 1284.5, daysOld: 3, state: 'READY', inbox: 'COSTS', category: 'Cost of Sales — Food', channel: 'EMAIL', docType: 'INVOICE', business: 'biz_burger' },
    { supplier: 'Bidfood', grossPounds: 976.2, daysOld: 10, state: 'PUBLISHED', inbox: 'COSTS', category: 'Cost of Sales — Food', channel: 'EMAIL', docType: 'INVOICE', business: 'biz_burger' },
    { supplier: 'Bidfood', grossPounds: 1102.85, daysOld: 17, state: 'ARCHIVED', inbox: 'COSTS', category: 'Cost of Sales — Food', channel: 'EMAIL', docType: 'INVOICE', business: 'biz_burger' },
    { supplier: 'Currys', grossPounds: 1299.0, daysOld: 4, state: 'TO_REVIEW', inbox: 'COSTS', channel: 'WHATSAPP', docType: 'RECEIPT', business: 'biz_burger' },
    { supplier: 'Adobe', grossPounds: 61.99, daysOld: 6, state: 'PUBLISHED', inbox: 'COSTS', category: 'Software', channel: 'EMAIL', docType: 'INVOICE', business: 'biz_burger' },
    { supplier: 'Shell', grossPounds: 78.4, daysOld: 2, state: 'TO_REVIEW', inbox: 'COSTS', channel: 'SMS_PORTAL', docType: 'RECEIPT', business: 'biz_burger' },
    { supplier: 'British Gas', grossPounds: 412.66, daysOld: 8, state: 'READY', inbox: 'COSTS', category: 'Utilities', channel: 'EMAIL', docType: 'INVOICE', business: 'biz_burger' },
    { supplier: 'Amazon', grossPounds: 156.3, daysOld: 5, state: 'TO_REVIEW', inbox: 'COSTS', channel: 'WEB_UPLOAD', docType: 'RECEIPT', business: 'biz_burger' },
    { supplier: 'Coca-Cola Europacific', grossPounds: 344.1, daysOld: 12, state: 'PUBLISHED', inbox: 'COSTS', category: 'Cost of Sales — Drink', channel: 'EMAIL', docType: 'INVOICE', business: 'biz_burger' },
    { supplier: 'Just Eat', grossPounds: 2841.55, daysOld: 7, state: 'READY', inbox: 'SALES', category: 'Sales — Delivery', channel: 'EMAIL', docType: 'INVOICE', business: 'biz_burger' },
    { supplier: 'Deliveroo', grossPounds: 1955.2, daysOld: 7, state: 'PUBLISHED', inbox: 'SALES', category: 'Sales — Delivery', channel: 'EMAIL', docType: 'INVOICE', business: 'biz_burger' },
    { supplier: 'Bidfood', grossPounds: 88.4, daysOld: 14, state: 'READY', inbox: 'COSTS', category: 'Cost of Sales — Food', channel: 'EMAIL', docType: 'CREDIT_NOTE', business: 'biz_burger' },
    { supplier: 'Screwfix', grossPounds: 47.88, daysOld: 1, state: 'PROCESSING', inbox: 'COSTS', channel: 'CHAT_UPLOAD', business: 'biz_burger' },
    { supplier: 'Unknown', grossPounds: 0, daysOld: 1, state: 'FAILED', inbox: 'COSTS', channel: 'WHATSAPP', business: 'biz_burger', failureCode: 'NT-EXT-0004', failureMessage: 'Photo too blurred to read supplier, date or total. Ask the sender to retake it in better light.' },
    { supplier: 'Unknown', grossPounds: 0, daysOld: 2, state: 'REJECTED', inbox: 'COSTS', channel: 'EMAIL', business: 'biz_burger', failureCode: 'NT-ING-0007', failureMessage: 'The PDF is password-protected, so it could not be opened. Ask the sender to resend without a password.' },
    { supplier: 'Currys', grossPounds: 1299.0, daysOld: 4, state: 'TO_REVIEW', inbox: 'COSTS', channel: 'EMAIL', docType: 'RECEIPT', business: 'biz_burger' }, // the duplicate

    // --- Cosmo: mid-volume -------------------------------------------------
    { supplier: 'Brakes', grossPounds: 2140.75, daysOld: 5, state: 'READY', inbox: 'COSTS', category: 'Cost of Sales — Food', channel: 'EMAIL', docType: 'INVOICE', business: 'biz_cosmo' },
    { supplier: 'Brakes', grossPounds: 1877.4, daysOld: 19, state: 'ARCHIVED', inbox: 'COSTS', category: 'Cost of Sales — Food', channel: 'EMAIL', docType: 'INVOICE', business: 'biz_cosmo' },
    { supplier: 'Google Ads', grossPounds: 600.0, daysOld: 9, state: 'TO_REVIEW', inbox: 'COSTS', channel: 'EMAIL', docType: 'INVOICE', business: 'biz_cosmo' },
    { supplier: 'Booker', grossPounds: 733.2, daysOld: 11, state: 'PUBLISHED', inbox: 'COSTS', category: 'Cost of Sales — Food', channel: 'WEB_UPLOAD', docType: 'INVOICE', business: 'biz_cosmo' },
    { supplier: 'Thames Water', grossPounds: 188.9, daysOld: 13, state: 'READY', inbox: 'COSTS', category: 'Utilities', channel: 'EMAIL', docType: 'INVOICE', business: 'biz_cosmo' },
    { supplier: 'Uber Eats', grossPounds: 3204.4, daysOld: 6, state: 'READY', inbox: 'SALES', category: 'Sales — Delivery', channel: 'EMAIL', docType: 'INVOICE', business: 'biz_cosmo' },
    { supplier: 'Sky Business', grossPounds: 96.0, daysOld: 20, state: 'ARCHIVED', inbox: 'COSTS', category: 'Subscriptions', channel: 'EMAIL', docType: 'INVOICE', business: 'biz_cosmo' },
    { supplier: 'Nisbets', grossPounds: 2480.0, daysOld: 3, state: 'TO_REVIEW', inbox: 'COSTS', channel: 'WEB_UPLOAD', docType: 'INVOICE', business: 'biz_cosmo' },
    { supplier: 'Bidfood', grossPounds: 512.3, daysOld: 15, state: 'PUBLISHED', inbox: 'COSTS', category: 'Cost of Sales — Food', channel: 'EMAIL', docType: 'INVOICE', business: 'biz_cosmo' },
    { supplier: 'Unknown', grossPounds: 0, daysOld: 1, state: 'PROCESSING', inbox: 'UNROUTED', channel: 'EMAIL', business: 'biz_cosmo' },

    // --- Harbourview Dental: light, not VAT registered ----------------------
    { supplier: 'Henry Schein', grossPounds: 1420.0, daysOld: 4, state: 'READY', inbox: 'COSTS', category: 'Consumables', channel: 'EMAIL', docType: 'INVOICE', business: 'biz_dental', vatRate: 0 },
    { supplier: 'Dental Directory', grossPounds: 688.5, daysOld: 8, state: 'PUBLISHED', inbox: 'COSTS', category: 'Consumables', channel: 'EMAIL', docType: 'INVOICE', business: 'biz_dental', vatRate: 0 },
    { supplier: 'GDC', grossPounds: 890.0, daysOld: 22, state: 'ARCHIVED', inbox: 'COSTS', category: 'Professional Fees', channel: 'WEB_UPLOAD', docType: 'INVOICE', business: 'biz_dental', vatRate: 0 },
    { supplier: 'Bupa', grossPounds: 4120.0, daysOld: 10, state: 'READY', inbox: 'SALES', category: 'Sales — Plans', channel: 'EMAIL', docType: 'INVOICE', business: 'biz_dental', vatRate: 0 },
    { supplier: 'Npower', grossPounds: 264.15, daysOld: 6, state: 'TO_REVIEW', inbox: 'COSTS', channel: 'EMAIL', docType: 'INVOICE', business: 'biz_dental' },
    { supplier: 'Anglian Water', grossPounds: 98.4, daysOld: 16, state: 'PUBLISHED', inbox: 'COSTS', category: 'Utilities', channel: 'EMAIL', docType: 'INVOICE', business: 'biz_dental' },
    { supplier: 'Amazon', grossPounds: 74.99, daysOld: 2, state: 'TO_REVIEW', inbox: 'COSTS', channel: 'SMS_PORTAL', docType: 'RECEIPT', business: 'biz_dental' },
    { supplier: 'Unknown', grossPounds: 0, daysOld: 3, state: 'REJECTED', inbox: 'COSTS', channel: 'EMAIL', business: 'biz_dental', failureCode: 'NT-ING-0011', failureMessage: 'The email contained a link to download the invoice rather than the invoice itself. Ask the sender to attach the file.' },
    { supplier: 'Henry Schein', grossPounds: 322.6, daysOld: 18, state: 'ARCHIVED', inbox: 'COSTS', category: 'Consumables', channel: 'EMAIL', docType: 'INVOICE', business: 'biz_dental', vatRate: 0 },
    { supplier: 'Practice Plan', grossPounds: 1860.0, daysOld: 12, state: 'READY', inbox: 'SALES', category: 'Sales — Plans', channel: 'EMAIL', docType: 'INVOICE', business: 'biz_dental', vatRate: 0 },

    // --- the Unrouted queue: nothing is ever silently dropped ---------------
    { supplier: 'Wolseley', grossPounds: 430.1, daysOld: 1, state: 'TO_REVIEW', inbox: 'UNROUTED', channel: 'EMAIL', docType: 'INVOICE', business: 'biz_burger' },
    { supplier: 'City Electrical', grossPounds: 210.0, daysOld: 2, state: 'TO_REVIEW', inbox: 'UNROUTED', channel: 'EMAIL', docType: 'INVOICE', business: 'biz_cosmo' },
    { supplier: 'Unknown', grossPounds: 55.0, daysOld: 3, state: 'TO_REVIEW', inbox: 'UNROUTED', channel: 'WHATSAPP', docType: 'RECEIPT', business: 'biz_burger' },
    { supplier: 'Lyreco', grossPounds: 129.4, daysOld: 4, state: 'TO_REVIEW', inbox: 'UNROUTED', channel: 'EMAIL', docType: 'INVOICE', business: 'biz_dental' },
  ];

  const docIds: string[] = [];

  for (const [i, s] of specs.entries()) {
    const id = `doc_${String(i + 1).padStart(3, '0')}`;
    docIds.push(id);
    const isFailure = s.state === 'REJECTED' || s.state === 'FAILED';
    const { totalPence, taxPence } = withVat(s.grossPounds, s.vatRate ?? 0.2);
    const receivedAt = daysAgo(s.daysOld);

    await prisma.document.create({
      data: {
        id,
        businessId: s.business,
        s3Key: `w/${s.business}/${id}.pdf`,
        originalFilename: `${s.supplier.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${id}.pdf`,
        mimeType: s.docType === 'RECEIPT' ? 'image/jpeg' : 'application/pdf',
        byteSize: 120_000 + i * 3_100,
        byteHash: `sha256:${id}${'0'.repeat(50)}`,
        perceptualHash: s.docType === 'RECEIPT' ? `phash:${id}` : null,
        channel: s.channel,
        submitterUserId: s.channel === 'WEB_UPLOAD' ? 'usr_tom' : s.business === 'biz_burger' ? 'usr_dee' : null,
        receivedAt,
        inbox: s.inbox,
        state: s.state,
        docType: s.docType ?? null,
        supplierName: isFailure ? null : s.inbox === 'SALES' ? null : s.supplier,
        customerName: s.inbox === 'SALES' ? s.supplier : null,
        documentDate: isFailure ? null : receivedAt,
        dueDate: isFailure || s.docType === 'RECEIPT' ? null : daysAhead(30 - s.daysOld),
        currency: isFailure ? null : 'GBP',
        totalPence: isFailure ? null : totalPence,
        taxPence: isFailure ? null : taxPence,
        reference: isFailure ? null : `${s.supplier.slice(0, 3).toUpperCase()}-${1000 + i}`,
        categoryCode: s.category ?? null,
        routingConfidence: s.inbox === 'UNROUTED' ? 0.41 : s.channel === 'EMAIL' ? 0.97 : null,
        routingDecision:
          s.inbox === 'UNROUTED'
            ? { method: 'ai_addressee', reason: 'Bill-to name matched no client workspace above threshold' }
            : s.channel === 'EMAIL'
              ? { method: 'sender_identity', matched: 'registered supplier address' }
              : null,
        failureCode: s.failureCode ?? null,
        failureMessage: s.failureMessage ?? null,
        archivedAt: s.state === 'ARCHIVED' ? daysAgo(s.daysOld - 1) : null,
      },
    });

    // Extraction with per-field confidence and provenance — this is what the
    // editable overlay and the provenance classes (§13.3) render from.
    if (!isFailure && s.state !== 'PROCESSING') {
      const lowConfidence = s.state === 'TO_REVIEW';
      await prisma.extraction.create({
        data: {
          id: `ext_${id}`,
          documentId: id,
          extractorKind: 'textract',
          modelVersion: 'textract-analyze-expense-2026-06',
          promptVersion: null,
          ladderRung: 'textract',
          overallConfidence: lowConfidence ? 0.71 : 0.96,
          isAccepted: true,
          fields: {
            supplier: { value: s.supplier, confidence: lowConfidence ? 0.64 : 0.98, provenance: 'textract:block/12' },
            total: { value: totalPence, confidence: lowConfidence ? 0.72 : 0.99, provenance: 'textract:block/44' },
            tax: { value: taxPence, confidence: lowConfidence ? 0.58 : 0.95, provenance: 'textract:block/45' },
            documentDate: { value: receivedAt.toISOString().slice(0, 10), confidence: lowConfidence ? 0.69 : 0.97, provenance: 'textract:block/7' },
            lineItems: [
              { description: s.inbox === 'SALES' ? 'Platform sales, period total' : `${s.supplier} goods`, totalPence: Math.round(totalPence * 0.7), taxPence: Math.round(taxPence * 0.7), quantity: 1, confidence: 0.94 },
              { description: 'Delivery / service', totalPence: Math.round(totalPence * 0.3), taxPence: Math.round(taxPence * 0.3), quantity: 1, confidence: 0.91 },
            ],
          },
          validatorResults: {
            vatArithmetic: { pass: true, detail: 'net + tax = gross within ±1p' },
            vatNumber: s.business === 'biz_dental' ? { pass: null, detail: 'client not VAT registered' } : { pass: true, detail: 'GB checksum ok' },
            dates: { pass: true },
            currency: { pass: true, detail: 'GBP symbol and ISO code agree' },
          },
        },
      });

      await prisma.documentEvent.createMany({
        data: [
          { id: `evt_${id}_1`, documentId: id, stage: 'ingest', outcome: 'ok', durationMs: 240, traceId: `trace_${id}` },
          { id: `evt_${id}_2`, documentId: id, stage: 'sanitise', outcome: 'ok', durationMs: 810, traceId: `trace_${id}` },
          { id: `evt_${id}_3`, documentId: id, stage: 'extract', outcome: 'ok', durationMs: 4_120, traceId: `trace_${id}` },
        ],
      });
    }

    if (isFailure) {
      await prisma.documentEvent.create({
        data: { id: `evt_${id}_1`, documentId: id, stage: 'ingest', outcome: 'failed', durationMs: 180, traceId: `trace_${id}`, detail: { code: s.failureCode } },
      });
    }

    // AI suggestions on the items awaiting review.
    if (s.state === 'TO_REVIEW' && !isFailure) {
      await prisma.suggestion.create({
        data: {
          id: `sug_${id}`,
          documentId: id,
          field: 'categoryCode',
          value: s.supplier === 'Currys' ? 'Computer Equipment' : s.supplier === 'Shell' ? 'Motor Expenses' : 'Office Supplies',
          confidence: 0.83,
          reasoning: `Past coding for ${s.supplier} at this client, plus line-item keywords.`,
          modelVersion: 'anthropic.claude-sonnet-4-6',
        },
      });
    }
  }

  // A pending duplicate pair — Currys receipt submitted twice, once by photo
  // and once by email forward. Different byte hashes, same transaction.
  await prisma.duplicate.create({
    data: {
      id: 'dup_001',
      businessId: 'biz_burger',
      documentAId: 'doc_004',
      documentBId: 'doc_016',
      score: 0.94,
      verdict: 'PENDING',
      signals: {
        byteHash: false,
        perceptualHash: false,
        ocrTextSimilarity: 0.93,
        fieldRule: 'supplier + total + date match',
        crossDocumentType: false,
        crossUploader: true,
      },
    },
  });

  // =========================================================================
  // BANKING — a month of lines, some matched, some driving chases
  // =========================================================================
  console.log('Banking…');

  for (const c of clients) {
    await prisma.bankConnection.create({
      data: {
        id: `bnk_${c.id}`,
        businessId: c.id,
        provider: 'truelayer',
        institutionName: c.id === 'biz_dental' ? 'Starling' : 'Barclays',
        consentState: c.id === 'biz_cosmo' ? 'RECONFIRM_DUE' : 'ACTIVE',
        consentedAt: daysAgo(c.id === 'biz_cosmo' ? 82 : 30),
        reconfirmDue: daysAhead(c.id === 'biz_cosmo' ? 8 : 60),
      },
    });

    await prisma.bankAccount.create({
      data: {
        id: `acc_${c.id}`,
        businessId: c.id,
        connectionId: `bnk_${c.id}`,
        displayName: `${c.name} — Current`,
        accountType: 'business_current',
        sortCode: '04-00-04',
        accountLast4: c.id === 'biz_burger' ? '4417' : c.id === 'biz_cosmo' ? '9082' : '3355',
        balancePence: pounds(c.id === 'biz_burger' ? 18_412.55 : c.id === 'biz_cosmo' ? 26_004.1 : 41_220.8),
        balanceAt: daysAgo(1),
      },
    });
  }

  // Descriptors that must never generate a chase — nobody gets chased for a
  // receipt that cannot exist (SoT Stage 7).
  const suppressed = ['STRIPE PAYOUT', 'SERVICE CHARGE', 'OD INTEREST', 'SUMUP', 'WORLDPAY'];

  const txSpecs: Array<{ business: string; desc: string; pounds: number; daysOld: number; matchDoc?: string; state: 'UNMATCHED' | 'CONFIRMED' | 'SUGGESTED' | 'EXCLUDED' }> = [
    { business: 'biz_burger', desc: 'BIDFOOD LTD', pounds: -1284.5, daysOld: 2, matchDoc: 'doc_001', state: 'CONFIRMED' },
    { business: 'biz_burger', desc: 'BIDFOOD LTD', pounds: -976.2, daysOld: 9, matchDoc: 'doc_002', state: 'CONFIRMED' },
    { business: 'biz_burger', desc: 'CURRYS 0842', pounds: -1299.0, daysOld: 3, state: 'UNMATCHED' },
    { business: 'biz_burger', desc: 'ADOBE SYSTEMS', pounds: -61.99, daysOld: 5, matchDoc: 'doc_005', state: 'CONFIRMED' },
    { business: 'biz_burger', desc: 'AMZNMKTPLACE', pounds: -156.3, daysOld: 4, state: 'SUGGESTED' },
    { business: 'biz_burger', desc: 'SHELL BRISTOL', pounds: -78.4, daysOld: 1, state: 'UNMATCHED' },
    { business: 'biz_burger', desc: 'BRITISH GAS', pounds: -412.66, daysOld: 7, state: 'UNMATCHED' },
    { business: 'biz_burger', desc: 'STRIPE PAYOUT', pounds: 2841.55, daysOld: 6, state: 'UNMATCHED' },
    { business: 'biz_burger', desc: 'SERVICE CHARGE', pounds: -18.0, daysOld: 6, state: 'UNMATCHED' },
    { business: 'biz_burger', desc: 'JUST EAT PAYOUT', pounds: 2841.55, daysOld: 6, matchDoc: 'doc_010', state: 'SUGGESTED' },
    { business: 'biz_burger', desc: 'SCREWFIX DIRECT', pounds: -47.88, daysOld: 1, state: 'UNMATCHED' },
    { business: 'biz_burger', desc: 'WOLSELEY UK', pounds: -430.1, daysOld: 1, state: 'UNMATCHED' },

    { business: 'biz_cosmo', desc: 'BRAKES BROS', pounds: -2140.75, daysOld: 4, matchDoc: 'doc_017', state: 'CONFIRMED' },
    { business: 'biz_cosmo', desc: 'GOOGLE ADS', pounds: -600.0, daysOld: 8, state: 'UNMATCHED' },
    { business: 'biz_cosmo', desc: 'BOOKER LTD', pounds: -733.2, daysOld: 10, matchDoc: 'doc_020', state: 'CONFIRMED' },
    { business: 'biz_cosmo', desc: 'THAMES WATER', pounds: -188.9, daysOld: 12, state: 'UNMATCHED' },
    { business: 'biz_cosmo', desc: 'NISBETS PLC', pounds: -2480.0, daysOld: 2, state: 'UNMATCHED' },
    { business: 'biz_cosmo', desc: 'UBER EATS PAYOUT', pounds: 3204.4, daysOld: 5, matchDoc: 'doc_022', state: 'SUGGESTED' },
    { business: 'biz_cosmo', desc: 'WORLDPAY', pounds: 1180.0, daysOld: 3, state: 'UNMATCHED' },
    { business: 'biz_cosmo', desc: 'SKY BUSINESS', pounds: -96.0, daysOld: 19, state: 'UNMATCHED' },

    { business: 'biz_dental', desc: 'HENRY SCHEIN', pounds: -1420.0, daysOld: 3, matchDoc: 'doc_027', state: 'CONFIRMED' },
    { business: 'biz_dental', desc: 'DENTAL DIRECTORY', pounds: -688.5, daysOld: 7, matchDoc: 'doc_028', state: 'CONFIRMED' },
    { business: 'biz_dental', desc: 'NPOWER', pounds: -264.15, daysOld: 5, state: 'UNMATCHED' },
    { business: 'biz_dental', desc: 'BUPA DENTAL', pounds: 4120.0, daysOld: 9, state: 'UNMATCHED' },
    { business: 'biz_dental', desc: 'OD INTEREST', pounds: -4.12, daysOld: 6, state: 'UNMATCHED' },
    { business: 'biz_dental', desc: 'AMZNMKTPLACE', pounds: -74.99, daysOld: 1, state: 'UNMATCHED' },
  ];

  for (const [i, t] of txSpecs.entries()) {
    const id = `txn_${String(i + 1).padStart(3, '0')}`;
    await prisma.bankTransaction.create({
      data: {
        id,
        businessId: t.business,
        accountId: `acc_${t.business}`,
        providerTransactionId: `tl_${id}`,
        bookedAt: daysAgo(t.daysOld),
        amountPence: pounds(t.pounds),
        currency: 'GBP',
        descriptionRaw: t.desc,
        merchantName: t.desc.split(' ')[0] ?? null,
        classification: t.pounds > 0 ? 'income' : 'expense',
        matchState: t.state,
        chaseSuppressed: suppressed.some((s) => t.desc.includes(s)),
      },
    });

    if (t.matchDoc) {
      await prisma.match.create({
        data: {
          id: `mat_${id}`,
          businessId: t.business,
          documentId: t.matchDoc,
          transactionId: id,
          kind: t.state === 'SUGGESTED' ? 'PROBABILISTIC' : 'EXACT',
          confidence: t.state === 'SUGGESTED' ? 0.78 : 1.0,
          state: t.state === 'CONFIRMED' ? 'CONFIRMED' : 'SUGGESTED',
          matchedBy: t.state === 'CONFIRMED' ? 'rule' : 'ai',
        },
      });
    }
  }

  // =========================================================================
  // CHASING — the flagship, with one awaiting approval so the card renders
  // =========================================================================
  console.log('Chases…');

  await prisma.chase.create({
    data: {
      id: 'chs_001',
      businessId: 'biz_burger',
      detectionEngine: 'UNMATCHED_TRANSACTION',
      transactionId: 'txn_003',
      recipientContactId: 'con_dee',
      state: 'SENT',
      itemRefs: [{ transactionId: 'txn_003', descriptor: 'CURRYS 0842', amountPence: pounds(1299), date: daysAgo(3).toISOString().slice(0, 10) }],
      schedule: { firstAfterHours: 48, reminderDays: 3, secondDays: 7, escalateDays: 10 },
      firstSentAt: daysAgo(2),
      lastSentAt: daysAgo(2),
      messages: {
        create: {
          id: 'msg_001',
          channel: 'sms',
          body: 'American Burger Accounts: we are missing the receipt for Currys £1,299.00 on ' + daysAgo(3).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }) + '. Upload securely: https://neoting.neovogent.com/p/xxxx',
          recipientE164: '+447700900123',
          deliveryState: 'delivered',
          sentAt: daysAgo(2),
        },
      },
    },
  });

  await prisma.chase.create({
    data: {
      id: 'chs_002',
      businessId: 'biz_cosmo',
      detectionEngine: 'UNMATCHED_TRANSACTION',
      transactionId: 'txn_017',
      recipientContactId: 'con_marco',
      state: 'ESCALATED',
      itemRefs: [{ transactionId: 'txn_017', descriptor: 'NISBETS PLC', amountPence: pounds(2480), date: daysAgo(2).toISOString().slice(0, 10) }],
      firstSentAt: daysAgo(9),
      lastSentAt: daysAgo(2),
      escalatedAt: daysAgo(1),
    },
  });

  await prisma.chase.create({
    data: {
      id: 'chs_003',
      businessId: 'biz_burger',
      detectionEngine: 'EXPECTED_RECURRING_MISSING',
      recipientContactId: 'con_dee',
      state: 'CLOSED_RECEIVED',
      itemRefs: [{ expected: 'Adobe monthly invoice' }],
      firstSentAt: daysAgo(8),
      closedAt: daysAgo(6),
      closedReason: 'Document received through the secure link',
      closedByDocumentId: 'doc_005',
    },
  });

  // A chase proposed but NOT yet approved — this is what makes the
  // Review → Approve card have something real to render on a fresh clone.
  await prisma.actionProposal.create({
    data: {
      id: 'prop_chase_dental',
      businessId: 'biz_dental',
      kind: 'chase-send',
      state: 'CREATED',
      createdByModel: 'anthropic.claude-sonnet-4-6',
      payloadHash: 'sha256:chase-dental-0001',
      expiresAt: daysAhead(2),
      payload: {
        chases: [
          {
            businessId: 'biz_dental',
            recipient: '+447700900321',
            body: 'Harbourview Dental: we are missing paperwork for Npower £264.15 and Amazon £74.99. Upload securely: https://neoting.neovogent.com/p/yyyy',
            items: ['txn_023', 'txn_026'],
          },
        ],
      },
      renderedSummary: { title: 'Chase 1 client for 2 missing documents', clientCount: 1, itemCount: 2 },
    },
  });

  // And one that completed the full path, so history shows a real approval.
  await prisma.actionProposal.create({
    data: {
      id: 'prop_publish_burger',
      businessId: 'biz_burger',
      kind: 'publish',
      state: 'EXECUTED',
      createdByUserId: 'usr_priya',
      approvedByUserId: 'usr_priya',
      payloadHash: 'sha256:publish-burger-0001',
      renderedSummaryHash: 'sha256:publish-burger-summary',
      expiresAt: daysAhead(1),
      reviewedAt: daysAgo(5),
      approvedAt: daysAgo(5),
      executedAt: daysAgo(5),
      payload: { documentIds: ['doc_002', 'doc_005', 'doc_009'], destination: 'XERO' },
      renderedSummary: { title: 'Publish 3 bills to Xero', grossPence: pounds(1382.29), vatPence: pounds(230.38) },
      outcome: { published: 3, failed: 0 },
    },
  });

  // =========================================================================
  // RULES, GUIDANCE, APPROVALS, INTEGRATIONS
  // =========================================================================
  console.log('Rules, integrations, vault…');

  await prisma.rule.createMany({
    data: [
      { id: 'rul_001', businessId: 'biz_burger', tier: 'SUPPLIER_CUSTOMER', scopeKey: 'Bidfood', sets: { categoryCode: 'Cost of Sales — Food', taxRate: 'standard', autoPublish: true }, createdVia: 'chat', createdByUserId: 'usr_priya', actionProposalId: 'prop_publish_burger' },
      { id: 'rul_002', businessId: 'biz_burger', tier: 'SUPPLIER_CUSTOMER', scopeKey: 'Amazon', conditions: { totalPenceGreaterThan: pounds(500) }, sets: { flagForReview: 'fixed-asset review' }, createdVia: 'chat' },
      { id: 'rul_003', businessId: 'biz_burger', tier: 'SUPPLIER_CUSTOMER', scopeKey: 'Amazon', sets: { categoryCode: 'Office Supplies' }, createdVia: 'correction' },
      { id: 'rul_004', businessId: 'biz_cosmo', tier: 'SUPPLIER_CUSTOMER', scopeKey: 'Brakes', sets: { categoryCode: 'Cost of Sales — Food', taxRate: 'standard' } },
      { id: 'rul_005', businessId: 'biz_dental', tier: 'ACCOUNT_DEFAULT', sets: { taxRate: 'exempt' } },
    ],
  });

  await prisma.guidance.createMany({
    data: [
      { id: 'gui_001', practiceId: 'prac_ledgerline', level: 'PRACTICE_CORE', mode: 'MANUAL_REVIEW', text: 'Fuel bought at a supermarket forecourt is Motor Expenses, not Groceries.', createdByUserId: 'usr_priya' },
      { id: 'gui_002', practiceId: 'prac_ledgerline', level: 'PRACTICE_SHARED', mode: 'AUTO_APPLY', text: 'Any invoice from a utility company goes to Utilities unless a supplier rule says otherwise.', createdByUserId: 'usr_priya' },
      { id: 'gui_003', businessId: 'biz_burger', level: 'ACCOUNT', mode: 'MANUAL_REVIEW', text: 'Deliveroo and Just Eat payouts are gross sales; the platform commission is a separate cost line.' },
    ],
  });

  await prisma.approvalWorkflow.create({
    data: {
      id: 'wfl_001',
      businessId: 'biz_burger',
      name: 'Purchases over £2,000',
      specificity: 10,
      stages: [
        { index: 0, name: 'Preparer review', approvers: ['usr_tom'], condition: { always: true }, canEdit: true },
        { index: 1, name: 'Director sign-off', approvers: ['usr_dee'], condition: { amountAtLeastPence: pounds(2000) }, canEdit: false },
      ],
      appliesTo: { itemType: 'costs' },
    },
  });

  await prisma.integration.createMany({
    data: [
      { id: 'int_burger_xero', businessId: 'biz_burger', kind: 'XERO', orgRef: 'xero-demo-org-1', health: 'healthy', lastSyncAt: daysAgo(1), tokenExpiresAt: daysAhead(45) },
      { id: 'int_cosmo_qbo', businessId: 'biz_cosmo', kind: 'QUICKBOOKS', orgRef: 'qbo-sandbox-1', health: 'token_expiring', lastSyncAt: daysAgo(3), tokenExpiresAt: daysAhead(4) },
    ],
  });

  for (const [i, d] of ['doc_002', 'doc_005', 'doc_009', 'doc_011', 'doc_020', 'doc_025', 'doc_028', 'doc_032'].entries()) {
    const biz = d <= 'doc_016' ? 'biz_burger' : d <= 'doc_026' ? 'biz_cosmo' : 'biz_dental';
    await prisma.publish.create({
      data: {
        id: `pub_${String(i + 1).padStart(3, '0')}`,
        businessId: biz,
        documentId: d,
        integrationId: biz === 'biz_burger' ? 'int_burger_xero' : biz === 'biz_cosmo' ? 'int_cosmo_qbo' : null,
        mode: i % 3 === 0 ? 'AUTO' : 'MANUAL',
        state: i === 7 ? 'FAILED' : 'SUCCEEDED',
        idempotencyKey: `idem_${d}`,
        attachmentSent: i !== 7,
        externalRef: i === 7 ? null : `INV-${9000 + i}`,
        failureCode: i === 7 ? 'NT-PUB-0003' : null,
        failureMessage: i === 7 ? 'Xero rejected the bill: the supplier contact has no valid VAT treatment for the chosen tax rate.' : null,
        publishedByUserId: 'usr_priya',
        completedAt: daysAgo(2),
      },
    });
  }

  await prisma.vaultItem.createMany({
    data: [
      { id: 'vlt_001', businessId: 'biz_burger', s3Key: 'w/biz_burger/vault/lease.pdf', filename: 'unit-14-lease.pdf', mimeType: 'application/pdf', byteSize: 840_000, title: 'Unit 14 lease agreement', category: 'Property', tags: ['lease', 'property'], folderPath: 'Legal/Property', expiresAt: daysAhead(400) },
      { id: 'vlt_002', businessId: 'biz_burger', s3Key: 'w/biz_burger/vault/insurance.pdf', filename: 'public-liability.pdf', mimeType: 'application/pdf', byteSize: 320_000, title: 'Public liability insurance', category: 'Insurance', tags: ['insurance'], folderPath: 'Insurance', expiresAt: daysAhead(9) },
      { id: 'vlt_003', businessId: 'biz_dental', s3Key: 'w/biz_dental/vault/cqc.pdf', filename: 'cqc-registration.pdf', mimeType: 'application/pdf', byteSize: 210_000, title: 'CQC registration certificate', category: 'Compliance', tags: ['regulatory'], folderPath: 'Compliance', expiresAt: daysAgo(3) },
    ],
  });

  await prisma.task.createMany({
    data: [
      { id: 'tsk_001', businessId: 'biz_burger', title: 'Collect and code August documents', ownerUserId: 'usr_tom', dueAt: daysAhead(5), status: 'open', cadence: 'monthly' },
      { id: 'tsk_002', businessId: 'biz_burger', title: 'Chase missing documents', ownerUserId: 'usr_tom', dueAt: daysAhead(2), status: 'complete', aiPrefilledAt: daysAgo(2) },
      { id: 'tsk_003', businessId: 'biz_cosmo', title: 'Reconfirm bank feed consent', ownerUserId: 'usr_priya', dueAt: daysAhead(8), status: 'open' },
      { id: 'tsk_004', businessId: 'biz_dental', title: 'Review AI assumptions before publishing', ownerUserId: 'usr_priya', dueAt: daysAhead(6), status: 'not_applicable' },
    ],
  });

  await prisma.notification.createMany({
    data: [
      { id: 'ntf_001', businessId: 'biz_burger', event: 'client.uploaded', recipientUserId: 'usr_tom', channels: ['in_app', 'email'], payload: { documentId: 'doc_006', client: 'American Burger Ltd' }, sentAt: daysAgo(2) },
      { id: 'ntf_002', businessId: 'biz_dental', event: 'publish.failed', recipientUserId: 'usr_priya', channels: ['in_app'], payload: { documentId: 'doc_032', code: 'NT-PUB-0003' }, sentAt: daysAgo(2) },
    ],
  });

  await prisma.featureFlag.createMany({
    data: [
      { id: 'flg_001', key: 'chase.auto-schedule', isEnabled: false, description: 'Standing auto-chase policy execution', owner: 'shakib', removeBy: daysAhead(90) },
      { id: 'flg_002', key: 'extraction.vision-ladder-sonnet', isEnabled: true, description: 'Middle rung of the vision escalation ladder — kept or dropped at W2', owner: 'shakib', removeBy: daysAhead(60) },
    ],
  });

  // =========================================================================
  const counts = {
    businesses: await prisma.business.count(),
    documents: await prisma.document.count(),
    transactions: await prisma.bankTransaction.count(),
    chases: await prisma.chase.count(),
    proposals: await prisma.actionProposal.count(),
  };
  console.log('Seed complete:', counts);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
