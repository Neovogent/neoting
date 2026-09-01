import { useMemo, useState } from 'react';
import { Search, UploadCloud } from 'lucide-react';
import { defineMessages, useIntl } from 'react-intl';
import { Modal } from './DynamicComponents/Modal';
import { commonActions } from '../i18n/common';

/**
 * The chat upload's client question, asked instead of refused. Files dropped
 * with "All clients" active (or several attached) used to meet a dead-end
 * dialog whose only instruction was to close it, find the composer's client
 * selector, and drop the files again. The files are already in hand — so this
 * asks the one thing actually missing, and the upload continues with an
 * explicit human answer. The never-guess rule is intact: nothing proceeds
 * until a client is chosen by name.
 *
 * Lazily imported from `ChatUpload.tsx` (default export for `lazy()`): the
 * chat upload flow is floor-resident and the worst route's headroom is ~3 kB,
 * so this dialog — Modal frame and all — must land on its own chunk, fetched
 * on the first drop that needs it.
 */

const m = defineMessages({
  title: { id: 'shell.chatClientPicker.title', defaultMessage: 'Choose a client for this upload' },
  detail: {
    id: 'shell.chatClientPicker.detail',
    defaultMessage:
      'Every document is filed under a named client. Pick who {count, plural, one {this file} other {these # files}} belong to — nothing uploads until you do.',
  },
  searchPlaceholder: { id: 'shell.chatClientPicker.searchPlaceholder', defaultMessage: 'Search clients…' },
  searchLabel: { id: 'shell.chatClientPicker.searchLabel', defaultMessage: 'Search clients' },
  noMatch: {
    id: 'shell.chatClientPicker.noMatch',
    defaultMessage: 'No client matches “{query}”.',
  },
});

export default function ChatClientPicker({
  clients,
  fileCount,
  onPick,
  onCancel,
}: {
  clients: ReadonlyArray<{ id: string; name: string }>;
  fileCount: number;
  onPick: (clientId: string) => void;
  onCancel: () => void;
}) {
  const intl = useIntl();
  const [query, setQuery] = useState('');
  const q = query.trim().toLowerCase();
  const matches = useMemo(() => (q ? clients.filter((c) => c.name.toLowerCase().includes(q)) : clients), [clients, q]);

  return (
    <Modal onClose={onCancel} width="max-w-md" label={intl.formatMessage(m.title)}>
      <div className="w-full bg-card border border-white/10 rounded-[28px] p-6 shadow-2xl">
        <div className="flex items-center gap-3 mb-2">
          <UploadCloud size={20} className="text-brand shrink-0" />
          <h3 className="text-base font-bold text-white">{intl.formatMessage(m.title)}</h3>
        </div>
        <p className="text-[13px] text-zinc-500 leading-relaxed mb-4">
          {intl.formatMessage(m.detail, { count: fileCount })}
        </p>

        <div className="relative mb-3">
          <Search size={15} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-zinc-500" />
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={intl.formatMessage(m.searchPlaceholder)}
            aria-label={intl.formatMessage(m.searchLabel)}
            // Focus follows the explicit drop gesture into the dialog it
            // opened — the established dialog pattern here, not focus theft.
            // eslint-disable-next-line jsx-a11y/no-autofocus
            autoFocus
            className="w-full bg-ground border border-white/10 rounded-full py-2.5 pl-9 pr-4 text-sm focus:outline-none focus:ring-1 focus:ring-brand focus:border-brand transition-all placeholder:text-zinc-600 text-white"
          />
        </div>

        <div className="max-h-[40dvh] overflow-y-auto flex flex-col gap-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          {matches.map((c) => (
            <button
              key={c.id}
              onClick={() => onPick(c.id)}
              className="w-full px-3 py-2.5 rounded-xl flex items-center gap-3 text-sm text-left hover:bg-white/5 transition-colors"
            >
              <span className="w-2 h-2 rounded-full shrink-0 bg-zinc-700" />
              <span className="truncate text-zinc-300">{c.name}</span>
            </button>
          ))}
          {matches.length === 0 && (
            <p className="px-3 py-2.5 text-[13px] text-zinc-500 leading-relaxed">
              {intl.formatMessage(m.noMatch, { query: query.trim() })}
            </p>
          )}
        </div>

        <div className="mt-4 flex justify-end">
          <button
            onClick={onCancel}
            className="px-4 py-2 rounded-full text-sm font-medium text-zinc-400 hover:text-white hover:bg-white/5 transition-colors"
          >
            {intl.formatMessage(commonActions.cancel)}
          </button>
        </div>
      </div>
    </Modal>
  );
}
