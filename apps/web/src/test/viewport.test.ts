import { describe, expect, it } from 'vitest';

import { renderHook, act } from '@testing-library/react';

import { useViewport } from '../lib/useViewport';
import { DEFAULT_VIEWPORT, currentViewport, evaluateQuery, setViewport } from './viewport';

/**
 * This tests the HARNESS, not the product — the same reason
 * `eslint/no-literal-string-in-jsx.test.js` exists.
 *
 * The stub it replaces was wrong in the worst available way: it answered every
 * question, it answered them all with `false`, and nothing failed. A stub that
 * silently stops discriminating turns every viewport assertion in the suite
 * into a green tick that checks nothing, so the discrimination itself is
 * pinned here — through `useViewport`, which is the only consumer that
 * matters, rather than through the string forms it happens to pass today.
 */

describe('the test viewport', () => {
  it('defaults to desktop, because the suite predates the phone', () => {
    expect(DEFAULT_VIEWPORT).toBe('desktop');
    expect(currentViewport()).toBe('desktop');
  });

  it('answers useViewport with exactly one mode at each width', () => {
    const { result } = renderHook(() => useViewport());

    // Desktop is the default, so this is also the state every test that says
    // nothing about the viewport is now rendering in.
    expect(result.current).toEqual({ phone: false, tablet: false, desktop: true, coarse: false });

    act(() => setViewport('tablet'));
    expect(result.current).toEqual({ phone: false, tablet: true, desktop: false, coarse: true });

    act(() => setViewport('phone'));
    expect(result.current).toEqual({ phone: true, tablet: false, desktop: false, coarse: true });
  });

  it('evaluates width features against the chosen viewport, not against zero', () => {
    // The md/lg breakpoints `useViewport` is built on, asked directly.
    expect(evaluateQuery('(min-width: 768px)', 'phone')).toBe(false);
    expect(evaluateQuery('(min-width: 768px)', 'tablet')).toBe(true);
    expect(evaluateQuery('(min-width: 1024px)', 'tablet')).toBe(false);
    expect(evaluateQuery('(min-width: 1024px)', 'desktop')).toBe(true);
    expect(evaluateQuery('(max-width: 767px)', 'phone')).toBe(true);
    expect(evaluateQuery('(max-width: 767px)', 'desktop')).toBe(false);
  });

  it('requires every feature of a compound query', () => {
    expect(evaluateQuery('(min-width: 768px) and (max-width: 1023px)', 'tablet')).toBe(true);
    expect(evaluateQuery('(min-width: 768px) and (max-width: 1023px)', 'desktop')).toBe(false);
  });

  it('keeps the old answer — false — for a query it does not understand', () => {
    // The point of the exercise is that the app's OWN queries stop being
    // guesses. Everything else keeps the previous stub's behaviour rather than
    // inventing an answer a real browser might disagree with.
    expect(evaluateQuery('(prefers-color-scheme: dark)', 'desktop')).toBe(false);
    expect(evaluateQuery('print', 'desktop')).toBe(false);
    expect(evaluateQuery('(min-width: wide)', 'desktop')).toBe(false);
  });

  it('reports no reduced-motion preference, which is what a test environment has', () => {
    expect(evaluateQuery('(prefers-reduced-motion: reduce)', 'phone')).toBe(false);
    expect(evaluateQuery('(prefers-reduced-motion: no-preference)', 'phone')).toBe(true);
  });
});
