/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { Suspense, lazy, useEffect, useState } from 'react';
import { defineMessages, useIntl } from 'react-intl';
import { Sidebar } from './components/Sidebar';
import { BottomNav } from './components/BottomNav';
import { useViewport, useVisualViewport } from './lib/useViewport';
import { useAppContext } from './context/AppContext';
import { motion, AnimatePresence } from 'motion/react';

/**
 * The shell renders almost no copy of its own — the tab names come from the
 * sidebar and every screen owns its own words. What is left is what the two
 * skeletons announce to a screen reader, which is copy even though nothing
 * draws it: `aria-label` is read aloud, so it goes through the catalogue like
 * anything else a user receives.
 *
 * One message for both skeletons rather than two: they say the same word for
 * the same reason, and splitting them would hand a translator the same string
 * twice with no way to see they must agree.
 */
const m = defineMessages({
  loading: { id: 'shell.app.loading', defaultMessage: 'Loading' },
});

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
const ChasePortalView = lazy(() => import('./views/business/ChasePortalView').then((m) => ({ default: m.ChasePortalView })));
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

// The front door (METH Stage 6). Lazy for the same budget reason as every
// route — and doubly so here, because in synthetic mode it never renders at
// all and must never have been paid for.
const LoginView = lazy(() => import('./views/LoginView').then((m) => ({ default: m.LoginView })));

// The §13.3 context header. Lazy for the budget (the floor sat 0.6 kB over
// SoT §14's 250 kB on the worst route with it inlined), and mounted only when
// a session state exists — synthetic mode never downloads it. `fallback` is
// null rather than a skeleton: an 11 px strip popping in beats a placeholder
// strip pretending to be one.
const ContextHeader = lazy(() => import('./components/ContextHeader').then((m) => ({ default: m.ContextHeader })));

/**
 * What a practice screen looks like while its chunk is in flight.
 *
 * A skeleton, not a spinner: Guideline §7.4.5 puts spinners off primary
 * surfaces. It borrows the real geometry of a workspace view — the same
 * `px-10` header and the same card rhythm underneath — so the screen settles
 * into place rather than replacing one thing with a different thing.
 */
function WorkspaceSkeleton() {
  const intl = useIntl();
  return (
    <div
      className="flex-1 flex flex-col min-w-0 bg-ground h-full overflow-hidden"
      role="status"
      aria-busy="true"
      aria-label={intl.formatMessage(m.loading)}
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
  const { messages, activeTab, setActiveTab, openClientId, openClient, portal, session, settings } = useAppContext();
  const [launcherOpen, setLauncherOpen] = useState(false);
  // The one place the layout mode is read in JS rather than in CSS: on a phone
  // the rail is not a narrower rail, it is a different component. Everything
  // that only changes size stays a Tailwind breakpoint.
  const { phone } = useViewport();
  // Mounted once, here: it keeps `--vvh` honest when the iOS keyboard opens,
  // which is what every `h-vv` in the app is sized against.
  useVisualViewport();

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
  // never see another client's data sitting behind it. The two SMS link
  // surfaces are stricter still: no account, no portal. 'approval' is one
  // client's batch; 'chase-upload' is one chase's outstanding items.
  if (portal !== 'accountant') {
    return (
      <div className="flex flex-col md:flex-row h-dvh w-full overflow-hidden bg-ground text-white font-sans selection:bg-brand/30">
        <Suspense fallback={<PortalSkeleton />}>
          {portal === 'approval' ? <ClientApprovalView />
            : portal === 'chase-upload' ? <ChasePortalView />
            : portal === 'registration' ? <UserRegistrationView />
            : <BusinessPortal />}
        </Suspense>
      </div>
    );
  }

  // The login wall (METH Stage 6), and only here — the client-facing shells
  // above have their own credentials (an SMS link is not a login). In
  // synthetic mode the session is 'off' and none of this exists; 'degraded'
  // (API enabled but unreachable) falls THROUGH to the workspace — empty,
  // never on seed data presented as real (launch M2) — because a login
  // screen against a dead API is a wall nobody can pass. The context header
  // wears the failure badge instead.
  if (session.status === 'loading') {
    return (
      <div className="flex flex-col md:flex-row h-dvh w-full overflow-hidden bg-ground text-white font-sans selection:bg-brand/30">
        <WorkspaceSkeleton />
      </div>
    );
  }

  if (session.status === 'unauthenticated') {
    return (
      <div className="flex flex-col md:flex-row h-dvh w-full overflow-hidden bg-ground text-white font-sans selection:bg-brand/30">
        <Suspense fallback={<PortalSkeleton />}>
          <LoginView />
        </Suspense>
      </div>
    );
  }

  return (
    <div className="flex flex-col md:flex-row h-dvh w-full overflow-hidden bg-ground text-white font-sans selection:bg-brand/30">
      {/* Suspense sits outside AnimatePresence on purpose: AnimatePresence has
          to keep the motion element as its own direct child or it cannot hold
          the launcher on screen long enough to run its exit animation. */}
      <Suspense fallback={null}>
        <AnimatePresence>
          {launcherOpen && <BusinessPortalLauncher onClose={() => setLauncherOpen(false)} />}
        </AnimatePresence>
      </Suspense>
      {/* On a phone the rail becomes the bottom tab bar below: the shell
          stacks vertically and the content keeps its own scroll area above
          the bar, so nothing ever hides behind it. */}
      <AnimatePresence initial={false}>
        {!isChatFocusMode && !phone && (
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
          screen without the sidebar flickering out from under the cursor. The
          context header sits above it and outside it — orientation (SoT
          §13.3) must not blink out while a route chunk loads. */}
      <div className="flex-1 flex flex-col min-w-0 min-h-0 overflow-hidden">
        {session.status !== 'off' && (
          <Suspense fallback={null}>
            <ContextHeader />
          </Suspense>
        )}
        <Suspense fallback={<WorkspaceSkeleton />}>{content}</Suspense>
      </div>
      {phone && !isChatFocusMode && (
        <BottomNav activeTab={activeTab} setActiveTab={goToTab} onOpenBusinessPortal={() => setLauncherOpen(true)} />
      )}
    </div>
  );
}
