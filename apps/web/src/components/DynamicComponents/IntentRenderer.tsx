import { ArrowRight } from 'lucide-react';
import { defineMessages, useIntl } from 'react-intl';
import { useAppContext } from '../../context/AppContext';
import { ActionCard } from './ActionCard';
import { ApprovalBatchCard } from './ApprovalBatchCard';
import { ChaseComposer } from './ChaseComposer';
import { ClientIntakeForm } from './ClientIntakeForm';
import { DocumentPreview } from './DocumentPreview';
import { DuplicateCompare } from './DuplicateCompare';
import { ExportsCard } from './ExportsCard';
import { LiveChaseComposerCard } from './LiveChaseComposerCard';
import { LiveMissingCard } from './LiveMissingCard';
import { LivePublishCard } from './LivePublishCard';
import { LiveRuleCard } from './LiveRuleCard';
import { MatchCard } from './MatchCard';
import { PipelineStats } from './PipelineStats';
import { PublishCard } from './PublishCard';
import { RuleBuilderCard } from './RuleBuilderCard';
import { StatementsCard } from './StatementsCard';
import { ApprovalsTable, AuditTable, InboxTable, MissingTable, RejectedTable } from './Tables';
import type { Message } from '../../lib/types';

const m = defineMessages({
  openApprovals: { id: 'shell.intentRenderer.openApprovals', defaultMessage: 'Open the Approvals queue' },
});

/**
 * Maps an assistant message's intent + payload onto the interface component
 * that answers it. This is what "the AI answers with real UI, not paragraphs"
 * means in practice (PRD section 8).
 */
export function IntentRenderer({ message }: { message: Message }) {
  const { documents, duplicates, matches, clients, setActiveTab } = useAppContext();
  const intl = useIntl();

  const payload = message.payload ?? {};
  const clientIds: string[] = payload.clientIds ?? [];
  const clientNames: string[] = payload.clientNames ?? [];
  const query: string = payload.query ?? '';
  // A length of one guarantees the name is there; the fallback is the same
  // wording used when nothing is scoped, so an impossible hole reads sanely.
  const scopeName = clientNames.length === 1 ? clientNames[0] ?? 'All clients' : clientNames.length ? `${clientNames.length} clients` : 'All clients';

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
      return <InboxTable clientIds={clientIds} clientNames={clientNames} statusFilter={payload.statusFilter} />;

    // D40's bank input (#233). Reads `GET /statements` itself — the model
    // picked the intent and nothing else.
    case 'SHOW_STATEMENTS':
      return <StatementsCard businessId={payload.businessId} businessName={payload.businessName} />;

    // The METH Stage 13 golden paths — real data, and every state change
    // through the real proposal engine (the cards say how).
    case 'LIVE_MISSING':
      return <LiveMissingCard businessId={payload.businessId} businessName={payload.businessName} />;

    case 'LIVE_CHASE':
      return <LiveChaseComposerCard businessId={payload.businessId} businessName={payload.businessName} />;

    case 'LIVE_RULE':
      return payload.ruleDraft ? (
        <LiveRuleCard draft={payload.ruleDraft} businessId={payload.businessId} businessName={payload.businessName} />
      ) : null;

    case 'LIVE_PUBLISH':
      return <LivePublishCard businessId={payload.businessId} businessName={payload.businessName} />;

    case 'SHOW_REJECTED':
      return <RejectedTable clientIds={clientIds} clientNames={clientNames} />;

    case 'SHOW_APPROVALS':
      // Server turns land here too since 5 Sep 2026 (review item 9). The table
      // is the synthetic cast's — live, the context array is empty by design —
      // so the card always carries the way to the REAL queue, which reads
      // `GET /action-proposals` itself.
      return (
        <div className="w-full flex flex-col gap-3">
          <ApprovalsTable clientIds={clientIds} clientNames={clientNames} />
          <button
            onClick={() => setActiveTab('Approvals')}
            className="self-start flex items-center gap-1.5 text-[12px] font-bold text-brand hover:text-brand-hover transition-colors"
          >
            {intl.formatMessage(m.openApprovals)}
            <ArrowRight size={13} />
          </button>
        </div>
      );

    // Review item 9 (5 Sep 2026): the export ask routes here — navigation to
    // D42's sole egress, nothing created from chat.
    case 'SHOW_EXPORTS':
      return <ExportsCard />;

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
