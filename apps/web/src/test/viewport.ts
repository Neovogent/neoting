/**
 * The viewport a component test renders at.
 *
 * ⚠ THIS EXISTS BECAUSE A STUB THAT ANSWERS `false` TO EVERYTHING IS NOT A
 * NEUTRAL DEFAULT — IT IS A CHOICE OF PHONE, MADE SILENTLY.
 *
 * jsdom has no layout engine and no `window.matchMedia` at all, so the suite
 * has always had to supply one. The supplied one returned `matches: false`
 * unconditionally. That was harmless while the app had a single layout; the
 * responsive port made it load-bearing, because `useViewport()` derives the
 * layout mode from three media queries and reads a universal `false` as
 * `{ phone: true, tablet: false, desktop: false }`. Every desktop-only branch
 * the port introduced — the sidebar rail, the desktop asides, the `hidden md:*`
 * surfaces — therefore rendered in no test at all, and a regression in any of
 * them would have gone green.
 *
 * So the stub now evaluates the query against a viewport the test can choose.
 * It is a real (small) media-query evaluator, not a lookup table of the three
 * strings `useViewport` happens to use today: a query this file does not
 * understand answers `false` — the old behaviour — but the width and pointer
 * features the app actually branches on are answered honestly, and a live
 * change notifies the subscribers the app really registers.
 *
 * The default is DESKTOP. That is what the suite exercised before the port
 * (there was one layout, and it was this one), and it is the mode most of the
 * assertions were written against. A test that wants the phone shell asks for
 * it by name, in one line, and says so where a reader can see it.
 *
 * Scope, deliberately: this moves `matchMedia` and nothing else. `innerWidth`,
 * `getBoundingClientRect` and layout generally are still jsdom's zeroes, so
 * this cannot be used to assert anything about measured geometry — only about
 * the branches the app takes on the layout mode it is told it is in.
 */

export type ViewportName = 'phone' | 'tablet' | 'desktop';

interface Environment {
  /** CSS pixels across, matched to `useViewport`'s md/lg breakpoints. */
  width: number;
  /** Primary input is a finger — `(pointer: coarse)`, no hover. */
  coarse: boolean;
}

/**
 * One representative width per mode rather than the breakpoint itself, so an
 * off-by-one in a `min-width` somewhere shows up as a wrong answer rather than
 * as a boundary this file happens to sit exactly on.
 */
const ENVIRONMENTS: Record<ViewportName, Environment> = {
  phone: { width: 390, coarse: true },
  tablet: { width: 834, coarse: true },
  desktop: { width: 1440, coarse: false },
};

export const DEFAULT_VIEWPORT: ViewportName = 'desktop';

let current: ViewportName = DEFAULT_VIEWPORT;

type ChangeListener = (event: MediaQueryListEvent) => void;

interface Registration {
  query: string;
  matches: boolean;
  listeners: Set<ChangeListener>;
  /** Kept so the older `onchange` property assignment is honoured too. */
  mql: MediaQueryList;
}

const live = new Set<Registration>();

/** `(min-width: 768px)` and friends. Every feature in the query must match. */
const FEATURE = /\(\s*([a-z-]+)\s*:\s*([^)]+?)\s*\)/g;

function matchFeature(name: string, value: string, env: Environment): boolean {
  switch (name) {
    // NaN comparisons are false in both directions, which is the honest answer
    // for a width this file cannot parse.
    case 'min-width':
      return env.width >= Number.parseFloat(value);
    case 'max-width':
      return env.width <= Number.parseFloat(value);
    case 'pointer':
      return value === (env.coarse ? 'coarse' : 'fine');
    case 'hover':
      return value === (env.coarse ? 'none' : 'hover');
    // A test environment has no user preference. `reduce` is false and
    // `no-preference` is true, which is what the three reduced-motion readers
    // in the app already assumed when the stub answered false to everything.
    case 'prefers-reduced-motion':
      return value === 'no-preference';
    default:
      return false;
  }
}

export function evaluateQuery(query: string, viewport: ViewportName = current): boolean {
  const env = ENVIRONMENTS[viewport];
  const features = [...query.matchAll(FEATURE)];
  // A query with no parsable feature is not a query this stub understands.
  if (features.length === 0) return false;
  return features.every(([, name, value]) => matchFeature(name ?? '', value ?? '', env));
}

function notify(registration: Registration): void {
  const event = {
    type: 'change',
    matches: registration.matches,
    media: registration.query,
  } as MediaQueryListEvent;
  registration.mql.onchange?.call(registration.mql, event);
  for (const listener of [...registration.listeners]) listener(event);
}

function createMediaQueryList(query: string): MediaQueryList {
  const listeners = new Set<ChangeListener>();
  const registration: Registration = {
    query,
    matches: evaluateQuery(query),
    listeners,
    mql: undefined as unknown as MediaQueryList,
  };

  const mql = {
    // A getter, not a snapshot: the app reads `mql.matches` inside its change
    // handler rather than reading the event, and a frozen value there would
    // make every live switch a no-op.
    get matches() {
      return registration.matches;
    },
    media: query,
    onchange: null as MediaQueryList['onchange'],
    addEventListener: (type: string, listener: ChangeListener) => {
      if (type === 'change') listeners.add(listener);
    },
    removeEventListener: (type: string, listener: ChangeListener) => {
      if (type === 'change') listeners.delete(listener);
    },
    // The pre-2019 API, still reached for by older library paths.
    addListener: (listener: ChangeListener) => listeners.add(listener),
    removeListener: (listener: ChangeListener) => listeners.delete(listener),
    dispatchEvent: () => false,
  };

  registration.mql = mql as unknown as MediaQueryList;
  live.add(registration);
  return registration.mql;
}

/**
 * Installs the stub. Called once from `vitest.setup.ts`.
 *
 * Assigned unconditionally, unlike the other shims in that file, and the
 * difference is deliberate: those are `??=`-guarded so a jsdom that grows a
 * real implementation wins. Here a real implementation would LOSE — jsdom's
 * would answer against a layout viewport it does not have, and `setViewport`
 * would go quietly back to controlling nothing, which is the exact failure
 * this module exists to end.
 */
export function installMatchMedia(): void {
  window.matchMedia = ((query: string) => createMediaQueryList(query)) as typeof window.matchMedia;
}

/**
 * Renders everything mounted after this call at `name`.
 *
 * Subscribers registered BEFORE the call are notified, so a test may also flip
 * the viewport on a mounted tree to assert the shell swaps — wrap that call in
 * `act()`, because it schedules React state updates.
 */
export function setViewport(name: ViewportName): void {
  current = name;
  for (const registration of live) {
    const next = evaluateQuery(registration.query, name);
    if (next === registration.matches) continue;
    registration.matches = next;
    notify(registration);
  }
}

export function currentViewport(): ViewportName {
  return current;
}

/**
 * Back to the default, and forget every subscription. Run from an `afterEach`
 * in `vitest.setup.ts` so one test choosing the phone cannot decide what the
 * next file renders as.
 */
export function resetViewport(): void {
  live.clear();
  current = DEFAULT_VIEWPORT;
}
