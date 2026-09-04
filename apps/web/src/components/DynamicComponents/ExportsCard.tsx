import { ArrowRight, Download } from 'lucide-react';
import { defineMessages, useIntl } from 'react-intl';
import { useAppContext } from '../../context/AppContext';

const m = defineMessages({
  title: { id: 'shell.exportsCard.title', defaultMessage: 'Export' },
  body: {
    id: 'shell.exportsCard.body',
    defaultMessage:
      'Exports are downloads from the Export screen: pick the client and the period, and you get the VT Transaction+ import file together with links back to every source document. An export carries Published documents only — nothing leaves the product on its own.',
  },
  open: { id: 'shell.exportsCard.open', defaultMessage: 'Open the Export screen' },
});

/**
 * `SHOW_EXPORTS` (review item 9, 5 Sep 2026) — the export ask used to dead-end
 * in prose while the screen it described sat one tab away. This card is
 * NAVIGATION and nothing else: no export is created, listed or previewed here,
 * because `POST /v1/exports` releases client data and chat is
 * `x-nt-side-effect: none` (D42 — the sole egress stays behind its own screen).
 *
 * Every string keeps the D42 vocabulary: "export", never "send to VT",
 * "publish to", "sync" or "posted" — `ExportView.test.tsx` documents why that
 * is compliance, not style.
 */
export function ExportsCard() {
  const intl = useIntl();
  const { setActiveTab } = useAppContext();

  return (
    <div className="w-full rounded-2xl bg-card border border-white/10 p-4 flex flex-col gap-3">
      <span className="flex items-center gap-2 text-[13px] font-bold text-white">
        <Download size={14} className="text-brand shrink-0" />
        {intl.formatMessage(m.title)}
      </span>
      <p className="text-[12.5px] text-zinc-400 leading-relaxed">{intl.formatMessage(m.body)}</p>
      <button
        onClick={() => setActiveTab('Export')}
        className="self-start flex items-center gap-1.5 text-[12px] font-bold text-brand hover:text-brand-hover transition-colors"
      >
        {intl.formatMessage(m.open)}
        <ArrowRight size={13} />
      </button>
    </div>
  );
}
