/**
 * Turning a phone camera into something small enough to send.
 *
 * The portal is the lightest surface in the product and the one most likely to
 * be used on bad mobile data (SoT §14), and a modern phone photograph is 4–8 MB
 * of receipt that reads perfectly well at a tenth of that. So a picture is
 * re-encoded before it leaves the device, and the client sees the size it is
 * actually sending rather than the size the camera produced.
 *
 * The numbers are `BusinessCaptureView`'s, deliberately unchanged: JPEG at
 * quality 0.86, and the byte count derived from the base64 payload with the
 * encoding overhead stripped so what is displayed is the real payload size.
 * That view keeps its own inline copy of the encode because it draws from a
 * live `<video>` frame; this one starts from a `File`. Same constant, one
 * meaning — change both or neither.
 */

/** JPEG quality for a captured page. `BusinessCaptureView` uses the same value. */
export const CAPTURE_JPEG_QUALITY = 0.86;

/**
 * The long edge a captured page is scaled down to.
 *
 * 2200 px keeps the small print on a supermarket receipt legible to OCR while
 * dropping a 12 MP phone photograph to a fraction of its size. Anything already
 * smaller is left alone — upscaling adds bytes and no information.
 */
export const CAPTURE_MAX_EDGE = 2200;

/**
 * A `data:` URL as the bytes it encodes.
 *
 * Written out rather than reached for through `fetch(dataUrl)`, which works but
 * spends a request on a string that is already in memory, and is one more thing
 * to explain in a module whose whole job is to send fewer bytes.
 */
export function dataUrlToBlob(dataUrl: string): Blob {
  const comma = dataUrl.indexOf(',');
  if (!dataUrl.startsWith('data:') || comma === -1) {
    throw new Error('Not a data URL');
  }
  const meta = dataUrl.slice('data:'.length, comma);
  const isBase64 = meta.endsWith(';base64');
  const mimeType = (isBase64 ? meta.slice(0, -';base64'.length) : meta) || 'application/octet-stream';
  const payload = dataUrl.slice(comma + 1);

  if (!isBase64) return new Blob([decodeURIComponent(payload)], { type: mimeType });

  const binary = atob(payload);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: mimeType });
}

/** What a compressed page carries: the bytes to send, and a preview to show. */
export interface CapturedPage {
  blob: Blob;
  /** For the `<img>` preview. The same encode, so what is shown is what is sent. */
  dataUrl: string;
  filename: string;
}

/**
 * Re-encode a picked image, or pass a non-image through untouched.
 *
 * A PDF is already a document and re-encoding it as a JPEG would throw away the
 * text layer extraction wants, so only images are compressed. A file the browser
 * cannot decode falls back to the original bytes rather than failing the upload:
 * a receipt that arrives large is worth far more than one that does not arrive.
 */
export async function compressImage(file: File): Promise<CapturedPage> {
  const original: CapturedPage = {
    blob: file,
    dataUrl: '',
    filename: file.name,
  };

  if (!file.type.startsWith('image/')) return original;

  try {
    const dataUrl = await readAsDataUrl(file);
    const image = await decode(dataUrl);
    const scale = Math.min(1, CAPTURE_MAX_EDGE / Math.max(image.width, image.height));

    const canvas = document.createElement('canvas');
    canvas.width = Math.round(image.width * scale);
    canvas.height = Math.round(image.height * scale);
    const context = canvas.getContext('2d');
    if (!context) return { ...original, dataUrl };
    context.drawImage(image, 0, 0, canvas.width, canvas.height);

    const encoded = canvas.toDataURL('image/jpeg', CAPTURE_JPEG_QUALITY);
    return {
      blob: dataUrlToBlob(encoded),
      dataUrl: encoded,
      filename: asJpegName(file.name),
    };
  } catch {
    // Every failure here is a browser that would not decode the picture. The
    // original still uploads; only the saving is lost.
    return original;
  }
}

/** `receipt.heic` → `receipt.jpg`, because that is what is now in the blob. */
export function asJpegName(filename: string): string {
  const dot = filename.lastIndexOf('.');
  const stem = dot > 0 ? filename.slice(0, dot) : filename;
  return `${stem || 'capture'}.jpg`;
}

function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error('Could not read the file'));
    reader.readAsDataURL(file);
  });
}

function decode(dataUrl: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('Could not decode the image'));
    image.src = dataUrl;
  });
}
