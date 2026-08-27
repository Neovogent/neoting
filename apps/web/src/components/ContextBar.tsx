import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Building2, ChevronDown, Plus, PanelLeftClose, PanelLeft, X, Check, Sparkles } from 'lucide-react';
import { useAppContext } from '../context/AppContext';
import { useTour } from '../tour/TourProvider';
import { motion, AnimatePresence } from 'motion/react';
import { defineMessages, useIntl } from 'react-intl';

const m = defineMessages({
  hideHistory: { id: 'shell.contextBar.hideHistory', defaultMessage: 'Hide history' },
  showHistory: { id: 'shell.contextBar.showHistory', defaultMessage: 'Show history' },
  detach: { id: 'shell.contextBar.detach', defaultMessage: 'Detach' },
  noClientAttached: {
    id: 'shell.contextBar.noClientAttached',
    defaultMessage: 'No client attached — answers span all clients',
  },
  attachClient: { id: 'shell.contextBar.attachClient', defaultMessage: 'Attach Client' },
  // The short halves of the three labels that shrink on a phone. A separate id
  // rather than a substring: what is short in English is not short in German,
  // so the trimming is a translator's decision, not a slice of the long form.
  attachClientShort: { id: 'shell.contextBar.attachClient.short', defaultMessage: 'Attach' },
  noClientAttachedShort: { id: 'shell.contextBar.noClientAttached.short', defaultMessage: 'All clients' },
  tourButton: { id: 'shell.contextBar.tourButton', defaultMessage: "Let's have a demo tour" },
  tourButtonShort: { id: 'shell.contextBar.tourButton.short', defaultMessage: 'Demo tour' },
  pickerHeading: { id: 'shell.contextBar.pickerHeading', defaultMessage: 'Attach to conversation' },
  pickerEmpty: {
    id: 'shell.contextBar.pickerEmpty',
    defaultMessage: 'No clients yet — add your first under Clients, then attach it here.',
  },
});

/**
 * Context bar: shows every client attached to the conversation. Multiple
 * clients can be attached at once for cross-client questions (PRD section 5.4).
 */
export function ContextBar() {
  const { isHistoryVisible, toggleHistory, clients, attachedClients, attachClient, detachClient, documentsSource } = useAppContext();
  const intl = useIntl();
  const tour = useTour();
  const [pickerOpen, setPickerOpen] = useState(false);
  const [anchor, setAnchor] = useState<{ top: number; left: number } | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  /**
   * The workspace clips this bar on three sides (the collapse animation, the
   * view container and <main> all use overflow-hidden), so the menu is rendered
   * in a portal and positioned against the trigger instead of nested inside it.
   */
  const place = useCallback(() => {
    const rect = triggerRef.current?.getBoundingClientRect();
    if (!rect) return;
    const width = 288;
    setAnchor({
      top: rect.bottom + 8,
      // Keep it on screen if the bar sits near the right edge.
      left: Math.min(rect.left, window.innerWidth - width - 16),
    });
  }, []);

  useLayoutEffect(() => {
    if (pickerOpen) place();
  }, [pickerOpen, place]);

  useEffect(() => {
    if (!pickerOpen) return;

    const onPointerDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (triggerRef.current?.contains(target) || menuRef.current?.contains(target)) return;
      setPickerOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setPickerOpen(false);

    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKey);
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
    };
  }, [pickerOpen, place]);


  return (
    <header className="h-16 sm:h-20 border-b border-white/5 px-3 sm:px-8 flex items-center justify-between gap-4 shrink-0 bg-ground/80 backdrop-blur-md z-10 sticky top-0">
      <div className="flex items-center gap-4 min-w-0">
        <button
          onClick={toggleHistory}
          data-tour="history-toggle"
          aria-label={intl.formatMessage(isHistoryVisible ? m.hideHistory : m.showHistory)}
          className="p-2.5 text-zinc-400 hover:text-white bg-card hover:bg-raised border border-white/5 rounded-full transition-all shadow-lg overflow-hidden relative flex items-center justify-center w-10 h-10 shrink-0"
          title={intl.formatMessage(isHistoryVisible ? m.hideHistory : m.showHistory)}
        >
          <AnimatePresence mode="wait" initial={false}>
            <motion.div
              key={isHistoryVisible ? 'hide' : 'show'}
              initial={{ y: -20, opacity: 0, rotate: -45, scale: 0.5 }}
              animate={{ y: 0, opacity: 1, rotate: 0, scale: 1 }}
              exit={{ y: 20, opacity: 0, rotate: 45, scale: 0.5 }}
              transition={{ type: 'spring', stiffness: 350, damping: 25, duration: 0.2 }}
              className="absolute"
            >
              {isHistoryVisible ? <PanelLeftClose size={18} /> : <PanelLeft size={18} />}
            </motion.div>
          </AnimatePresence>
        </button>

        <div className="flex items-center gap-2 min-w-0 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          <AnimatePresence initial={false}>
            {attachedClients.map((c) => (
              <motion.div
                key={c.id}
                layout
                initial={{ opacity: 0, scale: 0.9 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 0.9 }}
                className="group flex items-center gap-3 bg-card pl-4 pr-2 py-2 rounded-full border border-white/5 shadow-lg shrink-0"
              >
                <Building2 size={16} className="text-zinc-400 shrink-0" />
                <span className="text-sm font-semibold text-white tracking-wide whitespace-nowrap max-w-[9rem] sm:max-w-none truncate">{c.name}</span>
                <button
                  onClick={() => detachClient(c.id)}
                  className="p-1 rounded-full text-zinc-600 hover:text-white hover:bg-white/10 transition-colors"
                  title={intl.formatMessage(m.detach)}
                >
                  <X size={13} strokeWidth={3} />
                </button>
              </motion.div>
            ))}
          </AnimatePresence>

          {attachedClients.length === 0 && (
            <span className="text-sm text-zinc-500 font-medium px-2 whitespace-nowrap truncate">
              <span className="hidden sm:inline">{intl.formatMessage(m.noClientAttached)}</span>
              <span className="sm:hidden">{intl.formatMessage(m.noClientAttachedShort)}</span>
            </span>
          )}
        </div>

        <div className="shrink-0">
          <button
            ref={triggerRef}
            data-tour="attach-client"
            onClick={() => setPickerOpen((o) => !o)}
            className="flex items-center gap-2 text-zinc-400 hover:text-brand text-sm font-medium transition-colors px-3 py-2 rounded-full hover:bg-white/5 whitespace-nowrap"
          >
            <Plus size={16} />
            <span className="hidden sm:inline">{intl.formatMessage(m.attachClient)}</span>
            <span className="sm:hidden">{intl.formatMessage(m.attachClientShort)}</span>
            <ChevronDown size={14} className={`transition-transform ${pickerOpen ? 'rotate-180' : ''}`} />
          </button>

          {createPortal(
            <AnimatePresence>
              {pickerOpen && anchor && (
                <motion.div
                  ref={menuRef}
                  initial={{ opacity: 0, y: -8, scale: 0.97 }}
                  animate={{ opacity: 1, y: 0, scale: 1 }}
                  exit={{ opacity: 0, y: -8, scale: 0.97 }}
                  transition={{ type: 'spring', stiffness: 400, damping: 30 }}
                  style={{ top: anchor.top, left: anchor.left }}
                  className="fixed w-72 max-h-[60dvh] overflow-y-auto bg-card border border-white/10 rounded-2xl shadow-2xl z-[100] p-2 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
                >
                  <div className="px-3 py-2 text-[11px] font-bold text-zinc-500 uppercase tracking-widest">
                    {intl.formatMessage(m.pickerHeading)}
                  </div>
                  {clients.length === 0 && (
                    <p className="px-3 py-2.5 text-[13px] text-zinc-500 leading-relaxed">
                      {intl.formatMessage(m.pickerEmpty)}
                    </p>
                  )}
                  {clients.map((c) => {
                    const attached = attachedClients.some((a) => a.id === c.id);
                    return (
                      <button
                        key={c.id}
                        onClick={() => (attached ? detachClient(c.id) : attachClient(c.id))}
                        className="w-full px-3 py-2.5 rounded-xl flex items-center justify-between gap-3 text-sm text-left hover:bg-white/5 transition-colors"
                      >
                        <span className="flex items-center gap-3 min-w-0">
                          <span className={`w-2 h-2 rounded-full shrink-0 ${attached ? 'bg-brand' : 'bg-zinc-700'}`} />
                          <span className="truncate text-zinc-300">{c.name}</span>
                        </span>
                        {attached && <Check size={15} strokeWidth={3} className="text-brand shrink-0" />}
                      </button>
                    );
                  })}
                </motion.div>
              )}
            </AnimatePresence>,
            document.body,
          )}
        </div>
      </div>

      {/* Top right: the guided tour. It walks every screen and keeps coming
          back to the point that the chat can do all of it.

          KEYED TO `documentsSource !== 'api'` — the app's existing
          demo-vs-live signal, the same one the S14 gating sweep used to hide
          every local writer whose change a live poll would revert. It is
          `API_ENABLED ? 'api' : 'seed'` in AppContext, so this reads exactly
          as "the synthetic dataset is what is on screen".

          Why the tour belongs behind it rather than in every header:

          - the script is WRITTEN AGAINST the synthetic cast. It routes to
            `/clients/1`, narrates American Burger by name, and seeds
            conversations whose assistant turns are canned (`steps.ts`,
            DEMO-MOCK). Against a real firm's data it points at the wrong
            rows and says things that are not true of them;
          - two of its anchors only exist in synthetic mode.
            `bulk-publish-selected` is a DataTable bulk action, and live
            `ClientInbox` drops the whole synthetic bulk set — so the
            costs-ready-publish step degrades to a centred card with an amber
            "not on screen" line. Gating the entrance is what makes that step
            honest instead of broken;
          - a demo surface sitting permanently in a working accountant's
            chrome is a product decision nobody made. Shakib kept the tour in
            scope; this keeps it where it tells the truth.

          `/demo` (and `/demo?step=n`) carries the SAME gate since launch M2
          — TourProvider owns that address, and with the API on it is only a
          redirect home. A scripted story walking across a real firm's
          screens was the one door left open, and M2 closed it. */}
      {documentsSource !== 'api' && (
        <button
          onClick={() => tour.start(0)}
          data-tour="tour-button"
          className="shrink-0 flex items-center gap-2 px-3 sm:px-4 py-2 rounded-full text-[13px] font-bold text-brand bg-brand/10 border border-brand/30 hover:bg-brand/20 transition-colors whitespace-nowrap"
        >
          <Sparkles size={15} />
          <span className="hidden sm:inline">{intl.formatMessage(m.tourButton)}</span>
          <span className="sm:hidden">{intl.formatMessage(m.tourButtonShort)}</span>
        </button>
      )}

      {/* The connection chips are gone from here.
          Both said the same thing on every conversation regardless of subject,
          and neither was the answer to anything asked in the chat. Connection
          state belongs where it can be acted on — the client's Overview and
          Integrations tabs, and Settings → Connections, all of which show it
          and offer the re-auth. */}
    </header>
  );
}
