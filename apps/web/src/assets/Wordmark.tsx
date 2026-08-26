import type { ReactNode } from 'react';
import { defineMessages, useIntl } from 'react-intl';

/**
 * The Neo Accounting lockup (launch stage M1): the N mark set beside the
 * product name in the app's own face.
 *
 * The mark keeps the favicon's idea as geometry — one continuous stroke from
 * a ring node at one end to a ring node at the other: a document goes in one
 * end, a ledger entry comes out the other. It strokes in `currentColor`
 * through the `text-brand` token, so each theme supplies its own colour and
 * no hex appears here.
 *
 * The name is REAL TEXT, never type embedded in an SVG — an embedded font
 * silently falls back and nobody is told. "Neo" takes the heavier weight via
 * the message's own <strong> tags, so the split survives without the name
 * being concatenated from fragments.
 */

const m = defineMessages({
  name: {
    id: 'brand.wordmark.name',
    defaultMessage: '<strong>Neo</strong> Accounting',
    description:
      'The product name in the wordmark lockup. A brand name — leave untranslated, keeping the <strong> tags around "Neo".',
  },
});

/** The bare N mark, for surfaces that want the icon without the name. */
export function BrandMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 48 48" fill="none" aria-hidden="true" className={className}>
      <path
        d="M11.2 29.1 15.9 15.9 Q17.6 9.6 20.1 15.7 L27.5 33.8 Q30.1 40.2 32.4 33.9 L37.5 17"
        stroke="currentColor"
        strokeWidth="4.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle cx="9.5" cy="34" r="4" stroke="currentColor" strokeWidth="3.5" />
      <circle cx="39" cy="12" r="4" stroke="currentColor" strokeWidth="3.5" />
    </svg>
  );
}

interface WordmarkProps {
  /** Accessible name for the lockup — copy, so format it with react-intl at the call site. */
  title: string;
  /** Height of the type in px; the mark scales with it. */
  size?: number;
  className?: string;
}

export function Wordmark({ title, size = 20, className = '' }: WordmarkProps) {
  const intl = useIntl();
  return (
    <span
      role="img"
      aria-label={title}
      title={title}
      style={{ fontSize: size }}
      className={`inline-flex items-center gap-[0.4em] leading-none ${className}`}
    >
      <BrandMark className="w-[1.25em] h-[1.25em] shrink-0 text-brand" />
      <span aria-hidden="true" className="font-sans font-medium tracking-tight whitespace-nowrap">
        {intl.formatMessage(m.name, {
          strong: (chunks: ReactNode[]) => <span className="font-extrabold">{chunks}</span>,
        })}
      </span>
    </span>
  );
}
