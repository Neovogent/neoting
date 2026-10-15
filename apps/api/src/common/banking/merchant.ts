/**
 * Fuzzy merchant-name normalisation for the probabilistic match tier
 * (rush/matching, SoT §4 Stage 7 and §24.2.2).
 *
 * UK bank narratives are noisy and at least one major bank hard-truncates them
 * to 18 characters, so supplier matching works on prefixes and never requires
 * full-string equality. Pure string work — never fed to a model.
 */

/** Card, payment-type, reference and legal-form tokens that say nothing about who was paid. */
const NOISE = new Set([
  'card', 'crd', 'cd', 'vis', 'visa', 'mc', 'debit', 'credit', 'dd', 'ddr', 'so', 'sto', 'fpo', 'fpi', 'bgc', 'bp',
  'pos', 'cpt', 'tfr', 'contactless', 'ref', 'reference', 'payment', 'purchase', 'online', 'www', 'com', 'co',
  'uk', 'gb', 'ltd', 'limited', 'plc', 'llp', 'the', 'and', 'inc', 'gbp', 'via', 'paypal', 'sq', 'sumup', 'izettle',
]);

/**
 * Lower-case, punctuation to spaces, and drop every token that carries a digit
 * (card last-4s, references, dates like `12AUG`), every noise token and every
 * single letter. `CARD 4211 FRESH DIRECT LTD*AB12` → `fresh direct`.
 */
export function normaliseMerchant(label: string): string {
  return label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .split(' ')
    .filter((token) => token.length > 1 && !/\d/.test(token) && !NOISE.has(token))
    .join(' ');
}

/**
 * How well a document's supplier names a bank line's merchant, 0..1:
 * 1 identical after normalisation · 0.9 one is a prefix of the other (the
 * 18-character truncation) · 0.8 they share their leading word · 0.6 they share
 * any distinctive word · 0 otherwise.
 */
export function merchantScore(documentSupplier: string | null | undefined, bankLabel: string | null | undefined): number {
  if (!documentSupplier || !bankLabel) return 0;
  const a = normaliseMerchant(documentSupplier);
  const b = normaliseMerchant(bankLabel);
  if (a === '' || b === '') return 0;
  if (a === b) return 1;
  const ac = a.replace(/ /g, '');
  const bc = b.replace(/ /g, '');
  const shorter = ac.length <= bc.length ? ac : bc;
  const longer = ac.length <= bc.length ? bc : ac;
  // A truncated narrative ("CARD 4211 FRESH DI") is a prefix of the full name.
  if (shorter.length >= 4 && longer.startsWith(shorter)) return 0.9;
  const at = a.split(' ');
  const bt = b.split(' ');
  if (at[0] === bt[0] && at[0]!.length >= 3) return 0.8;
  if (at.some((token) => token.length >= 4 && bt.includes(token))) return 0.6;
  return 0;
}

/** The score at which a merchant counts as the same supplier for suggestions. */
export const MERCHANT_MATCH_THRESHOLD = 0.6;
