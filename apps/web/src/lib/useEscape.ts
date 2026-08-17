import { useEffect, useRef } from 'react';

/**
 * Escape closes the top-most dismissable surface — and only that one.
 *
 * Introduced by the jsx-a11y sweep: the modal backdrops used to be the only
 * dismissal short of the buttons, and a click target is invisible to a
 * keyboard. The backdrops keep their click (as `role="presentation"` — a
 * backdrop is not a button and announcing it as one would be a lie); the
 * keyboard path is this hook on the dialog instead.
 *
 * It is a stack, not a bare listener, because dialogs nest: DuplicateModal
 * opens ConfirmStep on top of itself. Two naive document listeners fire in
 * registration order — outer first — so one Escape would close the modal
 * UNDER the confirm while the confirm stayed up. Here the last surface
 * mounted owns the key until it unmounts.
 *
 * The handler is read through a ref so callers can pass inline closures
 * (`() => setPreviewId(null)`) without the subscription churning every
 * render, and without the stack entry going stale.
 *
 * `enabled` exists for surfaces that render conditionally inside a component
 * that is always mounted (the document viewers, the account-switch dropdown):
 * hooks cannot be called conditionally, but an entry that sits in the stack
 * while its surface is closed would swallow Escape from whatever is actually
 * on top. Pass the open state; the entry exists only while it is true.
 */
const stack: Array<() => void> = [];

const onKey = (e: KeyboardEvent) => {
  if (e.key !== 'Escape') return;
  stack[stack.length - 1]?.();
};

export function useEscape(onDismiss: () => void, enabled = true) {
  const latest = useRef(onDismiss);
  useEffect(() => {
    latest.current = onDismiss;
  });

  useEffect(() => {
    if (!enabled) return;
    const entry = () => latest.current();
    stack.push(entry);
    if (stack.length === 1) document.addEventListener('keydown', onKey);
    return () => {
      stack.splice(stack.indexOf(entry), 1);
      if (stack.length === 0) document.removeEventListener('keydown', onKey);
    };
  }, [enabled]);
}
