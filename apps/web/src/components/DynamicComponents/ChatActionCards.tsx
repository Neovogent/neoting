import { lazy, Suspense, useState } from 'react';
import { ArrowRight, CalendarDays, FileCheck2, UserPlus } from 'lucide-react';
import { defineMessages, useIntl, type MessageDescriptor } from 'react-intl';
import type { CreateActionProposalRequest } from '@neoting/contracts/model';
import { useAppContext } from '../../context/AppContext';
import { navigate, path } from '../../lib/router';
import { LiveProposalFlow } from './LiveProposalFlow';

/**
 * Chat reach (15 Oct 2026) — the cards behind the new server intents.
 *
 * Nothing here decides anything. The table a SHOW_* turn carries is the
 * server's (`ChatDisplayBlocks` renders it); `ScreenLinkCard` is only the way
 * to the screen. A draft is the server's, sent back verbatim on a click and
 * approved in Review → Approve. The two forms submit through the endpoints
 * their own screens already use.
 */

const RequestStatementDialog = lazy(() => import('./RequestStatementDialog'));
const InviteColleagueForm = lazy(() =>
  import('../../views/TeamView').then((mod) => ({ default: mod.InviteColleagueForm })),
);

const m = defineMessages({
  open: { id: 'shell.chatActions.open', defaultMessage: 'Open {screen}' },
  pickClient: { id: 'shell.chatActions.pickClient', defaultMessage: 'Pick a client to open this screen.' },
  draftTitle: { id: 'shell.chatActions.draftTitle', defaultMessage: 'Drafted for your review' },
  draftBody: {
    id: 'shell.chatActions.draftBody',
    defaultMessage: '{client} · nothing changes until it is reviewed and approved.',
  },
  stage: { id: 'shell.chatActions.stage', defaultMessage: 'Stage for review' },
  requestTitle: { id: 'shell.chatActions.requestTitle', defaultMessage: 'Request a bank statement' },
  requestBody: {
    id: 'shell.chatActions.requestBody',
    defaultMessage: 'Choose the period for {client}; the message and secure upload link are composed for you.',
  },
  requestOpen: { id: 'shell.chatActions.requestOpen', defaultMessage: 'Choose the period' },
  inviteTitle: { id: 'shell.chatActions.inviteTitle', defaultMessage: 'Invite a colleague' },
  invited: { id: 'shell.chatActions.invited', defaultMessage: 'Invitation sent.' },
});

const SCREEN_LABELS: Record<string, MessageDescriptor> = defineMessages({
  workspace: { id: 'shell.chatActions.screen.workspace', defaultMessage: 'the AI Workspace' },
  clients: { id: 'shell.chatActions.screen.clients', defaultMessage: 'Clients' },
  inboxes: { id: 'shell.chatActions.screen.inboxes', defaultMessage: 'Inboxes' },
  chases: { id: 'shell.chatActions.screen.chases', defaultMessage: 'Chases' },
  approvals: { id: 'shell.chatActions.screen.approvals', defaultMessage: 'Approvals' },
  documents: { id: 'shell.chatActions.screen.documents', defaultMessage: 'Documents' },
  export: { id: 'shell.chatActions.screen.export', defaultMessage: 'Export' },
  analytics: { id: 'shell.chatActions.screen.analytics', defaultMessage: 'Analytics' },
  team: { id: 'shell.chatActions.screen.team', defaultMessage: 'Team' },
  settings: { id: 'shell.chatActions.screen.settings', defaultMessage: 'Settings' },
  'client-overview': { id: 'shell.chatActions.screen.clientOverview', defaultMessage: 'the client overview' },
  'client-costs': { id: 'shell.chatActions.screen.clientCosts', defaultMessage: 'Costs' },
  'client-sales': { id: 'shell.chatActions.screen.clientSales', defaultMessage: 'Sales' },
  'client-bank': { id: 'shell.chatActions.screen.clientBank', defaultMessage: 'Bank' },
  'client-statements': { id: 'shell.chatActions.screen.clientStatements', defaultMessage: 'Statements' },
  'client-supplier-statements': {
    id: 'shell.chatActions.screen.clientSupplierStatements',
    defaultMessage: 'Supplier Statements',
  },
  'client-expense-claims': { id: 'shell.chatActions.screen.clientExpenseClaims', defaultMessage: 'Expense Claims' },
  'client-approvals': { id: 'shell.chatActions.screen.clientApprovals', defaultMessage: 'the client’s Approvals' },
  'client-documents': { id: 'shell.chatActions.screen.clientDocuments', defaultMessage: 'the client’s Documents' },
  'client-chases': { id: 'shell.chatActions.screen.clientChases', defaultMessage: 'the client’s Chases' },
  'client-tasks': { id: 'shell.chatActions.screen.clientTasks', defaultMessage: 'Tasks' },
  'client-users': { id: 'shell.chatActions.screen.clientUsers', defaultMessage: 'Users' },
  'client-connections': { id: 'shell.chatActions.screen.clientConnections', defaultMessage: 'Connections' },
  'client-settings': { id: 'shell.chatActions.screen.clientSettings', defaultMessage: 'the client’s Settings' },
});

/** Practice screens → sidebar tab names; client screens → their sub-tab slug. */
const PRACTICE_TABS: Record<string, string> = {
  workspace: 'AI Workspace',
  inboxes: 'Inboxes',
  chases: 'Chases',
  approvals: 'Approvals',
  documents: 'Documents',
  export: 'Export',
  analytics: 'Analytics',
  team: 'Team',
  settings: 'Settings',
};

/** The address a screen lives at, or null when it needs a client and none is in scope. */
export function screenPath(screen: string, businessId: string | undefined): string | null {
  if (screen === 'clients') return '/clients';
  if (screen in PRACTICE_TABS) return null; // handled by setActiveTab
  if (!screen.startsWith('client-') || businessId === undefined) return null;
  if (screen === 'client-statements') return path('clients', businessId, 'bank', 'statements');
  return path('clients', businessId, screen.slice('client-'.length));
}

const card = 'w-full rounded-2xl bg-card border border-white/10 p-4 flex flex-col gap-3';
const linkButton =
  'self-start flex items-center gap-1.5 text-[12px] font-bold text-brand hover:text-brand-hover transition-colors';

export function ScreenLinkCard({ screen, businessId }: { screen?: string | undefined; businessId?: string | undefined }) {
  const intl = useIntl();
  const { setActiveTab } = useAppContext();
  if (screen === undefined) return null;
  const label = SCREEN_LABELS[screen];
  if (label === undefined) return null;
  const tab = PRACTICE_TABS[screen];
  const to = screenPath(screen, businessId);
  if (tab === undefined && to === null) {
    return <p className="text-[12px] text-zinc-500">{intl.formatMessage(m.pickClient)}</p>;
  }
  return (
    <button onClick={() => (tab === undefined ? navigate(to as string) : setActiveTab(tab))} className={linkButton}>
      {intl.formatMessage(m.open, { screen: intl.formatMessage(label) })}
      <ArrowRight size={13} />
    </button>
  );
}

/** DRAFT_ACTION — the server's draft, staged by an explicit click (never on render). */
export function ChatDraftCard({
  draft,
  businessName,
}: {
  draft: CreateActionProposalRequest;
  businessName?: string | undefined;
}) {
  const intl = useIntl();
  return (
    <div className={card}>
      <span className="flex items-center gap-2 text-[13px] font-bold text-white">
        <FileCheck2 size={14} className="text-brand shrink-0" />
        {intl.formatMessage(m.draftTitle)}
      </span>
      <p className="text-[12.5px] text-zinc-400 leading-relaxed">
        {intl.formatMessage(m.draftBody, { client: businessName ?? '—' })}
      </p>
      <LiveProposalFlow
        buildRequest={() => draft}
        clientName={businessName ?? null}
        stageLabel={intl.formatMessage(m.stage)}
      />
    </div>
  );
}

export function RequestStatementCard({
  businessId,
  businessName,
}: {
  businessId?: string | undefined;
  businessName?: string | undefined;
}) {
  const intl = useIntl();
  const [open, setOpen] = useState(false);
  if (businessId === undefined) return null;
  return (
    <div className={card}>
      <span className="flex items-center gap-2 text-[13px] font-bold text-white">
        <CalendarDays size={14} className="text-brand shrink-0" />
        {intl.formatMessage(m.requestTitle)}
      </span>
      <p className="text-[12.5px] text-zinc-400 leading-relaxed">
        {intl.formatMessage(m.requestBody, { client: businessName ?? '—' })}
      </p>
      <button onClick={() => setOpen(true)} className={linkButton}>
        {intl.formatMessage(m.requestOpen)}
        <ArrowRight size={13} />
      </button>
      {open && (
        <Suspense fallback={null}>
          <RequestStatementDialog
            businessId={businessId}
            clientName={businessName ?? businessId}
            onClose={() => setOpen(false)}
          />
        </Suspense>
      )}
    </div>
  );
}

export function InviteMemberCard({ email }: { email?: string | undefined }) {
  const intl = useIntl();
  const { clients } = useAppContext();
  const [state, setState] = useState<'open' | 'closed' | 'sent'>('open');
  if (state === 'closed') return null;
  return (
    <div className={card}>
      <span className="flex items-center gap-2 text-[13px] font-bold text-white">
        <UserPlus size={14} className="text-brand shrink-0" />
        {intl.formatMessage(m.inviteTitle)}
      </span>
      {state === 'sent' ? (
        <p className="text-[12.5px] text-zinc-400">{intl.formatMessage(m.invited)}</p>
      ) : (
        <Suspense fallback={null}>
          <InviteColleagueForm
            clients={clients.map((c) => ({ id: c.id, name: c.name }))}
            defaultEmail={email ?? ''}
            onClose={() => setState('closed')}
            onInvited={() => setState('sent')}
          />
        </Suspense>
      )}
    </div>
  );
}
