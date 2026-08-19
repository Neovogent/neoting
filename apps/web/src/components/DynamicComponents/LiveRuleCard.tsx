import { Wand2 } from 'lucide-react';
import { defineMessages, useIntl } from 'react-intl';
import type { CreateActionProposalRequest } from '@neoting/contracts/model';
import type { DemoRuleDraft } from '../../lib/demoIntents';
import { LiveProposalFlow } from './LiveProposalFlow';
import { ReviewRows, ReviewSection } from './ReviewGate';
import { Pill } from './DataTable';

const m = defineMessages({
  title: { id: 'shell.liveRuleCard.title', defaultMessage: 'New rule: {supplier}' },
  subtitle: {
    id: 'shell.liveRuleCard.subtitle',
    defaultMessage: '{client} · parsed from your words. It activates only after review and approval — and the next matching document arrives pre-coded.',
  },
  ruleSection: { id: 'shell.liveRuleCard.ruleSection', defaultMessage: 'Rule that will be created' },
  appliesTo: { id: 'shell.liveRuleCard.appliesTo', defaultMessage: 'Applies to' },
  supplier: { id: 'shell.liveRuleCard.supplier', defaultMessage: 'Supplier match' },
  tier: { id: 'shell.liveRuleCard.tier', defaultMessage: 'Priority tier' },
  tierValue: { id: 'shell.liveRuleCard.tierValue', defaultMessage: '3 · Supplier / customer rules' },
  setsSection: { id: 'shell.liveRuleCard.setsSection', defaultMessage: 'Fields this rule sets' },
  category: { id: 'shell.liveRuleCard.category', defaultMessage: 'Category' },
  vat: { id: 'shell.liveRuleCard.vat', defaultMessage: 'VAT treatment' },
  parsedPill: { id: 'shell.liveRuleCard.parsedPill', defaultMessage: 'Parsed from natural language' },
  enginePill: { id: 'shell.liveRuleCard.enginePill', defaultMessage: 'Honoured by extraction from the next document' },
  stage: { id: 'shell.liveRuleCard.stage', defaultMessage: 'Stage for review' },
  noClient: {
    id: 'shell.liveRuleCard.noClient',
    defaultMessage: 'Name the client the rule is for — rules live inside one client workspace.',
  },
});

/**
 * "Whenever Bidfood invoices arrive for American Burger, code them Cost of
 * Sales Food with standard VAT" (METH Stage 13, utterance 3 — the wow beat).
 *
 * The draft arrived pre-parsed on the message payload (the canned table,
 * `// DEMO-MOCK: Opus via Bedrock`); staging creates a real `rule.create`
 * proposal, review renders the server's summary of the rule, and approval
 * writes the `rules` row the DemoExtractor honours on the next matching
 * upload — provenance `rule`, with the rule id recorded.
 */
export function LiveRuleCard({
  draft,
  businessId,
  businessName,
}: {
  draft: DemoRuleDraft;
  businessId?: string | undefined;
  businessName?: string | undefined;
}) {
  const intl = useIntl();

  const buildRequest = (): CreateActionProposalRequest => ({
    kind: 'rule.create',
    businessId: businessId ?? null,
    payload: {
      tier: 'SUPPLIER_CUSTOMER',
      scopeKey: draft.scopeKey,
      conditions: null,
      sets: {
        categoryCode: draft.categoryCode,
        ...(draft.vatTreatment === undefined ? {} : { vatTreatment: draft.vatTreatment }),
      },
    },
  });

  return (
    <div className="w-full border border-white/5 rounded-[32px] bg-card shadow-2xl overflow-hidden flex flex-col">
      <div className="p-6 flex items-center gap-4 border-b border-white/5">
        <div className="w-12 h-12 rounded-2xl flex items-center justify-center shrink-0 border shadow-inner bg-raised text-white border-white/5">
          <Wand2 size={20} />
        </div>
        <div className="min-w-0">
          <h3 className="font-sans font-bold text-xl text-white tracking-tight truncate">
            {intl.formatMessage(m.title, { supplier: draft.scopeKey })}
          </h3>
          <p className="text-[12px] text-zinc-500 mt-1 font-semibold">
            {intl.formatMessage(m.subtitle, { client: businessName ?? '—' })}
          </p>
        </div>
      </div>

      <div className="p-6 space-y-6">
        <ReviewSection title={intl.formatMessage(m.ruleSection)}>
          <ReviewRows
            rows={[
              { label: intl.formatMessage(m.appliesTo), value: businessName ?? '—' },
              { label: intl.formatMessage(m.supplier), value: draft.scopeKey },
              { label: intl.formatMessage(m.tier), value: intl.formatMessage(m.tierValue) },
            ]}
          />
        </ReviewSection>

        <ReviewSection title={intl.formatMessage(m.setsSection)}>
          <ReviewRows
            rows={[
              { label: intl.formatMessage(m.category), value: draft.categoryName },
              ...(draft.vatTreatment === undefined ? [] : [{ label: intl.formatMessage(m.vat), value: draft.vatTreatment }]),
            ]}
          />
        </ReviewSection>

        <div className="flex flex-wrap gap-2">
          <Pill tone="blue">{intl.formatMessage(m.parsedPill)}</Pill>
          <Pill>{intl.formatMessage(m.enginePill)}</Pill>
        </div>

        {businessId === undefined && <p className="text-[13px] text-amber-400">{intl.formatMessage(m.noClient)}</p>}

        <LiveProposalFlow
          buildRequest={buildRequest}
          clientName={businessName ?? null}
          stageLabel={intl.formatMessage(m.stage)}
          disabled={businessId === undefined}
        />
      </div>
    </div>
  );
}
