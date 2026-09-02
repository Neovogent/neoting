import { Suspense, lazy } from 'react';
import { defineMessages, useIntl } from 'react-intl';

import { API_ENABLED } from '../../api/config';
import { LiveBusinessPortal } from './LiveBusinessPortal';

/**
 * The client-facing shell, and the one decision it takes: whose portal is this?
 *
 * Deliberately its own portal rather than a tab in the practice app — a
 * business signs in here and can only ever see its own paperwork. Four things
 * only: what is outstanding, send a file, photograph a receipt, and its own
 * settings.
 *
 * ## ⚠ THE SYNTHETIC SHELL IS LAZY, AND THAT IS A BUDGET RULE, NOT A TIDY-UP
 *
 * This file used to import all six synthetic views at module scope, ABOVE the
 * `API_ENABLED` branch — so every real client on a bad connection in a car park
 * downloaded ~2,900 lines of demo shell they can never reach before the live
 * portal rendered. `API_ENABLED` is a runtime read (`api/config.ts` reads
 * `import.meta.env` defensively, which defeats static replacement), so both
 * halves are in the build whatever happens; a second `lazy()` is what decides
 * that only one of them is FETCHED. The portal is the lightest route in the
 * product and has to stay that way.
 *
 * Keep this file's static imports to the LIVE path only.
 *
 * ⚠ **THE REVERSE IS NOT TRUE, AND IT COSTS THE SYNTHETIC ROUTE 20,206 B.**
 * Because this file is the only module that dynamically imports the synthetic
 * shell, Rollup files everything the two halves SHARE — `BusinessPortalShell`,
 * `portalTabs`, `PortalStatusPill`, `portalCamera`, `portalUploadRules`, … — in
 * THIS chunk, which also holds the whole live portal. So a synthetic visitor
 * downloads the live portal to borrow the shell, and `SyntheticBusinessPortal`
 * measures 264,010 B against the 250 kB budget. Fixing it means making the two
 * halves siblings (both `lazy()` from `App.tsx`) or pinning the shared modules
 * with `manualChunks` — see `apps/web/CLAUDE.md`, *The synthetic portal pays for
 * the live portal*. Do NOT make `LiveBusinessPortal` lazy here: a nested dynamic
 * import is not in the parent's preload map, so it would add a serial round trip
 * to the lightest route in the product to help a demo-only one.
 */

const SyntheticBusinessPortal = lazy(() => import('./SyntheticBusinessPortal'));

const m = defineMessages({
  loading: { id: 'portal.businessPortal.loading', defaultMessage: 'Loading your portal…' },
});

export function BusinessPortal() {
  // ⚠ LIVE IS A DIFFERENT SURFACE, not the synthetic one fed with server rows.
  //
  // The shell below is driven by `AppContext.businessAccounts`, which is EMPTY
  // when the API is on — so with a live session it rendered a sign-in screen
  // that created an account in local React state and vanished on reload. There
  // was no business portal, only a drawing of one. `LiveBusinessPortal` is the
  // same four-tab journey against the contract, and it wears the SAME chrome
  // (`BusinessPortalShell`), so the two cannot drift into different products.
  if (API_ENABLED) return <LiveBusinessPortal />;

  return (
    <Suspense fallback={<PortalChunkSkeleton />}>
      <SyntheticBusinessPortal />
    </Suspense>
  );
}

/** The wait for the synthetic chunk. Never seen by a live client. */
function PortalChunkSkeleton() {
  const intl = useIntl();
  return (
    <div
      className="flex-1 flex flex-col min-w-0 h-full bg-ground overflow-hidden"
      role="status"
      aria-busy="true"
      aria-label={intl.formatMessage(m.loading)}
    >
      <div className="w-full max-w-md mx-auto px-5 py-10 flex flex-col gap-5">
        <div className="flex items-center gap-3">
          <div className="w-11 h-11 rounded-2xl bg-white/[0.06] shrink-0 animate-pulse" />
          <div className="flex flex-col gap-2">
            <div className="h-3.5 w-40 rounded-full bg-white/[0.06] animate-pulse" />
            <div className="h-2.5 w-24 rounded-full bg-white/[0.04] animate-pulse" />
          </div>
        </div>
        <div className="h-28 rounded-3xl bg-white/[0.04] animate-pulse" />
        <div className="h-28 rounded-3xl bg-white/[0.04] animate-pulse" />
      </div>
    </div>
  );
}
