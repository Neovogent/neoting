import { LeftPanel } from '../components/LeftPanel';
import { Workspace } from '../components/Workspace';
import { useAppContext } from '../context/AppContext';
import { useConversationSync } from '../api/chatConversations';
import { useViewport } from '../lib/useViewport';
import { motion, AnimatePresence } from 'motion/react';
import { defineMessages, useIntl } from 'react-intl';

const m = defineMessages({
  closeHistory: {
    id: 'workspace.historyDrawer.close',
    defaultMessage: 'Close history',
  },
});

export function AIWorkspaceView() {
  const intl = useIntl();
  const { isHistoryVisible, messages, toggleHistory } = useAppContext();
  // Server-persisted conversations (review item 9): hydrate the drawer, fetch
  // the open transcript, reconcile turns/pins/deletions back up. Mounted HERE
  // — a lazy chunk — so the generated conversations client stays off the
  // bundle floor; it no-ops entirely in synthetic mode.
  useConversationSync();
  const { desktop } = useViewport();
  const isEmpty = messages.length === 0;
  const showHistory = isHistoryVisible && isEmpty;

  return (
    <div className="flex flex-1 overflow-hidden w-full bg-ground relative" style={{ perspective: '1200px' }}>
      {/* On a wide screen the history sits beside the workspace and pushes it
          over. Under 1024px there is no room to give up, so the same panel
          slides over the top as a drawer and a tap on the scrim puts it away. */}
      <AnimatePresence initial={false}>
        {showHistory && desktop && (
          <motion.div
            key="history-column"
            initial={{ width: 0, opacity: 0, x: -50, rotateY: 15, filter: 'blur(4px)' }}
            animate={{ width: 288, opacity: 1, x: 0, rotateY: 0, filter: 'blur(0px)' }}
            exit={{ width: 0, opacity: 0, x: -50, rotateY: 15, filter: 'blur(4px)' }}
            transition={{ type: 'spring', stiffness: 300, damping: 28, mass: 1 }}
            className="shrink-0 h-full overflow-hidden origin-left border-r border-white/5 bg-ground"
          >
            <div className="w-72 h-full absolute inset-y-0 left-0">
              <LeftPanel />
            </div>
          </motion.div>
        )}
      </AnimatePresence>
      <AnimatePresence>
        {showHistory && !desktop && (
          <>
            <motion.button
              key="history-scrim"
              aria-label={intl.formatMessage(m.closeHistory)}
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={toggleHistory}
              className="absolute inset-0 z-30 bg-black/60 backdrop-blur-sm"
            />
            <motion.div
              key="history-drawer"
              initial={{ x: '-100%' }}
              animate={{ x: 0 }}
              exit={{ x: '-100%' }}
              transition={{ type: 'spring', stiffness: 340, damping: 34 }}
              className="absolute inset-y-0 left-0 z-40 w-[min(20rem,88vw)] shadow-2xl"
            >
              <LeftPanel />
            </motion.div>
          </>
        )}
      </AnimatePresence>
      <Workspace />
    </div>
  );
}
