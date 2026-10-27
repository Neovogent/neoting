/**
 * The countries a practice can sign up in — the contract's `countryCode` enum
 * on `PracticeSignupRequest`. The server owns what each one sets (currency,
 * language); this file only works out which one the visitor is in, from the two
 * signals bhai asked for: the mobile number first, then location.
 */
export type SignupCountry = 'GB' | 'AU';

const DIALLING: Record<SignupCountry, string> = { GB: '44', AU: '61' };

/** The contract's `mobile` pattern (E.164). */
const E164 = /^\+[1-9][0-9]{7,14}$/;

/**
 * A first guess from the browser's own settings, never a decision: the form
 * shows it and the visitor confirms or changes it. An Australian time zone wins,
 * then an `en-AU` language; anything else is GB, which is what every practice
 * was before AU existed.
 */
export function guessCountry(timeZone: string | undefined, languages: readonly string[]): SignupCountry {
  if (timeZone?.startsWith('Australia/') === true) return 'AU';
  if (languages.some((language) => language.toLowerCase() === 'en-au')) return 'AU';
  return 'GB';
}

/** The guess for this browser. Guarded: a locked-down browser may refuse either read. */
export function guessCountryHere(): SignupCountry {
  try {
    return guessCountry(Intl.DateTimeFormat().resolvedOptions().timeZone, navigator.languages ?? []);
  } catch {
    return 'GB';
  }
}

/** Digits and a leading +, with `00` read as `+` — how people actually type a number. */
function compact(typed: string): string {
  const kept = typed.trim().replace(/[\s().-]/g, '');
  return kept.startsWith('00') ? `+${kept.slice(2)}` : kept;
}

/**
 * The country a typed mobile names, or undefined when it names neither.
 * International forms (+61…, +44…, 0061…) are certain; the national mobile
 * prefixes are distinct too — 04 is an Australian mobile, 07 a UK one.
 */
export function countryFromMobile(typed: string): SignupCountry | undefined {
  const n = compact(typed);
  if (n.startsWith('+61')) return 'AU';
  if (n.startsWith('+44')) return 'GB';
  if (/^04\d/.test(n)) return 'AU';
  if (/^07\d/.test(n)) return 'GB';
  return undefined;
}

/**
 * The typed mobile in E.164, reading a national number (leading 0) in the
 * chosen country; undefined when it cannot be a valid number.
 */
export function toE164(typed: string, country: SignupCountry): string | undefined {
  const n = compact(typed);
  const e164 = n.startsWith('+') ? n : n.startsWith('0') ? `+${DIALLING[country]}${n.slice(1)}` : `+${n}`;
  return E164.test(e164) ? e164 : undefined;
}
