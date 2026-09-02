import { ProposalKind } from '@neoting/contracts/model';
import { createActionProposalBody } from '@neoting/contracts/zod';
import { expect, test } from 'vitest';

import { AppException } from '../../common/problem/problem.js';
import { knownProposalKind, parseCreateProposalBody, parseStoredProposalPayload } from './proposal-body.js';

/**
 * The pinning tests `proposal-body.ts` promises: one VALID example per kind
 * must parse against the member its kind selects. If the spec's `oneOf` is
 * ever reordered, most of these fail at once — the loud version of
 * "validating payloads against the wrong member". They also pin the two
 * measured orval gaps, so their fixes are noticed when they land.
 */
export const VALID_EXAMPLES: Record<ProposalKind, Record<string, unknown>> = {
  'document.route': { documentId: 'doc_1', inbox: 'COSTS', toBusinessId: 'biz_1' },
  'document.update-coding': { documentId: 'doc_1', fields: { supplierName: 'Currys', totalPence: 129_900 } },
  'document.move-business': { documentId: 'doc_1', toBusinessId: 'biz_2', acknowledgedAddresseeMismatch: true },
  'document.reprocess': { documentIds: ['doc_1'] },
  'document.reject': { documentIds: ['doc_1'], reason: 'Not a receipt' },
  'document.split': { documentId: 'doc_1', pageRanges: ['1-3', '4'] },
  'document.archive': { documentIds: ['doc_1'], archived: true },
  'chase.send': {
    messages: [{ recipientE164: '+447700900001', body: 'Upload securely: https://x', transactionIds: ['txn_1'] }],
  },
  'publish.batch': { documentIds: ['doc_1'], preview: { itemCount: 1, grossPence: 129_900, vatPence: 21_650 } },
  'bank.confirm-match': { transactionId: 'txn_1', documentId: 'doc_1', matchKind: 'EXACT' },
  'rule.create': { tier: 'SUPPLIER_CUSTOMER', scopeKey: 'bidfood', sets: { categoryCode: 'COS_FOOD' } },
  'document.revoke-link': { documentLinkIds: ['dlk_1'], reason: 'Exported to the wrong client' },
  'business.offboard': { businessId: 'biz_1', reason: 'Client moved to another practice' },
  'document.purge': { documentIds: ['doc_1'], reason: 'Duplicate scan, already in Trash' },
};

test('every kind parses its own valid example — the index ↔ kind pin', () => {
  for (const kind of Object.values(ProposalKind)) {
    const parsed = parseCreateProposalBody(kind, { kind, businessId: 'biz_1', payload: VALID_EXAMPLES[kind] });
    expect(parsed.businessId, kind).toBe('biz_1');
    expect(parsed.payload, kind).toEqual(VALID_EXAMPLES[kind]);
    expect(parseStoredProposalPayload(kind, VALID_EXAMPLES[kind]), kind).toEqual(VALID_EXAMPLES[kind]);
  }
});

test('businessId is optional and normalises to null — the practice-level shape', () => {
  const parsed = parseCreateProposalBody('document.route', { kind: 'document.route', payload: VALID_EXAMPLES['document.route'] });
  expect(parsed.businessId).toBeNull();
});

test('a payload of the wrong shape is refused — the zod.unknown() discriminator hole is closed here', () => {
  // Orval gap 1, measured: the union's own `kind` is `zod.unknown()`, so this
  // selection is the only thing stopping an archive claim with a reprocess body.
  expect(() => parseCreateProposalBody('document.archive', { kind: 'document.archive', payload: VALID_EXAMPLES['document.reprocess'] })).toThrow(AppException);
  expect(() => parseCreateProposalBody('chase.send', { kind: 'chase.send', payload: VALID_EXAMPLES['publish.batch'] })).toThrow(AppException);
  expect(parseStoredProposalPayload('document.reject', VALID_EXAMPLES['document.reprocess'])).toBeNull();
});

test('the WHOLE generated union rejects even a valid request — orval gap 2, measured, the reason the halves are parsed separately', () => {
  // A strict-∧-strict intersection refuses every input: each half reports the
  // other's keys. When this assertion FAILS, orval fixed allOf-with-strict —
  // collapse proposal-body.ts to one parseBoundary and delete this test.
  const valid = { kind: 'document.archive', businessId: 'biz_1', payload: VALID_EXAMPLES['document.archive'] };
  expect(createActionProposalBody.safeParse(valid).success).toBe(false);
  expect(parseCreateProposalBody('document.archive', valid).payload).toEqual(VALID_EXAMPLES['document.archive']);
});

test('a misspelled top-level field is a named 400, not a silent drop — strictness survives the split', () => {
  try {
    parseCreateProposalBody('document.archive', {
      kind: 'document.archive',
      businesId: 'biz_1', // the classic
      payload: VALID_EXAMPLES['document.archive'],
    });
    expect.unreachable('should have thrown');
  } catch (error) {
    expect(error).toBeInstanceOf(AppException);
    expect((error as AppException).fieldErrors?.[0]?.field).toBe('businesId');
  }
});

// Float refusal on *Pence fields is deliberately NOT re-tested here: the
// R5 lint family refuses the float literal a test would need to write, and
// the guarantee is already negative-tested where it lives — `check-contract`
// fails the build if the generated Zod ever loses `.int()` on a money field.

test('knownProposalKind is the registry allow-list, not a string check', () => {
  expect(knownProposalKind('document.archive')).toBe('document.archive');
  expect(knownProposalKind('rule.create')).toBe('rule.create');
  expect(knownProposalKind('document.destroy')).toBeNull();
  expect(knownProposalKind('')).toBeNull();
  expect(knownProposalKind(42)).toBeNull();
  expect(knownProposalKind(undefined)).toBeNull();
});
