import { expect, test } from 'vitest';

import { DocumentState } from '@prisma/client';

import { PortalDocumentStatus } from '@neoting/contracts/model';

import { PORTAL_HIDDEN_DOCUMENT_STATE, portalDocumentStatus } from './portal-document-status.js';

/**
 * The five words a client is shown, and the eight states behind them.
 *
 * The tests that matter here are the two TOTALITY ones. This mapping is the one
 * place `DocumentState` becomes something a person reads, so a state the
 * pipeline gains and this file does not is either a compile error (the
 * exhaustive `switch`) or an `undefined` in a status pill — and a status pill
 * that says nothing is how a client concludes their receipt was lost.
 */

test('every DocumentState maps to something, and to one of the contract\'s five values', () => {
  // Driven off the PRISMA enum object rather than a hand-written list, so a
  // ninth state added to the schema fails this test on the day it lands.
  const states = Object.values(DocumentState);
  expect(states.length).toBeGreaterThan(0);

  const allowed = new Set<string>(Object.values(PortalDocumentStatus));
  for (const state of states) {
    const status = portalDocumentStatus(state);
    expect(allowed.has(status), `${state} -> ${String(status)}`).toBe(true);
  }
});

test('every one of the contract\'s five values is REACHABLE — no dead vocabulary', () => {
  // The other direction. A value in the contract that nothing can produce is a
  // word the design promised and the server never says: the portal would render
  // a legend with a state that cannot occur, or worse, a frontend would invent
  // its own way to produce it.
  const produced = new Set(Object.values(DocumentState).map(portalDocumentStatus));
  expect([...produced].sort()).toEqual([...Object.values(PortalDocumentStatus)].sort());
});

test('the internal distinctions collapse: RECEIVED/PROCESSING are one word, REJECTED/FAILED are one word', () => {
  // RECEIVED vs PROCESSING says how busy a queue is. REJECTED vs FAILED names
  // whose fault it was. Neither is the client's, and what the client can DO
  // about each pair is identical.
  expect(portalDocumentStatus('RECEIVED')).toBe(portalDocumentStatus('PROCESSING'));
  expect(portalDocumentStatus('REJECTED')).toBe(portalDocumentStatus('FAILED'));
  expect(portalDocumentStatus('REJECTED')).toBe('needs_another_copy');
});

test('the three good outcomes stay APART — "with your accountant", "accepted" and "filed" are different facts', () => {
  // The temptation is to collapse these too. They must not be: "on a human's
  // desk", "the accountant is happy with it" and "released into your books" are
  // three different answers to "what happened to my receipt", and only the last
  // one means the client can stop thinking about it.
  expect(portalDocumentStatus('TO_REVIEW')).toBe('with_accountant');
  expect(portalDocumentStatus('READY')).toBe('accepted');
  expect(portalDocumentStatus('PUBLISHED')).toBe('filed');
});

test('⚠ ARCHIVED is never called "filed", and it is not served at all', () => {
  // `filed` would claim the document reached the client's books. Archiving is
  // the practice's own housekeeping — a duplicate set aside, a document
  // superseded — so the claim would be false, and false in the direction that
  // stops a client re-sending something we do need.
  expect(portalDocumentStatus('ARCHIVED')).not.toBe('filed');
  // And the list excludes it, which is what makes that branch unreachable
  // through the endpoint. The constant is shared with the service's `where`
  // clause so the two cannot drift.
  expect(PORTAL_HIDDEN_DOCUMENT_STATE).toBe('ARCHIVED');
});
