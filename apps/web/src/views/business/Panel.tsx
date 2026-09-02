/**
 * `Panel` — the portal's card frame: a rounded section with a title and an
 * optional subtitle. Three portal screens draw it.
 *
 * It lives here, not in `BusinessHomeView`, because a view module is a screen
 * and not a component library: `BusinessUploadView` reached it with
 * `import { Panel } from './BusinessHomeView'`, and Rollup cannot shake a whole
 * view module down to one re-exported component. Today that line costs nothing
 * — every synthetic portal screen is in one chunk, so the edge is invisible —
 * and that is exactly why it had to go: it is a tripwire under any future
 * `lazy()` on those tabs, which would then drag the entire Home chunk behind
 * the Upload tab and reclaim nothing. See `apps/web/CLAUDE.md`,
 * *`import { Modal } from './ApprovalsView'` costs ~32 kB gzip a route*.
 *
 * Moved verbatim from `BusinessHomeView`; `BusinessSettingsView`'s private
 * byte-identical copy now points here too, so the frame cannot drift between
 * the tabs of one screen.
 */
export function Panel({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-[28px] border border-white/5 bg-card p-6">
      <div className="mb-4">
        <h2 className="text-[15px] font-bold text-white tracking-tight">{title}</h2>
        {subtitle && <p className="text-[12px] text-zinc-500 mt-1">{subtitle}</p>}
      </div>
      {children}
    </section>
  );
}
