import { useAppContext } from '../../context/AppContext';
import { ActionCard } from './ActionCard';
import { ApprovalBatchCard } from './ApprovalBatchCard';
import { ChaseComposer } from './ChaseComposer';
import { ClientIntakeForm } from './ClientIntakeForm';
import { DocumentPreview } from './DocumentPreview';
import { DuplicateCompare } from './DuplicateCompare';
import { MatchCard } from './MatchCard';
import { PipelineStats } from './PipelineStats';
import { PublishCard } from './PublishCard';
import { RuleBuilderCard } from './RuleBuilderCard';
import { UserInviteForm } from './UserInviteForm';
import { ApprovalsTable, AuditTable, InboxTable, MissingTable, RejectedTable } from './Tables';
import type { Message } from '../../lib/types';

/**
 * Maps an assistant message's intent + payload onto the interface component
 * that answers it. This is what "the AI answers with real UI, not paragraphs"
 * means in practice (PRD section 8).
 */
export function IntentRenderer({ message }: { message: Message }) {
  const { documents, duplicates, matches, clients } = useAppContext();

  const payload = message.payload ?? {};
  const clientIds: string[] = payload.clientIds ?? [];
  const clientNames: string[] = payload.clientNames ?? [];
  const query: string = payload.query ?? '';
  const scopeName = clientNames.length === 1 ? clientNames[0] : clientNames.length ? `${clientNames.length} clients` : 'All clients';

  switch (message.intent) {
    case 'ADD_CLIENT':
      return <ClientIntakeForm defaultName={payload.clientName ?? ''} />;

    case 'SHOW_MISSING':
      return <ActionCard clientIds={clientIds} period={payload.period} />;

    case 'CHASE_MISSING':
      return <ChaseComposer clientIds={clientIds} missingItemIds={payload.missingItemIds} />;

    // Legacy intent kept so older conversations still render.
    case 'APPROVE_CHASE':
      return <ChaseComposer clientIds={clientIds} />;

    case 'SHOW_INBOX':
      return <InboxTable clientIds={clientIds} clientNames={clientNames} />;

    case 'SHOW_REJECTED':
      return <RejectedTable clientIds={clientIds} clientNames={clientNames} />;

    case 'SHOW_APPROVALS':
      return <ApprovalsTable clientIds={clientIds} clientNames={clientNames} />;

    case 'APPROVE_ITEMS':
      return <ApprovalBatchCard query={query} clientIds={clientIds} />;

    case 'CREATE_RULE':
      return <RuleBuilderCard query={query} clientIds={clientIds.length ? clientIds : clients.slice(0, 1).map((c) => c.id)} />;

    case 'REVIEW_DOCUMENT': {
      const doc =
        documents.find((d) => d.id === payload.documentId) ??
        documents.find((d) => (clientIds.length ? clientIds.includes(d.clientId) : true) && d.status === 'review') ??
        documents[0];
      return doc ? <DocumentPreview document={doc} /> : null;
    }

    case 'SHOW_DUPLICATES':
      return <DuplicateCompare pairs={duplicates.filter((d) => (clientNames.length ? clientNames.includes(d.clientName) : true))} />;

    case 'SHOW_MATCHES':
      return <MatchCard matches={matches.filter((m) => (clientNames.length ? clientNames.includes(m.clientName) : true))} />;

    case 'PUBLISH':
      return <PublishCard clientIds={clientIds} />;

    case 'INVITE_USER':
      return <UserInviteForm />;

    case 'SHOW_ANALYTICS':
      return <PipelineStats scopeName={scopeName} />;

    case 'SHOW_AUDIT':
      return <AuditTable />;

    case 'SHOW_MISSING_TABLE':
      return <MissingTable clientIds={clientIds} clientNames={clientNames} />;

    default:
      return null;
  }
}
