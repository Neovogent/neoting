import { useState } from 'react';
import { ArrowLeft, Building2, ChevronDown } from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { defineMessages, useIntl } from 'react-intl';

import { useAppContext } from '../../context/AppContext';
import { navigate, usePath } from '../../lib/router';
import { useEscape } from '../../lib/useEscape';
import { BusinessPortalShell } from './BusinessPortalShell';
import { BusinessCaptureView } from './BusinessCaptureView';
import { BusinessHomeView } from './BusinessHomeView';
import { BusinessSettingsView } from './BusinessSettingsView';
import { BusinessSignInView } from './BusinessSignInView';
import { BusinessUploadView } from './BusinessUploadView';
import { pathForTab, tabFromPath, type PortalTab } from './portalTabs';

/**
 * ⚠ **DO NOT PUT THESE TABS BEHIND `lazy()`.** It was measured on 3 Sep 2026
 * and it makes the budget WORSE, not better. This chunk is only ever reached
 * through `BusinessPortal`, so Rollup files the shared shell (`portalTabs`,
 * `BusinessPortalShell`, `PortalStatusPill`, `portalCamera`, …) in that
 * guaranteed-ancestor chunk — which also holds the entire LIVE portal, 20,206 B
 * gzip. Every chunk split off THIS one therefore inherits index + query +
 * BusinessPortal + SyntheticBusinessPortal ≈ 231 kB before a line of its own
 * code, so splitting Upload/Capture/Settings out turned one route 14 kB over
 * budget into three (`BusinessSettingsView` 261,501, `BusinessUploadView`
 * 254,443, and this one still 251,332). See `apps/web/CLAUDE.md`,
 * *The synthetic portal pays for the live portal*.
 */

/**
 * The business portal on seeded data — the whole four-tab shell the demo walks
 * through with no API at all (METH_MODE §1 makes that a standing condition).
 *
 * ⚠ **THIS FILE EXISTS TO KEEP ITSELF OFF A REAL CLIENT'S PHONE.** It and the
 * five views it pulls in are roughly 2,900 lines that a live visitor can never
 * reach, and until 2 Sep 2026 `BusinessPortal.tsx` imported every one of them
 * statically — *above* the `API_ENABLED` branch — so every real client
 * downloaded the synthetic shell before being shown the live one. The branch is
 * a runtime read (`api/config.ts` reads `import.meta.env` defensively, which
 * defeats static replacement), so both halves ship whatever happens; what a
 * second `lazy()` buys is that only one of them is ever FETCHED. Keep the
 * imports below out of `BusinessPortal.tsx`.
 *
 * Default-exported because `lazy()` wants a default, and it is the whole
 * module's purpose.
 */

const m = defineMessages({
  exitAction: { id: 'portal.businessPortal.exitAction', defaultMessage: 'Accountant portal' },
  switchTrigger: { id: 'portal.switchAccount.trigger', defaultMessage: 'Switch business' },
  switchSignOut: { id: 'portal.switchAccount.signInAsAnother', defaultMessage: 'Sign in as another business' },
});

export default function SyntheticBusinessPortal() {
  const { businessAccounts, portalAccountId, exitBusinessPortal } = useAppContext();
  const intl = useIntl();

  // /portal/:accountId(/:tab) — the tab is the last segment when it names one,
  // so this shell's account-scoped addresses and the live portal's bare
  // `/portal/:tab` read through the same two functions.
  const segments = usePath();
  const tab = tabFromPath(segments);
  const setTab = (next: PortalTab) => navigate(pathForTab(segments, next));

  const account = businessAccounts.find((a) => a.id === portalAccountId);

  // No account selected — sign in, accept an invite, or sign the business up.
  if (!account) return <BusinessSignInView />;

  return (
    <BusinessPortalShell
      businessName={account.businessName}
      tab={tab}
      onTab={setTab}
      actions={
        <>
          <SwitchAccount />
          {/* On a phone this collapses to the arrow alone — the aria-label is
              then the only name it has, so it carries the same catalogue copy
              the visible span does. */}
          <button
            onClick={exitBusinessPortal}
            aria-label={intl.formatMessage(m.exitAction)}
            className="flex items-center gap-2 px-3 md:px-4 py-2 rounded-full text-[13px] font-bold text-zinc-400 border border-white/5 bg-ground hover:text-white hover:border-white/15 transition-colors"
          >
            <ArrowLeft size={14} strokeWidth={2.5} />
            <span className="hidden md:inline">{intl.formatMessage(m.exitAction)}</span>
          </button>
        </>
      }
    >
      {tab === 'Home' && <BusinessHomeView account={account} onGo={setTab} />}
      {tab === 'Upload' && <BusinessUploadView account={account} />}
      {tab === 'Capture' && <BusinessCaptureView account={account} />}
      {tab === 'Settings' && <BusinessSettingsView account={account} />}
    </BusinessPortalShell>
  );
}

/** Demo affordance: hop between the seeded businesses without signing out. */
function SwitchAccount() {
  const { businessAccounts, portalAccountId, openBusinessPortal } = useAppContext();
  const intl = useIntl();
  const [open, setOpen] = useState(false);
  const active = businessAccounts.find((a) => a.id === portalAccountId);
  // Enabled only while the menu is open, so the entry does not linger in the
  // Escape stack under real dialogs.
  useEscape(() => setOpen(false), open);

  return (
    <div className="relative">
      {/* Phone: the label collapses to the Building2 glyph, so the aria-label
          carries the same catalogue copy the visible span does. */}
      <button
        onClick={() => setOpen((o) => !o)}
        aria-label={intl.formatMessage(m.switchTrigger)}
        aria-expanded={open}
        className="flex items-center gap-2 px-3 md:px-4 py-2 rounded-full text-[13px] font-bold text-zinc-400 border border-white/5 bg-ground hover:text-white hover:border-white/15 transition-colors"
      >
        <Building2 size={14} className="md:hidden" />
        <span className="hidden md:inline">{intl.formatMessage(m.switchTrigger)}</span>
        <ChevronDown size={14} className={`transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>
      <AnimatePresence>
        {open && (
          <>
            {/* A click-away scrim, not a button — role="presentation" says so.
                The keyboard already has both exits: Escape above, and the
                trigger re-toggles. */}
            <div className="fixed inset-0 z-20" onClick={() => setOpen(false)} role="presentation" />
            <motion.div
              initial={{ opacity: 0, y: -6 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -6 }}
              // `max-w-[calc(100vw-2rem)]` so a 64-wide menu cannot overflow a
              // 360px screen and push the page sideways.
              className="absolute right-0 top-full mt-2 w-64 max-w-[calc(100vw-2rem)] z-30 rounded-2xl border border-white/5 bg-card shadow-2xl overflow-hidden p-1.5"
            >
              {businessAccounts.map((a) => (
                <button
                  key={a.id}
                  onClick={() => {
                    openBusinessPortal(a.id);
                    setOpen(false);
                  }}
                  className={`w-full text-left px-3 py-2.5 rounded-xl text-[13px] font-semibold transition-colors ${
                    a.id === active?.id ? 'bg-brand/15 text-brand' : 'text-zinc-300 hover:bg-white/5 hover:text-white'
                  }`}
                >
                  {a.businessName}
                  <span className="block text-[11px] text-zinc-500 font-medium mt-0.5">{a.contactName}</span>
                </button>
              ))}
              <button
                onClick={() => {
                  openBusinessPortal(null);
                  setOpen(false);
                }}
                className="w-full text-left px-3 py-2.5 rounded-xl text-[13px] font-semibold text-zinc-400 hover:bg-white/5 hover:text-white transition-colors border-t border-white/5 mt-1.5 pt-3"
              >
                {intl.formatMessage(m.switchSignOut)}
              </button>
            </motion.div>
          </>
        )}
      </AnimatePresence>
    </div>
  );
}
