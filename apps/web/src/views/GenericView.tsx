import { Construction } from 'lucide-react';
import { defineMessages, useIntl } from 'react-intl';

/**
 * The body stays ONE message rather than five fragments around four `<strong>`
 * elements. Rich-text tags keep the sentence whole for a translator, who can
 * move the emphasised tab names to wherever the target language wants them —
 * splitting on the markup would hard-code English word order into the layout.
 */
const m = defineMessages({
  body: {
    id: 'shell.genericView.body',
    defaultMessage:
      "This section is part of the Document Workflow scope but hasn't been fully mocked up in this prototype iteration. Use the <tab>AI Workspace</tab>, <tab>Clients</tab>, <tab>Inboxes</tab>, or <tab>Chases</tab> tabs to explore active features.",
  },
});

export function GenericView({ title }: { title: string }) {
  const intl = useIntl();

  return (
    <div className="flex-1 flex flex-col items-center justify-center bg-ground text-center p-4 md:p-10">
      <div className="w-24 h-24 bg-card border border-white/5 rounded-[32px] flex items-center justify-center text-zinc-600 mb-8 shadow-2xl">
         <Construction size={48} />
      </div>
      <h2 className="font-sans text-3xl font-bold text-white mb-4 tracking-tight">{title}</h2>
      <p className="text-zinc-400 max-w-lg leading-relaxed font-medium">
        {intl.formatMessage(m.body, {
          tab: (chunks) => <strong className="text-brand">{chunks}</strong>,
        })}
      </p>
    </div>
  );
}
