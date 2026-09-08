import { currency } from './resolver';
import type { Document } from './types';

/**
 * What to SHOW where a document's supplier goes, and whether that text is a
 * real party or a stand-in.
 *
 * `toLocalDocument` falls back to the file name when nothing was extracted
 * (item 43: a capture's is the server-generated "Capture — {member} ·
 * {business} · {date}", which reads as a description). A plain upload's is the
 * client's own file name, and on 7 Sep 2026 a live walk found an unreadable
 * photo listed in the SUPPLIER column as **5b-blurred-restaurant**, styled
 * exactly like "Bidfood (UK) Ltd" beside it — while the document's own detail
 * honestly said `—` at 10% confident. A board that cannot be read at a glance
 * for "did the pipeline actually know this?" is the whole of item 47's
 * complaint, one altitude up.
 *
 * So the predicate lives here, once, and every board asks it rather than
 * repeating `displayTitle ?? supplier` and guessing at the styling. `Unknown`
 * is the data sentinel readiness already compares against (`lib/selectors.ts`),
 * so this adds no second notion of "not extracted".
 */
export function documentTitle(doc: Pick<Document, 'displayTitle' | 'supplier'>): {
  text: string;
  /** True when the text is a file name standing in for a supplier nobody read. */
  isFallback: boolean;
} {
  return { text: doc.displayTitle ?? doc.supplier, isFallback: doc.supplier === 'Unknown' };
}

/** The class the two cases wear, so one rule paints every board. */
export function documentTitleClass(isFallback: boolean): string {
  return isFallback ? 'text-zinc-400 font-medium italic' : 'text-white font-semibold';
}

/**
 * The supplier cell, everywhere. One component so a board cannot forget the
 * distinction and paint a file name as a party.
 */
export function DocumentTitle({ doc }: { doc: Pick<Document, 'displayTitle' | 'supplier'> }) {
  const { text, isFallback } = documentTitle(doc);
  return (
    <span title={text} className={documentTitleClass(isFallback)}>
      {text}
    </span>
  );
}

/**
 * The money cell on a document board.
 *
 * ⚠ A total nobody could read is `—`, never `£0.00` (8 Sep 2026, found live on
 * a handwritten receipt). `fromPence(null)` is 0 and `currency(0)` renders a
 * confident figure, so a board printing it asserted a total the document's own
 * detail said it did not have — the same mistake as a file name rendered as a
 * supplier, one column over.
 *
 * A genuine zero still prints as £0.00: the predicate is whether the SERVER
 * sent a total, not whether the number is falsy.
 */
export function documentTotal(doc: Pick<Document, 'total' | 'totalKnown' | 'currency'>): string | null {
  return doc.totalKnown === false ? null : currency(doc.total, doc.currency);
}

export function DocumentTotal({ doc }: { doc: Pick<Document, 'total' | 'totalKnown' | 'currency'> }) {
  const text = documentTotal(doc);
  return text === null ? (
    <span className="text-zinc-500 font-medium tabular-nums">—</span>
  ) : (
    <span className="text-white font-bold tabular-nums">{text}</span>
  );
}

/**
 * The date cell on a document board.
 *
 * ⚠ A date nobody has read is `—`, never today (8 Sep 2026, found live on a
 * document still in Processing). `toLocalDocument` falls back to `receivedAt`
 * so every list has something to sort by, and the board then printed that
 * arrival date in the DATE column beside dates genuinely read off paper. Same
 * mistake as `£0.00`, one column over, and the same shape of answer: the
 * predicate is whether the SERVER sent a document date, not whether the string
 * is falsy.
 */
export function documentDate(doc: Pick<Document, 'date' | 'dateKnown'>): string | null {
  return doc.dateKnown === false ? null : doc.date;
}

export function DocumentDate({ doc }: { doc: Pick<Document, 'date' | 'dateKnown'> }) {
  const text = documentDate(doc);
  return text === null ? <span className="text-zinc-600 font-medium">—</span> : <>{text}</>;
}
