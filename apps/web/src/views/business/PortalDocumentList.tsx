import { useEffect, useRef, useState } from 'react';
import { Download, FileText, X } from 'lucide-react';
import { defineMessages, useIntl, type MessageDescriptor } from 'react-intl';

import { fetchPortalDocumentOriginal, type PortalSentDocument, type PortalSentPage } from '../../api/onboarding';
import { currency } from '../../lib/resolver';
import { useEscape } from '../../lib/useEscape';
import { PortalStatusPill } from './PortalStatusPill';

/**
 * The client's own documents, browsable — **review item 18**.
 *
 * > *"From the client portal there is option to see how many document is sent
 * > but no option to see the actual list of sent document with preview option
 * > download option and with other document control functions"*
 *
 * `GET /portal/documents` has served this list since 2 Sep 2026 and two screens
 * read it: the Home tab showed eight rows and the Upload tab showed ten of one
 * channel, neither openable. The count said forty-one and a client could learn
 * nothing about any of them.
 *
 * ## One row component, two surfaces, and that is the point
 *
 * Home renders a short recent list and Upload renders the whole thing behind a
 * filter. They are the SAME rows off the same read — "one list at two levels of
 * detail", which is what the operation's own description calls them — so a row
 * is written once. Two row components would be two opinions about what a
 * document looks like to its sender, and they would diverge on the day one of
 * them learned a new status word.
 *
 * ## ⚠ What a client may NOT be shown, and it is structural
 *
 * `PortalDocument` carries no `state`, no `inbox`, no `categoryCode`, no
 * `failureCode` — deliberately, and the absence is the design. Where a document
 * sits in the practice's review queue is the firm's working state; what happened
 * to the receipt is the client's question, and `status` is the whole answer. So
 * this file has **no mapping table from anything to anything**: the five words
 * arrive decided (`PortalDocumentStatus`, mapped server-side so two browsers
 * cannot describe one document differently) and `PortalStatusPill` only supplies
 * the wording. Nothing here may start deriving one.
 *
 * `supplier` is **untrusted content** — read off a scanned page by a model. It
 * goes into a text node and nowhere else.
 *
 * ## The presigned URL
 *
 * [Open] and [Download] fetch `GET /documents/{id}/original` per press and never
 * cache it: it is bearer authority over a financial record with no session
 * behind it, and it expires in minutes. Every anchor and the preview frame carry
 * `rel="noreferrer noopener"` / `referrerPolicy="no-referrer"` for the reason
 * `DocumentViewer` states in full — a `Referer` would carry that URL wherever
 * the tab goes next.
 *
 * ## ⚠ Only an IMAGE is previewed in place, and that is a phone decision
 *
 * The obvious build is an `<iframe>` for the PDF too, and it was the first one.
 * It renders on desktop Chrome and is unreliable exactly where this surface
 * lives: iOS Safari shows the first page of a framed PDF and no way to reach the
 * rest, and several Android WebViews show nothing at all — a blank white box
 * where a client's invoice should be, with no error to explain it.
 *
 * So a photograph — which is most of what a client sends — opens here, and
 * anything else is handed over as a **real anchor** the browser opens with its
 * own viewer or its own share sheet. The anchor is also what makes it work at
 * all: the presigned URL is fetched on the press, so by the time it arrives the
 * user gesture has expired and a programmatic `window.open` would be blocked by
 * Safari. The dialog is the thing that turns an async fetch back into a link a
 * person clicks.
 *
 * The practice app's `DocumentViewer` (zoom, rotation, paging) is NOT reused —
 * this is the lightest route in the product and nothing it imports may become
 * shared with a practice screen.
 */

const m = defineMessages({
  filterAll: { id: 'portal.documentList.filterAll', defaultMessage: 'All' },
  // ⚠ The SAME five words `PortalStatusPill` uses, and they must stay the same
  // words: a filter chip that says something a pill does not is a sixth
  // vocabulary the server never agreed to.
  filterProcessing: { id: 'portal.documentList.filterProcessing', defaultMessage: 'Processing' },
  filterWithAccountant: { id: 'portal.documentList.filterWithAccountant', defaultMessage: 'With your accountant' },
  filterAccepted: { id: 'portal.documentList.filterAccepted', defaultMessage: 'Accepted' },
  filterFiled: { id: 'portal.documentList.filterFiled', defaultMessage: 'Filed' },
  filterNeedsCopy: { id: 'portal.documentList.filterNeedsCopy', defaultMessage: 'Needs another copy' },
  filterLabel: { id: 'portal.documentList.filterLabel', defaultMessage: 'Show' },

  unnamed: { id: 'portal.documentList.unnamed', defaultMessage: 'Not read yet' },
  detail: { id: 'portal.documentList.detail', defaultMessage: '{date} · {amount}' },
  detailNoAmount: { id: 'portal.documentList.detailNoAmount', defaultMessage: '{date}' },
  noDate: { id: 'portal.documentList.noDate', defaultMessage: 'Sent {date}' },
  via: { id: 'portal.documentList.via', defaultMessage: '{detail} · {channel}' },

  // How it reached the accountant, in the client's own words. ⚠ No SMS in this
  // release (D40/D47) — `SMS_PORTAL` is the portal, whatever the enum is called.
  channelPortal: { id: 'portal.documentList.channelPortal', defaultMessage: 'Sent from here' },
  channelEmail: { id: 'portal.documentList.channelEmail', defaultMessage: 'Emailed' },
  channelWhatsapp: { id: 'portal.documentList.channelWhatsapp', defaultMessage: 'WhatsApp' },
  channelChat: { id: 'portal.documentList.channelChat', defaultMessage: 'Added by your accountant' },
  channelWeb: { id: 'portal.documentList.channelWeb', defaultMessage: 'Added by your accountant' },

  open: { id: 'portal.documentList.open', defaultMessage: 'Open' },
  download: { id: 'portal.documentList.download', defaultMessage: 'Download' },
  opening: { id: 'portal.documentList.opening', defaultMessage: 'Opening…' },
  // ⚠ Never "you are not allowed to see it". The server answers one 404 for a
  // document that is not this client's AND for one their accountant has taken
  // back, and telling those apart is exactly what the uniform 404 prevents.
  openFailed: {
    id: 'portal.documentList.openFailed',
    defaultMessage: 'We could not open that copy. Your accountant still has the document.',
  },

  previewLabel: { id: 'portal.documentList.previewLabel', defaultMessage: 'Document preview' },
  close: { id: 'portal.documentList.close', defaultMessage: 'Close' },
  noPreview: {
    id: 'portal.documentList.noPreview',
    defaultMessage: 'This one opens in its own tab — your browser knows how to show it.',
  },
  openInTab: { id: 'portal.documentList.openInTab', defaultMessage: 'Open in a new tab' },

  showMore: { id: 'portal.documentList.showMore', defaultMessage: 'Show older documents' },
  showingCount: {
    id: 'portal.documentList.showingCount',
    defaultMessage: '{count, plural, one {# document} other {# documents}}',
  },
  // ⚠ Two different empties, and collapsing them would be a lie in the
  // direction that matters: "nothing with that status" over an empty account
  // reads as "we lost your documents", and the teaching empty state over an
  // active filter reads as "you have never sent anything". The HOST supplies the
  // first, because only it knows which screen the client is standing on.
  filteredEmpty: { id: 'portal.documentList.filteredEmpty', defaultMessage: 'Nothing with that status.' },
  loading: { id: 'portal.documentList.loading', defaultMessage: 'Loading what you have sent…' },
});

/** The contract's own enum, in the order a client reads it: newest concern first. */
const FILTERS: readonly { key: PortalSentDocument['status'] | 'all'; label: MessageDescriptor }[] = [
  { key: 'all', label: m.filterAll },
  { key: 'needs_another_copy', label: m.filterNeedsCopy },
  { key: 'processing', label: m.filterProcessing },
  { key: 'with_accountant', label: m.filterWithAccountant },
  { key: 'accepted', label: m.filterAccepted },
  { key: 'filed', label: m.filterFiled },
];

/**
 * `DocumentChannel` → what the client calls it.
 *
 * ⚠ Deliberately NOT total over the enum, and the fallback is silence rather
 * than the raw value: a channel this build has not been taught is an internal
 * word (`UNROUTED`, whatever comes next) and printing it on a client's screen
 * would be the practice's plumbing on the client's surface.
 */
const CHANNEL: Partial<Record<string, MessageDescriptor>> = {
  SMS_PORTAL: m.channelPortal,
  EMAIL: m.channelEmail,
  WHATSAPP: m.channelWhatsapp,
  CHAT_UPLOAD: m.channelChat,
  WEB_UPLOAD: m.channelWeb,
};

type OpenState =
  | { kind: 'idle' }
  | { kind: 'opening'; id: string }
  | { kind: 'open'; id: string; url: string; mimeType: string; filename: string | null }
  | { kind: 'failed'; id: string };

export function PortalDocumentList({
  documents,
  documentsFault,
  sessionToken,
  emptyMessage,
  browse = false,
  onShowMore,
  canShowMore = false,
}: {
  readonly documents: PortalSentPage | null;
  readonly documentsFault: string | null;
  /** React state only — never `localStorage`, never a cookie. It dies with the tab. */
  readonly sessionToken: string | null;
  /** What "you have sent nothing at all" says on THIS screen — see `filteredEmpty`. */
  readonly emptyMessage: string;
  /** Browse mode adds the status filter, the count and [Show older]; Home does not want them. */
  readonly browse?: boolean;
  readonly onShowMore?: () => void;
  readonly canShowMore?: boolean;
}) {
  const intl = useIntl();
  const [filter, setFilter] = useState<PortalSentDocument['status'] | 'all'>('all');
  const [opened, setOpened] = useState<OpenState>({ kind: 'idle' });

  const rows = documents?.rows ?? [];
  const shown = browse && filter !== 'all' ? rows.filter((d) => d.status === filter) : rows.slice(0, browse ? rows.length : 8);

  const open = async (doc: PortalSentDocument, into: 'preview' | 'download') => {
    if (sessionToken === null) return;
    setOpened({ kind: 'opening', id: doc.id });
    try {
      const file = await fetchPortalDocumentOriginal(sessionToken, doc.id);
      if (into === 'preview') {
        setOpened({ kind: 'open', id: doc.id, ...file });
        return;
      }
      // The house download shape (`DocumentViewer`, `ExportView`): a real anchor
      // with `noreferrer`, clicked. The presigned response is `inline` with the
      // stored MIME pinned, so this opens the file rather than forcing a save —
      // which is what "download" means on a phone, where there is no folder to
      // save into and the share sheet is the destination.
      const anchor = window.document.createElement('a');
      anchor.href = file.url;
      if (file.filename !== null) anchor.download = file.filename;
      anchor.target = '_blank';
      anchor.rel = 'noreferrer noopener';
      anchor.click();
      setOpened({ kind: 'idle' });
    } catch {
      setOpened({ kind: 'failed', id: doc.id });
    }
  };

  if (documentsFault !== null) {
    return (
      <p role="alert" className="text-[13px] text-red-400 leading-relaxed py-2">
        {documentsFault}
      </p>
    );
  }

  if (documents === null) {
    return (
      <div className="flex flex-col gap-2" role="status" aria-busy="true">
        <span className="sr-only">{intl.formatMessage(m.loading)}</span>
        <div className="h-14 rounded-2xl bg-white/[0.04] animate-pulse" />
        <div className="h-14 rounded-2xl bg-white/[0.04] animate-pulse" />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      {browse && rows.length > 0 && (
        <div className="flex items-center gap-2 flex-wrap">
          <span className="sr-only" id="portal-doc-filter">
            {intl.formatMessage(m.filterLabel)}
          </span>
          <div role="group" aria-labelledby="portal-doc-filter" className="flex items-center gap-1.5 flex-wrap">
            {FILTERS.map((option) => (
              <button
                key={option.key}
                type="button"
                aria-pressed={filter === option.key}
                onClick={() => setFilter(option.key)}
                className={`px-3 py-1.5 rounded-full text-[12px] font-bold transition-colors ${
                  filter === option.key
                    ? 'bg-brand text-brand-on'
                    : 'text-zinc-400 border border-white/10 hover:text-white hover:border-white/25'
                }`}
              >
                {intl.formatMessage(option.label)}
              </button>
            ))}
          </div>
        </div>
      )}

      {shown.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-10 text-center">
          <FileText size={24} className="text-zinc-700" />
          <p className="text-[13px] text-zinc-500 mt-3 font-medium">
            {rows.length === 0 ? emptyMessage : intl.formatMessage(m.filteredEmpty)}
          </p>
        </div>
      ) : (
        <ul className="flex flex-col gap-2">
          {shown.map((doc) => (
            <Row
              key={doc.id}
              doc={doc}
              opening={opened.kind === 'opening' && opened.id === doc.id}
              failed={opened.kind === 'failed' && opened.id === doc.id}
              canOpen={sessionToken !== null}
              onPreview={() => void open(doc, 'preview')}
              onDownload={() => void open(doc, 'download')}
            />
          ))}
        </ul>
      )}

      {browse && shown.length > 0 && (
        <div className="flex items-center justify-between gap-3 flex-wrap pt-1">
          <span className="text-[12px] text-zinc-600 font-semibold">
            {intl.formatMessage(m.showingCount, { count: shown.length })}
          </span>
          {canShowMore && onShowMore !== undefined && (
            <button
              type="button"
              onClick={onShowMore}
              className="px-4 py-2 rounded-full text-[12px] font-bold text-zinc-300 border border-white/10 hover:text-white hover:border-white/25 transition-colors"
            >
              {intl.formatMessage(m.showMore)}
            </button>
          )}
        </div>
      )}

      {opened.kind === 'open' && (
        <PreviewOverlay
          url={opened.url}
          mimeType={opened.mimeType}
          filename={opened.filename}
          onClose={() => setOpened({ kind: 'idle' })}
        />
      )}
    </div>
  );
}

function Row({
  doc,
  opening,
  failed,
  canOpen,
  onPreview,
  onDownload,
}: {
  doc: PortalSentDocument;
  opening: boolean;
  failed: boolean;
  canOpen: boolean;
  onPreview: () => void;
  onDownload: () => void;
}) {
  const intl = useIntl();
  const channel = CHANNEL[doc.channel];

  const detail =
    doc.date === null
      ? intl.formatMessage(m.noDate, {
          date: intl.formatDate(doc.receivedAt, { day: 'numeric', month: 'short', timeZone: 'Europe/London' }),
        })
      : doc.total === null
        ? intl.formatMessage(m.detailNoAmount, { date: doc.date })
        : intl.formatMessage(m.detail, { date: doc.date, amount: currency(Math.abs(doc.total)) });

  return (
    <li className="flex items-center justify-between gap-3 p-4 rounded-2xl bg-ground/60 border border-white/5 flex-wrap">
      <div className="min-w-0 flex-1">
        {/* Untrusted content: extracted off a scanned page by a model, rendered
            as text and nothing else. */}
        <div className="text-sm font-bold text-white truncate">
          {doc.supplier ?? intl.formatMessage(m.unnamed)}
        </div>
        <div className="text-[12px] text-zinc-500 mt-0.5 truncate">
          {channel === undefined
            ? detail
            : intl.formatMessage(m.via, { detail, channel: intl.formatMessage(channel) })}
        </div>
        {failed && (
          <p role="alert" className="text-[12px] text-amber-400 mt-1">
            {intl.formatMessage(m.openFailed)}
          </p>
        )}
      </div>
      <div className="flex items-center gap-2 shrink-0">
        <PortalStatusPill status={doc.status} />
        {canOpen && (
          <>
            <button
              type="button"
              onClick={onPreview}
              disabled={opening}
              className="px-3 py-1.5 rounded-full text-[12px] font-bold text-zinc-300 border border-white/10 hover:text-white hover:border-white/25 disabled:opacity-40 transition-colors"
            >
              {opening ? intl.formatMessage(m.opening) : intl.formatMessage(m.open)}
            </button>
            <button
              type="button"
              onClick={onDownload}
              disabled={opening}
              aria-label={intl.formatMessage(m.download)}
              title={intl.formatMessage(m.download)}
              className="p-2 rounded-full text-zinc-400 border border-white/10 hover:text-white hover:border-white/25 disabled:opacity-40 transition-colors"
            >
              <Download size={14} />
            </button>
          </>
        )}
      </div>
    </li>
  );
}

/**
 * The preview itself.
 *
 * Escape closes it through `lib/useEscape`'s stack rather than a listener of its
 * own — dialogs nest in this app and a bare `keydown` closes the wrong one. The
 * backdrop is `role="presentation"`: it is a click target, not a control, and
 * the keyboard dismissal is Escape.
 */
function PreviewOverlay({
  url,
  mimeType,
  filename,
  onClose,
}: {
  url: string;
  mimeType: string;
  filename: string | null;
  onClose: () => void;
}) {
  const intl = useIntl();
  const closeRef = useRef<HTMLButtonElement>(null);
  useEscape(onClose);

  // Focus follows the client's own press, into the one control that gets them
  // back out — the phone case, where the frame fills the screen.
  useEffect(() => closeRef.current?.focus(), []);

  const isImage = mimeType.startsWith('image/');

  return (
    <div className="fixed inset-0 z-50 bg-black/80 flex items-center justify-center p-4 pt-safe pb-safe">
      {/* The scrim's dismiss-on-click, as a real BUTTON rather than a handler on
          a div — a click target with no keyboard path is what `jsx-a11y` refuses,
          and rightly. It is out of the accessible tree because the keyboard
          dismissals are Escape and the [Close] control in the header; a second
          "Close" announced behind the dialog would be noise.

          ⚠ Not the practice app's `Modal`, which does all of this already: the
          portal is the lightest route in the product and nothing it imports may
          become shared with a practice screen. */}
      <button
        type="button"
        tabIndex={-1}
        aria-hidden="true"
        onClick={onClose}
        className="absolute inset-0 w-full h-full cursor-default"
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={intl.formatMessage(m.previewLabel)}
        className="relative w-full max-w-3xl max-h-full flex flex-col rounded-[28px] border border-white/10 bg-card overflow-hidden"
      >
        <div className="flex items-center justify-between gap-3 p-4 border-b border-white/5 shrink-0">
          <span className="text-[13px] font-bold text-white truncate">
            {filename ?? intl.formatMessage(m.previewLabel)}
          </span>
          <div className="flex items-center gap-2 shrink-0">
            <a
              href={url}
              {...(filename === null ? {} : { download: filename })}
              target="_blank"
              // ⚠ Not decoration — the URL is bearer authority over a financial
              // record, and a Referer would carry it wherever the tab goes next.
              rel="noreferrer noopener"
              className="flex items-center gap-2 px-3 py-1.5 rounded-full text-[12px] font-bold text-zinc-300 border border-white/10 hover:text-white hover:border-white/25 transition-colors"
            >
              <Download size={14} />
              {intl.formatMessage(m.download)}
            </a>
            <button
              ref={closeRef}
              type="button"
              onClick={onClose}
              aria-label={intl.formatMessage(m.close)}
              className="p-2 rounded-full text-zinc-400 hover:text-white hover:bg-white/5 transition-colors"
            >
              <X size={16} />
            </button>
          </div>
        </div>

        <div className="flex-1 min-h-0 overflow-auto bg-ground flex items-center justify-center p-3">
          {isImage ? (
            <img src={url} alt="" referrerPolicy="no-referrer" className="max-w-full max-h-[70vh] object-contain" />
          ) : (
            <div className="flex flex-col items-center gap-4 py-12 text-center">
              <FileText size={28} className="text-zinc-700" />
              <p className="text-[13px] text-zinc-400 max-w-xs">{intl.formatMessage(m.noPreview)}</p>
              <a
                href={url}
                target="_blank"
                // ⚠ See the header: the URL is bearer authority over a financial
                // record, and a Referer would carry it wherever that tab goes.
                rel="noreferrer noopener"
                className="px-4 py-2 rounded-full text-[13px] font-bold text-brand-on bg-brand hover:bg-brand-hover transition-colors"
              >
                {intl.formatMessage(m.openInTab)}
              </a>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
