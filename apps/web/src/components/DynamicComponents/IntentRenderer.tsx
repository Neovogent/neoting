import { lazy, Suspense } from 'react';
import { ArrowRight } from 'lucide-react';
import { defineMessages, useIntl } from 'react-intl';
import { useAppContext } from '../../context/AppContext';
import { ActionCard } from './ActionCard';
import { ChatRuleClientCard, ChatRuleOfferCard } from './ChatRuleCards';
import { ExportsCard } from './ExportsCard';
import { MatchCard } from './MatchCard';
import { PipelineStats } from './PipelineStats';
import { PublishCard } from './PublishCard';
import { StatementsCard } from './StatementsCard';
import type { Message } from '../../lib/types';

/**
 * ⚠ **`DocumentPreview` is LAZY here, and it is the reason the chat route was
 * 56 kB over budget** (8 Sep 2026). This module is reachable from the shell, so
 * a static import put the whole document panel — and its `document-detail`
 * client, its bank-match read and its coding-proposal card — on
 * `AIWorkspaceView`'s opening download, for a card that renders only when
 * somebody asks the assistant to open one document. Every view in the app
 * already loads it this way; the chat renderer was the last static importer.
 *
 * The `Suspense` boundary sits at the CARD, not around the whole renderer, so
 * every other intent still paints immediately.
 */
const DocumentPreview = lazy(() =>
  import('./DocumentPreview').then((m) => ({ default: m.DocumentPreview })),
);

/**
 * The intake form, by the same argument and worth as much again: it is the
 * whole three-step client-onboarding flow, it renders for ONE intent, and the
 * Clients board loads its own copy anyway.
 */
const ClientIntakeForm = lazy(() =>
  import('./ClientIntakeForm').then((m) => ({ default: m.ClientIntakeForm })),
);

/**
 * The rest of the chat's cards, by the same argument — and here it costs
 * nothing at all: every one of these renders only AFTER a model turn returns,
 * which is seconds, so the chunk fetch hides entirely behind a wait the user
 * is already having. Each is reachable from exactly one intent.
 */
const ChaseComposer = lazy(() => import('./ChaseComposer').then((m) => ({ default: m.ChaseComposer })));
const LiveChaseComposerCard = lazy(() => import('./LiveChaseComposerCard').then((m) => ({ default: m.LiveChaseComposerCard })));
const DuplicateCompare = lazy(() => import('./DuplicateCompare').then((m) => ({ default: m.DuplicateCompare })));
const RuleBuilderCard = lazy(() => import('./RuleBuilderCard').then((m) => ({ default: m.RuleBuilderCard })));
const LivePublishCard = lazy(() => import('./LivePublishCard').then((m) => ({ default: m.LivePublishCard })));
const ApprovalBatchCard = lazy(() => import('./ApprovalBatchCard').then((m) => ({ default: m.ApprovalBatchCard })));
const LiveRuleCard = lazy(() => import('./LiveRuleCard').then((m) => ({ default: m.LiveRuleCard })));
const LiveMissingCard = lazy(() => import('./LiveMissingCard').then((m) => ({ default: m.LiveMissingCard })));
const ChatUploadDecisionCard = lazy(() => import('./ChatUploadDecisionCard').then((m) => ({ default: m.ChatUploadDecisionCard })));

/**
 * The five tables, from ONE dynamic import — the bundler emits a single chunk
 * and all five share it, so a chat that shows an inbox table pays for the
 * table module once and a chat that shows none pays nothing.
 */
const ApprovalsTable = lazy(() => import('./Tables').then((m) => ({ default: m.ApprovalsTable })));
const AuditTable = lazy(() => import('./Tables').then((m) => ({ default: m.AuditTable })));
const InboxTable = lazy(() => import('./Tables').then((m) => ({ default: m.InboxTable })));
const MissingTable = lazy(() => import('./Tables').then((m) => ({ default: m.MissingTable })));
const RejectedTable = lazy(() => import('./Tables').then((m) => ({ default: m.RejectedTable })));

/** What the chat shows for the beat between the click and the chunk. */
function DocumentPreviewSkeleton() {
  return <div className="h-64 rounded-[32px] border border-white/5 bg-card animate-pulse" aria-hidden />;
}

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

  /**
   * Review item 51's affordances come BEFORE the intent switch, because both
   * ride on `GENERAL`: a client-less rule ask and a correct refusal are both
   * GENERAL turns, and their card is about what the server attached to the
   * turn rather than about how it was classified.
   */
  if (payload.awaiting === 'client') return <ChatRuleClientCard query={query} />;
  if (payload.offer === 'rule') return <ChatRuleOfferCard businessName={payload.businessName} />;

  switch (message.intent) {
    case 'ADD_CLIENT':
      return (
        <Suspense fallback={<DocumentPreviewSkeleton />}>
          <ClientIntakeForm defaultName={payload.clientName ?? ''} />
        </Suspense>
      );

    // Review item 58: the held chat upload's decision card. Payload-free after
    // a restore (persistence keeps text + intent only) — the question's own
    // sentence stands and the card degrades to nothing.
    case 'CHAT_UPLOAD_DECISION':
      return payload.uploadMessageId ? (
        <ChatUploadDecisionCard
          uploadMessageId={payload.uploadMessageId}
          suggestedClientId={payload.suggestedClientId}
          suggestedClientName={payload.suggestedClientName}
        />
      ) : null;

    case 'SHOW_MISSING':
      return <ActionCard clientIds={clientIds} period={payload.period} />;

    case 'CHASE_MISSING':
      return (
        <Suspense fallback={<DocumentPreviewSkeleton />}>
          <ChaseComposer clientIds={clientIds} missingItemIds={payload.missingItemIds} />
        </Suspense>
      );

    // Legacy intent kept so older conversations still render.
    case 'APPROVE_CHASE':
      return (
        <Suspense fallback={<DocumentPreviewSkeleton />}>
          <ChaseComposer clientIds={clientIds} />
        </Suspense>
      );

    case 'SHOW_INBOX':
      return (
        <Suspense fallback={<DocumentPreviewSkeleton />}>
          <InboxTable clientIds={clientIds} clientNames={clientNames} statusFilter={payload.statusFilter} />
        </Suspense>
      );

    // D40's bank input (#233). Reads `GET /statements` itself — the model
    // picked the intent and nothing else.
    case 'SHOW_STATEMENTS':
      return <StatementsCard businessId={payload.businessId} businessName={payload.businessName} />;

    // The METH Stage 13 golden paths — real data, and every state change
    // through the real proposal engine (the cards say how).
    case 'LIVE_MISSING':
      return (
        <Suspense fallback={<DocumentPreviewSkeleton />}>
          <LiveMissingCard businessId={payload.businessId} businessName={payload.businessName} />
        </Suspense>
      );

    case 'LIVE_CHASE':
      return (
        <Suspense fallback={<DocumentPreviewSkeleton />}>
          <LiveChaseComposerCard businessId={payload.businessId} businessName={payload.businessName} />
        </Suspense>
      );

    case 'LIVE_RULE':
      return payload.ruleDraft ? (
        <LiveRuleCard draft={payload.ruleDraft} businessId={payload.businessId} businessName={payload.businessName} />
      ) : null;

    case 'LIVE_PUBLISH':
      return (
        <Suspense fallback={<DocumentPreviewSkeleton />}>
          <LivePublishCard businessId={payload.businessId} businessName={payload.businessName} />
        </Suspense>
      );

    case 'SHOW_REJECTED':
      return (
        <Suspense fallback={<DocumentPreviewSkeleton />}>
          <RejectedTable clientIds={clientIds} clientNames={clientNames} />
        </Suspense>
      );

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
      return (
        <Suspense fallback={<DocumentPreviewSkeleton />}>
          <ApprovalBatchCard query={query} clientIds={clientIds} />
        </Suspense>
      );

    case 'CREATE_RULE':
      return (
        <Suspense fallback={<DocumentPreviewSkeleton />}>
          <RuleBuilderCard query={query} clientIds={clientIds.length ? clientIds : clients.slice(0, 1).map((c) => c.id)} />
        </Suspense>
      );

    case 'REVIEW_DOCUMENT': {
      const doc =
        documents.find((d) => d.id === payload.documentId) ??
        documents.find((d) => (clientIds.length ? clientIds.includes(d.clientId) : true) && d.status === 'review') ??
        documents[0];
      return doc ? (
        <Suspense fallback={<DocumentPreviewSkeleton />}>
          <DocumentPreview document={doc} />
        </Suspense>
      ) : null;
    }

    case 'SHOW_DUPLICATES':
      return (
        <Suspense fallback={<DocumentPreviewSkeleton />}>
          <DuplicateCompare pairs={duplicates.filter((d) => (clientNames.length ? clientNames.includes(d.clientName) : true))} />
        </Suspense>
      );

    case 'SHOW_MATCHES':
      return <MatchCard matches={matches.filter((m) => (clientNames.length ? clientNames.includes(m.clientName) : true))} />;

    case 'PUBLISH':
      return <PublishCard clientIds={clientIds} />;

    case 'SHOW_ANALYTICS':
      return <PipelineStats scopeName={scopeName} />;

    case 'SHOW_AUDIT':
      return (
        <Suspense fallback={<DocumentPreviewSkeleton />}>
          <AuditTable />
        </Suspense>
      );

    case 'SHOW_MISSING_TABLE':
      return (
        <Suspense fallback={<DocumentPreviewSkeleton />}>
          <MissingTable clientIds={clientIds} clientNames={clientNames} />
        </Suspense>
      );

    default:
      return null;
  }
}
