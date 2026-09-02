import { afterEach, describe, expect, test, vi } from 'vitest';

import { cameraAvailability, cameraFaultFor, captureFilename, frameToPage } from './portalCamera';

/**
 * The camera's refusals.
 *
 * This is the half of the Capture tab that cannot be checked by hand: every
 * one of these branches needs a *differently broken* phone, and the common
 * failure of a camera surface is that they all collapse into one useless
 * sentence. Each fault here has its own copy and each points at the device
 * camera fallback, which is what actually works on a locked-down phone — so a
 * misrouted fault is a client who stops trying to send their receipts.
 *
 * jsdom has no `getUserMedia` and no canvas 2D context, which is exactly why
 * the logic lives in a module of its own rather than inside the view.
 */

const originalNavigator = globalThis.navigator;

afterEach(() => {
  vi.unstubAllGlobals();
  Object.defineProperty(globalThis, 'navigator', { value: originalNavigator, configurable: true });
});

describe('cameraFaultFor', () => {
  const named = (name: string) => Object.assign(new Error('nope'), { name });

  test('the two commonest phone failures are named, including their legacy aliases', () => {
    expect(cameraFaultFor(named('NotAllowedError'))).toBe('blocked');
    // Older WebKit still throws this one; without it, "the client said no" and
    // "something went wrong" become the same sentence.
    expect(cameraFaultFor(named('PermissionDeniedError'))).toBe('blocked');
    expect(cameraFaultFor(named('NotReadableError'))).toBe('in-use');
    expect(cameraFaultFor(named('TrackStartError'))).toBe('in-use');
  });

  test('no camera, wrong constraints and an insecure page are each their own answer', () => {
    expect(cameraFaultFor(named('NotFoundError'))).toBe('not-found');
    expect(cameraFaultFor(named('DevicesNotFoundError'))).toBe('not-found');
    expect(cameraFaultFor(named('OverconstrainedError'))).toBe('unsupported-constraints');
    expect(cameraFaultFor(named('ConstraintNotSatisfiedError'))).toBe('unsupported-constraints');
    expect(cameraFaultFor(named('SecurityError'))).toBe('insecure');
  });

  test('anything unrecognised still gets a sentence, never a blank screen', () => {
    expect(cameraFaultFor(named('AbortError'))).toBe('other');
    expect(cameraFaultFor(new Error('plain'))).toBe('other');
    expect(cameraFaultFor('a string')).toBe('other');
    expect(cameraFaultFor(null)).toBe('other');
  });
});

describe('cameraAvailability', () => {
  test('a browser with the API is ok', () => {
    Object.defineProperty(globalThis, 'navigator', {
      value: { mediaDevices: { getUserMedia: () => Promise.resolve({}) } },
      configurable: true,
    });
    expect(cameraAvailability()).toBe('ok');
  });

  // ⚠ Two different failures. Telling someone to check their browser
  // permissions when the real problem is that the page is not on https sends
  // them somewhere they can do nothing at all.
  test('no API on an insecure page is "insecure", not "no-api"', () => {
    Object.defineProperty(globalThis, 'navigator', { value: {}, configurable: true });
    vi.stubGlobal('window', { ...window, isSecureContext: false });
    expect(cameraAvailability()).toBe('insecure');
  });

  test('no API on a secure page is the browser', () => {
    Object.defineProperty(globalThis, 'navigator', { value: {}, configurable: true });
    vi.stubGlobal('window', { ...window, isSecureContext: true });
    expect(cameraAvailability()).toBe('no-api');
  });
});

describe('frameToPage', () => {
  // The shutter's own refusal: `videoWidth` is 0 until the first frame
  // decodes, and encoding that produces a blank JPEG the client would be told
  // was their receipt.
  test('refuses a video with no frame yet rather than encoding a blank page', () => {
    const canvas = document.createElement('canvas');
    expect(frameToPage({ videoWidth: 0, videoHeight: 0 }, canvas, 'x.jpg')).toBeNull();
    expect(frameToPage({ videoWidth: 1920, videoHeight: 0 }, canvas, 'x.jpg')).toBeNull();
  });

  test('refuses when the canvas has no 2D context rather than throwing at the shutter', () => {
    const canvas = document.createElement('canvas');
    vi.spyOn(canvas, 'getContext').mockReturnValue(null);
    expect(frameToPage({ videoWidth: 1920, videoHeight: 1080 }, canvas, 'x.jpg')).toBeNull();
  });

  // The long edge is the shared constant from `lib/capture.ts` — there is one
  // compressor in this app and this reuses it rather than adding a second.
  test('downscales the long edge to 2200 and keeps the aspect ratio', () => {
    const canvas = document.createElement('canvas');
    vi.spyOn(canvas, 'getContext').mockReturnValue({ drawImage: () => undefined } as unknown as CanvasRenderingContext2D);
    vi.spyOn(canvas, 'toDataURL').mockReturnValue('data:image/jpeg;base64,AAAA');

    frameToPage({ videoWidth: 4400, videoHeight: 2200 }, canvas, 'x.jpg');
    expect(canvas.width).toBe(2200);
    expect(canvas.height).toBe(1100);
  });

  test('leaves a frame already small enough alone — upscaling adds bytes and no information', () => {
    const canvas = document.createElement('canvas');
    vi.spyOn(canvas, 'getContext').mockReturnValue({ drawImage: () => undefined } as unknown as CanvasRenderingContext2D);
    vi.spyOn(canvas, 'toDataURL').mockReturnValue('data:image/jpeg;base64,AAAA');

    frameToPage({ videoWidth: 1280, videoHeight: 720 }, canvas, 'x.jpg');
    expect(canvas.width).toBe(1280);
    expect(canvas.height).toBe(720);
  });
});

describe('captureFilename', () => {
  test('is dated, numbered, and claims the extension it actually is', () => {
    expect(captureFilename(2, new Date('2026-09-02T11:00:00Z'))).toBe('capture-2026-09-02-2.jpg');
  });
});
