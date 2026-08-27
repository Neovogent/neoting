import { useEffect, useState } from 'react';
import {
  Bot, Users, Inbox, CheckCircle, MoreHorizontal, Send, FileText, BarChart2,
  Shield, Settings, Store, Sun, Moon, X, type LucideProps,
} from 'lucide-react';
import { defineMessages, useIntl, type MessageDescriptor } from 'react-intl';
import { motion, AnimatePresence } from 'motion/react';
import { useAppContext } from '../context/AppContext';
import { shellNav } from './Sidebar';

/**
 * Phone navigation for the practice shell. The rail's nine tabs do not fit a
 * thumb-width bar, so the four most-visited live on it and the rest sit one
 * tap away in a sheet — together with the two things that used to live only
 * at the foot of the rail: the business-portal launcher and the theme toggle.
 *
 * Colours deliberately reuse the rail's unprefixed classes so the light-theme
 * remap in index.css picks them up.
 *
 * Two things this does NOT copy from the rail's first draft. `tab` is the
 * routing vocabulary and the label is a descriptor beside it (see Sidebar):
 * keying a tab off its own translated label works in English and breaks
 * navigation outright in every other locale. And the labels themselves are
 * imported from the rail rather than redeclared — the same string under the
 * same id in two files is a duplicate-id build failure, and translating
 * "Clients" twice would be wrong even if it were not.
 */

/**
 * A bar this narrow cannot hold every rail label, and what is short in English
 * is not short in German, so the shrunk form is its own message rather than a
 * truncation. `.short` on the same id keeps the pair visibly related in the
 * catalogue.
 */
const m = defineMessages({
  aiWorkspaceShort: { id: 'shell.sidebar.aiWorkspace.short', defaultMessage: 'Workspace' },
  more: { id: 'shell.bottomNav.more', defaultMessage: 'More' },
  moreHeading: { id: 'shell.bottomNav.moreHeading', defaultMessage: 'More' },
  closeMenu: { id: 'shell.bottomNav.closeMenu', defaultMessage: 'Close menu' },
  primary: {
    id: 'shell.bottomNav.primary',
    defaultMessage: 'Primary',
    description: 'Accessible name of the bottom tab bar, read by a screen reader.',
  },
});

interface Item {
  icon: React.ComponentType<LucideProps>;
  /** The routing vocabulary — never translated. See Sidebar. */
  tab: string;
  label: MessageDescriptor;
  /** Shown on the bar itself when the full label will not fit. */
  short?: MessageDescriptor;
}

const PRIMARY: Item[] = [
  { icon: Bot, tab: 'AI Workspace', label: shellNav.aiWorkspace, short: m.aiWorkspaceShort },
  { icon: Users, tab: 'Clients', label: shellNav.clients },
  { icon: Inbox, tab: 'Inboxes', label: shellNav.inboxes },
  { icon: CheckCircle, tab: 'Approvals', label: shellNav.approvals },
];

const MORE: Item[] = [
  { icon: Send, tab: 'Chases', label: shellNav.chases },
  { icon: FileText, tab: 'Documents', label: shellNav.documents },
  { icon: BarChart2, tab: 'Analytics', label: shellNav.analytics },
  { icon: Shield, tab: 'Team', label: shellNav.team },
  { icon: Settings, tab: 'Settings', label: shellNav.settings },
];

interface BottomNavProps {
  activeTab: string;
  setActiveTab: (tab: string) => void;
  onOpenBusinessPortal: () => void;
}

export function BottomNav({ activeTab, setActiveTab, onOpenBusinessPortal }: BottomNavProps) {
  const { settings, updateSettings, documentsSource } = useAppContext();
  const intl = useIntl();
  const [moreOpen, setMoreOpen] = useState(false);
  const isLight = settings.theme === 'light';
  const moreActive = MORE.some((item) => item.tab === activeTab);

  // Any navigation closes the sheet, including the browser's Back.
  useEffect(() => setMoreOpen(false), [activeTab]);

  const go = (tab: string) => {
    setMoreOpen(false);
    setActiveTab(tab);
  };

  return (
    <>
      <nav
        data-tour="nav"
        aria-label={intl.formatMessage(m.primary)}
        className="shrink-0 z-30 border-t border-white/5 bg-card pb-safe"
      >
        <div className="flex items-stretch justify-around h-16 px-1">
          {PRIMARY.map((item) => (
            <NavButton
              key={item.tab}
              icon={item.icon}
              label={intl.formatMessage(item.short ?? item.label)}
              active={activeTab === item.tab}
              onClick={() => go(item.tab)}
            />
          ))}
          <NavButton
            icon={moreOpen ? X : MoreHorizontal}
            label={intl.formatMessage(m.more)}
            active={moreActive || moreOpen}
            onClick={() => setMoreOpen((o) => !o)}
            expanded={moreOpen}
          />
        </div>
      </nav>

      <AnimatePresence>
        {moreOpen && (
          <>
            <motion.button
              key="scrim"
              aria-label={intl.formatMessage(m.closeMenu)}
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => setMoreOpen(false)}
              className="fixed inset-0 z-40 bg-black/60 backdrop-blur-sm"
            />
            <motion.div
              key="sheet"
              role="dialog"
              aria-label={intl.formatMessage(m.moreHeading)}
              initial={{ y: '100%' }}
              animate={{ y: 0 }}
              exit={{ y: '100%' }}
              transition={{ type: 'spring', stiffness: 380, damping: 36 }}
              className="fixed inset-x-0 bottom-0 z-50 rounded-t-[28px] border-t border-white/10 bg-card shadow-2xl pb-safe-4"
            >
              <div className="mx-auto mt-3 mb-2 h-1 w-10 rounded-full bg-white/15" aria-hidden />
              <div className="px-4 pb-2">
                <div className="px-2 py-2 text-[11px] font-bold uppercase tracking-widest text-zinc-500">
                  {intl.formatMessage(m.moreHeading)}
                </div>
                <div className="grid grid-cols-1 gap-1">
                  {MORE.map((item) => (
                    <SheetRow
                      key={item.tab}
                      icon={item.icon}
                      label={intl.formatMessage(item.label)}
                      active={activeTab === item.tab}
                      onClick={() => go(item.tab)}
                    />
                  ))}
                </div>
                <div className="my-2 border-t border-white/5" />
                <div className="grid grid-cols-1 gap-1">
                  {/* Seed-backed demo surface — synthetic only, like the tour
                      button (launch M8). */}
                  {documentsSource !== 'api' && (
                    <SheetRow
                      icon={Store}
                      label={intl.formatMessage(shellNav.businessPortal)}
                      onClick={() => {
                        setMoreOpen(false);
                        onOpenBusinessPortal();
                      }}
                    />
                  )}
                  <SheetRow
                    icon={isLight ? Moon : Sun}
                    label={intl.formatMessage(isLight ? shellNav.darkMode : shellNav.lightMode)}
                    onClick={() => updateSettings({ theme: isLight ? 'dark' : 'light' })}
                  />
                </div>
              </div>
            </motion.div>
          </>
        )}
      </AnimatePresence>
    </>
  );
}

function NavButton({
  icon: Icon, label, active, onClick, expanded,
}: {
  icon: React.ComponentType<LucideProps>;
  label: string;
  active: boolean;
  onClick: () => void;
  expanded?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      aria-label={label}
      aria-current={active && !expanded ? 'page' : undefined}
      aria-expanded={expanded}
      className={`flex flex-1 flex-col items-center justify-center gap-1 rounded-2xl min-w-0 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand/60 ${
        active ? 'text-brand' : 'text-zinc-500'
      }`}
    >
      <span className={`flex h-7 w-12 items-center justify-center rounded-full transition-colors ${active ? 'bg-brand/10' : ''}`}>
        <Icon size={21} strokeWidth={active ? 2.5 : 2} />
      </span>
      <span className="text-[10.5px] font-semibold leading-none truncate max-w-full">{label}</span>
    </button>
  );
}

function SheetRow({
  icon: Icon, label, active, onClick,
}: {
  icon: React.ComponentType<LucideProps>;
  label: string;
  active?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      aria-current={active ? 'page' : undefined}
      className={`flex w-full items-center gap-4 rounded-2xl px-4 py-3.5 text-left text-[15px] font-medium transition-colors ${
        active ? 'bg-brand/10 text-brand' : 'text-zinc-300 hover:bg-white/5'
      }`}
    >
      <Icon size={20} strokeWidth={active ? 2.5 : 2} />
      {label}
    </button>
  );
}
