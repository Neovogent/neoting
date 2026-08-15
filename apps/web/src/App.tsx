/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { useEffect, useState } from 'react';
import { Sidebar } from './components/Sidebar';
import { BusinessPortalLauncher } from './components/BusinessPortalLauncher';
import { BusinessPortal } from './views/business/BusinessPortal';
import { ClientApprovalView } from './views/business/ClientApprovalView';
import { UserRegistrationView } from './views/business/UserRegistrationView';
import { AIWorkspaceView } from './views/AIWorkspaceView';
import { ClientsView } from './views/ClientsView';
import { ClientDetailView } from './views/ClientDetailView';
import { InboxesView } from './views/InboxesView';
import { ApprovalsView } from './views/ApprovalsView';
import { DocumentsView } from './views/DocumentsView';
import { AnalyticsView } from './views/AnalyticsView';
import { TeamView } from './views/TeamView';
import { SettingsView } from './views/SettingsView';
import { ChasesView } from './views/ChasesView';
import { GenericView } from './views/GenericView';
import { useAppContext } from './context/AppContext';
import { motion, AnimatePresence } from 'motion/react';

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
      <div className="flex h-screen w-screen overflow-hidden bg-[#0a0a0c] text-white font-sans selection:bg-[#14e3c4]/30">
        {portal === 'approval' ? <ClientApprovalView />
          : portal === 'registration' ? <UserRegistrationView />
          : <BusinessPortal />}
      </div>
    );
  }

  return (
    <div className="flex h-screen w-screen overflow-hidden bg-[#0a0a0c] text-white font-sans selection:bg-[#14e3c4]/30">
      <AnimatePresence>
        {launcherOpen && <BusinessPortalLauncher onClose={() => setLauncherOpen(false)} />}
      </AnimatePresence>
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
      {content}
    </div>
  );
}
