import { useState } from 'react';
import { Check, X } from 'lucide-react';
import { defineMessages, useIntl } from 'react-intl';
import { commonActions, commonLabels } from '../../i18n/common';
import { BUSINESS_ROLES } from '../../lib/business';
import type { BusinessMemberRole } from '../../lib/types';

/**
 * The suggested role names themselves are NOT extracted: `BUSINESS_ROLES` holds
 * the values stored on a member and compared against, they are seeded outside
 * this file, and a custom role is whatever the business typed. Translating the
 * label would change the identity.
 */
const m = defineMessages({
  clear: { id: 'shell.rolePicker.clear', defaultMessage: 'Clear this role' },
  customPlaceholder: { id: 'shell.rolePicker.customPlaceholder', defaultMessage: 'Head Chef' },
  customLabel: { id: 'shell.rolePicker.customLabel', defaultMessage: 'Custom role' },
  use: { id: 'shell.rolePicker.use', defaultMessage: 'Use this role' },
  addCustom: { id: 'shell.rolePicker.addCustom', defaultMessage: '+ Custom role' },
});

/**
 * Picks what someone is at the business. Owner / Manager / Staff are the
 * suggestions, not the options — a restaurant has a Head Chef and a site has a
 * Foreman, and forcing those into "Staff" loses the only thing that made the
 * role worth recording.
 *
 * Used from both sides: the business naming its own people, and the accountant
 * inviting someone on its behalf.
 */
export function RolePicker({ value, onChange, hint }: {
  value: BusinessMemberRole;
  onChange: (role: BusinessMemberRole) => void;
  hint?: string;
}) {
  const intl = useIntl();
  const isSuggested = (BUSINESS_ROLES as readonly string[]).includes(value);
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState('');

  const commit = () => {
    const next = draft.trim();
    if (next) onChange(next);
    setDraft('');
    setAdding(false);
  };

  return (
    <div>
      <div className="text-[11px] font-bold text-zinc-500 uppercase tracking-widest mb-2">{intl.formatMessage(commonLabels.role)}</div>

      <div className="flex items-center gap-2 flex-wrap">
        {BUSINESS_ROLES.map((r) => (
          <button
            key={r}
            onClick={() => onChange(r)}
            className={`px-4 py-2.5 rounded-xl border text-[13px] font-bold transition-colors ${
              value === r
                ? 'bg-brand/10 border-brand/40 text-brand'
                : 'bg-ground border-white/5 text-zinc-400 hover:text-white'
            }`}
          >
            {r}
          </button>
        ))}

        {/* A role already set to something custom stays visible and selected,
            so reopening the form never silently demotes anyone. */}
        {!isSuggested && !adding && (
          <span className="px-4 py-2.5 rounded-xl border border-brand/40 bg-brand/10 text-[13px] font-bold text-brand flex items-center gap-2">
            {value}
            {/* Clearing a custom role drops to the least-privileged suggestion,
                which is the last of the three the list always holds. */}
            <button
              onClick={() => { onChange(BUSINESS_ROLES[BUSINESS_ROLES.length - 1] ?? 'Staff'); }}
              title={intl.formatMessage(m.clear)}
              aria-label={intl.formatMessage(m.clear)}
              className="text-brand/70 hover:text-brand"
            >
              <X size={13} />
            </button>
          </span>
        )}

        {adding ? (
          <span className="flex items-center gap-1.5">
            <input
              // This input mounts because the user just chose "add a custom
              // role": focus is following their action, not being stolen —
              // the rule's concern — and Escape hands it back.
              // eslint-disable-next-line jsx-a11y/no-autofocus
              autoFocus
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') commit();
                if (e.key === 'Escape') { setDraft(''); setAdding(false); }
              }}
              placeholder={intl.formatMessage(m.customPlaceholder)}
              aria-label={intl.formatMessage(m.customLabel)}
              maxLength={28}
              className="w-36 bg-ground border border-white/10 rounded-xl px-3 py-2.5 text-[13px] text-white placeholder:text-zinc-600 focus:outline-none focus:border-brand transition-colors"
            />
            <button
              onClick={commit}
              disabled={!draft.trim()}
              title={intl.formatMessage(m.use)}
              aria-label={intl.formatMessage(m.use)}
              className="p-2.5 rounded-xl text-brand bg-brand/10 border border-brand/25 hover:bg-brand/20 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            >
              <Check size={14} strokeWidth={3} />
            </button>
            <button
              onClick={() => { setDraft(''); setAdding(false); }}
              title={intl.formatMessage(commonActions.cancel)}
              aria-label={intl.formatMessage(commonActions.cancel)}
              className="p-2.5 rounded-xl text-zinc-500 border border-white/5 hover:text-white transition-colors"
            >
              <X size={14} />
            </button>
          </span>
        ) : (
          <button
            onClick={() => { setDraft(isSuggested ? '' : String(value)); setAdding(true); }}
            className="px-4 py-2.5 rounded-xl border border-dashed border-white/15 text-[13px] font-bold text-zinc-400 hover:text-white hover:border-white/30 transition-colors"
          >
            {intl.formatMessage(m.addCustom)}
          </button>
        )}
      </div>

      {hint && <p className="text-[12px] text-zinc-500 mt-2 leading-relaxed">{hint}</p>}
    </div>
  );
}
