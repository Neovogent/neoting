import { useMemo } from 'react';
import { encodeQr } from './qr';

/**
 * The enrolment QR, drawn as one SVG path.
 *
 * ⚠ **THIS IS THE ONE SURFACE IN THE APP THAT DOES NOT FOLLOW THE THEME, AND
 * THAT IS DELIBERATE.** A QR reader expects dark modules on a light ground;
 * inverted codes are read by some phones and not others, and "some phones"
 * means an accountant who cannot set up their second factor and has no way to
 * find out why. So the symbol is black on white in both themes, inside its own
 * white card — the theme applies to the card's surroundings, not to the code.
 *
 * The quiet zone is not decoration either: the spec requires four light
 * modules on every side, and a QR flush to the edge of its container fails to
 * scan against a dark page. It is drawn as part of the SVG rather than left to
 * the caller's padding, so no layout change can remove it.
 *
 * One `<path>` of `M x y h1 v1 h-1 z` subpaths rather than a rect per module:
 * a version-9 symbol is 53×53, and around 1,400 elements is enough DOM to be
 * felt on a phone.
 */
export function QrCode({ value, label, size = 232 }: { value: string; label: string; size?: number }) {
  const { path, side } = useMemo(() => {
    const matrix = encodeQr(value);
    const QUIET = 4;
    const subpaths: string[] = [];
    matrix.modules.forEach((row, y) => {
      row.forEach((dark, x) => {
        if (dark) subpaths.push(`M${x + QUIET} ${y + QUIET}h1v1h-1z`);
      });
    });
    return { path: subpaths.join(''), side: matrix.size + QUIET * 2 };
  }, [value]);

  return (
    <svg
      viewBox={`0 0 ${side} ${side}`}
      width={size}
      height={size}
      // `role="img"` plus a label, because to a screen reader this is a picture
      // of a secret — the manual-entry seed below it is the accessible route,
      // and the label says so rather than describing the pixels.
      role="img"
      aria-label={label}
      // Nearest-neighbour: a browser that smooths this loses the sharp module
      // edges a camera locks onto.
      className="rounded-xl [image-rendering:pixelated]"
      shapeRendering="crispEdges"
    >
      <rect width={side} height={side} className="fill-white" />
      <path d={path} className="fill-black" />
    </svg>
  );
}
