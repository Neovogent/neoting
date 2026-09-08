import { BILLED_TO_LABELS } from '../api/document-detail';
import type { Document, ExtractedField } from './types';

/**
 * Does this document's own "bill to" name the client whose books it is filed
 * under?
 *
 * ⚠ Found on a live walk, 7 Sep 2026. A Wolseley invoice addressed to
 * **American Burger Ltd** was sitting in *Aldgate Kitchen Ltd*'s inbox with the
 * customer name extracted at 97% confidence and nothing anywhere saying the two
 * disagreed — no flag on the board, no note in the panel. Filing a cost into
 * the wrong client's books is the most expensive mistake this product can make
 * and the cheapest to spot: the document says who it is for, and we know who we
 * filed it under.
 *
 * D46 — this FLAGS, it never blocks. A group with several trading names, a
 * document addressed to a parent, a landlord's invoice in the tenant's name:
 * all legitimate, all common, and none of them ours to refuse. The accountant
 * is told and decides.
 *
 * Deliberately dumb comparison. Company suffixes and punctuation come off, then
 * either name containing the other is a match — so "Aldgate Kitchen" on the
 * paper matches "Aldgate Kitchen Ltd" on the record, and a fuzzy distance
 * (which would have to pick a threshold, and would fire on "Aldgate Kitchens
 * Ltd" vs "Aldgate Kitchen Ltd") is not attempted. A false quiet is better than
 * a warning nobody trusts.
 */
const NOISE = /\b(ltd|limited|plc|llp|llc|inc|incorporated|co|company|group|holdings|uk|the)\b/gu;

export function normaliseParty(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(NOISE, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
}

/**
 * True when the document names a bill-to party and it is not the client this
 * document sits under. False whenever either side is missing or unreadable —
 * silence is the only honest answer when there is nothing to compare.
 */
export function billedToMismatch(
  doc: Pick<Document, 'kind' | 'clientName'>,
  fields: readonly ExtractedField[],
): string | null {
  // Only on COSTS. On a sales document the customer is somebody else by
  // definition, and flagging every invoice a client issues would be noise.
  if (doc.kind !== 'cost') return null;

  // ⚠ EVERY label that row goes by, never the one word "Customer" — a bank
  // statement calls it "Account holder", and matching one string is how this
  // check silently stopped firing on statements for a few hours on 8 Sep 2026.
  const billedTo = fields.find((f) => BILLED_TO_LABELS.includes(f.label))?.value?.trim();
  if (billedTo === undefined || billedTo === '' || billedTo === '—') return null;

  const paper = normaliseParty(billedTo);
  const books = normaliseParty(doc.clientName);
  if (paper === '' || books === '') return null;
  if (paper.includes(books) || books.includes(paper)) return null;

  return billedTo;
}
