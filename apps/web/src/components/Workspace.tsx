import { ContextBar } from './ContextBar';
import { ChatArea } from './ChatArea';
import { InputRow } from './InputRow';
import { useAppContext } from '../context/AppContext';
import { motion, AnimatePresence } from 'motion/react';
import { X } from 'lucide-react';
import { defineMessages, useIntl } from 'react-intl';

const m = defineMessages({
  closeChat: { id: 'shell.workspace.closeChat', defaultMessage: 'Close chat' },
  hero: { id: 'shell.workspace.hero', defaultMessage: 'Accounting, but make it magic.' },
});

export function Workspace() {
  const { messages, setMessages } = useAppContext();
  const intl = useIntl();
  const isEmpty = messages.length === 0;

  return (
    <main className="flex-1 flex flex-col min-w-0 bg-deep relative overflow-hidden">
      {/* Dark to Blue Gradient Background matching the image */}
      <div className="absolute inset-0 bg-gradient-to-b from-black via-ground to-mint-soft/40 pointer-events-none z-0" />
      {/* An 80px blur over a 150%-wide layer is the single most expensive thing
          on this screen; phones get the plain gradient above instead. */}
      <div className="hidden md:block absolute bottom-0 left-1/2 -translate-x-1/2 w-[150%] h-[60vh] bg-[radial-gradient(ellipse_at_bottom,_var(--tw-gradient-stops))] from-brand/80 via-teal-deep/30 to-transparent blur-[80px] pointer-events-none z-0" />
      
      {/* Decorative lines to mimic the image's techy aesthetic */}
      <div className="absolute inset-0 bg-[linear-gradient(to_bottom,#ffffff02_1px,transparent_1px),linear-gradient(to_right,#ffffff02_1px,transparent_1px)] bg-[size:100px_100px] pointer-events-none z-0 mask-image:linear-gradient(to_bottom,transparent,black)" style={{ WebkitMaskImage: 'linear-gradient(to bottom, transparent 20%, black 100%)' }} />
      
      <div className="relative z-10 flex flex-col h-full w-full">
        <AnimatePresence initial={false}>
          {isEmpty && (
            <motion.div
              key="context-bar"
              initial={{ height: 0, opacity: 0, y: -20 }}
              animate={{ height: 'auto', opacity: 1, y: 0 }}
              exit={{ height: 0, opacity: 0, y: -20, filter: 'blur(5px)' }}
              transition={{ type: "spring", stiffness: 300, damping: 30 }}
              className="shrink-0 overflow-hidden"
            >
              <ContextBar />
            </motion.div>
          )}
        </AnimatePresence>
        
        <AnimatePresence>
          {!isEmpty && (
            <motion.button
              key="close-btn"
              onClick={() => setMessages([])}
              initial={{ scale: 0, opacity: 0, rotate: -90 }}
              animate={{ scale: 1, opacity: 1, rotate: 0 }}
              exit={{ scale: 0, opacity: 0, rotate: 90 }}
              transition={{ type: "spring", stiffness: 400, damping: 25, delay: 0.1 }}
              className="absolute top-3 right-3 sm:top-6 sm:right-6 z-50 p-2.5 bg-white/5 hover:bg-white/10 text-zinc-400 hover:text-white rounded-full border border-white/10 backdrop-blur-md transition-colors shadow-lg"
              title={intl.formatMessage(m.closeChat)}
            >
              <X size={20} />
            </motion.button>
          )}
        </AnimatePresence>
        
        {isEmpty ? (
          <div className="flex-1 flex flex-col items-center justify-center p-4 sm:p-8 sm:mt-[-10vh] overflow-y-auto">
            <motion.div 
              initial={{ opacity: 0, y: 30, filter: 'blur(10px)' }}
              animate={{ opacity: 1, y: 0, filter: 'blur(0px)' }}
              transition={{ duration: 0.8, ease: [0.16, 1, 0.3, 1] }}
              className="flex flex-col items-center justify-center text-center pb-6 sm:pb-10 w-full"
            >
              {/* The strapline underneath is gone: the box now says what is
                  actually outstanding, which is more use than a joke about
                  shoeboxes to someone opening this at nine in the morning. */}
              <h1 className="text-[34px] leading-[1.05] sm:text-5xl md:text-[56px] font-medium text-white tracking-tight" style={{ letterSpacing: '-0.02em' }}>
                {intl.formatMessage(m.hero)}
              </h1>
            </motion.div>
            <motion.div 
              initial={{ opacity: 0, y: 40, scale: 0.95, filter: 'blur(10px)' }}
              animate={{ opacity: 1, y: 0, scale: 1, filter: 'blur(0px)' }}
              transition={{ duration: 0.8, delay: 0.2, ease: [0.16, 1, 0.3, 1] }}
              className="w-full max-w-4xl"
            >
              <InputRow />
            </motion.div>
          </div>
        ) : (
          <>
            <ChatArea />
            <InputRow />
          </>
        )}
      </div>
    </main>
  );
}
