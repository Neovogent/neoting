import { expect, test } from 'vitest';

import { statementRefusalMessage, STATEMENT_REQUEST_REFUSAL_CODE } from './statement-request-refusal.js';

/**
 * The sentence a refused client reads. It is the ONLY wording of this refusal —
 * the portal shows this string verbatim off `documents.failure_message` — so it
 * is pinned here rather than described.
 */
test('the refusal names what was asked for and what arrived', () => {
  expect(statementRefusalMessage('INVOICE', '2026-08')).toBe(
    'We asked for your bank statement for 2026-08, but this looks like an invoice. Please send the statement — the request is still open.',
  );
});

test('a request with no readable period still names the thing that was asked for', () => {
  expect(statementRefusalMessage('RECEIPT', null)).toBe(
    'We asked for a bank statement, but this looks like a receipt. Please send the statement — the request is still open.',
  );
});

/**
 * An unread type must never produce "something else" as though we had judged
 * it — the step returns before composing a message when `docType` is null, but
 * the copy is safe either way rather than relying on that one caller.
 */
test('an unknown type is described as something else, never invented', () => {
  expect(statementRefusalMessage(null, '2026-08')).toContain('this looks like something else');
});

test('the failure code is the stable one the portal and the accountant both key on', () => {
  expect(STATEMENT_REQUEST_REFUSAL_CODE).toBe('NT-STM-002');
});
