import { ProposalKind } from '@neoting/contracts/model';
import { expect, test } from 'vitest';

import { proposalIdentity } from './proposal-identity.js';

/**
 * Review item 26. The eight-identical-cards bug, and the several ways a naive
 * dedupe key would have created a worse one.
 */

test('the identity table is total over ProposalKind', () => {
  // Not a formality: `null` is a real answer here ("never dedupe this kind"),
  // so a MISSING entry would throw rather than answer, and it would throw
  // inside `create()` on the one path that mints every state change.
  for (const kind of Object.values(ProposalKind)) {
    expect(() => proposalIdentity(kind, {})).not.toThrow();
  }
});

test('the reported bug: two publish.batch stagings over the same documents are one act', () => {
  const first = proposalIdentity('publish.batch', { documentIds: ['doc_a', 'doc_b'] });
  const second = proposalIdentity('publish.batch', { documentIds: ['doc_a', 'doc_b'] });
  expect(first).not.toBeNull();
  expect(second).toBe(first);
});

test('selection ORDER is not part of the act — the same documents picked differently still match', () => {
  expect(proposalIdentity('publish.batch', { documentIds: ['doc_b', 'doc_a'] })).toBe(
    proposalIdentity('publish.batch', { documentIds: ['doc_a', 'doc_b'] }),
  );
});

test('a different document set is a different act', () => {
  expect(proposalIdentity('publish.batch', { documentIds: ['doc_a'] })).not.toBe(
    proposalIdentity('publish.batch', { documentIds: ['doc_a', 'doc_b'] }),
  );
});

test('a correction is keyed on the document and the FIELD NAMES, not the values', () => {
  // Two attempts to set the same field are the same act even when the second
  // click typed a different number: the pending one is the decision to make,
  // and a rival proposal over one field is a queue holding two contradictory
  // answers to one question.
  const first = proposalIdentity('document.update-coding', { documentId: 'doc_a', fields: { totalPence: 99400 } });
  const retyped = proposalIdentity('document.update-coding', { documentId: 'doc_a', fields: { totalPence: 900000 } });
  expect(retyped).toBe(first);

  // A DIFFERENT field on the same document is a different act and must stage.
  const other = proposalIdentity('document.update-coding', { documentId: 'doc_a', fields: { categoryCode: '5000' } });
  expect(other).not.toBe(first);

  // Field ORDER is not an act either — a payload is an object.
  expect(
    proposalIdentity('document.update-coding', { documentId: 'doc_a', fields: { taxPence: 1, totalPence: 2 } }),
  ).toBe(proposalIdentity('document.update-coding', { documentId: 'doc_a', fields: { totalPence: 2, taxPence: 1 } }));
});

test('archive and UNarchive over the same documents are opposite acts, not duplicates', () => {
  // The trap a documents-only key would have set: the second one would be
  // refused because the first was pending, and the refusal would read
  // "already awaiting review" about the opposite request.
  expect(proposalIdentity('document.archive', { documentIds: ['doc_a'], archived: true })).not.toBe(
    proposalIdentity('document.archive', { documentIds: ['doc_a'], archived: false }),
  );
});

test('a duplicate ruling is keyed on the ORDERED pair — keep A delete B is not keep B delete A', () => {
  expect(proposalIdentity('document.resolve-duplicate', { documentKeepId: 'a', documentCopyId: 'b', resolution: 'x' })).not.toBe(
    proposalIdentity('document.resolve-duplicate', { documentKeepId: 'b', documentCopyId: 'a', resolution: 'x' }),
  );
});

test('a chase is keyed on what it chases, never on the body the engine discards', () => {
  // `computeChaseSendPayload` rewrites every body at creation with a signed
  // link over a freshly minted chase id, so a body in the key would make every
  // re-stage look novel — the exact kinds this exists for are the rewritten ones.
  const withBody = proposalIdentity('chase.send', {
    messages: [{ transactionIds: ['txn_1'], body: 'Composed at review.' }],
  });
  const rewritten = proposalIdentity('chase.send', {
    messages: [{ transactionIds: ['txn_1'], body: 'Hi Sam — we are missing a receipt… https://…/p/abc' }],
  });
  expect(rewritten).toBe(withBody);

  // A statement request carries no transactions at all; the period identifies it.
  const august = proposalIdentity('chase.send', { messages: [{ statementPeriod: '2026-08' }] });
  expect(august).not.toBeNull();
  expect(proposalIdentity('chase.send', { messages: [{ statementPeriod: '2026-07' }] })).not.toBe(august);
});

test('rule.create is never deduped, deliberately', () => {
  // Two rules over one client are two rules — that is what a rule set IS.
  expect(proposalIdentity('rule.create', { name: 'Google Ads → Advertising' })).toBeNull();
});

test('a payload that is not the shape this file expects answers null rather than a wrong key', () => {
  // The stored row is re-parsed against the contract at review and approve. A
  // dedupe check is the wrong place to start refusing rows — and a key built
  // out of junk would silently group unrelated proposals.
  expect(proposalIdentity('publish.batch', {})).toBeNull();
  expect(proposalIdentity('publish.batch', { documentIds: [] })).toBeNull();
  expect(proposalIdentity('publish.batch', { documentIds: ['doc_a', 42] })).toBeNull();
  expect(proposalIdentity('document.update-coding', { documentId: 'doc_a', fields: {} })).toBeNull();
  expect(proposalIdentity('document.update-coding', { documentId: '', fields: { totalPence: 1 } })).toBeNull();
  expect(proposalIdentity('chase.send', { messages: [{ body: 'nothing identifying' }] })).toBeNull();
});

test('revoke-link keys on the LINKS, because two links on one document are two acts', () => {
  expect(proposalIdentity('document.revoke-link', { documentLinkIds: ['lnk_1'] })).not.toBe(
    proposalIdentity('document.revoke-link', { documentLinkIds: ['lnk_2'] }),
  );
  // And the field name is the contract's — `documentIds` here is not the payload.
  expect(proposalIdentity('document.revoke-link', { documentIds: ['doc_a'] })).toBeNull();
});
