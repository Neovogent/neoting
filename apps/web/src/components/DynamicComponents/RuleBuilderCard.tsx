import { useState } from 'react';
import { AlertTriangle, Wand2 } from 'lucide-react';
import { defineMessages, useIntl } from 'react-intl';
import { useAppContext } from '../../context/AppContext';
import { describe, parseRule, TIER_ORDER } from '../../lib/ruleParser';
import { ReviewGate, ReviewRows, ReviewSection } from './ReviewGate';
import { Pill } from './DataTable';

/**
 * `conflictWarning` keeps its bold opening clause inside the message as a rich
 * text tag rather than splitting the sentence at the `</span>`. A translator
 * handed "Overlaps an existing rule." and " {conflict}" as two entries cannot
 * see that they are one sentence, and cannot reorder them if the target
 * language wants the detail first.
 */
const m = defineMessages({
  allClients: { id: 'shell.ruleBuilderCard.allClients', defaultMessage: 'All clients' },
  ruleSection: { id: 'shell.ruleBuilderCard.ruleSection', defaultMessage: 'Rule that will be created' },
  appliesTo: { id: 'shell.ruleBuilderCard.appliesTo', defaultMessage: 'Applies to' },
  supplier: { id: 'shell.ruleBuilderCard.supplier', defaultMessage: 'Supplier / customer' },
  conditions: { id: 'shell.ruleBuilderCard.conditions', defaultMessage: 'Conditions' },
  conditionsAlways: { id: 'shell.ruleBuilderCard.conditionsAlways', defaultMessage: 'Always' },
  tier: { id: 'shell.ruleBuilderCard.tier', defaultMessage: 'Priority tier' },
  setsSection: { id: 'shell.ruleBuilderCard.setsSection', defaultMessage: 'Fields this rule sets' },
  conflictWarning: {
    id: 'shell.ruleBuilderCard.conflictWarning',
    defaultMessage: '<strong>Overlaps an existing rule.</strong> {conflict}',
  },
  conflictNote: {
    id: 'shell.ruleBuilderCard.conflictNote',
    defaultMessage:
      'Approving keeps both — they coexist because the conditions differ. Multiple rules per supplier is deliberate here.',
  },
  scopeSection: { id: 'shell.ruleBuilderCard.scopeSection', defaultMessage: 'Scope' },
  retroLabel: { id: 'shell.ruleBuilderCard.retroLabel', defaultMessage: 'Retro-apply to existing inbox items' },
  retroHint: {
    id: 'shell.ruleBuilderCard.retroHint',
    defaultMessage: 'Off = the rule only affects items received from now on.',
  },
  parsedPill: { id: 'shell.ruleBuilderCard.parsedPill', defaultMessage: 'Parsed from natural language' },
  tierPill: { id: 'shell.ruleBuilderCard.tierPill', defaultMessage: 'Never overrides a higher tier' },
  title: { id: 'shell.ruleBuilderCard.title', defaultMessage: 'New rule: {supplier}' },
  subtitle: {
    id: 'shell.ruleBuilderCard.subtitle',
    defaultMessage: '{client} • {count, plural, one {# field set} other {# fields set}}',
  },
  approveLabel: { id: 'shell.ruleBuilderCard.approveLabel', defaultMessage: 'Approve & activate' },
  successMessage: { id: 'shell.ruleBuilderCard.successMessage', defaultMessage: 'Rule active: {rule}' },
  auditAction: { id: 'shell.ruleBuilderCard.auditAction', defaultMessage: 'Activated rule' },
});

/**
 * Natural-language rule builder (PRD stage 3).
 * The utterance is parsed into a structured rule; conflicts with existing rules
 * are surfaced on the card; nothing activates until Review -> Approve.
 */
export function RuleBuilderCard({ query, clientIds }: { query: string; clientIds: string[] }) {
  const { rules, clients, addRule } = useAppContext();
  const intl = useIntl();
  const scoped = clients.filter((c) => clientIds.includes(c.id));
  const target = scoped[0];
  const clientId = target?.id ?? 'all';
  const clientName = target?.name ?? intl.formatMessage(m.allClients);

  const [rule] = useState(() => parseRule(query, clientId, clientName, rules));
  const [retro, setRetro] = useState(false);

  const detail = (
    <>
      <ReviewSection title={intl.formatMessage(m.ruleSection)}>
        <ReviewRows
          rows={[
            { label: intl.formatMessage(m.appliesTo), value: clientName },
            { label: intl.formatMessage(m.supplier), value: rule.supplier },
            {
              label: intl.formatMessage(m.conditions),
              value: rule.conditions.length
                ? rule.conditions.map((c) => `${c.field} ${c.operator} ${c.value}`).join(' · ')
                : intl.formatMessage(m.conditionsAlways),
            },
            { label: intl.formatMessage(m.tier), value: TIER_ORDER.find((t) => t.tier === rule.tier)?.label ?? '—' },
          ]}
        />
      </ReviewSection>

      <ReviewSection title={intl.formatMessage(m.setsSection)}>
        <ReviewRows rows={rule.sets.map((s) => ({ label: s.field, value: s.value }))} />
      </ReviewSection>

      {rule.conflictsWith && (
        <div className="flex items-start gap-3 bg-amber-500/10 border border-amber-500/20 rounded-2xl p-4">
          <AlertTriangle size={18} className="text-amber-400 shrink-0 mt-0.5" />
          <div className="text-[13px] text-amber-200/90 leading-relaxed">
            {intl.formatMessage(m.conflictWarning, {
              conflict: rule.conflictsWith,
              strong: (chunks) => <span className="font-bold text-amber-400">{chunks}</span>,
            })}
            <div className="mt-2 text-amber-200/70">{intl.formatMessage(m.conflictNote)}</div>
          </div>
        </div>
      )}

      <ReviewSection title={intl.formatMessage(m.scopeSection)}>
        <button
          onClick={() => setRetro((r) => !r)}
          className="w-full bg-card border border-white/5 rounded-2xl p-4 flex items-center justify-between gap-4 shadow-inner hover:border-white/10 transition-colors"
        >
          <div className="text-left">
            <div className="text-sm font-bold text-white">{intl.formatMessage(m.retroLabel)}</div>
            <div className="text-[12px] text-zinc-500 mt-0.5">{intl.formatMessage(m.retroHint)}</div>
          </div>
          <div
            className={`w-11 h-6 rounded-full shrink-0 transition-colors relative ${retro ? 'bg-brand' : 'bg-white/10'}`}
          >
            <div
              className={`absolute top-1 w-4 h-4 rounded-full bg-white transition-all ${retro ? 'left-6' : 'left-1'}`}
            />
          </div>
        </button>
      </ReviewSection>

      <div className="flex flex-wrap gap-2">
        <Pill tone="blue">{intl.formatMessage(m.parsedPill)}</Pill>
        <Pill>{intl.formatMessage(m.tierPill)}</Pill>
      </div>
    </>
  );

  return (
    <ReviewGate
      icon={Wand2}
      title={intl.formatMessage(m.title, { supplier: rule.supplier })}
      subtitle={intl.formatMessage(m.subtitle, { client: clientName, count: rule.sets.length })}
      detail={detail}
      approveLabel={intl.formatMessage(m.approveLabel)}
      successMessage={intl.formatMessage(m.successMessage, { rule: describe(rule) })}
      auditAction={intl.formatMessage(m.auditAction)}
      auditScope={describe(rule)}
      onApprove={() => addRule({ ...rule, active: true, retroApply: retro })}
    />
  );
}
