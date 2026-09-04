import { describe, expect, test } from 'vitest';
import { composeChaseBody, formatPoundsForSms, shortDay, toE164 } from './demoIntents';

/**
 * The classification tests that used to live here are gone with the classifier.
 * Utterance → intent is now the server's job and is measured where it belongs:
 * `evals/` scores it against the gold set on the real model, which is the only
 * place an accuracy claim about a model means anything. A regex pinned in a
 * browser unit test would have measured the regex.
 *
 * What remains is display-tier and genuinely deterministic: the SMS copy shape
 * a human approves verbatim, and the money/day formatting inside it.
 */

describe('the SMS draft (display-tier — the payload carries only ids and text)', () => {
  test('the SoT §8.2 copy shape, verbatim for one item — NO amount (amended 4 Sep 2026)', () => {
    const body = composeChaseBody('American Burger', [{ supplier: 'Currys', amount: 1299.0, date: '09 Aug 2026' }], 'https://x/p/');
    expect(body).toBe("American Burger Accounts: we're missing the receipt for Currys on 9 Aug. Upload securely: https://x/p/");
    // A lock-screen preview must not carry a client's spending; the composer
    // CARD still shows the amounts to the accountant, the message never does.
    expect(body).not.toContain('£');
  });

  test('grouped per client — one text, a natural list, plural noun', () => {
    const body = composeChaseBody(
      'American Burger',
      [
        { supplier: 'Currys', amount: 1299.0, date: '09 Aug 2026' },
        { supplier: 'Google', amount: 600.0, date: '05 Aug 2026' },
      ],
      'https://x/p/',
    );
    expect(body).toContain("we're missing the receipts for Currys on 9 Aug and Google on 5 Aug.");
  });

  test('pounds keep pence only when they carry information', () => {
    expect(formatPoundsForSms(1299)).toBe('£1,299');
    expect(formatPoundsForSms(78.4)).toBe('£78.40');
    expect(formatPoundsForSms(-212.4)).toBe('£212.40'); // magnitude — the sign is not part of the sentence
  });

  test('the day drops its leading zero and its year', () => {
    expect(shortDay('09 Aug 2026')).toBe('9 Aug');
    expect(shortDay('15 Aug 2026')).toBe('15 Aug');
  });

  test('recipient numbers normalise to E.164 or refuse', () => {
    expect(toE164('+44 7700 900123')).toBe('+447700900123');
    expect(toE164('+447700900001')).toBe('+447700900001');
    expect(toE164('07700 900123')).toBeNull(); // no country code — refused, not guessed
    expect(toE164('not a number')).toBeNull();
  });
});
