import { LeftPanel } from '../components/LeftPanel';
import { Workspace } from '../components/Workspace';
import { useAppContext } from '../context/AppContext';
import { motion, AnimatePresence } from 'motion/react';

export function AIWorkspaceView() {
  const { isHistoryVisible, messages } = useAppContext();
  const isEmpty = messages.length === 0;
  
  return (
    <div className="flex flex-1 overflow-hidden w-full bg-[#0a0a0c]" style={{ perspective: '1200px' }}>
      <AnimatePresence initial={false}>
        {(isHistoryVisible && isEmpty) && (
          <motion.div
            initial={{ width: 0, opacity: 0, x: -50, rotateY: 15, filter: 'blur(4px)' }}
            animate={{ width: 288, opacity: 1, x: 0, rotateY: 0, filter: 'blur(0px)' }}
            exit={{ width: 0, opacity: 0, x: -50, rotateY: 15, filter: 'blur(4px)' }}
            transition={{ type: 'spring', stiffness: 300, damping: 28, mass: 1 }}
            className="shrink-0 h-full overflow-hidden origin-left border-r border-white/5 bg-[#0a0a0c]"
          >
            <div className="w-72 h-full absolute inset-y-0 left-0">
              <LeftPanel />
            </div>
          </motion.div>
        )}
      </AnimatePresence>
      <Workspace />
    </div>
  );
}
