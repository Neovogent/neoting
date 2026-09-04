import { useState } from 'react';
import { defineMessages, useIntl } from 'react-intl';
import { Bell } from 'lucide-react';
import { useAppContext } from '../context/AppContext';
import { useEscape } from '../lib/useEscape';
import { markAllNotificationsRead, useNotifications, type NotificationItem } from '../api/notifications';

const m = defineMessages({
  bell: { id: 'shell.notificationsBell.bell', defaultMessage: 'Notifications' },
  title: { id: 'shell.notificationsBell.title', defaultMessage: 'Notifications' },
  markAllRead: { id: 'shell.notificationsBell.markAllRead', defaultMessage: 'Mark all read' },
  empty: {
    id: 'shell.notificationsBell.empty',
    defaultMessage: 'Nothing yet. A client sending a document is the first thing that lands here.',
  },
  failed: { id: 'shell.notificationsBell.failed', defaultMessage: 'Notifications could not be loaded.' },
  // One sentence per event the pipeline writes today. An event this build does
  // not know renders the honest generic line rather than nothing — a new
  // writer server-side must show up, not vanish.
  portalUpload: {
    id: 'shell.notificationsBell.portalUpload',
    defaultMessage: '{business} sent a document through their portal',
  },
  documentReceived: {
    id: 'shell.notificationsBell.documentReceived',
    defaultMessage: 'A document arrived for {business}',
  },
  chaseClosed: {
    id: 'shell.notificationsBell.chaseClosed',
    defaultMessage: 'A chased document arrived for {business}',
  },
  genericEvent: { id: 'shell.notificationsBell.genericEvent', defaultMessage: '{event} — {business}' },
  badgeOverflow: {
    id: 'shell.notificationsBell.badgeOverflow',
    defaultMessage: '99+',
    description: 'The unread badge when the count exceeds two digits.',
  },
});

function lineFor(intl: ReturnType<typeof useIntl>, item: NotificationItem): string {
  switch (item.event) {
    case 'portal.upload':
      return intl.formatMessage(m.portalUpload, { business: item.businessName });
    case 'document.received':
      return intl.formatMessage(m.documentReceived, { business: item.businessName });
    case 'chase.closed':
      return intl.formatMessage(m.chaseClosed, { business: item.businessName });
    default:
      return intl.formatMessage(m.genericEvent, { event: item.event, business: item.businessName });
  }
}

/**
 * The bell (review item 12, 5 Sep 2026): the live sign of document arrival.
 * Polls `GET /v1/notifications` every 10 s and on focus; the badge is the
 * server's whole-practice unread count, never a page-derived guess.
 *
 * Rendered by `ContextHeader` inside the authenticated branch only, so the
 * query never runs before a session exists — and never in synthetic mode,
 * where there is no server to have written a row.
 *
 * The dropdown copies the user menu's own pattern in the same header: a
 * `fixed inset-0` pointer backdrop, an absolutely positioned panel, and
 * `useEscape` for the keyboard dismissal.
 */
export function NotificationsBell() {
  const intl = useIntl();
  const { openClient } = useAppContext();
  const [open, setOpen] = useState(false);
  useEscape(() => setOpen(false), open);

  const { items, unreadCount, error, contractError, refetch } = useNotifications(true);
  const failed = error !== null || contractError !== null;

  return (
    <span className="relative shrink-0">
      <button
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        aria-label={intl.formatMessage(m.bell)}
        className="relative flex items-center px-2 py-1.5 rounded-full hover:bg-white/5 text-zinc-400 hover:text-white transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-brand/60"
      >
        <Bell size={15} className="shrink-0" />
        {unreadCount > 0 && (
          <span
            aria-live="polite"
            className="absolute -top-0.5 -right-0.5 min-w-4 h-4 px-1 rounded-full bg-brand text-brand-on text-[10px] font-bold flex items-center justify-center tabular-nums"
          >
            {unreadCount > 99 ? intl.formatMessage(m.badgeOverflow) : intl.formatNumber(unreadCount)}
          </span>
        )}
      </button>

      {open && (
        <>
          <div role="presentation" className="fixed inset-0 z-30" onClick={() => setOpen(false)} />
          <div className="absolute right-0 top-full mt-2 z-40 w-80 p-2 rounded-2xl bg-card border border-white/10 shadow-glow-tile">
            <span className="flex items-center justify-between px-3 pt-2 pb-1">
              <span className="text-[12.5px] font-bold text-white">{intl.formatMessage(m.title)}</span>
              {unreadCount > 0 && (
                <button
                  onClick={() => {
                    void markAllNotificationsRead().then(() => refetch());
                  }}
                  className="text-[11.5px] font-bold text-brand hover:text-brand-hover transition-colors"
                >
                  {intl.formatMessage(m.markAllRead)}
                </button>
              )}
            </span>

            {failed ? (
              <p role="alert" className="px-3 py-3 text-[12px] font-semibold text-red-400">
                {intl.formatMessage(m.failed)}
              </p>
            ) : items.length === 0 ? (
              <p className="px-3 py-3 text-[12px] text-zinc-500">{intl.formatMessage(m.empty)}</p>
            ) : (
              <ul className="max-h-80 overflow-y-auto overscroll-contain">
                {items.map((item) => (
                  <li key={item.id}>
                    <button
                      onClick={() => {
                        setOpen(false);
                        openClient(item.businessId);
                      }}
                      className="w-full flex items-start gap-2 px-3 py-2 rounded-xl text-left hover:bg-white/5 transition-colors"
                    >
                      <span
                        aria-hidden
                        className={`mt-1.5 w-1.5 h-1.5 rounded-full shrink-0 ${item.readAt === null ? 'bg-brand' : 'bg-white/10'}`}
                      />
                      <span className="flex flex-col min-w-0">
                        <span
                          className={`text-[12.5px] leading-snug ${item.readAt === null ? 'text-white font-semibold' : 'text-zinc-400'}`}
                        >
                          {lineFor(intl, item)}
                        </span>
                        <span className="text-[11px] text-zinc-500">
                          {intl.formatDate(item.createdAt, { day: 'numeric', month: 'short' })}
                          {' · '}
                          {intl.formatTime(item.createdAt)}
                        </span>
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </>
      )}
    </span>
  );
}
