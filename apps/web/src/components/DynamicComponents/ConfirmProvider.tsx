import { createContext, useCallback, useContext, useState, type ReactNode } from 'react';
import { ConfirmStep } from './ConfirmStep';

export interface ConfirmOptions {
  title: string;
  detail: string;
  /** The part that cannot be undone, if there is one. */
  consequence?: string;
  confirmLabel: string;
  tone?: 'brand' | 'red';
  /**
   * A third way out, for the questions that genuinely have one — closing with
   * unsaved work is save / discard / keep editing, and forcing that into two
   * buttons makes one of the three outcomes unreachable.
   */
  altLabel?: string;
}

/** `true` confirmed, `false` cancelled, `'alt'` took the third option. */
export type ConfirmResult = boolean | 'alt';

/**
 * One confirmation for the whole app, asked for with `await confirm({…})`.
 *
 * Every irreversible move — approving, rejecting, deleting, publishing,
 * pushing a document to its next state — has to ask first, and there are
 * around twenty of them across eight screens. Giving each its own dialog state
 * is how some of them quietly end up without one, which is exactly what
 * happened: the two approval modals asked and nothing else did.
 *
 * So this is a promise. A call site reads:
 *
 *     if (await confirm({ … })) doTheThing();
 *
 * which is one line, hard to half-apply, and puts the wording next to the
 * action it guards rather than in a component three files away.
 */
const ConfirmContext = createContext<(options: ConfirmOptions) => Promise<ConfirmResult>>(
  async () => true,
);

export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [pending, setPending] = useState<{ options: ConfirmOptions; settle: (ok: ConfirmResult) => void } | null>(null);

  const confirm = useCallback(
    (options: ConfirmOptions) =>
      new Promise<ConfirmResult>((resolve) => {
        setPending((current) => {
          // A second request while one is open cancels the first rather than
          // losing its promise — nothing should ever hang unresolved.
          current?.settle(false);
          return { options, settle: resolve };
        });
      }),
    [],
  );

  const close = (ok: ConfirmResult) => {
    pending?.settle(ok);
    setPending(null);
  };

  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      {pending && (
        <ConfirmStep
          {...pending.options}
          onConfirm={() => close(true)}
          onCancel={() => close(false)}
          onAlt={pending.options.altLabel ? () => close('alt') : undefined}
        />
      )}
    </ConfirmContext.Provider>
  );
}

export const useConfirm = () => useContext(ConfirmContext);
