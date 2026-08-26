import { useEffect } from 'react';

/**
 * A tiny event bus between the tour and the views.
 *
 * Some things the tour wants to show live in a view's local state — the
 * document preview in Inboxes, the approval detail in Approvals. Rather than
 * lifting that state, the view subscribes to a named action and the tour
 * emits it. `tour:reset` fires on every step change so a view can close what
 * it opened.
 */
const EVENT = 'app:tour-action';

export function emitTourAction(name: string) {
  window.dispatchEvent(new CustomEvent(EVENT, { detail: name }));
}

export function useTourAction(name: string, handler: () => void) {
  useEffect(() => {
    const onAction = (e: Event) => {
      if ((e as CustomEvent<string>).detail === name) handler();
    };
    window.addEventListener(EVENT, onAction);
    return () => window.removeEventListener(EVENT, onAction);
  }, [name, handler]);
}
