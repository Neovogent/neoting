/**
 * `LinkTtlField` — the secure-link lifetime control, shared by the Chases
 * screen and Settings.
 *
 * It lives here, not in `ChasesView`, because a view module is a screen and not
 * a component library: `SettingsView` reached it with
 * `import { LinkTtlField } from './ChasesView'`, Rollup cannot shake a whole view
 * module down to one re-exported component, and the Settings route therefore
 * fetched the entire 15.8 kB `ChasesView` chunk before it could render. See
 * `apps/web/CLAUDE.md`, *`import { Modal } from './ApprovalsView'` costs ~32 kB
 * gzip a route*. Both screens now import it from here. Moved verbatim — the
 * markup, the class strings and the six `chase.linkTtlField.*` message ids are
 * unchanged, so `lang/en-GB.json` needs no edit.
 */
import { useState } from 'react';
import { defineMessages, useIntl } from 'react-intl';
import { clampLinkTtl, LINK_TTL_PRESETS, MAX_LINK_TTL_HOURS, MIN_LINK_TTL_HOURS } from '../../lib/generate';

const mTtl = defineMessages({
  label: { id: 'chase.linkTtlField.label', defaultMessage: 'Secure link expires after' },
  hours: { id: 'chase.linkTtlField.hours', defaultMessage: 'hours' },
  // Two messages rather than one plural: the "s" is decided by the hour count
  // crossing 48, not by the day count, so a plural rule would read "1.5 days"
  // where this screen has always said "1.5 day". Extraction, not a rewrite.
  hoursWithDay: { id: 'chase.linkTtlField.hoursWithDay', defaultMessage: 'hours · {days} day' },
  hoursWithDays: { id: 'chase.linkTtlField.hoursWithDays', defaultMessage: 'hours · {days} days' },
  reduced: {
    id: 'chase.linkTtlField.reduced',
    defaultMessage: 'A link cannot outlive 7 days — kept at {hours} hours.',
  },
  hint: {
    id: 'chase.linkTtlField.hint',
    defaultMessage: 'Anything from 1 hour up to 7 days. A link that outlives the conversation is a security risk.',
  },
});

/**
 * Secure-link lifetime: any value the practice wants, up to a week. The cap is
 * enforced here and again in the context, so it holds however the value is set.
 */
export function LinkTtlField({ value, onChange }: { value: number; onChange: (v: number) => void }) {
  const intl = useIntl();
  // Clamped on every keystroke rather than on blur: a ceiling that depends on
  // the field losing focus is a ceiling that can be walked around.
  const [reduced, setReduced] = useState(false);

  const commit = (raw: string) => {
    const asked = Number(raw);
    const clamped = clampLinkTtl(asked);
    setReduced(asked > MAX_LINK_TTL_HOURS);
    onChange(clamped);
  };

  return (
    <div>
      <div className="text-[11px] font-bold text-zinc-500 uppercase tracking-widest mb-2">
        {intl.formatMessage(mTtl.label)}
      </div>
      <div className="flex items-center gap-2 flex-wrap mb-2.5">
        {LINK_TTL_PRESETS.map((p) => (
          <button
            key={p.hours}
            onClick={() => { setReduced(false); onChange(p.hours); }}
            className={`px-3.5 py-2 rounded-full text-[12px] font-bold border transition-all ${
              value === p.hours
                ? 'bg-brand text-white border-brand'
                : 'bg-ground text-zinc-400 border-white/5 hover:text-white hover:border-white/15'
            }`}
          >
            {p.label}
          </button>
        ))}
      </div>
      <div className="flex items-center gap-2">
        <input
          type="number"
          min={MIN_LINK_TTL_HOURS}
          max={MAX_LINK_TTL_HOURS}
          value={value}
          onChange={(e) => commit(e.target.value)}
          className={`w-28 bg-ground border rounded-xl px-4 py-2.5 text-sm text-white focus:outline-none transition-colors ${
            reduced ? 'border-amber-500/50' : 'border-white/5 focus:border-brand'
          }`}
        />
        <span className="text-[13px] text-zinc-500 font-semibold">
          {value >= 24
            ? intl.formatMessage(value >= 48 ? mTtl.hoursWithDays : mTtl.hoursWithDay, {
                days: (value / 24).toFixed(value % 24 === 0 ? 0 : 1),
              })
            : intl.formatMessage(mTtl.hours)}
        </span>
      </div>
      <div className={`text-[11px] mt-1.5 font-medium ${reduced ? 'text-amber-400' : 'text-zinc-600'}`}>
        {reduced
          ? intl.formatMessage(mTtl.reduced, { hours: MAX_LINK_TTL_HOURS })
          : intl.formatMessage(mTtl.hint)}
      </div>
    </div>
  );
}
