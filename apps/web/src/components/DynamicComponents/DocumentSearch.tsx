import { useEffect, useState } from 'react';
import { Search } from 'lucide-react';
import { defineMessages, useIntl } from 'react-intl';

import { previewVaultItem, searchEverything, snippetParts, type SearchResult } from '../../api/practiceVault';

/**
 * Full-text search across documents and practice-vault items (`GET /v1/search`).
 * Live only — the server's tsvector index is the whole engine, so there is
 * nothing to search in synthetic mode. Matches arrive marked « » and are
 * rendered as <mark> text, never as HTML.
 */

const m = defineMessages({
  label: { id: 'documents.documentSearch.label', defaultMessage: 'Search documents and the vault' },
  placeholder: {
    id: 'documents.documentSearch.placeholder',
    defaultMessage: 'Search suppliers, references, descriptions, vault summaries…',
  },
  searching: { id: 'documents.documentSearch.searching', defaultMessage: 'Searching…' },
  none: { id: 'documents.documentSearch.none', defaultMessage: 'Nothing matches “{query}”.' },
  count: {
    id: 'documents.documentSearch.count',
    defaultMessage: '{count, plural, one {# match} other {# matches}}',
  },
  kindDocument: { id: 'documents.documentSearch.kindDocument', defaultMessage: 'Document' },
  kindVault: { id: 'documents.documentSearch.kindVault', defaultMessage: 'Vault' },
});

const MIN_CHARS = 2;
const DEBOUNCE_MS = 300;

export function DocumentSearch({ onOpenDocument }: { onOpenDocument: (id: string) => void }) {
  const intl = useIntl();
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchResult[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const q = query.trim();
    if (q.length < MIN_CHARS) {
      setResults(null);
      setError(null);
      return;
    }
    let cancelled = false;
    const timer = setTimeout(() => {
      setBusy(true);
      searchEverything(q)
        .then((rows) => {
          if (!cancelled) {
            setResults(rows);
            setError(null);
          }
        })
        .catch((cause: unknown) => {
          if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause));
        })
        .finally(() => {
          if (!cancelled) setBusy(false);
        });
    }, DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [query]);

  const open = (row: SearchResult) => {
    if (row.kind === 'document') onOpenDocument(row.id);
    else void previewVaultItem(row.id).catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)));
  };

  return (
    <div className="mb-4">
      <div className="flex items-center gap-2 rounded-2xl border border-white/10 bg-raised px-4 py-2.5">
        <Search aria-hidden size={15} className="shrink-0 text-zinc-500" />
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={intl.formatMessage(m.placeholder)}
          aria-label={intl.formatMessage(m.label)}
          className="w-full bg-transparent text-[13px] text-white placeholder:text-zinc-500 outline-none"
        />
        {busy && <span className="shrink-0 text-[12px] text-zinc-500">{intl.formatMessage(m.searching)}</span>}
      </div>

      {error !== null && (
        <p role="alert" className="mt-2 text-[12px] font-semibold text-red-300">{error}</p>
      )}

      {results !== null && error === null && (
        <div aria-live="polite" className="mt-2 rounded-2xl border border-white/10 bg-card">
          {results.length === 0 ? (
            <p className="px-4 py-3 text-[13px] text-zinc-400">{intl.formatMessage(m.none, { query: query.trim() })}</p>
          ) : (
            <>
              <p className="px-4 pt-3 text-[11px] font-bold uppercase tracking-wide text-zinc-500">
                {intl.formatMessage(m.count, { count: results.length })}
              </p>
              <ul className="max-h-80 overflow-y-auto divide-y divide-white/5">
                {results.map((row) => (
                  <li key={`${row.kind}:${row.id}`}>
                    <button
                      type="button"
                      onClick={() => open(row)}
                      className="w-full text-left px-4 py-2.5 hover:bg-raised flex flex-col gap-0.5"
                    >
                      <span className="flex items-center gap-2 min-w-0">
                        <span
                          className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-bold ${
                            row.kind === 'document' ? 'bg-brand/15 text-brand' : 'bg-amber-500/15 text-amber-300'
                          }`}
                        >
                          {intl.formatMessage(row.kind === 'document' ? m.kindDocument : m.kindVault)}
                        </span>
                        <span className="truncate text-[13px] font-semibold text-white">{row.title}</span>
                        <span className="shrink-0 text-[12px] text-zinc-500">{row.businessName}</span>
                        {row.date !== null && (
                          <span className="ml-auto shrink-0 text-[12px] text-zinc-500">
                            {intl.formatDate(row.date, { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Europe/London' })}
                          </span>
                        )}
                      </span>
                      {row.snippet !== '' && (
                        <span className="text-[12px] text-zinc-400 line-clamp-2">
                          {snippetParts(row.snippet).map((part, i) =>
                            part.hit ? (
                              <mark key={i} className="bg-brand/25 text-white rounded px-0.5">{part.text}</mark>
                            ) : (
                              <span key={i}>{part.text}</span>
                            ),
                          )}
                        </span>
                      )}
                    </button>
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      )}
    </div>
  );
}

export default DocumentSearch;
