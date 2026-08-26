import { Suspense, createContext, lazy, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useAppContext } from '../context/AppContext';
import { lockNavigation, navigate, usePath } from '../lib/router';
import { useEscape } from '../lib/useEscape';
import { emitTourAction } from './bus';
import type { TourCtx, TourStep } from './steps';

/**
 * The tour is mounted around the whole app, so everything it statically
 * imports is on the shared floor of every route — and the script is 63 steps
 * of prose plus its own overlay, which measured at ~14 kB gzipped there. That
 * is 6 % of the 250 kB per-route budget (SoT §14) spent on a surface almost
 * nobody opens, and it pushed the worst route over.
 *
 * So both halves are fetched on demand: the script when a step is first asked
 * for, the overlay when there is a step to draw. `import type` above is erased
 * at build, which is what keeps the module graph clean — a value import of
 * `TOUR_STEPS` here would put it straight back on the floor.
 */
const TourOverlay = lazy(() => import('./TourOverlay').then((m) => ({ default: m.TourOverlay })));

interface TourApi {
  active: boolean;
  index: number;
  total: number;
  step: TourStep | null;
  start: (at?: number) => void;
  next: () => void;
  prev: () => void;
  stop: () => void;
}

const TourContext = createContext<TourApi | null>(null);

export function useTour(): TourApi {
  const ctx = useContext(TourContext);
  if (!ctx) throw new Error('useTour outside TourProvider');
  return ctx;
}

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Owns the tour: which step is open, moving between steps, and the work each
 * step needs before it can be shown — seed a conversation, navigate, ask a
 * view to open something. Mounted inside AppProvider so it spans the practice
 * shell and the business portal alike. `/demo` starts it.
 *
 * `TourCtx` used to carry a `t` so this component could resolve the script's
 * MessageDescriptors with its own `intl`. The script is English-only now (see
 * the header of `steps.ts` for the decision), so the strings arrive resolved
 * and the hook is gone with the field it existed for.
 */
export function TourProvider({ children }: { children: ReactNode }) {
  const { clients, startConversation, setMessages, businessAccounts } = useAppContext();
  const path = usePath();
  const [index, setIndex] = useState<number | null>(null);
  // A step that is still preparing (navigating, seeding) should not be
  // overtaken by a fast second click; the run id lets a stale run bail out.
  const runRef = useRef(0);
  // The script, once fetched. Held in a ref as well as in state: `goTo` needs
  // it synchronously on the next step, and the state exists only so the render
  // that follows the first fetch actually happens.
  const stepsRef = useRef<TourStep[] | null>(null);
  const [steps, setSteps] = useState<TourStep[] | null>(null);

  const loadSteps = useCallback(async (): Promise<TourStep[]> => {
    const already = stepsRef.current;
    if (already) return already;
    const { TOUR_STEPS } = await import('./steps');
    stepsRef.current = TOUR_STEPS;
    setSteps(TOUR_STEPS);
    return TOUR_STEPS;
  }, []);

  const ctx = useMemo<TourCtx>(
    () => ({
      clients,
      startConversation,
      portalAccountId: businessAccounts[0]?.id ?? null,
    }),
    [clients, startConversation, businessAccounts],
  );

  const goTo = useCallback(
    async (i: number) => {
      const script = await loadSteps();
      const step = script[i];
      if (!step) return;
      const run = ++runRef.current;
      emitTourAction('tour:reset');

      // Only the tour moves the address while it is running. Its own moves
      // (and the conversations it seeds, which navigate internally) go through
      // with the lock lifted for the moment it takes.
      //
      // ⚠ THE LOCK MUST NOT SURVIVE A FAILURE. `navigationLocked` is a
      // module-global in `lib/router.ts`, so re-arming it in a bare `finally`
      // meant that a throw out of `startConversation` or a step's `setup`
      // re-locked the router AND skipped `setIndex(i)` — leaving the app with
      // no tour on screen, no overlay to leave from, and every navigation in
      // the product silently dead until a reload. The lock therefore goes back
      // on only once the step has actually been prepared; if preparing it
      // throws, the router is left open and the error propagates loudly rather
      // than stranding the app quietly.
      lockNavigation(false);
      let prepared = false;
      try {
        // A "/" step wants the empty workspace, not whichever seeded chat was
        // last open — the shell (rail, history) only shows when the chat is
        // empty. startConversation with no seed opens a fresh draft and
        // navigates synchronously, inside the unlocked window.
        if (step.route === '/') startConversation(['1']);
        step.setup?.(ctx);
        if (step.route && step.route !== '/') {
          const to = typeof step.route === 'function' ? step.route(ctx) : step.route;
          navigate(to, { replace: true, force: true });
        }
        prepared = true;
      } finally {
        lockNavigation(prepared);
      }
      setIndex(i);

      if (step.action) {
        // The view has to be mounted to hear it; say it twice, the action is
        // idempotent and the second call catches a slow first paint.
        await wait(300);
        if (runRef.current !== run) return;
        emitTourAction(step.action);
        await wait(700);
        if (runRef.current !== run) return;
        emitTourAction(step.action);
      }
    },
    [ctx, startConversation, loadSteps],
  );

  const start = useCallback((at = 0) => void goTo(at), [goTo]);
  const stop = useCallback(() => {
    runRef.current++;
    emitTourAction('tour:reset');
    lockNavigation(false);
    setIndex(null);
  }, []);
  const next = useCallback(() => {
    if (index === null) return;
    if (steps && index >= steps.length - 1) {
      stop();
      setMessages([]);
      return;
    }
    void goTo(index + 1);
  }, [index, steps, goTo, stop, setMessages]);
  const prev = useCallback(() => {
    if (index === null || index === 0) return;
    void goTo(index - 1);
  }, [index, goTo]);

  // /demo is the tour's own address; /demo?step=12 opens a particular step.
  // Starting replaces it with the step's own screen, so Back from the tour
  // never lands on an empty "demo" page.
  useEffect(() => {
    if (path[0] === 'demo' && index === null) {
      const wanted = Number(new URLSearchParams(window.location.search).get('step'));
      // The script is not loaded yet, so a ?step= out of range is clamped by
      // goTo (which bails on a missing step) rather than checked here.
      const at = Number.isFinite(wanted) && wanted >= 1 ? wanted - 1 : 0;
      navigate('/', { replace: true, force: true });
      start(at);
    }
  }, [path, index, start]);

  useEffect(() => () => lockNavigation(false), []);

  // The browser's Back button during a tour means "get me out of here".
  useEffect(() => {
    if (index === null) return;
    const onPop = () => stop();
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, [index, stop]);

  // Escape leaves. Through the shared stack rather than a listener of its own,
  // so a dialog opened on top of a tour step closes itself first instead of
  // both closing on one key — that stack is the whole reason `useEscape`
  // exists.
  useEscape(stop, index !== null);

  // Keyboard: arrows move. Ignored while typing in a field.
  useEffect(() => {
    if (index === null) return;
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      if (e.key === 'ArrowRight' || e.key === 'Enter') { e.preventDefault(); next(); }
      else if (e.key === 'ArrowLeft') { e.preventDefault(); prev(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [index, next, prev]);

  const api = useMemo<TourApi>(
    () => ({
      active: index !== null,
      index: index ?? 0,
      total: steps?.length ?? 0,
      step: index === null ? null : steps?.[index] ?? null,
      start,
      next,
      prev,
      stop,
    }),
    [index, steps, start, next, prev, stop],
  );

  return (
    <TourContext.Provider value={api}>
      {children}
      {api.step && (
        // No fallback: the spotlight appearing a frame late is better than a
        // placeholder overlay flashing over the screen it is about to explain.
        <Suspense fallback={null}>
          <TourOverlay key={api.step.id} step={api.step} index={api.index} total={api.total} onNext={next} onPrev={prev} onStop={stop} />
        </Suspense>
      )}
    </TourContext.Provider>
  );
}
