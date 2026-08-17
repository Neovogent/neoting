import '@testing-library/jest-dom/vitest';

// jsdom has no layout engine; these are the browser APIs the app shell
// touches when a component test renders it (motion reads matchMedia and
// observes resize; ChatArea scrolls). Guarded so a jsdom that grows a real
// implementation wins.
if (typeof window !== 'undefined') {
  window.matchMedia ??= ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
  window.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
  window.HTMLElement.prototype.scrollIntoView ??= () => {};
}
