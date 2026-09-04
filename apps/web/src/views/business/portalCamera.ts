import { CAPTURE_JPEG_QUALITY, CAPTURE_MAX_EDGE, dataUrlToBlob, type CapturedPage } from '../../lib/capture';

/**
 * The camera, as a state machine and a set of named refusals.
 *
 * Split out of the view so the part with logic can be tested without a
 * `<video>`, a `MediaStream` or a permission prompt — none of which jsdom has,
 * and all of which are exactly where this surface goes wrong on a real phone.
 */

export type CameraState = 'idle' | 'starting' | 'live' | 'error';

/**
 * Why the camera would not start.
 *
 * Each value gets its own sentence in the view, and **every one of them points
 * at the fallback**: a business on a locked-down phone still has to be able to
 * send a receipt, and "camera unavailable" with no next step is where that
 * client stops trying.
 */
export type CameraFault =
  | 'no-api'
  | 'insecure'
  | 'blocked'
  | 'not-found'
  | 'in-use'
  | 'unsupported-constraints'
  | 'other';

/**
 * Whether this browser will give a web page a camera at all.
 *
 * ⚠ Two different failures, and they need different sentences.
 * `getUserMedia` is undefined on an old browser AND on any page not served
 * over HTTPS — telling someone to check their browser permissions when the
 * real problem is the address bar sends them somewhere they can do nothing.
 */
export function cameraAvailability(): 'ok' | 'no-api' | 'insecure' {
  if (typeof navigator === 'undefined') return 'no-api';
  if (navigator.mediaDevices?.getUserMedia === undefined) {
    // `isSecureContext` is true on localhost as well as https, which is what a
    // developer needs and what a client on http:// is missing.
    if (typeof window !== 'undefined' && window.isSecureContext === false) return 'insecure';
    return 'no-api';
  }
  return 'ok';
}

/**
 * A `getUserMedia` rejection, named.
 *
 * The spec's own `DOMException.name` values, plus the two legacy aliases that
 * older WebKit still throws (`PermissionDeniedError`, `TrackStartError`) —
 * dropping those would collapse the two commonest phone failures into "other".
 */
export function cameraFaultFor(error: unknown): CameraFault {
  const name = error instanceof Error ? error.name : '';
  switch (name) {
    case 'NotAllowedError':
    case 'PermissionDeniedError':
      return 'blocked';
    case 'NotFoundError':
    case 'DevicesNotFoundError':
      return 'not-found';
    case 'NotReadableError':
    case 'TrackStartError':
      return 'in-use';
    case 'OverconstrainedError':
    case 'ConstraintNotSatisfiedError':
      return 'unsupported-constraints';
    case 'SecurityError':
      return 'insecure';
    default:
      return 'other';
  }
}

/**
 * The constraints, written once.
 *
 * `facingMode: { ideal: 'environment' }` and not `{ exact: … }`: a laptop has
 * only a front camera, and `exact` would turn "no rear camera" into an
 * `OverconstrainedError` rather than a usable picture of a receipt.
 */
export const CAMERA_CONSTRAINTS: MediaStreamConstraints = {
  video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } },
  audio: false,
};

/**
 * A frame off a live `<video>`, downscaled and encoded exactly as
 * `lib/capture.ts` encodes a picked file — same quality, same long edge, same
 * `dataUrlToBlob`. There is one compressor in this app and this is it being
 * reused rather than a second one being written.
 *
 * Returns null when the video has no frame yet: `videoWidth` is 0 until the
 * first frame decodes, and a canvas of that size encodes a blank JPEG the
 * client would have to be told was a receipt.
 */
export function frameToPage(
  video: { videoWidth: number; videoHeight: number },
  canvas: HTMLCanvasElement,
  filename: string,
): CapturedPage | null {
  if (video.videoWidth === 0 || video.videoHeight === 0) return null;

  const scale = Math.min(1, CAPTURE_MAX_EDGE / Math.max(video.videoWidth, video.videoHeight));
  canvas.width = Math.round(video.videoWidth * scale);
  canvas.height = Math.round(video.videoHeight * scale);
  const context = canvas.getContext('2d');
  if (context === null) return null;
  context.drawImage(video as unknown as CanvasImageSource, 0, 0, canvas.width, canvas.height);

  const dataUrl = canvas.toDataURL('image/jpeg', CAPTURE_JPEG_QUALITY);
  return { blob: dataUrlToBlob(dataUrl), dataUrl, filename };
}

/** `capture-2026-09-02-1.jpg` — dated, numbered, and the extension is honest. */
export function captureFilename(index: number, now: Date = new Date()): string {
  return `capture-${now.toISOString().slice(0, 10)}-${index}.jpg`;
}
