import { expect, test } from 'vitest';

import type { Publish as PublishRow } from '@prisma/client';

import { toPublish } from './publish-projection.js';

const CREATED = new Date('2026-08-20T09:15:30.123Z');
const COMPLETED = new Date('2026-08-20T09:15:32.456Z');

/**
 * A row as Prisma hands it over — INCLUDING the two columns the contract does
 * not have. They are here on purpose: a projection test built from the contract
 * shape can never catch over-exposure, because the fields it would leak are the
 * ones it never constructed.
 */
function row(over: Partial<PublishRow> = {}): PublishRow {
  return {
    id: 'pub_1',
    businessId: 'biz_1',
    documentId: 'doc_1',
    integrationId: 'int_1',
    mode: 'MANUAL',
    state: 'SUCCEEDED',
    externalRef: 'XERO-INV-0042',
    idempotencyKey: 'prop_1:doc_1',
    attachmentSent: true,
    actionProposalId: 'prop_1',
    failureCode: null,
    failureMessage: null,
    publishedByUserId: 'usr_1',
    createdAt: CREATED,
    completedAt: COMPLETED,
    ...over,
  } as PublishRow;
}

test('a succeeded row projects onto the contract Publish, dates ISO in UTC', () => {
  const publish = toPublish(row());

  expect(publish).toEqual({
    id: 'pub_1',
    businessId: 'biz_1',
    documentId: 'doc_1',
    integrationId: 'int_1',
    mode: 'MANUAL',
    state: 'SUCCEEDED',
    externalRef: 'XERO-INV-0042',
    attachmentSent: true,
    actionProposalId: 'prop_1',
    failureCode: null,
    failureMessage: null,
    createdAt: '2026-08-20T09:15:30.123Z',
    completedAt: '2026-08-20T09:15:32.456Z',
  });
  // UTC on the wire, always — the Europe/London rendering happens in the web
  // app. A localised string here cannot be converted back without knowing which
  // zone made it, and the offset changes twice a year.
  expect(publish.createdAt).toBe(CREATED.toISOString());
  expect(publish.completedAt).toBe(COMPLETED.toISOString());
});

test('the internal columns NEVER leave the server — the key set is exactly the contract', () => {
  // `idempotencyKey` is the anti-double-post key and is globally unique;
  // `publishedByUserId` is not in the contract's `Publish` at all. The failure
  // mode this pins is a spread (`...row`), which typechecks and silently
  // widens the response.
  const keys = Object.keys(toPublish(row())).sort();

  expect(keys).toEqual([
    'actionProposalId',
    'attachmentSent',
    'businessId',
    'completedAt',
    'createdAt',
    'documentId',
    'externalRef',
    'failureCode',
    'failureMessage',
    'id',
    'integrationId',
    'mode',
    'state',
  ]);
  expect(keys).not.toContain('idempotencyKey');
  expect(keys).not.toContain('publishedByUserId');
});

test('a FAILED row always carries its reason, verbatim, and never a success ref', () => {
  // The contract: "A FAILED row always carries `failureCode` and
  // `failureMessage` ... a failure with no reason attached is a bug, not a
  // state." Neither is trimmed, translated or collapsed on the way out — the
  // message is what the Rejected/Failed surface shows the human who has to fix
  // it, and a code the retry decision is made on.
  const publish = toPublish(
    row({
      state: 'FAILED',
      externalRef: null,
      failureCode: 'NT-PUB-002',
      failureMessage: 'Xero rejected the bill: the supplier contact was locked by another update.',
      completedAt: COMPLETED,
    }),
  );

  expect(publish.state).toBe('FAILED');
  expect(publish.failureCode).toBe('NT-PUB-002');
  expect(publish.failureMessage).toBe('Xero rejected the bill: the supplier contact was locked by another update.');
  expect(publish.externalRef).toBeNull();
});

test('a reasonless FAILED row is served as-is, not papered over with an invented code', () => {
  // The inverse of the test above, and the one that stops a "helpful" default
  // being added later. If a writer ever commits a FAILED row with no reason,
  // that is a bug in the writer; substituting a code here would hide it AND put
  // a value on the wire that no writer emitted and no client has a branch for.
  const publish = toPublish(row({ state: 'FAILED', externalRef: null, failureCode: null, failureMessage: null }));

  expect(publish.failureCode).toBeNull();
  expect(publish.failureMessage).toBeNull();
});

test('a QUEUED row reports null completion and null ref EXPLICITLY, not by omission', () => {
  // Present-and-null is a claim ("this attempt has not completed"); an absent
  // key is ambiguous between that and "we did not look". A client rendering an
  // in-flight batch reads this key on every poll.
  const publish = toPublish(row({ state: 'QUEUED', externalRef: null, attachmentSent: false, completedAt: null }));

  expect(publish.state).toBe('QUEUED');
  expect(publish.completedAt).toBeNull();
  expect(publish.externalRef).toBeNull();
  expect(publish).toHaveProperty('completedAt');
  expect(publish).toHaveProperty('externalRef');
  // False because nothing has travelled yet — never silently true (`openapi.yaml`).
  expect(publish.attachmentSent).toBe(false);
});

test('a null integrationId survives as null — it means "the single active integration"', () => {
  // `PublishBatchPayload.integrationId` documents null as a real value, not a
  // gap. Projecting it as `undefined` would drop the key and lose that meaning.
  const publish = toPublish(row({ integrationId: null, actionProposalId: null }));

  expect(publish.integrationId).toBeNull();
  expect(publish.actionProposalId).toBeNull();
});

test('every PublishMode and PublishState crosses unchanged — nothing is re-derived', () => {
  // `state` is not inferred from whether `externalRef` is set, and `mode` is
  // not defaulted. A row whose columns disagree is a writer bug to be seen, not
  // a shape for this function to have an opinion about.
  for (const mode of ['MANUAL', 'AUTO', 'AI'] as const) {
    expect(toPublish(row({ mode })).mode).toBe(mode);
  }
  for (const state of ['QUEUED', 'SUCCEEDED', 'FAILED'] as const) {
    expect(toPublish(row({ state })).state).toBe(state);
  }
});
