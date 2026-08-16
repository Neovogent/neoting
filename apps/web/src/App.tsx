/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { Suspense, lazy, useEffect, useState } from 'react';
import { Sidebar } from './components/Sidebar';
import { useAppContext } from './context/AppContext';
import { motion, AnimatePresence } from 'motion/react';

/**
 * Every top-level surface is fetched when it is opened, not when the app boots.
 *
 * SoT §14 asks for under 250 KB gzipped per route and for the OTP portal to be
 * "the lightest surface in the product" — it opens on a phone, on bad mobile
 * data, in a car park. The Next.js plan got both free from route groups; D37
 * moved to Vite and said in as many words that the requirement survives as
 * build configuration plus review. This is the configuration half.
 *
 * The client-facing three matter most. A business owner following an SMS link
 * has no reason to download the practice's approvals queue, bank matching or
 * team admin, and until these were lazy, they did.
 *
 * The views are named exports, so each import names the member it wants rather
 * than the whole module changing its export style to suit the bundler.
 */

// Client-facing. Nothing behind the portal, approval or registration shells
// should pull the practice app down with it.
const BusinessPortal = lazy(() => import('./views/business/BusinessPortal').then((m) => ({ default: m.BusinessPortal })));
const ClientApprovalView = lazy(() => import('./views/business/ClientApprovalView').then((m) => ({ default: m.ClientApprovalView })));
const UserRegistrationView = lazy(() => import('./views/business/UserRegistrationView').then((m) => ({ default: m.UserRegistrationView })));

// The practice app. One chunk per tab, so opening Clients does not also cost
// you Approvals.
const AIWorkspaceView = lazy(() => import('./views/AIWorkspaceView').then((m) => ({ default: m.AIWorkspaceView })));
const ClientsView = lazy(() => import('./views/ClientsView').then((m) => ({ default: m.ClientsView })));
const ClientDetailView = lazy(() => import('./views/ClientDetailView').then((m) => ({ default: m.ClientDetailView })));
const InboxesView = lazy(() => import('./views/InboxesView').then((m) => ({ default: m.InboxesView })));
const ApprovalsView = lazy(() => import('./views/ApprovalsView').then((m) => ({ default: m.ApprovalsView })));
const DocumentsView = lazy(() => import('./views/DocumentsView').then((m) => ({ default: m.DocumentsView })));
const AnalyticsView = lazy(() => import('./views/AnalyticsView').then((m) => ({ default: m.AnalyticsView })));
const TeamView = lazy(() => import('./views/TeamView').then((m) => ({ default: m.TeamView })));
const SettingsView = lazy(() => import('./views/SettingsView').then((m) => ({ default: m.SettingsView })));
const ChasesView = lazy(() => import('./views/ChasesView').then((m) => ({ default: m.ChasesView })));
const GenericView = lazy(() => import('./views/GenericView').then((m) => ({ default: m.GenericView })));

// Practice-only, and a modal, so it is the safest thing in the file to defer:
// a client on the portal never opens it and should never pay for it.
const BusinessPortalLauncher = lazy(() => import('./components/BusinessPortalLauncher').then((m) => ({ default: m.BusinessPortalLauncher })));

/**
 * What a practice screen looks like while its chunk is in flight.
 *
 * A skeleton, not a spinner: Guideline §7.4.5 puts spinners off primary
 * surfaces. It borrows the real geometry of a workspace view — the same
 * `px-10` header and the same card rhythm underneath — so the screen settles
 * into place rather than replacing one thing with a different thing.
 */
function WorkspaceSkeleton() {
  return (
    <div
      className="flex-1 flex flex-col min-w-0 bg-ground h-full overflow-hidden"
      role="status"
      aria-busy="true"
      aria-label="Loading"
    >
      <header className="px-10 pt-8 pb-5 flex items-center justify-between gap-4 shrink-0">
        <div className="h-8 w-52 rounded-full bg-white/[0.07] animate-pulse" />
        <div className="flex items-center gap-3">
          <div className="h-10 w-64 rounded-full bg-white/[0.04] animate-pulse" />
          <div className="h-10 w-28 rounded-full bg-white/[0.04] animate-pulse" />
        </div>
      </header>
      <div className="flex-1 px-10 pb-10 flex flex-col gap-3 overflow-hidden">
        {[0, 1, 2, 3, 4, 5].map((i) => (
          <div
            key={i}
            className="h-20 shrink-0 rounded-3xl bg-card border border-white/5 animate-pulse"
            // Staggered so the column reads as one surface arriving rather than
            // six things flashing in unison.
            style={{ animationDelay: `${i * 90}ms` }}
          />
        ))}
      </div>
    </div>
  );
}

/**
 * The same idea on the client side, in the portal's own proportions — a narrow
 * centred column, not a workspace. This is the one that renders on a bad
 * connection, so it stays to a handful of nodes.
 */
function PortalSkeleton() {
  return (
    <div
      className="flex-1 flex flex-col min-w-0 h-full bg-ground overflow-hidden"
      role="status"
      aria-busy="true"
      aria-label="Loading"
    >
      <div className="w-full max-w-md mx-auto px-5 py-10 flex flex-col gap-5">
        <div className="flex items-center gap-3">
          <div className="w-11 h-11 rounded-2xl bg-white/[0.06] shrink-0 animate-pulse" />
          <div className="flex flex-col gap-2">
            <div className="h-5 w-40 rounded-full bg-white/[0.07] animate-pulse" />
            <div className="h-3 w-28 rounded-full bg-white/[0.04] animate-pulse" />
          </div>
        </div>
        {[0, 1, 2].map((i) => (
          <div
            key={i}
            className="h-24 rounded-3xl bg-card border border-white/5 animate-pulse"
            style={{ animationDelay: `${i * 90}ms` }}
          />
        ))}
      </div>
    </div>
  );
}

export default function App() {
  const { messages, activeTab, setActiveTab, openClientId, openClient, portal, settings } = useAppContext();
  const [launcherOpen, setLauncherOpen] = useState(false);

  // The theme is a class on <html> so it also covers the body background
  // behind the app shell.
  useEffect(() => {
    document.documentElement.classList.toggle('light', settings.theme === 'light');
  }, [settings.theme]);

  const isChatFocusMode = activeTab === 'AI Workspace' && messages.length > 0;

  // Coming back to Clients from the sidebar always lands on the list, not the
  // client that happened to be open last.
  // Coming back to Clients from the sidebar lands on the list, not the client
  // that happened to be open last — both are the same address, '/clients'.
  const goToTab = (tab: string) => (tab === 'Clients' ? openClient(null) : setActiveTab(tab));

  let content;
  switch (activeTab) {
    case 'AI Workspace':
      content = <AIWorkspaceView />;
      break;
    case 'Clients':
      content = openClientId ? <ClientDetailView key={openClientId} /> : <ClientsView />;
      break;
    case 'Inboxes':
      content = <InboxesView />;
      break;
    case 'Chases':
      content = <ChasesView />;
      break;
    case 'Approvals':
      content = <ApprovalsView />;
      break;
    case 'Documents':
      content = <DocumentsView />;
      break;
    case 'Analytics':
      content = <AnalyticsView />;
      break;
    case 'Team':
      content = <TeamView />;
      break;
    case 'Settings':
      content = <SettingsView />;
      break;
    default:
      content = <GenericView title={activeTab} />;
      break;
  }

  // The business portal replaces the practice shell outright — a client must
  // never see another client's data sitting behind it. The SMS approval link
  // is stricter still: no account, no portal, one client's batch only.
  if (portal !== 'accountant') {
    return (
      <div className="flex h-screen w-screen overflow-hidden bg-ground text-white font-sans selection:bg-brand/30">
        <Suspense fallback={<PortalSkeleton />}>
          {portal === 'approval' ? <ClientApprovalView />
            : portal === 'registration' ? <UserRegistrationView />
            : <BusinessPortal />}
        </Suspense>
      </div>
    );
  }

  return (
    <div className="flex h-screen w-screen overflow-hidden bg-ground text-white font-sans selection:bg-brand/30">
      {/* Suspense sits outside AnimatePresence on purpose: AnimatePresence has
          to keep the motion element as its own direct child or it cannot hold
          the launcher on screen long enough to run its exit animation. */}
      <Suspense fallback={null}>
        <AnimatePresence>
          {launcherOpen && <BusinessPortalLauncher onClose={() => setLauncherOpen(false)} />}
        </AnimatePresence>
      </Suspense>
      <AnimatePresence initial={false}>
        {!isChatFocusMode && (
          <motion.div
            initial={{ width: 0, opacity: 0, x: -50 }}
            animate={{ width: 'auto', opacity: 1, x: 0 }}
            exit={{ width: 0, opacity: 0, x: -50, filter: 'blur(10px)' }}
            transition={{ type: "spring", stiffness: 300, damping: 30 }}
            className="shrink-0 overflow-hidden"
          >
            <Sidebar activeTab={activeTab} setActiveTab={goToTab} onOpenBusinessPortal={() => setLauncherOpen(true)} />
          </motion.div>
        )}
      </AnimatePresence>
      {/* The boundary wraps the content area only, so a tab change swaps the
          screen without the sidebar flickering out from under the cursor. */}
      <Suspense fallback={<WorkspaceSkeleton />}>{content}</Suspense>
    </div>
  );
}
