import type { ReactNode } from 'react';
import { Building2, Camera, Home, Settings, Upload } from 'lucide-react';
import { motion } from 'motion/react';
import { defineMessages, useIntl } from 'react-intl';

import { PORTAL_TABS, type PortalTab } from './portalTabs';

/**
 * The four-tab chrome both business portals wear.
 *
 * D49 makes the prototype the design source of record, and the prototype's
 * portal is a four-tab product — Home · Upload · Capture · Settings — not a
 * scrolling page of cards. This is that chrome, extracted so the LIVE portal
 * and the synthetic one are the same shell with different content, rather than
 * two drawings that drift apart.
 *
 * Two navigations, one state:
 *
 * - **≥768px**: a horizontal row with an animated underline (`layoutId`, so
 *   the bar slides between tabs rather than blinking).
 * - **<768px**: a thumb bar pinned to the bottom, icon over a 10.5px label,
 *   the active one teal inside a soft pill. On a phone the top of the screen
 *   is where nothing is reachable one-handed, and this surface is used
 *   standing at a till.
 *
 * Both key off `t.key` — the machine value — and never off the label, which is
 * translated. Both are always in the DOM and CSS chooses, so nothing measures
 * text and nothing has to re-render on a resize.
 */

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
  tabBarLabel: { id: 'portal.businessPortal.tabBarLabel', defaultMessage: 'Portal sections' },
  subtitle: { id: 'portal.businessPortal.subtitle', defaultMessage: 'Business portal' },
});

const CHROME: Record<PortalTab, { icon: typeof Home; label: typeof m.tabHome; short: typeof m.tabHome }> = {
  Home: { icon: Home, label: m.tabHome, short: m.tabHomeShort },
  Upload: { icon: Upload, label: m.tabUpload, short: m.tabUploadShort },
  Capture: { icon: Camera, label: m.tabCapture, short: m.tabCaptureShort },
  Settings: { icon: Settings, label: m.tabSettings, short: m.tabSettingsShort },
};

export function BusinessPortalShell({
  businessName,
  tab,
  onTab,
  actions,
  children,
}: {
  readonly businessName: string;
  readonly tab: PortalTab;
  readonly onTab: (next: PortalTab) => void;
  readonly actions?: ReactNode;
  readonly children: ReactNode;
}) {
  const intl = useIntl();

  return (
    <div className="flex-1 flex flex-col min-w-0 h-full bg-ground overflow-hidden">
      <header className="shrink-0 border-b border-white/5 bg-card px-4 md:px-6 py-3 md:py-4 pt-safe flex items-center justify-between gap-3 md:gap-4">
        <div className="flex items-center gap-3 min-w-0">
          <div className="w-10 h-10 rounded-2xl bg-brand flex items-center justify-center text-brand-on shrink-0 shadow-glow-tile">
            <Building2 size={18} />
          </div>
          <div className="min-w-0">
            <div className="font-sans font-bold text-[15px] text-white tracking-tight truncate">{businessName}</div>
            <div className="text-[11px] text-zinc-500 font-semibold uppercase tracking-wider">
              {intl.formatMessage(m.subtitle)}
            </div>
          </div>
        </div>
        {actions !== undefined && <div className="flex items-center gap-2">{actions}</div>}
      </header>

      <nav
        aria-label={intl.formatMessage(m.tabBarLabel)}
        className="hidden md:flex shrink-0 border-b border-white/5 bg-card/60 px-6 items-center gap-1"
      >
        {PORTAL_TABS.map((key) => {
          const chrome = CHROME[key];
          const isActive = tab === key;
          return (
            <button
              key={key}
              onClick={() => onTab(key)}
              {...(isActive ? { 'aria-current': 'page' as const } : {})}
              className={`relative flex items-center gap-2 px-4 py-3 text-[13px] font-bold transition-colors ${
                isActive ? 'text-white' : 'text-zinc-500 hover:text-zinc-300'
              }`}
            >
              <chrome.icon size={15} className={isActive ? 'text-brand' : ''} />
              {intl.formatMessage(chrome.label)}
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
          {children}
        </motion.div>
      </div>

      {/* Phone: the same four tabs as a thumb bar. They are URL segments, so
          this is purely a different place to put the same navigation — and it
          keys off the machine value, never off the label, which is translated. */}
      <nav
        aria-label={intl.formatMessage(m.thumbBarLabel)}
        className="md:hidden shrink-0 border-t border-white/5 bg-card pb-safe"
      >
        <div className="flex items-stretch justify-around h-16 px-1">
          {PORTAL_TABS.map((key) => {
            const chrome = CHROME[key];
            const isActive = tab === key;
            return (
              <button
                key={key}
                onClick={() => onTab(key)}
                {...(isActive ? { 'aria-current': 'page' as const } : {})}
                className={`flex flex-1 flex-col items-center justify-center gap-1 rounded-2xl ${
                  isActive ? 'text-brand' : 'text-zinc-500'
                }`}
              >
                <span
                  className={`flex h-7 w-12 items-center justify-center rounded-full ${isActive ? 'bg-brand/10' : ''}`}
                >
                  <chrome.icon size={21} strokeWidth={isActive ? 2.5 : 2} />
                </span>
                <span className="text-[10.5px] font-semibold leading-none">{intl.formatMessage(chrome.short)}</span>
              </button>
            );
          })}
        </div>
      </nav>
    </div>
  );
}
