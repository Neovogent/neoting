import { describe, expect, test } from 'vitest';
import {
  composeChaseBody,
  formatPoundsForSms,
  matchDemoIntent,
  parseDemoRule,
  resolveBusiness,
  shortDay,
  toE164,
} from './demoIntents';

/**
 * The canned intent table (METH Stage 13). What matters here is the DEMO
 * SCRIPT: the five scripted utterances must land on their live intents with
 * the right payloads — tolerantly, because they will be typed or dictated with
 * fillers — and everything else must fall through (null) to the regex
 * classifier's graceful fallback.
 */

const BUSINESSES = [
  { id: 'biz_burger', name: 'American Burger Ltd' },
  { id: 'biz_cosmo', name: 'Cosmo Restaurants Ltd' },
];

const DOCUMENTS = [
  { id: 'doc_ready', supplier: 'Currys', status: 'ready' },
  { id: 'doc_review', supplier: 'Currys', status: 'review' },
  { id: 'doc_other', supplier: 'Adobe', status: 'ready' },
];

const CTX = { businesses: BUSINESSES, documents: DOCUMENTS };

test('utterance 1 — "Show missing paperwork for American Burger" → LIVE_MISSING, scoped to the server id', () => {
  const match = matchDemoIntent('Show missing paperwork for American Burger', CTX);
  expect(match?.intent).toBe('LIVE_MISSING');
  expect(match?.payload.businessId).toBe('biz_burger');
  expect(match?.payload.businessName).toBe('American Burger Ltd');
});

test('utterance 2 — "Chase American Burger for the missing receipts" → LIVE_CHASE, not the missing table', () => {
  // Contains "missing" too — order in the table is what keeps this a chase.
  const match = matchDemoIntent('Chase American Burger for the missing receipts', CTX);
  expect(match?.intent).toBe('LIVE_CHASE');
  expect(match?.payload.businessId).toBe('biz_burger');
});

test('utterance 3 — the Bidfood rule → LIVE_RULE with the exact contract-ready draft', () => {
  const match = matchDemoIntent(
    'Whenever Bidfood invoices arrive for American Burger, code them Cost of Sales Food with standard VAT',
    CTX,
  );
  expect(match?.intent).toBe('LIVE_RULE');
  expect(match?.payload.businessId).toBe('biz_burger');
  expect(match?.payload.ruleDraft).toEqual({
    // scopeKey must equal the extractor profile's supplierName EXACTLY —
    // "Bidfood", title-cased — or the single-tier match never fires.
    scopeKey: 'Bidfood',
    categoryCode: 'COST_OF_SALES_FOOD',
    categoryName: 'Cost of Sales — Food',
    vatTreatment: 'standard',
  });
});

test('utterance 4 — "Publish all approved costs to Xero" → LIVE_PUBLISH, unscoped when no client is named', () => {
  const match = matchDemoIntent('Publish all approved costs to Xero', CTX);
  expect(match?.intent).toBe('LIVE_PUBLISH');
  expect(match?.payload.businessId).toBeUndefined();
});

test('utterance 5a — "Show everything to review" → the inbox narrowed to review', () => {
  const match = matchDemoIntent('Show everything to review', CTX);
  expect(match?.intent).toBe('SHOW_INBOX');
  expect(match?.payload.statusFilter).toBe('review');
});

test('utterance 5b — "open the Currys receipt" → REVIEW_DOCUMENT, preferring the in-review copy', () => {
  const match = matchDemoIntent('open the Currys receipt', CTX);
  expect(match?.intent).toBe('REVIEW_DOCUMENT');
  expect(match?.payload.documentId).toBe('doc_review');
});

test('unknown input falls through to the classifier — never a guess', () => {
  expect(matchDemoIntent('what is the meaning of life?', CTX)).toBeNull();
  expect(matchDemoIntent('add Franco Pizza as a client', CTX)).toBeNull();
});

test('dictated variants land too — tolerant matching is the point of the table', () => {
  expect(matchDemoIntent('please chase up american burger for those receipts', CTX)?.intent).toBe('LIVE_CHASE');
  expect(matchDemoIntent('show me the missing paperwork', CTX)?.intent).toBe('LIVE_MISSING');
  expect(matchDemoIntent('publish the approved costs to xero please', CTX)?.intent).toBe('LIVE_PUBLISH');
});

describe('resolveBusiness', () => {
  test('full name, then a distinctive first word; never a short-word false hit', () => {
    expect(resolveBusiness('chase American Burger Ltd today', BUSINESSES)?.id).toBe('biz_burger');
    expect(resolveBusiness('anything from cosmo lately?', BUSINESSES)?.id).toBe('biz_cosmo');
    expect(resolveBusiness('show me everything', BUSINESSES)).toBeNull();
  });
});

describe('parseDemoRule', () => {
  test('half a rule is no rule: missing supplier or category returns null', () => {
    expect(parseDemoRule('whenever invoices arrive, code them Cost of Sales Food')).toBeNull();
    expect(parseDemoRule('whenever Bidfood invoices arrive, do something sensible')).toBeNull();
  });

  test('VAT wording maps to a treatment, and its absence stays absent', () => {
    expect(parseDemoRule('whenever Bidfood invoices arrive, code them advertising')?.vatTreatment).toBeUndefined();
    expect(parseDemoRule('whenever Bidfood invoices arrive, code them advertising, zero-rated')?.vatTreatment).toBe('zero');
  });
});

describe('the SMS draft (display-tier — the payload carries only ids and text)', () => {
  test('the SoT §8.2 copy shape, verbatim for one item', () => {
    expect(
      composeChaseBody('American Burger', [{ supplier: 'Currys', amount: 1299.0, date: '09 Aug 2026' }], 'https://x/p/'),
    ).toBe("American Burger Accounts: we're missing the receipt for Currys £1,299 on 9 Aug. Upload securely: https://x/p/");
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
    expect(body).toContain("we're missing the receipts for Currys £1,299 on 9 Aug and Google £600 on 5 Aug.");
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
