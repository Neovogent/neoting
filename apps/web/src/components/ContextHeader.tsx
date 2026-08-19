import { useState } from 'react';
import { defineMessages, useIntl, type MessageDescriptor } from 'react-intl';
import { ChevronDown, LogOut, UserRound } from 'lucide-react';
import type { WorkspaceRole } from '@neoting/contracts/model';
import { useAppContext } from '../context/AppContext';
import { useEscape } from '../lib/useEscape';
import { DataSourceBadge } from './DataSourceBadge';

/**
 * The persistent context header (SoT §13.3, METH Stage 6): who is signed in,
 * the role they are acting under, and the client scope — real, from `/v1/me`,
 * on every practice screen.
 *
 * It renders nothing in synthetic mode ('off'): there is no identity to show
 * and inventing one would be the opposite of orientation. In 'degraded' mode
 * it carries only the dev-only fallback badges, so an API that died
 * mid-session is named rather than silently impersonated by seed data.
 */
const m = defineMessages({
  scope: {
    id: 'shell.contextHeader.scope',
    defaultMessage: '{count, plural, one {# client in scope} other {# clients in scope}}',
  },
  userMenu: { id: 'shell.contextHeader.userMenu', defaultMessage: 'Account menu' },
  logout: { id: 'shell.contextHeader.logout', defaultMessage: 'Log out' },
  sessionSlice: {
    id: 'shell.contextHeader.sessionSlice',
    defaultMessage: 'session',
    description: 'Name of the session data slice on the fallback badge — a technical noun.',
  },
  businessesSlice: {
    id: 'shell.contextHeader.businessesSlice',
    defaultMessage: 'clients',
    description: 'Name of the businesses data slice on the fallback badge.',
  },
  // Role names stay per-component (i18n rule: consolidation by meaning only).
  rolePracticeAdmin: { id: 'shell.contextHeader.rolePracticeAdmin', defaultMessage: 'Practice Admin' },
  rolePracticeStandard: { id: 'shell.contextHeader.rolePracticeStandard', defaultMessage: 'Practice Standard' },
  roleClientAdmin: { id: 'shell.contextHeader.roleClientAdmin', defaultMessage: 'Client Admin' },
  roleBusinessAdmin: { id: 'shell.contextHeader.roleBusinessAdmin', defaultMessage: 'Business Admin' },
  roleUserAdmin: { id: 'shell.contextHeader.roleUserAdmin', defaultMessage: 'User Admin' },
  roleBusinessStandard: { id: 'shell.contextHeader.roleBusinessStandard', defaultMessage: 'Business Standard' },
});

const ROLE_LABEL: Record<WorkspaceRole, MessageDescriptor> = {
  PRACTICE_ADMIN: m.rolePracticeAdmin,
  PRACTICE_STANDARD: m.rolePracticeStandard,
  CLIENT_ADMIN: m.roleClientAdmin,
  BUSINESS_ADMIN: m.roleBusinessAdmin,
  USER_ADMIN: m.roleUserAdmin,
  BUSINESS_STANDARD: m.roleBusinessStandard,
};

export function ContextHeader() {
  const intl = useIntl();
  const { session, businesses, slices, logout } = useAppContext();
  const [menuOpen, setMenuOpen] = useState(false);
  useEscape(() => setMenuOpen(false), menuOpen);

  if (session.status === 'off') return null;

  const badges = (
    <span className="flex items-center gap-2 min-w-0">
      {session.status === 'degraded' && (
        <DataSourceBadge
          slice={intl.formatMessage(m.sessionSlice)}
          status={{ source: 'seed-fallback', loading: false, error: session.error }}
        />
      )}
      <DataSourceBadge slice={intl.formatMessage(m.businessesSlice)} status={slices.businesses} />
    </span>
  );

  if (session.status !== 'authenticated') {
    // 'degraded': no identity to show, but the badges must still be visible.
    return (
      <header className="shrink-0 flex items-center justify-end gap-2 px-10 h-11 border-b border-white/5 bg-card">
        {badges}
      </header>
    );
  }

  const { user, practice, role } = session.me;
  const name = [user.firstName, user.lastName].filter(Boolean).join(' ') || user.email;

  return (
    <header className="shrink-0 flex items-center justify-between gap-4 px-10 h-11 border-b border-white/5 bg-card">
      <span className="flex items-center gap-3 min-w-0">
        {practice && (
          <span className="text-[12.5px] font-bold text-white truncate">{practice.name}</span>
        )}
        <span className="px-2.5 py-0.5 rounded-full bg-brand/10 text-brand text-[11px] font-bold whitespace-nowrap">
          {intl.formatMessage(ROLE_LABEL[role])}
        </span>
        <span className="text-[12px] text-zinc-500 font-semibold whitespace-nowrap">
          {intl.formatMessage(m.scope, { count: businesses.length })}
        </span>
      </span>

      <span className="flex items-center gap-3 min-w-0">
        {badges}
        <span className="relative shrink-0">
          <button
            onClick={() => setMenuOpen((open) => !open)}
            aria-expanded={menuOpen}
            aria-label={intl.formatMessage(m.userMenu)}
            className="flex items-center gap-2 px-2.5 py-1.5 rounded-full hover:bg-white/5 text-zinc-400 hover:text-white transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-brand/60"
          >
            <UserRound size={15} className="shrink-0" />
            <span className="text-[12.5px] font-semibold max-w-48 truncate">{name}</span>
            <ChevronDown size={13} className="shrink-0" />
          </button>

          {menuOpen && (
            <>
              {/* The keyboard dismissal is the useEscape entry above; the
                  backdrop is a pointer target only, per the house pattern. */}
              <div role="presentation" className="fixed inset-0 z-30" onClick={() => setMenuOpen(false)} />
              <div className="absolute right-0 top-full mt-2 z-40 w-64 p-2 rounded-2xl bg-card border border-white/10 shadow-glow-tile">
                <p className="px-3 pt-2 text-[12.5px] font-bold text-white truncate">{name}</p>
                <p className="px-3 pb-2 text-[11.5px] text-zinc-500 truncate">{user.email}</p>
                <button
                  onClick={() => {
                    setMenuOpen(false);
                    void logout();
                  }}
                  className="w-full flex items-center gap-2 px-3 py-2 rounded-xl text-left text-[13px] font-semibold text-zinc-300 hover:bg-white/5 hover:text-white transition-colors"
                >
                  <LogOut size={14} className="shrink-0" />
                  {intl.formatMessage(m.logout)}
                </button>
              </div>
            </>
          )}
        </span>
      </span>
    </header>
  );
}
