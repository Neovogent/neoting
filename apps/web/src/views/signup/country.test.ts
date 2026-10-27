import { expect, test } from 'vitest';

import { countryFromMobile, guessCountry, toE164 } from './country';

test('an Australian time zone or an en-AU browser guesses AU; everything else stays GB', () => {
  expect(guessCountry('Australia/Melbourne', ['en-GB'])).toBe('AU');
  expect(guessCountry('Asia/Dhaka', ['bn-BD', 'en-AU'])).toBe('AU');
  expect(guessCountry('Europe/London', ['en-GB', 'en'])).toBe('GB');
  expect(guessCountry('Asia/Dhaka', ['en-US'])).toBe('GB');
  expect(guessCountry(undefined, [])).toBe('GB');
});

test('a mobile names its country in international and national form, and nothing else guesses', () => {
  expect(countryFromMobile('+61 412 345 678')).toBe('AU');
  expect(countryFromMobile('0061412345678')).toBe('AU');
  expect(countryFromMobile('0412 345 678')).toBe('AU');
  expect(countryFromMobile('+44 7700 900123')).toBe('GB');
  expect(countryFromMobile('07700 900123')).toBe('GB');
  expect(countryFromMobile('+880 1711 000000')).toBeUndefined();
  expect(countryFromMobile('02 9999 9999')).toBeUndefined();
  expect(countryFromMobile('')).toBeUndefined();
});

test('a typed mobile becomes E.164, reading a national number in the chosen country', () => {
  expect(toE164('0412 345 678', 'AU')).toBe('+61412345678');
  expect(toE164('07700 900123', 'GB')).toBe('+447700900123');
  expect(toE164('+61 412-345-678', 'GB')).toBe('+61412345678');
  expect(toE164('0061 412 345 678', 'GB')).toBe('+61412345678');
  expect(toE164('12', 'GB')).toBeUndefined();
  expect(toE164('not a number', 'AU')).toBeUndefined();
});
