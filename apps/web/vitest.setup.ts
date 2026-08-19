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

  // jsdom 25's Blob still has no `arrayBuffer()`. The portal reads the bytes it
  // is about to upload in order to hash them (`byteHash`, the contract's dedupe
  // signal), which every browser this ships to supports. Built out of jsdom's
  // own FileReader, which does exist, so the shim is a real read rather than a
  // stand-in — and `??=`-guarded like the three above, so a jsdom that grows
  // the method wins.
  Blob.prototype.arrayBuffer ??= function readBytes(this: Blob): Promise<ArrayBuffer> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as ArrayBuffer);
      reader.onerror = () => reject(reader.error ?? new Error('Could not read the blob'));
      reader.readAsArrayBuffer(this);
    });
  };
}
