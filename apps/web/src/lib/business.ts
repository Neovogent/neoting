import type { BusinessAccount, BusinessMember, Client } from './types';

/** Per-channel ceiling for anything sent from the business portal. */
export const PORTAL_UPLOAD_LIMIT = 25 * 1024 * 1024;

export const BUSINESS_ROLES: BusinessMember['role'][] = ['Owner', 'Manager', 'Staff'];

let memberSeq = 0;

export function newMember(name = '', email = ''): BusinessMember {
  return {
    id: `bm-${Date.now()}-${memberSeq++}`,
    name,
    email,
    role: 'Staff',
    canUpload: true,
    canSeeTotals: false,
  };
}

/**
 * Defaults for a freshly created account. Notifications start on because the
 * whole point of the portal is that the business answers a chase without the
 * accountant having to ring them.
 */
export function newBusinessAccount(
  init: Pick<BusinessAccount, 'clientId' | 'businessName' | 'contactName' | 'email' | 'mobile' | 'origin' | 'createdBy'> &
    Partial<BusinessAccount>,
): BusinessAccount {
  return {
    id: `biz-${Date.now()}`,
    status: init.origin === 'accountant-invite' ? 'invited' : 'active',
    createdAt: new Date().toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }),
    notifyBySms: true,
    notifyByEmail: true,
    weeklySummary: true,
    defaultDocKind: 'cost',
    autoSubmitOnCapture: false,
    multiPageCapture: true,
    members: [],
    twoFactor: false,
    ...init,
  };
}

/**
 * Two accounts exist up front so the portal has something to open into: one the
 * practice created and the client has been using, one the business signed up for
 * on its own.
 */
export function buildBusinessAccounts(clients: Client[]): BusinessAccount[] {
  const accounts: BusinessAccount[] = [];

  const first = clients[0];
  if (first) {
    accounts.push({
      id: 'biz-seed-1',
      clientId: first.id,
      businessName: first.name,
      contactName: first.contactName ?? 'Primary contact',
      email: 'john@americanburger.co.uk',
      mobile: first.mobile ?? '+44 7700 900123',
      origin: 'accountant-invite',
      status: 'active',
      createdAt: '02 Mar 2026',
      createdBy: 'You (Practice Admin)',
      notifyBySms: true,
      notifyByEmail: true,
      weeklySummary: true,
      defaultDocKind: 'cost',
      autoSubmitOnCapture: false,
      multiPageCapture: true,
      twoFactor: false,
      members: [
        { id: 'bm-seed-1', name: first.contactName ?? 'John Doe', email: 'john@americanburger.co.uk', mobile: '+44 7700 900123', role: 'Owner', canUpload: true, canSeeTotals: true, status: 'active' },
        { id: 'bm-seed-2', name: 'Priya Nair', email: 'priya@americanburger.co.uk', mobile: '+44 7700 900455', role: 'Manager', canUpload: true, canSeeTotals: true, status: 'active' },
        { id: 'bm-seed-3', name: 'Tom Whyte', email: 'tom@americanburger.co.uk', mobile: '+44 7700 900771', role: 'Staff', canUpload: true, canSeeTotals: false, status: 'active' },
        {
          // Proposed by the practice and waiting on the business — the state
          // that makes the approval card in the portal reachable on load.
          id: 'bm-seed-5',
          name: 'Dan Okonkwo',
          email: 'dan@americanburger.co.uk',
          mobile: '+44 7700 900318',
          role: 'Staff',
          canUpload: true,
          canSeeTotals: false,
          status: 'pending-client-approval',
          invitedAt: '2 hours ago',
          invitedBy: 'You (Practice Admin)',
        },
      ],
    });
  }

  const second = clients[1];
  if (second) {
    accounts.push({
      id: 'biz-seed-2',
      clientId: second.id,
      businessName: second.name,
      contactName: second.contactName ?? 'Primary contact',
      email: 'maria@anandagroup.co.uk',
      mobile: second.mobile ?? '+44 7700 900871',
      origin: 'self-signup',
      status: 'active',
      createdAt: '28 Jun 2026',
      createdBy: 'Signed up directly',
      practiceCode: 'PRC-4417',
      notifyBySms: true,
      notifyByEmail: false,
      weeklySummary: false,
      defaultDocKind: 'cost',
      autoSubmitOnCapture: true,
      multiPageCapture: true,
      twoFactor: true,
      // Subscribed, so the settings Plan section has a populated state to
      // show. The first account deliberately has no subscription — it is the
      // one the synthetic onboarding journey picks, so the subscribe step
      // stays reachable in a demo (launch stage M6).
      subscription: { status: 'active', renewsOn: '28 Sep 2026' },
      members: [
        { id: 'bm-seed-4', name: second.contactName ?? 'Maria Silva', email: 'maria@anandagroup.co.uk', mobile: '+44 7700 900871', role: 'Owner', canUpload: true, canSeeTotals: true, status: 'active' },
      ],
    });
  }

  return accounts;
}
