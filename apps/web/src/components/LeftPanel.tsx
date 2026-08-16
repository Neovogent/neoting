import { useMemo, useState } from 'react';
import { Search, Pin, MessageSquare, Clock, Plus, Trash2, PinOff } from 'lucide-react';
import { motion, type Variants } from 'motion/react';
import { useAppContext } from '../context/AppContext';
import { relativeTime } from '../lib/resolver';

const containerVariants: Variants = {
  hidden: { opacity: 0 },
  visible: { opacity: 1, transition: { staggerChildren: 0.08, delayChildren: 0.2 } },
};

const itemVariants: Variants = {
  hidden: { opacity: 0, x: -20, filter: 'blur(5px)' },
  visible: { opacity: 1, x: 0, filter: 'blur(0px)', transition: { type: 'spring', stiffness: 350, damping: 25 } },
};

export function LeftPanel() {
  const {
    clients,
    conversations,
    activeConversationId,
    attachedClients,
    selectConversation,
    deleteConversation,
    togglePinConversation,
    newConversation,
    attachClient,
    statsFor,
  } = useAppContext();

  const [query, setQuery] = useState('');
  const q = query.trim().toLowerCase();

  const filteredClients = useMemo(
    () => (q ? clients.filter((c) => c.name.toLowerCase().includes(q)) : clients.slice(0, 3)),
    [clients, q],
  );

  const filteredConversations = useMemo(() => {
    // Empty drafts stay out of history until they have a first message.
    const started = conversations.filter((c) => c.messages.length > 0);
    const list = q
      ? started.filter(
          (c) => c.title.toLowerCase().includes(q) || c.messages.some((m) => m.content.toLowerCase().includes(q)),
        )
      : started;
    return [...list].sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.updatedAt - a.updatedAt);
  }, [conversations, q]);

  return (
    <aside className="w-full h-full flex flex-col border-r border-white/5 bg-ground">
      <div className="h-20 px-6 flex items-center justify-between gap-3 border-b border-white/5 shrink-0">
        <h2 className="font-sans text-xl font-semibold text-white tracking-tight">Workspace</h2>
        <button
          onClick={newConversation}
          title="New conversation"
          className="w-9 h-9 rounded-full bg-card border border-white/5 flex items-center justify-center text-zinc-400 hover:text-white hover:bg-raised transition-all shadow-lg"
        >
          <Plus size={17} />
        </button>
      </div>

      <motion.div
        initial={{ opacity: 0, y: -10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.1, duration: 0.4 }}
        className="p-5 shrink-0"
      >
        <div className="relative">
          <Search size={16} className="absolute left-4 top-1/2 -translate-y-1/2 text-zinc-500" />
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search clients or history..."
            className="w-full bg-card border border-white/5 rounded-full py-2.5 pl-10 pr-4 text-sm focus:outline-none focus:ring-1 focus:ring-brand focus:border-brand transition-all placeholder:text-zinc-600 text-white"
          />
        </div>
      </motion.div>

      <motion.div
        className="flex-1 overflow-y-auto px-3 pb-4 [scrollbar-width:none] [-ms-overflow-style:none] [&::-webkit-scrollbar]:hidden"
        variants={containerVariants}
        initial="hidden"
        animate="visible"
      >
        <div className="mb-8">
          <motion.div
            variants={itemVariants}
            className="px-3 mb-3 flex items-center gap-2 text-[11px] font-bold text-zinc-500 uppercase tracking-widest"
          >
            <Pin size={12} /> {q ? 'Matching clients' : 'Pinned Clients'}
          </motion.div>
          <div className="flex flex-col gap-1">
            {filteredClients.map((c) => (
              <motion.div key={c.id} variants={itemVariants}>
                <ClientItem
                  name={c.name}
                  missing={statsFor(c.id).missing}
                  active={attachedClients.some((a) => a.id === c.id)}
                  onClick={() => attachClient(c.id)}
                />
              </motion.div>
            ))}
            {filteredClients.length === 0 && <EmptyRow text="No clients match." />}
          </div>
        </div>

        <div>
          <motion.div
            variants={itemVariants}
            className="px-3 mb-3 flex items-center gap-2 text-[11px] font-bold text-zinc-500 uppercase tracking-widest"
          >
            <Clock size={12} /> Recent History
          </motion.div>
          <div className="flex flex-col gap-1">
            {filteredConversations.map((c) => (
              <motion.div key={c.id} variants={itemVariants}>
                <HistoryItem
                  title={c.title}
                  date={relativeTime(c.updatedAt)}
                  pinned={c.pinned}
                  active={c.id === activeConversationId}
                  onClick={() => selectConversation(c.id)}
                  onPin={() => togglePinConversation(c.id)}
                  onDelete={() => deleteConversation(c.id)}
                />
              </motion.div>
            ))}
            {filteredConversations.length === 0 && <EmptyRow text="No conversations match." />}
          </div>
        </div>
      </motion.div>
    </aside>
  );
}

function ClientItem({
  name,
  missing,
  active,
  onClick,
}: {
  name: string;
  missing: number;
  active?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={`w-full text-left px-4 py-2.5 rounded-xl text-sm transition-all flex items-center gap-3 ${
        active
          ? 'bg-card text-white font-medium border border-white/5'
          : 'text-zinc-400 hover:bg-card/50 border border-transparent'
      }`}
    >
      <div className={`w-2 h-2 rounded-full shadow-lg shrink-0 ${active ? 'bg-brand shadow-[0_0_10px_rgba(20,227,196,0.5)]' : 'bg-zinc-700'}`} />
      <span className="truncate flex-1">{name}</span>
      {missing > 0 && <span className="text-[11px] font-bold text-zinc-600 shrink-0">{missing}</span>}
    </button>
  );
}

function HistoryItem({
  title,
  date,
  pinned,
  active,
  onClick,
  onPin,
  onDelete,
}: {
  title: string;
  date: string;
  pinned: boolean;
  active: boolean;
  onClick: () => void;
  onPin: () => void;
  onDelete: () => void;
}) {
  return (
    <div
      onClick={onClick}
      className={`w-full text-left px-4 py-2.5 rounded-xl text-sm transition-all flex items-center justify-between group cursor-pointer border ${
        active ? 'bg-card text-white border-white/5' : 'text-zinc-400 hover:bg-card/50 hover:text-zinc-200 border-transparent'
      }`}
    >
      <div className="flex items-center gap-3 truncate">
        <MessageSquare
          size={14}
          className={`shrink-0 transition-colors ${active ? 'text-brand' : 'text-zinc-600 group-hover:text-brand'}`}
        />
        <span className="truncate">{title}</span>
      </div>
      <div className="flex items-center gap-1 shrink-0 ml-2">
        <span className="text-[11px] text-zinc-600 font-medium group-hover:hidden">{date}</span>
        <button
          onClick={(e) => {
            e.stopPropagation();
            onPin();
          }}
          title={pinned ? 'Unpin' : 'Pin'}
          className={`p-1 rounded-lg hover:bg-white/10 transition-colors ${pinned ? 'text-brand' : 'text-zinc-600 hidden group-hover:block'}`}
        >
          {pinned ? <Pin size={13} /> : <PinOff size={13} />}
        </button>
        <button
          onClick={(e) => {
            e.stopPropagation();
            onDelete();
          }}
          title="Delete"
          className="p-1 rounded-lg text-zinc-600 hover:text-red-400 hover:bg-white/10 transition-colors hidden group-hover:block"
        >
          <Trash2 size={13} />
        </button>
      </div>
    </div>
  );
}

function EmptyRow({ text }: { text: string }) {
  return <div className="px-4 py-3 text-[13px] text-zinc-600">{text}</div>;
}
