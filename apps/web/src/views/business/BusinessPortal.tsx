import { useState } from 'react';
import { Home, Upload, Camera, Settings, ArrowLeft, Building2, ChevronDown } from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { defineMessages, useIntl } from 'react-intl';
import { useAppContext } from '../../context/AppContext';
import { BusinessHomeView } from './BusinessHomeView';
import { BusinessUploadView } from './BusinessUploadView';
import { BusinessCaptureView } from './BusinessCaptureView';
import { BusinessSettingsView } from './BusinessSettingsView';
import { BusinessSignInView } from './BusinessSignInView';
import { slug, useSegment } from '../../lib/router';
import { useEscape } from '../../lib/useEscape';

const m = defineMessages({
  tabHome: { id: 'portal.businessPortal.tabHome', defaultMessage: 'Home' },
  tabUpload: { id: 'portal.businessPortal.tabUpload', defaultMessage: 'Upload' },
  tabCapture: { id: 'portal.businessPortal.tabCapture', defaultMessage: 'Capture' },
  tabSettings: { id: 'portal.businessPortal.tabSettings', defaultMessage: 'Settings' },
  // The thumb bar gives each label roughly 90px at 360px wide. English fits;
  // German does not, so the short form is its own id a translator can shorten
  // without touching the desktop row.
  tabHomeShort: { id: 'portal.businessPortal.tabHome.short', defaultMessage: 'Home' },
  tabUploadShort: { id: 'portal.businessPortal.tabUpload.short', defaultMessage: 'Upload' },
  tabCaptureShort: { id: 'portal.businessPortal.tabCapture.short', defaultMessage: 'Capture' },
  tabSettingsShort: { id: 'portal.businessPortal.tabSettings.short', defaultMessage: 'Settings' },
  thumbBarLabel: { id: 'portal.businessPortal.thumbBarLabel', defaultMessage: 'Portal' },
  subtitle: { id: 'portal.businessPortal.subtitle', defaultMessage: 'Business portal' },
  exitAction: { id: 'portal.businessPortal.exitAction', defaultMessage: 'Accountant portal' },
  switchTrigger: { id: 'portal.switchAccount.trigger', defaultMessage: 'Switch business' },
  switchSignOut: { id: 'portal.switchAccount.signInAsAnother', defaultMessage: 'Sign in as another business' },
});

// `key` stays the machine value — it is the union the router and `onGo` speak,
// and slugs the URL. Only `label` (desktop row) and `labelShort` (thumb bar)
// are copy. Keying navigation off a translated label breaks the moment the
// locale changes; the key never moves.
const TABS = [
  { key: 'Home', icon: Home, label: m.tabHome, labelShort: m.tabHomeShort },
  { key: 'Upload', icon: Upload, label: m.tabUpload, labelShort: m.tabUploadShort },
  { key: 'Capture', icon: Camera, label: m.tabCapture, labelShort: m.tabCaptureShort },
  { key: 'Settings', icon: Settings, label: m.tabSettings, labelShort: m.tabSettingsShort },
] as const;

type Tab = (typeof TABS)[number]['key'];

/**
 * The client-facing shell. Deliberately its own portal rather than a tab in the
 * practice app: a business signs in here and can only ever see its own
 * paperwork. Four things only — what's outstanding, send a file, photograph a
 * receipt, and its own settings.
 */
export function BusinessPortal() {
  const { businessAccounts, portalAccountId, exitBusinessPortal } = useAppContext();
  const intl = useIntl();
  // /portal/:accountId/:tab
  const [tabSlug, setTabSlug] = useSegment(2);
  const tab: Tab = (TABS.map((x) => x.key).find((k) => slug(k) === tabSlug) as Tab) ?? 'Home';
  const setTab = (next: Tab) => setTabSlug(next === 'Home' ? null : slug(next));

  const account = businessAccounts.find((a) => a.id === portalAccountId);

  // No account selected — sign in, accept an invite, or sign the business up.
  if (!account) return <BusinessSignInView />;

  return (
    <div className="flex-1 flex flex-col min-w-0 h-full bg-ground overflow-hidden">
      <header className="shrink-0 border-b border-white/5 bg-card px-4 md:px-6 py-3 md:py-4 pt-safe flex items-center justify-between gap-3 md:gap-4">
        <div className="flex items-center gap-3 min-w-0">
          <div className="w-10 h-10 rounded-2xl bg-brand flex items-center justify-center text-white shrink-0 shadow-glow-tile">
            <Building2 size={18} />
          </div>
          <div className="min-w-0">
            <div className="font-sans font-bold text-[15px] text-white tracking-tight truncate">{account.businessName}</div>
            <div className="text-[11px] text-zinc-500 font-semibold uppercase tracking-wider">
              {intl.formatMessage(m.subtitle)}
            </div>
          </div>
        </div>

        <div className="flex items-center gap-2">
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
        </div>
      </header>

      <nav className="hidden md:flex shrink-0 border-b border-white/5 bg-card/60 px-6 items-center gap-1">
        {TABS.map((t) => {
          const isActive = tab === t.key;
          return (
            <button
              key={t.key}
              onClick={() => setTab(t.key)}
              className={`relative flex items-center gap-2 px-4 py-3 text-[13px] font-bold transition-colors ${
                isActive ? 'text-white' : 'text-zinc-500 hover:text-zinc-300'
              }`}
            >
              <t.icon size={15} className={isActive ? 'text-brand' : ''} />
              {intl.formatMessage(t.label)}
              {isActive && (
                <motion.span
                  layoutId="business-tab-underline"
                  className="absolute left-3 right-3 -bottom-px h-0.5 rounded-full bg-brand"
                />
              )}
            </button>
          );
        })}
      </nav>

      <div className="flex-1 min-h-0 overflow-y-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        <motion.div key={tab} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} className="h-full">
          {tab === 'Home' && <BusinessHomeView account={account} onGo={setTab} />}
          {tab === 'Upload' && <BusinessUploadView account={account} />}
          {tab === 'Capture' && <BusinessCaptureView account={account} />}
          {tab === 'Settings' && <BusinessSettingsView account={account} />}
        </motion.div>
      </div>

      {/* Phone: the same four tabs as a thumb bar. They are URL segments, so
          this is purely a different place to put the same navigation — and it
          keys off `t.key`, never off the label, which is translated. */}
      <nav
        aria-label={intl.formatMessage(m.thumbBarLabel)}
        className="md:hidden shrink-0 border-t border-white/5 bg-card pb-safe"
      >
        <div className="flex items-stretch justify-around h-16 px-1">
          {TABS.map((t) => {
            const isActive = tab === t.key;
            return (
              <button
                key={t.key}
                onClick={() => setTab(t.key)}
                {...(isActive ? { 'aria-current': 'page' as const } : {})}
                className={`flex flex-1 flex-col items-center justify-center gap-1 rounded-2xl ${isActive ? 'text-brand' : 'text-zinc-500'}`}
              >
                <span className={`flex h-7 w-12 items-center justify-center rounded-full ${isActive ? 'bg-brand/10' : ''}`}>
                  <t.icon size={21} strokeWidth={isActive ? 2.5 : 2} />
                </span>
                <span className="text-[10.5px] font-semibold leading-none">{intl.formatMessage(t.labelShort)}</span>
              </button>
            );
          })}
        </div>
      </nav>
    </div>
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
