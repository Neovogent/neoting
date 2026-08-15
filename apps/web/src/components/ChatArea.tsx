import { ReactNode, useEffect, useRef } from 'react';
import { Mic, Paperclip } from 'lucide-react';
import { IntentRenderer } from './DynamicComponents/IntentRenderer';
import { useAppContext } from '../context/AppContext';
import { motion } from 'motion/react';
import logo from '../assets/logo.png';

export function ChatArea() {
  const { messages } = useAppContext();
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  return (
    <div className={`flex-1 overflow-y-auto px-6 py-8 flex flex-col gap-8 max-w-4xl w-full mx-auto [scrollbar-width:none] [-ms-overflow-style:none] [&::-webkit-scrollbar]:hidden`}>
      
      {messages.map((msg) => (
        <Message key={msg.id} role={msg.role}>
          <p className={`text-[15px] leading-relaxed mb-4 ${msg.role === 'user' ? 'text-white' : 'text-zinc-300'}`}>
            {msg.content}
          </p>

          {msg.viaVoice && (
            <div className="flex items-center gap-1.5 text-[11px] font-bold text-zinc-500 uppercase tracking-wider mb-3">
              <Mic size={11} /> Dictated, confirmed before sending
            </div>
          )}

          {msg.attachments && msg.attachments.length > 0 && (
            <div className="flex flex-wrap gap-2 mb-3">
              {msg.attachments.map((f) => (
                <span
                  key={f.name}
                  className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-white/5 border border-white/10 text-[12px] font-semibold text-zinc-300"
                >
                  <Paperclip size={12} />
                  {f.name}
                  <span className="text-zinc-500">{(f.size / 1024).toFixed(0)}KB</span>
                </span>
              ))}
            </div>
          )}

          {msg.role === 'assistant' && <IntentRenderer message={msg} />}
        </Message>
      ))}

      <div ref={bottomRef} className="h-4 shrink-0" /> {/* Bottom padding */}
    </div>
  );
}

function Message({ role, children }: { role: 'user' | 'assistant', children: ReactNode }) {
  const isUser = role === 'user';
  
  return (
    <motion.div 
      initial={{ 
        opacity: 0, 
        y: 20, 
        x: isUser ? 20 : -20,
        scale: 0.95,
        filter: 'blur(5px)'
      }}
      animate={{ 
        opacity: 1, 
        y: 0, 
        x: 0,
        scale: 1,
        filter: 'blur(0px)'
      }}
      transition={{ 
        type: 'spring', 
        stiffness: 350, 
        damping: 25, 
        delay: isUser ? 0 : 0.1, // Add a tiny delay for the AI response to feel like it's "thinking"
        mass: 0.8
      }}
      className={`flex w-full ${isUser ? 'justify-end' : 'justify-start'}`}
    >
      <div className={`flex gap-4 w-full max-w-[90%] ${isUser ? 'flex-row-reverse' : 'flex-row'}`}>
        <motion.div 
          initial={{ scale: 0, rotate: isUser ? 45 : -45 }}
          animate={{ scale: 1, rotate: 0 }}
          transition={{ type: 'spring', stiffness: 300, damping: 20, delay: isUser ? 0.1 : 0.2 }}
          className={`w-10 h-10 rounded-2xl flex items-center justify-center shrink-0 mt-1 shadow-lg overflow-hidden ${
          isUser ? 'bg-white/10 text-white border border-white/10 backdrop-blur-md' : ''
        }`}>
          {isUser ? 'U' : <img src={logo} alt="" className="w-full h-full object-cover" />}
        </motion.div>
        <div className={`flex flex-col w-full ${isUser ? 'items-end' : 'items-start'}`}>
          {isUser ? (
            <div className="px-6 py-4 bg-white/10 backdrop-blur-xl text-white border border-white/10 rounded-[24px] rounded-tr-sm inline-block shadow-2xl">
              {children}
            </div>
          ) : (
            <motion.div 
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.3, duration: 0.4 }}
              className="py-2 w-full max-w-full text-zinc-300"
            >
              {children}
            </motion.div>
          )}
        </div>
      </div>
    </motion.div>
  );
}
