import { describe, expect, it } from 'vitest';
import type { BankTransaction as ApiBankTransaction } from '@neoting/contracts/model';

import { toLocalTransaction } from './bank';
import { isMatched } from '../lib/matching';
import type { BankTransaction as LocalBankTransaction } from '../lib/types';

/**
 * The boundary where the contract's SIGNED integer pence becomes the unsigned
 * pounds the Bank screen renders, and where the server's `matchState` takes
 * over from the seed's `matchedDocId`.
 *
 * Both are exactly the kind of conversion that looks right in a demo and is
 * wrong by a factor of a hundred, or silently shows every persisted match as
 * unmatched.
 */

const row = (over: Partial<ApiBankTransaction> = {}): ApiBankTransaction => ({
  id: 'txn_003',
  businessId: 'biz_burger',
  accountId: 'acc_biz_burger',
  bookedAt: '2026-08-16T00:00:00.000Z',
  amountPence: -129_900,
  currency: 'GBP',
  descriptionRaw: 'CURRYS 0842',
  merchantName: 'CURRYS',
  matchedDocumentId: null,
  classification: 'expense',
  balanceAfterPence: 1_841_255,
  matchState: 'UNMATCHED',
  chaseSuppressed: false,
  ...over,
});

const nameFor = (businessId: string) => (businessId === 'biz_burger' ? 'American Burger Ltd' : businessId);

const local = (over: Partial<LocalBankTransaction> = {}): LocalBankTransaction => ({
  id: 't1',
  clientId: 'biz_burger',
  clientName: 'American Burger Ltd',
  description: 'CURRYS 0842',
  date: '16 Aug 2026',
  amount: 1299, // positive is money OUT, the app's ledger convention
  isCredit: false,
  accountId: 'acc_biz_burger',
  ...over,
});

describe('money', () => {
  it('NEGATES: the feed says negative-is-out, the app says positive-is-out', () => {
    // `seed.ts` gives an ordinary supplier payment a positive amount and a
    // refund a negative one, and BankView paints anything negative emerald.
    // Copying the wire sign through would flip every row on the screen.
    const spend = toLocalTransaction(row({ amountPence: -129_900 }), nameFor);
    expect(spend.amount).toBe(1299);
    expect(spend.isCredit).toBe(false);

    const credit = toLocalTransaction(row({ amountPence: 284_155 }), nameFor);
    expect(credit.amount).toBe(-2841.55);
    // Money IN is what the local shape has always called a credit.
    expect(credit.isCredit).toBe(true);
  });

  it('agrees with the seeded rows it is replacing', () => {
    // `seedTransactions.t4` is a refund: `{ amount: -212.4, isCredit: true }`.
    // The API row for the same money must land on exactly that shape, or the
    // screen changes appearance the moment `VITE_API_ENABLED` is set.
    const refund = toLocalTransaction(row({ amountPence: 21_240 }), nameFor);
    expect(refund.amount).toBe(-212.4);
    expect(refund.isCredit).toBe(true);
  });

  it('does not round a penny away, in either direction', () => {
    for (const pence of [1, 10, 29, 6199, 34_000, 85_020, 142_050, 482_075, 123_456_789]) {
      expect(Math.round(toLocalTransaction(row({ amountPence: -pence }), nameFor).amount * 100)).toBe(pence);
      expect(Math.round(toLocalTransaction(row({ amountPence: pence }), nameFor).amount * 100)).toBe(-pence);
    }
  });

  it('a zero amount is a value, not a missing one', () => {
    const out = toLocalTransaction(row({ amountPence: 0 }), nameFor);
    expect(out.amount).toBe(0);
    // Zero is not money in.
    expect(out.isCredit).toBe(false);
  });
});

describe('the projection', () => {
  it('renders the booked date the way every screen does', () => {
    expect(toLocalTransaction(row(), nameFor).date).toBe('16 Aug 2026');
  });

  it('resolves the client name rather than parsing the business id', () => {
    expect(toLocalTransaction(row(), nameFor).clientName).toBe('American Burger Ltd');
    // A real id will not match a seeded client and must fall through to the id
    // rather than inventing a name.
    expect(toLocalTransaction(row({ businessId: 'biz_unknown' }), nameFor).clientName).toBe('biz_unknown');
  });

  it('carries the server signals the chase list also reads', () => {
    const out = toLocalTransaction(row({ matchState: 'CONFIRMED', chaseSuppressed: true }), nameFor);
    expect(out.matchState).toBe('CONFIRMED');
    expect(out.chaseSuppressed).toBe(true);
  });

  it('NEVER invents a matchedDocId — the contract does not carry one', () => {
    // `matching.ts` builds its `claimed` set from these ids so one receipt
    // cannot answer two lines, and `ClientApprovalView` looks a transaction up
    // BY one. A placeholder would corrupt both.
    expect(toLocalTransaction(row({ matchState: 'CONFIRMED' }), nameFor).matchedDocId).toBeUndefined();
  });
});

describe('isMatched — the one place the two match signals are reconciled', () => {
  it('a seeded row is matched by its document id', () => {
    expect(isMatched(local({ matchedDocId: 'd1' }))).toBe(true);
    expect(isMatched(local())).toBe(false);
  });

  it('a server row is matched by CONFIRMED alone', () => {
    expect(isMatched(local({ matchState: 'CONFIRMED' }))).toBe(true);
    expect(isMatched(local({ matchState: 'UNMATCHED' }))).toBe(false);
  });

  it('SUGGESTED is NOT matched — a suggestion is a question, not evidence', () => {
    // Counting it would take the line out of the unmatched total the whole
    // screen, and the chase list, are about.
    expect(isMatched(local({ matchState: 'SUGGESTED' }))).toBe(false);
  });

  it('EXCLUDED is not matched either — it is out of matching, not explained', () => {
    expect(isMatched(local({ matchState: 'EXCLUDED' }))).toBe(false);
  });

  it('the confirmed row survives a round trip through the projection', () => {
    expect(isMatched(toLocalTransaction(row({ matchState: 'CONFIRMED' }), nameFor))).toBe(true);
    expect(isMatched(toLocalTransaction(row({ matchState: 'UNMATCHED' }), nameFor))).toBe(false);
  });
});
