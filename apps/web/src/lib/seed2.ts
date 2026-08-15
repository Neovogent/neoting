import type {
  AppSettings,
  ApprovalWorkflow,
  Client,
  Colleague,
  Team,
  VaultDocument,
  WorkflowTask,
} from './types';

/**
 * Six demo workflows, written to wireframe screen 12.
 *
 * They exist to show the shape of the feature, so between them they cover the
 * whole rule vocabulary rather than repeating one pattern: the specificity
 * ladder (type → supplier → category), conditional branching on amount and on
 * a new supplier, per-stage thresholds, a client-side stage delivered by SMS,
 * self-approval, auto-publish, and one workflow switched off.
 *
 * Client scope is the load-bearing part. American Burger has opted in and has
 * five; Cosmo Restaurants has one narrow rule for capital spend and nothing
 * else, so its routine invoices publish without pausing — which is the
 * wireframe's "opt-in, default OFF" made visible rather than asserted.
 */
export const seedWorkflows: ApprovalWorkflow[] = [
  {
    id: 'wf-1',
    name: 'Costs — standard',
    appliesTo: 'All cost items',
    clientIds: ['1'],
    specificity: 1,
    stages: [
      { name: 'Manager review', approver: 'You', canEdit: true },
      { name: 'Finance Director', approver: 'S. Patel', thresholdAbove: 1000, canEdit: false },
      // The business signs off its own large spend. Delivered by SMS + OTP —
      // this is the stage that makes the client-side approval screen exist.
      { name: 'Client sign-off', approver: 'John Doe (Director)', thresholdAbove: 1000, canEdit: false, clientSide: true },
    ],
    branches: [
      { field: 'amount', operator: '>', value: '2000', addApprover: 'Finance Director', label: 'Amount over £2,000 adds the Finance Director' },
      { field: 'supplier-age', operator: 'is', value: 'new', addApprover: 'Compliance', label: 'A brand-new supplier adds Compliance' },
    ],
    selfApproval: false,
    autoPublishOnApproval: true,
    active: true,
  },
  {
    id: 'wf-2',
    name: 'Capital expenditure',
    appliesTo: 'Category: Computer Equipment, Kitchen Equipment',
    clientIds: ['1', '2'],
    specificity: 4,
    stages: [
      { name: 'Manager review', approver: 'R. Okafor', canEdit: true },
      { name: 'Finance Director', approver: 'S. Patel', canEdit: false },
      { name: 'Partner sign-off', approver: 'J. Whitfield', thresholdAbove: 5000, canEdit: false },
    ],
    branches: [{ field: 'amount', operator: '>', value: '10000', addApprover: 'Partner', label: 'Over £10,000 requires a second partner' }],
    selfApproval: false,
    autoPublishOnApproval: false,
    active: true,
  },
  {
    id: 'wf-3',
    name: 'Sales invoices',
    appliesTo: 'All sales items',
    clientIds: ['1'],
    specificity: 2,
    stages: [{ name: 'Manager review', approver: 'R. Okafor', canEdit: true }],
    branches: [],
    selfApproval: true,
    autoPublishOnApproval: true,
    active: false,
  },
  {
    /**
     * The routine-supplier case the wireframe argues for: a food wholesaler
     * billing twice a week does not need a signature every time, so the rule
     * that catches it is lighter than the blanket one it overrides.
     */
    id: 'wf-4',
    name: 'Trusted food suppliers',
    appliesTo: 'Supplier: Bidfood, Brakes, Booker',
    clientIds: ['1'],
    specificity: 3,
    stages: [
      { name: 'Manager review', approver: 'R. Okafor', canEdit: true },
      // Only the unusually large delivery gets a second pair of eyes.
      { name: 'Finance Director', approver: 'S. Patel', thresholdAbove: 2500, canEdit: false },
    ],
    branches: [
      { field: 'amount', operator: '>', value: '5000', addApprover: 'Finance Director', label: 'Over £5,000 is not a routine delivery — adds the Finance Director' },
    ],
    selfApproval: true,
    autoPublishOnApproval: true,
    active: true,
  },
  {
    /**
     * Marketing is where money leaves fastest and evidence is thinnest, so
     * this one is deliberately stricter than the blanket rule and the client
     * signs for their own ad spend.
     */
    id: 'wf-5',
    name: 'Marketing and advertising',
    appliesTo: 'Category: Marketing, Advertising',
    clientIds: ['1'],
    specificity: 4,
    stages: [
      { name: 'Manager review', approver: 'You', canEdit: true },
      { name: 'Client sign-off', approver: 'John Doe (Director)', thresholdAbove: 500, canEdit: false, clientSide: true },
    ],
    branches: [
      { field: 'supplier-age', operator: 'is', value: 'new', addApprover: 'Compliance', label: 'A new advertising platform adds Compliance' },
    ],
    selfApproval: false,
    autoPublishOnApproval: true,
    active: true,
  },
  {
    /**
     * Cosmo's only rule beyond capital spend. Deliberately narrow: they asked
     * for eyes on the two wholesalers they buy from and nothing else, so the
     * rest of their invoices publish without pausing. The queue therefore has
     * both clients in it while their opt-in levels stay visibly different.
     */
    id: 'wf-7',
    name: 'Wholesale suppliers',
    appliesTo: 'Supplier: Costco, Sysco, Brakes',
    clientIds: ['2'],
    specificity: 3,
    stages: [
      { name: 'Manager review', approver: 'You', canEdit: true },
      { name: 'Finance Director', approver: 'S. Patel', thresholdAbove: 2000, canEdit: false },
    ],
    branches: [
      { field: 'amount', operator: '>', value: '3000', addApprover: 'Compliance', label: 'Over £3,000 from a wholesaler is worth a second look' },
    ],
    selfApproval: false,
    autoPublishOnApproval: true,
    active: true,
  },
  {
    /**
     * Travel and entertaining, where the question is rarely the amount — it is
     * whether the spend is allowable at all, which is why no stage can edit.
     */
    id: 'wf-6',
    name: 'Travel and entertaining',
    appliesTo: 'Category: Travel, Entertaining, Subsistence',
    clientIds: ['1', '2'],
    specificity: 4,
    stages: [
      { name: 'Manager review', approver: 'R. Okafor', canEdit: false },
      { name: 'Partner sign-off', approver: 'J. Whitfield', thresholdAbove: 750, canEdit: false },
    ],
    branches: [
      { field: 'amount', operator: '>', value: '1500', addApprover: 'Finance Director', label: 'Over £1,500 adds the Finance Director — disallowable spend at this size is a P11D question' },
    ],
    selfApproval: false,
    autoPublishOnApproval: false,
    active: true,
  },
];

/**
 * Four colleagues — every approver the workflows below name, plus one standard
 * user with finance fields hidden so that permission is visible in the demo.
 */
export const seedColleagues: Colleague[] = [
  {
    id: 'u1', name: 'You', email: 'you@practice.co.uk', role: 'Practice Admin', location: 'London',
    teamId: 't1', clientIds: ['1', '2'],
    permissions: ['Publish', 'Approve', 'Chase', 'Connect bank', 'Export', 'Delete'],
    hideFinanceFields: false, active: true,
  },
  {
    id: 'u2', name: 'R. Okafor', email: 'r.okafor@practice.co.uk', role: 'Client Admin', location: 'London',
    teamId: 't1', clientIds: ['1', '2'],
    permissions: ['Publish', 'Approve', 'Chase', 'Export'],
    hideFinanceFields: false, active: true,
  },
  {
    id: 'u3', name: 'S. Patel', email: 's.patel@practice.co.uk', role: 'Client Admin', location: 'Manchester',
    teamId: 't2', clientIds: ['1'],
    permissions: ['Approve', 'Export'],
    hideFinanceFields: false, active: true,
  },
  {
    id: 'u4', name: 'J. Whitfield', email: 'j.whitfield@practice.co.uk', role: 'Practice Admin', location: 'London',
    teamId: 't1', clientIds: ['1', '2'],
    permissions: ['Publish', 'Approve', 'Chase', 'Connect bank', 'Export', 'Delete'],
    hideFinanceFields: false, active: true,
  },
  {
    id: 'u5', name: 'L. Nguyen', email: 'l.nguyen@practice.co.uk', role: 'Standard User', location: 'Manchester',
    teamId: 't2', clientIds: ['2'],
    permissions: ['Chase'],
    hideFinanceFields: true, active: true,
  },
];

export const seedTeams: Team[] = [
  { id: 't1', name: 'Bookkeeping — London', accessLevel: 'All clients', memberIds: ['u1', 'u2', 'u4'] },
  { id: 't2', name: 'Hospitality specialists', accessLevel: 'Assigned clients only', memberIds: ['u3', 'u5'] },
];

/** Five steps per client — ten tasks in total across the demo dataset. */
const TASK_TEMPLATE = [
  'Confirm bank feed is live',
  'Collect documents for the period',
  'Chase missing documents',
  'Review AI assumptions',
  'Publish to accounting software',
];

/** Recurring per-client checklists, scoped to this product's job. */
export function buildTasks(clients: Client[]): WorkflowTask[] {
  const tasks: WorkflowTask[] = [];
  clients.forEach((client, ci) => {
    TASK_TEMPLATE.forEach((title, i) => {
      tasks.push({
        id: `task-${client.id}-${i}`,
        clientId: client.id,
        clientName: client.name,
        title,
        assignee: ['You', 'R. Okafor', 'S. Patel', 'L. Nguyen'][(ci + i) % 4],
        due: client.deadline,
        status: 'open',
        // These three can be answered from real pipeline state.
        aiPrefilled: i === 0 || i === 2 || i === 4,
        dependsOn: i > 0 ? `task-${client.id}-${i - 1}` : undefined,
      });
    });
  });
  return tasks;
}

/**
 * Five records per client — ten in the vault in total. Between them they cover
 * a near-expiry document, a long-dated one, a permanent record, and the one
 * category that is practice-only rather than client-visible.
 */
const VAULT_TEMPLATE: { category: VaultDocument['category']; name: string; summary: string; tags: string[]; months?: number }[] = [
  { category: 'Engagement letters', name: 'Engagement letter', summary: 'Scope of services, fees and termination terms for the current year.', tags: ['signed', 'annual'], months: 7 },
  { category: 'Insurance', name: 'Employers liability certificate', summary: 'Statutory cover, £10m limit. Must be displayed and renewed annually.', tags: ['statutory', 'renewal'], months: 1 },
  { category: 'Leases', name: 'Premises lease', summary: 'Five-year lease with a break clause at year three; rent reviewed annually.', tags: ['property', 'long-term'], months: 26 },
  { category: 'Tax filings', name: 'VAT registration certificate', summary: 'HMRC registration confirmation and effective date.', tags: ['hmrc', 'permanent'] },
  { category: 'Payroll', name: 'PAYE reference letter', summary: 'HMRC PAYE and Accounts Office references for payroll submissions.', tags: ['payroll', 'hmrc'] },
];

/** Shown as the owner on firm-owned files; matches the practice profile. */
export const PRACTICE_NAME = 'Migrate Properly LLP';

export function buildVault(clients: Client[]): VaultDocument[] {
  const docs: VaultDocument[] = [];

  clients.forEach((client, ci) => {
    VAULT_TEMPLATE.forEach((t, i) => {
      // Deliberately vary expiry so the "to review" tab has real content.
      const offset = t.months === undefined ? undefined : t.months - ci;
      const daysToExpiry = offset === undefined ? undefined : Math.round(offset * 30);

      // Statutory and permanent records belong to the practice; the rest sit
      // with whichever accountant handles the engagement.
      const uploader = ['You', 'R. Okafor', 'S. Patel'][(ci + i) % 3];
      const firmOwned =
        t.tags.includes('permanent') || t.category === 'Payroll' || t.category === 'Engagement letters';

      docs.push({
        id: `vault-${client.id}-${i}`,
        clientId: client.id,
        clientName: client.name,
        financialYear: 'FY 2026',
        category: t.category,
        name: `${t.name} — ${client.name}`,
        summary: t.summary,
        tags: t.tags,
        expiresOn: daysToExpiry === undefined ? undefined : dateFromNow(daysToExpiry),
        daysToExpiry,
        ownerKind: firmOwned ? 'firm' : 'accountant',
        ownerName: firmOwned ? PRACTICE_NAME : uploader,
        sizeKb: 120 + ((ci * 7 + i * 13) % 900),
        source: i % 3 === 0 ? 'Google Drive sync' : 'Web upload',
        uploader,
        uploadedAt: `${1 + ((ci + i) % 11)} months ago`,
        access: t.category === 'Payroll' ? 'practice' : 'client-visible',
      });
    });
  });

  return docs;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** Dates are rendered relative to the fixed 12 Aug 2026 "today" of this dataset. */
function dateFromNow(days: number): string {
  const base = Date.UTC(2026, 7, 12);
  const d = new Date(base + days * 86400000);
  return `${String(d.getUTCDate()).padStart(2, '0')} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

export const DEFAULT_SETTINGS: AppSettings = {
  theme: 'light',
  practiceName: PRACTICE_NAME,
  country: 'United Kingdom',
  baseCurrency: 'GBP',
  yearEnd: '31 March',
  docEmail: 'doc@ourdomain.com',
  duplicateMode: 'review',
  extractTax: true,
  extractDueDate: true,
  autoCategorisation: 'always',
  suggestionMode: 'suggest',
  autoArchiveOnPublish: true,
  autoArchiveOnExport: false,
  dateFormat: 'DD/MM/YYYY',
  csvFormat: 'Standard',
  enforce2fa: true,
  sso: 'off',
  whatsappNumber: '+44 7700 900000',
  notifyPublishFailure: true,
  notifyExtractionFailure: true,
  notifyClientUpload: true,
};
