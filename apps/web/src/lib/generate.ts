import type {
  ApprovalItem,
  ApprovalWorkflow,
  BankAccount,
  BankTransaction,
  Chase,
  ChasePolicy,
  ChaseStage,
  Client,
  Document,
  ExtractedField,
  MissingItem,
  StatementGap,
} from './types';

/**
 * Tops the hand-written seed data up to each client's headline counts, so the
 * numbers shown in the Clients list are the same rows you can drill into.
 * Deterministic — the same input always produces the same rows.
 */

function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

const SUPPLIERS_BY_INDUSTRY: Record<string, string[]> = {
  'Hospitality & Food': ['Bidfood', 'Brakes', 'Booker', 'Sysco', 'Costco', 'Coca-Cola Europacific', 'Nisbets', 'Uber Eats', 'Deliveroo', 'Just Eat', 'British Gas', 'Reynolds Catering'],
  'Software & IT': ['AWS', 'Google Cloud', 'GitHub', 'Slack', 'Atlassian', 'Figma', 'Notion', 'Datadog', 'Vercel', 'Apple', 'Dell', 'Adobe'],
  Architecture: ['Hilti UK', 'RIBA Bookshop', 'Autodesk', 'Screwfix', 'Travis Perkins', 'Canon UK', 'Vectorworks', 'Trainline', 'Premier Inn'],
  default: ['Amazon Business', 'Currys', 'Royal Mail', 'BT Business', 'WeWork', 'Staples', 'Uber', 'Trainline'],
};

const CATEGORIES_BY_INDUSTRY: Record<string, string[]> = {
  'Hospitality & Food': ['Cost of Sales Food', 'Cost of Sales Drink', 'Kitchen Equipment', 'Utilities', 'Packaging'],
  'Software & IT': ['Software', 'Cloud Hosting', 'Computer Equipment', 'Professional Fees', 'Marketing'],
  Architecture: ['Materials', 'Software', 'Travel', 'Subsistence', 'Professional Fees'],
  default: ['Office Supplies', 'Travel', 'Marketing', 'Utilities', 'Professional Fees'],
};

const CUSTOMERS_BY_INDUSTRY: Record<string, string[]> = {
  'Hospitality & Food': ['Deliveroo', 'Just Eat', 'Uber Eats', 'Corporate Catering Co', 'Westfield Events'],
  'Software & IT': ['Meridian Health Group', 'Halcyon Retail', 'Northwind Logistics', 'Peak Financial', 'Orbit Media'],
  Architecture: ['Barratt Developments', 'Camden Council', 'Lyle Property Group', 'Sable Estates'],
  default: ['Acme Holdings', 'Bright Retail', 'Kingsway Partners'],
};

const SALES_CATEGORIES: Record<string, string[]> = {
  'Hospitality & Food': ['Sales — Delivery', 'Sales — Dine-in', 'Sales — Events'],
  'Software & IT': ['Sales — Consultancy', 'Sales — Licences', 'Sales — Support'],
  Architecture: ['Sales — Design Fees', 'Sales — Project Management'],
  default: ['Sales — Services'],
};

const ENGINES: MissingItem['detectedBy'][] = [
  'bank-transaction',
  'bank-transaction',
  'bank-transaction',
  'supplier-statement',
  'ledger-attachment',
  'recurring',
  'statement-gap',
];

const CHANNELS: Document['source'][] = ['email', 'email', 'web', 'whatsapp', 'sms-link', 'csv'];

function pick<T>(list: T[], r: () => number): T {
  return list[Math.floor(r() * list.length)];
}

function dateIn(month: string, day: number) {
  return `${String(day).padStart(2, '0')} ${month} 2026`;
}

function suppliersFor(client: Client) {
  return SUPPLIERS_BY_INDUSTRY[client.industry] ?? SUPPLIERS_BY_INDUSTRY.default;
}

function categoriesFor(client: Client) {
  return CATEGORIES_BY_INDUSTRY[client.industry] ?? CATEGORIES_BY_INDUSTRY.default;
}

function seedFromId(id: string) {
  let h = 7;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return h;
}

/** Fills each client's missing-paperwork list up to its headline count. */
export function buildMissing(base: MissingItem[], clients: Client[]): MissingItem[] {
  const out = [...base];

  for (const client of clients) {
    const existing = base.filter((m) => m.clientId === client.id).length;
    const needed = Math.max(0, client.missingDocs - existing);
    const r = rng(seedFromId(client.id) + 11);
    const suppliers = suppliersFor(client);

    for (let i = 0; i < needed; i++) {
      const engine = pick(ENGINES, r);
      out.push({
        id: `mi-${client.id}-g${i}`,
        clientId: client.id,
        clientName: client.name,
        supplier: pick(suppliers, r),
        date: dateIn(r() > 0.45 ? 'Jul' : 'Aug', 1 + Math.floor(r() * 28)),
        amount: engine === 'statement-gap' ? 0 : Math.round((30 + r() * 2400) * 100) / 100,
        detectedBy: engine,
        // Roughly a third are already out with the client awaiting a reply.
        chased: r() > 0.66,
      });
    }
  }

  return out;
}

/** Line descriptions on archived documents — what keyword search reaches into. */
const LINE_ITEM_POOL = [
  'Brioche buns — case of 60',
  'Avocado, ripe — 4kg box',
  'Beef patties 4oz — case of 48',
  'Cheddar slices — 5kg',
  'Paper napkins — 2000 count',
  'Cleaning consumables',
  'Delivery surcharge',
  'Annual licence renewal',
];

const BANKS = ['Barclays', 'Lloyds', 'NatWest', 'HSBC', 'Starling', 'Monzo Business'];

/** One current account per client, plus a savings account for the larger ones. */
export function buildAccounts(clients: Client[]): BankAccount[] {
  return clients.flatMap((client) => {
    const r = rng(seedFromId(client.id) + 53);
    const bank = pick(BANKS, r);
    const accounts: BankAccount[] = [
      {
        id: `acct-${client.id}-1`,
        clientId: client.id,
        clientName: client.name,
        bankName: bank,
        sortCode: `${20 + Math.floor(r() * 60)}-${10 + Math.floor(r() * 80)}-${10 + Math.floor(r() * 80)}`,
        last4: String(1000 + Math.floor(r() * 8999)).slice(0, 4),
        balance: Math.round((2000 + r() * 60000) * 100) / 100,
        lastSync: client.bankConnected ? `${1 + Math.floor(r() * 6)}h ago` : 'never',
        reauthDays: client.bankConnected ? 8 + Math.floor(r() * 82) : 0,
        status: client.bankConnected ? 'live' : 'disconnected',
        source: client.bankConnected ? 'feed' : 'statements',
      },
    ];

    if (r() > 0.55) {
      accounts.push({
        id: `acct-${client.id}-2`,
        clientId: client.id,
        clientName: client.name,
        bankName: bank,
        sortCode: accounts[0].sortCode,
        last4: String(1000 + Math.floor(r() * 8999)).slice(0, 4),
        balance: Math.round((500 + r() * 24000) * 100) / 100,
        lastSync: client.bankConnected ? `${1 + Math.floor(r() * 9)}h ago` : 'never',
        reauthDays: client.bankConnected ? 4 + Math.floor(r() * 40) : 0,
        // A credential error that has not yet hit the 90-day auto-disconnect.
        status: client.bankConnected ? (r() > 0.7 ? 'error' : 'live') : 'disconnected',
        source: client.bankConnected ? 'feed' : 'statements',
      });
    }

    return accounts;
  });
}

/**
 * Builds the transaction feed. Every missing item detected from the bank gets a
 * real transaction carrying its id, so matching or cash-coding one closes the
 * missing item — and with it the client's chase.
 */
export function buildTransactions(
  base: BankTransaction[],
  clients: Client[],
  missing: MissingItem[],
  accounts: BankAccount[],
): BankTransaction[] {
  const out = base.map((t) => ({
    ...t,
    accountId: t.accountId || `acct-${t.clientId}-1`,
  }));

  for (const client of clients) {
    const r = rng(seedFromId(client.id) + 71);
    const clientAccounts = accounts.filter((a) => a.clientId === client.id);
    if (!clientAccounts.length) continue;

    // Unexplained spend: one transaction per bank-detected missing item.
    const fromBank = missing.filter((m) => m.clientId === client.id && m.detectedBy === 'bank-transaction');
    for (const item of fromBank) {
      if (out.some((t) => t.missingItemId === item.id)) continue;
      out.push({
        id: `txn-${item.id}`,
        clientId: client.id,
        clientName: client.name,
        description: item.supplier.toUpperCase(),
        date: item.date,
        amount: item.amount,
        isCredit: false,
        accountId: pick(clientAccounts, r).id,
        missingItemId: item.id,
      });
    }

    // Explained spend: transactions that already carry their evidence. Kept to
    // a handful — enough for the reconciled/unreconciled split to be visible
    // without burying the rows that actually need attention.
    const suppliers = suppliersFor(client);
    const settled = 2 + Math.floor(r() * 2);
    for (let i = 0; i < settled; i++) {
      out.push({
        id: `txn-${client.id}-s${i}`,
        clientId: client.id,
        clientName: client.name,
        description: pick(suppliers, r).toUpperCase(),
        date: dateIn(r() > 0.5 ? 'Jul' : 'Aug', 1 + Math.floor(r() * 28)),
        amount: Math.round((40 + r() * 2200) * 100) / 100,
        isCredit: false,
        accountId: pick(clientAccounts, r).id,
        matchedDocId: `matched-${client.id}-${i}`,
      });
    }

    // A refund or two — negative amounts Dext cannot bank-match at all.
    if (r() > 0.4) {
      out.push({
        id: `txn-${client.id}-cr`,
        clientId: client.id,
        clientName: client.name,
        description: `${pick(suppliers, r).toUpperCase()} REFUND`,
        date: dateIn('Aug', 1 + Math.floor(r() * 20)),
        amount: -Math.round((30 + r() * 600) * 100) / 100,
        isCredit: true,
        accountId: clientAccounts[0].id,
      });
    }
  }

  return out;
}

/**
 * Picks the workflow that applies to a document — most specific wins, exactly
 * one workflow per document.
 */
const listed = (appliesTo: string, prefix: string) =>
  appliesTo.replace(prefix, '').split(',').map((v) => v.trim().toLowerCase()).filter(Boolean);

/**
 * The workflow that claims a document, or none at all.
 *
 * Two rules from wireframe screen 12. Approvals are opt-in per client, so a
 * document belonging to a client with no workflow returns nothing and never
 * pauses. And where several could apply, the most specific wins — a rule about
 * one category beats a rule about one supplier, which beats "all costs".
 */
export function workflowFor(doc: Document, workflows: ApprovalWorkflow[]): ApprovalWorkflow | undefined {
  const candidates = workflows.filter((w) => {
    if (!w.active) return false;
    if (!w.clientIds.includes(doc.clientId)) return false;

    if (w.appliesTo.startsWith('Category:')) {
      return listed(w.appliesTo, 'Category:').includes(doc.category.toLowerCase());
    }
    if (w.appliesTo.startsWith('Supplier:')) {
      return listed(w.appliesTo, 'Supplier:').some((name) => doc.supplier.toLowerCase().includes(name));
    }
    if (w.appliesTo === 'All sales items') return doc.kind === 'sales';
    return doc.kind === 'cost';
  });
  return candidates.sort((a, b) => b.specificity - a.specificity)[0];
}

/** Which branch conditions fire for this amount / supplier. */
export function branchesFor(workflow: ApprovalWorkflow, total: number, newSupplier: boolean) {
  return workflow.branches.filter((b) => {
    if (b.field === 'amount') return total > Number(b.value);
    if (b.field === 'supplier-age') return newSupplier;
    return false;
  });
}

/** Builds the approval queue from documents that a live workflow captures. */
export function buildApprovals(documents: Document[], workflows: ApprovalWorkflow[]): ApprovalItem[] {
  const out: ApprovalItem[] = [];

  documents.forEach((doc, i) => {
    if (doc.status !== 'ready' && doc.status !== 'review') return;
    // Small-value items clear without a signature; everything above the floor
    // is under whichever workflow claims it. There is no extra sampling here —
    // the queue is exactly what the active workflows say it should be.
    if (doc.total < 150) return;

    const workflow = workflowFor(doc, workflows);
    if (!workflow) return;

    const newSupplier = doc.supplier.length % 7 === 0;
    const fired = branchesFor(workflow, doc.total, newSupplier);
    /**
     * An item sits at the highest stage its own value demands — the stages
     * below it have already been passed. Without this nothing ever started
     * beyond stage 1, so a workflow's later stages (including any client-side
     * sign-off) had no way of appearing until someone approved by hand.
     */
    const stageIndex = workflow.stages.reduce(
      (best, s, i) => (s.thresholdAbove !== undefined && doc.total > s.thresholdAbove ? i : best),
      0,
    );
    const stage = workflow.stages[stageIndex];

    out.push({
      id: `appr-${doc.id}`,
      documentId: doc.id,
      clientId: doc.clientId,
      clientName: doc.clientName,
      supplier: doc.supplier,
      total: doc.total,
      category: doc.category,
      workflowId: workflow.id,
      stageIndex,
      stage: `Stage ${stageIndex + 1} — ${stage.name}`,
      approver: stage.approver,
      waitingDays: 1 + (i % 9),
      state: 'pending',
      addedByBranch: fired.map((b) => b.addApprover),
      locked: false,
      history: [{ at: `${1 + (i % 9)} days ago`, label: 'Entered approval', actor: 'Rules engine', note: workflow.name }],
    });
  });

  return out;
}

export const DEFAULT_CHASE_POLICY: ChasePolicy = {
  firstChaseAfterHours: 48,
  reminderOneDays: 3,
  reminderTwoDays: 7,
  escalateAfterDays: 10,
  quietHoursStart: '20:00',
  quietHoursEnd: '08:00',
  senderId: 'MigratePro',
  linkTtlHours: 72,
  resendAfterHours: 72,
  autoChase: false,
  notifyOnUpload: true,
};

/** One SMS per client naming the exact transactions — never one text per receipt. */
export function composeChaseMessage(client: Client, items: { supplier: string; amount: number; date: string }[]) {
  const head = items[0];
  const rest = items.length - 1;
  const first = head
    ? `we're missing the receipt for ${head.supplier}${head.amount ? ` £${head.amount.toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : ''} on ${head.date.replace(/ \d{4}$/, '')}`
    : 'we need some paperwork from you';
  const tail = rest > 0 ? `, plus ${rest} other item${rest === 1 ? '' : 's'}` : '';
  return `${client.name.replace(/ Ltd$/, '')} Accounts: ${first}${tail}. Upload securely: https://sec.ure/${client.id}${hashPart(client.id)}`;
}

function hashPart(id: string) {
  let h = 17;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return h.toString(36).slice(0, 4);
}

/**
 * Every already-chased missing item belongs to a live chase. Building the
 * records from the same list keeps counts and chase state from ever drifting.
 */
/**
 * A secure upload link may be set to whatever suits the client, but never
 * beyond a week — a link that outlives the conversation it came from is a
 * standing invitation to whoever ends up with the text.
 */
export const MIN_LINK_TTL_HOURS = 1;
export const MAX_LINK_TTL_HOURS = 168;

export const clampLinkTtl = (hours: number) =>
  Math.min(MAX_LINK_TTL_HOURS, Math.max(MIN_LINK_TTL_HOURS, Math.round(hours) || MIN_LINK_TTL_HOURS));

/** Presets for the common choices; anything between them can still be typed. */
export const LINK_TTL_PRESETS = [
  { label: '24 hours', hours: 24 },
  { label: '48 hours', hours: 48 },
  { label: '72 hours', hours: 72 },
  { label: '7 days', hours: 168 },
];

export function buildChases(
  missing: MissingItem[],
  clients: Client[],
  policy: ChasePolicy,
  nowMs: number = Date.now(),
): Chase[] {
  const chases: Chase[] = [];

  // Staggered so the practice dashboard shows every stage of the schedule,
  // rather than every client happening to sit in the same window.
  const AGES = [30, 96, 200, 288];

  clients.forEach((client, index) => {
    const chased = missing.filter((m) => m.clientId === client.id && m.chased);
    if (chased.length === 0) return;

    const hoursSinceSent = AGES[index % AGES.length];
    const days = hoursSinceSent / 24;

    let stage: ChaseStage = 'sent';
    if (days >= policy.escalateAfterDays) stage = 'escalated';
    else if (days >= policy.reminderTwoDays) stage = 'reminder-2';
    else if (days >= policy.reminderOneDays) stage = 'reminder-1';

    const events = [{ at: `${hoursSinceSent}h ago`, label: 'Chase sent by SMS', detail: `${chased.length} items requested` }];
    // Each reminder refreshes the secure link, so expiry runs from the last touch.
    let hoursSinceLastTouch = hoursSinceSent;
    if (stage !== 'sent') {
      hoursSinceLastTouch = Math.round(hoursSinceSent - policy.reminderOneDays * 24);
      events.unshift({ at: `${hoursSinceLastTouch}h ago`, label: 'Reminder 1 sent', detail: 'No response yet' });
    }
    if (stage === 'reminder-2' || stage === 'escalated') {
      hoursSinceLastTouch = Math.round(hoursSinceSent - policy.reminderTwoDays * 24);
      events.unshift({ at: `${hoursSinceLastTouch}h ago`, label: 'Reminder 2 sent', detail: 'No response yet' });
    }
    if (stage === 'escalated') events.unshift({ at: 'now', label: 'Escalated to the accountant', detail: 'Past the escalation threshold' });

    chases.push({
      id: `chase-${client.id}`,
      clientId: client.id,
      clientName: client.name,
      recipientName: client.contactName ?? 'Primary contact',
      recipientMobile: client.mobile ?? '—',
      message: composeChaseMessage(client, chased),
      hoursSinceSent,
      // Seeded from the age above so a freshly loaded chase has a real
      // last-sent time to count a cooldown from.
      lastSmsAtMs: nowMs - hoursSinceLastTouch * 3_600_000,
      stage,
      linkExpiresInHours: Math.max(0, policy.linkTtlHours - Math.max(0, hoursSinceLastTouch)),
      // Some clients have partially responded; others have gone quiet.
      lastUpload: index % 2 === 0 ? `${2 + index * 3}h ago` : 'awaiting',
      policy: `Standard (${policy.reminderOneDays}/${policy.reminderTwoDays} days)`,
      items: chased.map((m) => ({
        missingItemId: m.id,
        supplier: m.supplier,
        amount: m.amount,
        date: m.date,
        status: 'requested',
        origin: m,
      })),
      events,
    });
  });

  return chases;
}

/** Statement periods where the balances or dates do not run continuously. */
export function buildGaps(clients: Client[], accounts: BankAccount[]): StatementGap[] {
  const gaps: StatementGap[] = [];

  for (const client of clients) {
    const r = rng(seedFromId(client.id) + 97);
    const account = accounts.find((a) => a.clientId === client.id);
    if (!account) continue;

    // Clients on statement upload drift far more than clients on a live feed.
    const count = client.bankConnected ? (r() > 0.75 ? 1 : 0) : 1 + Math.floor(r() * 2);
    for (let i = 0; i < count; i++) {
      const start = 1 + Math.floor(r() * 14);
      gaps.push({
        id: `gap-${client.id}-${i}`,
        clientId: client.id,
        clientName: client.name,
        accountId: account.id,
        periodStart: dateIn('Jul', start),
        periodEnd: dateIn('Jul', start + 7 + Math.floor(r() * 10)),
        reason:
          r() > 0.5
            ? 'Closing balance does not carry into the next statement'
            : 'No statement covers this period',
      });
    }
  }

  return gaps;
}

function fieldsFor(supplier: string, total: number, category: string, r: () => number): ExtractedField[] {
  const catConfidence = category === '—' ? 0.24 : 0.8 + r() * 0.19;
  return [
    { label: 'Supplier', value: supplier, confidence: 0.9 + r() * 0.09, provenance: 'header block, page 1' },
    { label: 'Document date', value: 'see header', confidence: 0.88 + r() * 0.11, provenance: 'top-right, page 1' },
    { label: 'Invoice number', value: `INV-${Math.floor(r() * 899999 + 100000)}`, confidence: 0.85 + r() * 0.14, provenance: 'header block, page 1' },
    { label: 'Total', value: `£${total.toFixed(2)}`, confidence: 0.94 + r() * 0.05, provenance: 'totals table' },
    { label: 'Tax amount', value: `£${(total * 0.2).toFixed(2)}`, confidence: 0.7 + r() * 0.29, provenance: 'totals table' },
    { label: 'Category', value: category, confidence: catConfidence, provenance: category === '—' ? 'no rule matched; new vendor' : 'supplier rule' },
  ];
}

/** Fills each client's inbox up to its "items waiting" count. */
export function buildDocuments(base: Document[], clients: Client[]): Document[] {
  const out = [...base];

  for (const client of clients) {
    const existing = base.filter((d) => d.clientId === client.id && d.status === 'review').length;
    const needed = Math.max(0, client.toReview - existing);
    const r = rng(seedFromId(client.id) + 29);
    const suppliers = suppliersFor(client);
    const categories = categoriesFor(client);

    // Items still awaiting review.
    for (let i = 0; i < needed; i++) {
      const supplier = pick(suppliers, r);
      const total = Math.round((25 + r() * 1800) * 100) / 100;
      const noCategory = r() > 0.72;
      const category = noCategory ? '—' : pick(categories, r);
      out.push({
        id: `doc-${client.id}-r${i}`,
        clientId: client.id,
        clientName: client.name,
        supplier,
        date: dateIn(r() > 0.5 ? 'Jul' : 'Aug', 1 + Math.floor(r() * 28)),
        total,
        category,
        status: 'review',
        statusNote: noCategory ? 'Missing Category' : r() > 0.5 ? 'Missing VAT' : 'Suspected duplicate',
        source: pick(CHANNELS, r),
        uploader: client.contactName ?? 'client upload',
        currency: 'GBP',
        kind: 'cost',
        fields: fieldsFor(supplier, total, category, r),
        lineItems: [],
      });
    }

    // A matching band of items that already passed every check. All three
    // bands below scale off `needed`, with no floor — a client whose headline
    // count is already met by hand-written seed rows gets no filler at all.
    const readyCount = Math.round(needed * 0.6);
    for (let i = 0; i < readyCount; i++) {
      const supplier = pick(suppliers, r);
      const total = Math.round((25 + r() * 1200) * 100) / 100;
      const category = pick(categories, r);
      out.push({
        id: `doc-${client.id}-y${i}`,
        clientId: client.id,
        clientName: client.name,
        supplier,
        date: dateIn(r() > 0.5 ? 'Jul' : 'Aug', 1 + Math.floor(r() * 28)),
        total,
        category,
        status: 'ready',
        source: pick(CHANNELS, r),
        uploader: client.contactName ?? 'client upload',
        currency: 'GBP',
        kind: 'cost',
        fields: fieldsFor(supplier, total, category, r),
        lineItems: [],
      });
    }

    // A back-catalogue of published items, so the archive has real history to
    // search. Line items are included — keyword search reaches inside them.
    const publishedCount = Math.round(needed * 0.5);
    for (let i = 0; i < publishedCount; i++) {
      const supplier = pick(suppliers, r);
      const total = Math.round((30 + r() * 1600) * 100) / 100;
      const category = pick(categories, r);
      out.push({
        id: `doc-${client.id}-p${i}`,
        clientId: client.id,
        clientName: client.name,
        supplier,
        date: dateIn(r() > 0.6 ? 'Jun' : 'Jul', 1 + Math.floor(r() * 28)),
        total,
        category,
        status: 'published',
        source: pick(CHANNELS, r),
        uploader: client.contactName ?? 'client upload',
        currency: 'GBP',
        kind: 'cost',
        fields: fieldsFor(supplier, total, category, r),
        // Vary which lines appear so keyword search genuinely discriminates.
        lineItems: Array.from({ length: 1 + Math.floor(r() * 3) }, (_, li) => ({
          description: LINE_ITEM_POOL[(i * 3 + li + Math.floor(r() * 8)) % LINE_ITEM_POOL.length],
          quantity: 1 + li,
          total: Math.round((total / (li + 2)) * 100) / 100,
          tax: 0,
        })),
      });
    }

    // Sales-side documents land in their own inbox via AI classification.
    const customers = CUSTOMERS_BY_INDUSTRY[client.industry] ?? CUSTOMERS_BY_INDUSTRY.default;
    const salesCategories = SALES_CATEGORIES[client.industry] ?? SALES_CATEGORIES.default;
    const salesCount = Math.round(needed * 0.22);
    for (let i = 0; i < salesCount; i++) {
      const customer = pick(customers, r);
      const total = Math.round((320 + r() * 14000) * 100) / 100;
      const needsReview = r() > 0.62;
      const category = needsReview && r() > 0.5 ? '—' : pick(salesCategories, r);
      out.push({
        id: `doc-${client.id}-s${i}`,
        clientId: client.id,
        clientName: client.name,
        supplier: customer,
        date: dateIn(r() > 0.5 ? 'Jul' : 'Aug', 1 + Math.floor(r() * 28)),
        total,
        category,
        status: needsReview ? 'review' : 'ready',
        statusNote: needsReview ? (category === '—' ? 'Missing Category' : 'Missing customer reference') : undefined,
        source: pick(CHANNELS, r),
        uploader: client.contactName ?? 'client upload',
        currency: 'GBP',
        kind: 'sales',
        fields: fieldsFor(customer, total, category, r).map((f) =>
          f.label === 'Supplier' ? { ...f, label: 'Customer' } : f,
        ),
        lineItems: [],
      });
    }
  }

  return out;
}
