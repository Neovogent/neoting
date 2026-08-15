import { useState } from 'react';
import { Check, X } from 'lucide-react';
import { BUSINESS_ROLES } from '../../lib/business';
import type { BusinessMemberRole } from '../../lib/types';

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
      <div className="text-[11px] font-bold text-zinc-500 uppercase tracking-widest mb-2">Role</div>

      <div className="flex items-center gap-2 flex-wrap">
        {BUSINESS_ROLES.map((r) => (
          <button
            key={r}
            onClick={() => onChange(r)}
            className={`px-4 py-2.5 rounded-xl border text-[13px] font-bold transition-colors ${
              value === r
                ? 'bg-[#14e3c4]/10 border-[#14e3c4]/40 text-[#14e3c4]'
                : 'bg-[#0a0a0c] border-white/5 text-zinc-400 hover:text-white'
            }`}
          >
            {r}
          </button>
        ))}

        {/* A role already set to something custom stays visible and selected,
            so reopening the form never silently demotes anyone. */}
        {!isSuggested && !adding && (
          <span className="px-4 py-2.5 rounded-xl border border-[#14e3c4]/40 bg-[#14e3c4]/10 text-[13px] font-bold text-[#14e3c4] flex items-center gap-2">
            {value}
            <button
              onClick={() => { onChange(BUSINESS_ROLES[BUSINESS_ROLES.length - 1]); }}
              title="Clear this role"
              aria-label="Clear this role"
              className="text-[#14e3c4]/70 hover:text-[#14e3c4]"
            >
              <X size={13} />
            </button>
          </span>
        )}

        {adding ? (
          <span className="flex items-center gap-1.5">
            <input
              autoFocus
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') commit();
                if (e.key === 'Escape') { setDraft(''); setAdding(false); }
              }}
              placeholder="Head Chef"
              aria-label="Custom role"
              maxLength={28}
              className="w-36 bg-[#0a0a0c] border border-white/10 rounded-xl px-3 py-2.5 text-[13px] text-white placeholder:text-zinc-600 focus:outline-none focus:border-[#14e3c4] transition-colors"
            />
            <button
              onClick={commit}
              disabled={!draft.trim()}
              title="Use this role"
              aria-label="Use this role"
              className="p-2.5 rounded-xl text-[#14e3c4] bg-[#14e3c4]/10 border border-[#14e3c4]/25 hover:bg-[#14e3c4]/20 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            >
              <Check size={14} strokeWidth={3} />
            </button>
            <button
              onClick={() => { setDraft(''); setAdding(false); }}
              title="Cancel"
              aria-label="Cancel"
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
            + Custom role
          </button>
        )}
      </div>

      {hint && <p className="text-[12px] text-zinc-500 mt-2 leading-relaxed">{hint}</p>}
    </div>
  );
}
