import { useState } from 'react';
import { Home, Upload, Camera, Settings, ArrowLeft, Building2, ChevronDown } from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { useAppContext } from '../../context/AppContext';
import { BusinessHomeView } from './BusinessHomeView';
import { BusinessUploadView } from './BusinessUploadView';
import { BusinessCaptureView } from './BusinessCaptureView';
import { BusinessSettingsView } from './BusinessSettingsView';
import { BusinessSignInView } from './BusinessSignInView';
import { slug, useSegment } from '../../lib/router';

const TABS = [
  { key: 'Home', icon: Home },
  { key: 'Upload', icon: Upload },
  { key: 'Capture', icon: Camera },
  { key: 'Settings', icon: Settings },
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
  // /portal/:accountId/:tab
  const [tabSlug, setTabSlug] = useSegment(2);
  const tab: Tab = (TABS.map((x) => x.key).find((k) => slug(k) === tabSlug) as Tab) ?? 'Home';
  const setTab = (next: Tab) => setTabSlug(next === 'Home' ? null : slug(next));

  const account = businessAccounts.find((a) => a.id === portalAccountId);

  // No account selected — sign in, accept an invite, or sign the business up.
  if (!account) return <BusinessSignInView />;

  return (
    <div className="flex-1 flex flex-col min-w-0 h-full bg-[#0a0a0c] overflow-hidden">
      <header className="shrink-0 border-b border-white/5 bg-[#16161a] px-6 py-4 flex items-center justify-between gap-4">
        <div className="flex items-center gap-3 min-w-0">
          <div className="w-10 h-10 rounded-2xl bg-[#14e3c4] flex items-center justify-center text-white shrink-0 shadow-[0_0_15px_rgba(20,227,196,0.3)]">
            <Building2 size={18} />
          </div>
          <div className="min-w-0">
            <div className="font-sans font-bold text-[15px] text-white tracking-tight truncate">{account.businessName}</div>
            <div className="text-[11px] text-zinc-500 font-semibold uppercase tracking-wider">Business portal</div>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <SwitchAccount />
          <button
            onClick={exitBusinessPortal}
            className="flex items-center gap-2 px-4 py-2 rounded-full text-[13px] font-bold text-zinc-400 border border-white/5 bg-[#0a0a0c] hover:text-white hover:border-white/15 transition-colors"
          >
            <ArrowLeft size={14} strokeWidth={2.5} />
            Accountant portal
          </button>
        </div>
      </header>

      <nav className="shrink-0 border-b border-white/5 bg-[#16161a]/60 px-6 flex items-center gap-1">
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
              <t.icon size={15} className={isActive ? 'text-[#14e3c4]' : ''} />
              {t.key}
              {isActive && (
                <motion.span
                  layoutId="business-tab-underline"
                  className="absolute left-3 right-3 -bottom-px h-0.5 rounded-full bg-[#14e3c4]"
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
    </div>
  );
}

/** Demo affordance: hop between the seeded businesses without signing out. */
function SwitchAccount() {
  const { businessAccounts, portalAccountId, openBusinessPortal } = useAppContext();
  const [open, setOpen] = useState(false);
  const active = businessAccounts.find((a) => a.id === portalAccountId);

  return (
    <div className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-2 px-4 py-2 rounded-full text-[13px] font-bold text-zinc-400 border border-white/5 bg-[#0a0a0c] hover:text-white hover:border-white/15 transition-colors"
      >
        Switch business
        <ChevronDown size={14} className={`transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>
      <AnimatePresence>
        {open && (
          <>
            <div className="fixed inset-0 z-20" onClick={() => setOpen(false)} />
            <motion.div
              initial={{ opacity: 0, y: -6 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -6 }}
              className="absolute right-0 top-full mt-2 w-64 z-30 rounded-2xl border border-white/5 bg-[#16161a] shadow-2xl overflow-hidden p-1.5"
            >
              {businessAccounts.map((a) => (
                <button
                  key={a.id}
                  onClick={() => {
                    openBusinessPortal(a.id);
                    setOpen(false);
                  }}
                  className={`w-full text-left px-3 py-2.5 rounded-xl text-[13px] font-semibold transition-colors ${
                    a.id === active?.id ? 'bg-[#14e3c4]/15 text-[#14e3c4]' : 'text-zinc-300 hover:bg-white/5 hover:text-white'
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
                Sign in as another business
              </button>
            </motion.div>
          </>
        )}
      </AnimatePresence>
    </div>
  );
}
