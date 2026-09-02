/**
 * The two settings-form primitives — a labelled text input and a labelled
 * switch — extracted out of `views/ApprovalsView.tsx`, where they used to live.
 *
 * ## Why they moved
 *
 * They are used by `SettingsView`, `TeamView` and `ApprovalsView`, and the first
 * two were reaching them with `import { Field, Toggle } from './ApprovalsView'`.
 * Rollup cannot shake a 1,900-line view module down to two small components, so
 * a chunk that did that emitted a bare side-effect import of the ENTIRE
 * `ApprovalsView` chunk (15.9 kB gzip) and dragged `DocumentPreview`,
 * `LiveProposalCard`, `ReviewGate` and `Tooltip` along behind it — ~30 kB on a
 * route, to get two components that together gzip to a few hundred bytes. See
 * `apps/web/CLAUDE.md`, *`import { Modal } from './ApprovalsView'` costs ~32 kB
 * gzip a route*: this is the same bug, and this module is the fix for the
 * `Field`/`Toggle` half of it.
 *
 * Nothing about the markup changed in the move. If you need a third form
 * primitive, put it here — not in whichever view happens to need it first.
 */
export function Field({ label, value, onChange, placeholder }: { label: string; value: string; onChange: (v: string) => void; placeholder?: string }) {
  return (
    <div>
      <div className="text-[11px] font-bold text-zinc-500 uppercase tracking-widest mb-2">{label}</div>
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="w-full bg-ground border border-white/5 rounded-xl px-4 py-2.5 text-sm text-white placeholder:text-zinc-600 focus:outline-none focus:border-brand transition-colors"
      />
    </div>
  );
}

export function Toggle({ label, hint, value, onChange }: { label: string; hint?: string; value: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      onClick={() => onChange(!value)}
      className="bg-ground/60 border border-white/5 rounded-2xl p-4 flex items-center justify-between gap-4 shadow-inner hover:border-white/10 transition-colors text-left"
    >
      <div>
        <div className="text-sm font-bold text-white">{label}</div>
        {hint && <div className="text-[12px] text-zinc-500 mt-0.5">{hint}</div>}
      </div>
      <span className={`w-11 h-6 rounded-full shrink-0 transition-colors relative ${value ? 'bg-brand' : 'bg-white/10'}`}>
        <span className={`absolute top-1 w-4 h-4 rounded-full bg-white transition-all ${value ? 'left-6' : 'left-1'}`} />
      </span>
    </button>
  );
}
