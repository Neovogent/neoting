import { Construction } from 'lucide-react';

export function GenericView({ title }: { title: string }) {
  return (
    <div className="flex-1 flex flex-col items-center justify-center bg-[#0a0a0c] text-center p-10">
      <div className="w-24 h-24 bg-[#16161a] border border-white/5 rounded-[32px] flex items-center justify-center text-zinc-600 mb-8 shadow-2xl">
         <Construction size={48} />
      </div>
      <h2 className="font-sans text-3xl font-bold text-white mb-4 tracking-tight">{title}</h2>
      <p className="text-zinc-400 max-w-lg leading-relaxed font-medium">
        This section is part of the Document Workflow scope but hasn't been fully mocked up in this prototype iteration. Use the <strong className="text-[#14e3c4]">AI Workspace</strong>, <strong className="text-[#14e3c4]">Clients</strong>, <strong className="text-[#14e3c4]">Inboxes</strong>, or <strong className="text-[#14e3c4]">Chases</strong> tabs to explore active features.
      </p>
    </div>
  );
}
