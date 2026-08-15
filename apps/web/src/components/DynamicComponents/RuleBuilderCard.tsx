import { useState } from 'react';
import { AlertTriangle, Wand2 } from 'lucide-react';
import { useAppContext } from '../../context/AppContext';
import { describe, parseRule, TIER_ORDER } from '../../lib/ruleParser';
import { ReviewGate, ReviewRows, ReviewSection } from './ReviewGate';
import { Pill } from './DataTable';

/**
 * Natural-language rule builder (PRD stage 3).
 * The utterance is parsed into a structured rule; conflicts with existing rules
 * are surfaced on the card; nothing activates until Review -> Approve.
 */
export function RuleBuilderCard({ query, clientIds }: { query: string; clientIds: string[] }) {
  const { rules, clients, addRule } = useAppContext();
  const scoped = clients.filter((c) => clientIds.includes(c.id));
  const target = scoped[0];
  const clientId = target?.id ?? 'all';
  const clientName = target?.name ?? 'All clients';

  const [rule] = useState(() => parseRule(query, clientId, clientName, rules));
  const [retro, setRetro] = useState(false);

  const detail = (
    <>
      <ReviewSection title="Rule that will be created">
        <ReviewRows
          rows={[
            { label: 'Applies to', value: clientName },
            { label: 'Supplier / customer', value: rule.supplier },
            {
              label: 'Conditions',
              value: rule.conditions.length
                ? rule.conditions.map((c) => `${c.field} ${c.operator} ${c.value}`).join(' · ')
                : 'Always',
            },
            { label: 'Priority tier', value: TIER_ORDER.find((t) => t.tier === rule.tier)?.label ?? '—' },
          ]}
        />
      </ReviewSection>

      <ReviewSection title="Fields this rule sets">
        <ReviewRows rows={rule.sets.map((s) => ({ label: s.field, value: s.value }))} />
      </ReviewSection>

      {rule.conflictsWith && (
        <div className="flex items-start gap-3 bg-amber-500/10 border border-amber-500/20 rounded-2xl p-4">
          <AlertTriangle size={18} className="text-amber-400 shrink-0 mt-0.5" />
          <div className="text-[13px] text-amber-200/90 leading-relaxed">
            <span className="font-bold text-amber-400">Overlaps an existing rule.</span> {rule.conflictsWith}
            <div className="mt-2 text-amber-200/70">
              Approving keeps both — they coexist because the conditions differ. Multiple rules per supplier is
              deliberate here.
            </div>
          </div>
        </div>
      )}

      <ReviewSection title="Scope">
        <button
          onClick={() => setRetro((r) => !r)}
          className="w-full bg-[#16161a] border border-white/5 rounded-2xl p-4 flex items-center justify-between gap-4 shadow-inner hover:border-white/10 transition-colors"
        >
          <div className="text-left">
            <div className="text-sm font-bold text-white">Retro-apply to existing inbox items</div>
            <div className="text-[12px] text-zinc-500 mt-0.5">Off = the rule only affects items received from now on.</div>
          </div>
          <div
            className={`w-11 h-6 rounded-full shrink-0 transition-colors relative ${retro ? 'bg-[#14e3c4]' : 'bg-white/10'}`}
          >
            <div
              className={`absolute top-1 w-4 h-4 rounded-full bg-white transition-all ${retro ? 'left-6' : 'left-1'}`}
            />
          </div>
        </button>
      </ReviewSection>

      <div className="flex flex-wrap gap-2">
        <Pill tone="blue">Parsed from natural language</Pill>
        <Pill>Never overrides a higher tier</Pill>
      </div>
    </>
  );

  return (
    <ReviewGate
      icon={Wand2}
      title={`New rule: ${rule.supplier}`}
      subtitle={`${clientName} • ${rule.sets.length} field${rule.sets.length === 1 ? '' : 's'} set`}
      detail={detail}
      approveLabel="Approve & activate"
      successMessage={`Rule active: ${describe(rule)}`}
      auditAction="Activated rule"
      auditScope={describe(rule)}
      onApprove={() => addRule({ ...rule, active: true, retroApply: retro })}
    />
  );
}
