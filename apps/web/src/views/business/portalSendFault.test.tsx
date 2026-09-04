import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { defineMessages } from 'react-intl';

import { NtProblemError, NtTransportError } from '@neoting/contracts';

import { AppIntlProvider } from '../../i18n/AppIntlProvider';
import { PortalStorageError } from '../../api/portal';
import { PortalSendFaultNotice, groupFaults } from './PortalSendFaultNotice';
import { sendFaultFor } from './portalSendFault';

/**
 * The reported failure, pinned at the only level that can hold it.
 *
 * A client photographed two receipts, pressed **Send to accountant**, and read
 * *"2 photos did not send — they are still here, try again."* Four unrelated
 * problems produce that sentence and only one of them is answered by trying
 * again. This suite asserts that each of the four now arrives with its own
 * reason and its own `NT-` code where one exists.
 *
 * ## ⚠ WHAT THIS SUITE CANNOT DO, AND NOBODY SHOULD BELIEVE IT DOES
 *
 * **It cannot catch a real cross-origin failure.** jsdom has no CORS: it does
 * not send a preflight, does not evaluate `Access-Control-Allow-Origin`, and
 * `fetch` is stubbed in every suite here. A bucket with its CORS configuration
 * deleted would leave every test in this file green. What this pins is the
 * half that is ours — that an opaque transport failure is NAMED as one, is not
 * given an invented cause, and is not collapsed back into a count.
 *
 * The other half is a manual check against a real browser and a real bucket,
 * and it is written down in `docs/runbooks/live-local.md` ("The browser upload
 * check") rather than faked with a mock that would pass either way.
 */

const problem = (status: number, code: string, detail?: string) =>
  new NtProblemError(detail === undefined ? { status, code, title: code } : { status, code, title: code, detail });

describe('sendFaultFor — the four causes, told apart', () => {
  it('names a lapsed subscription and keeps the code the client must quote', () => {
    const fault = sendFaultFor(problem(402, 'NT-BIL-001', 'Subscription is not active.'));
    expect(fault.reason).toBe('lapsed');
    expect(fault.code).toBe('NT-BIL-001');
    expect(fault.detail).toBe('Subscription is not active.');
  });

  it('treats a 402 under any other code as lapsed as well', () => {
    // The remedy is the checkout button either way, and "try again" is wrong
    // for all of them — so the status is a fallback rather than a formality.
    expect(sendFaultFor(problem(402, 'NT-BIL-999')).reason).toBe('lapsed');
  });

  it('names an expired session, which is what ends the session rather than the send', () => {
    const fault = sendFaultFor(problem(401, 'NT-OTP-002'));
    expect(fault.reason).toBe('expired');
    expect(fault.code).toBe('NT-OTP-002');
  });

  it('names a refused file and carries the server’s own words', () => {
    const fault = sendFaultFor(problem(400, 'NT-VAL-001', 'mimeType is not accepted.'));
    expect(fault.reason).toBe('refused');
    expect(fault.detail).toBe('mimeType is not accepted.');
  });

  it('⚠ names an opaque storage failure WITHOUT inventing a status or a code', () => {
    // This is the CORS/offline case. `putBytes` catches a `fetch` that threw
    // and `sendPortalUpload` re-throws it tagged; the browser gives no status
    // for a cross-origin failure and never will, so neither may we.
    const fault = sendFaultFor(new PortalStorageError('Failed to fetch'));
    expect(fault.reason).toBe('storage-unreachable');
    expect(fault.code).toBeNull();
    expect(fault.detail).toBeNull();
  });

  it('separates storage ANSWERING with a refusal from storage never answering', () => {
    // A status means the request got there. The two cannot share a sentence:
    // one blames the connection, and the other proves the connection worked.
    expect(sendFaultFor(new PortalStorageError('Upload rejected by storage (403)', 403)).reason).toBe(
      'storage-refused',
    );
  });

  it('does not blame storage when it was OUR API that could not be reached', () => {
    // `http-client.ts` throws a bare NtTransportError for our own two calls.
    // Telling the client their upload could not reach storage would name the
    // wrong host and offer the wrong remedy.
    expect(sendFaultFor(new NtTransportError('Network request failed')).reason).toBe('api-unreachable');
  });

  it('falls back to a reportable server fault for anything unrecognised', () => {
    expect(sendFaultFor(new Error('boom')).reason).toBe('server');
    expect(sendFaultFor(problem(500, 'NT-SRV-001')).reason).toBe('server');
  });
});

describe('groupFaults', () => {
  it('collapses one reason shared by several files into one line', () => {
    const lapsed = sendFaultFor(problem(402, 'NT-BIL-001'));
    const groups = groupFaults([lapsed, lapsed, lapsed]);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.count).toBe(3);
  });

  it('keeps two genuinely different refusals apart', () => {
    const groups = groupFaults([
      sendFaultFor(problem(400, 'NT-VAL-001', 'too big')),
      sendFaultFor(problem(400, 'NT-VAL-001', 'wrong type')),
    ]);
    expect(groups).toHaveLength(2);
  });
});

// The Capture surface's own headline, byte-identical to the real descriptor so
// that this file can never become a conflicting duplicate id if the extractor
// is ever pointed at tests.
const headline = defineMessages({
  h: {
    id: 'portal.livePortalCapture.sendFault',
    defaultMessage:
      '{count, plural, one {# photo did not send} other {# photos did not send}} — they are still here.',
  },
}).h;

function renderNotice(faults: ReturnType<typeof sendFaultFor>[]) {
  return render(
    <AppIntlProvider>
      <PortalSendFaultNotice failures={faults} headline={headline} onSubscribe={() => {}} busy={false} />
    </AppIntlProvider>,
  );
}

describe('PortalSendFaultNotice — the reason reaches the screen', () => {
  it('THE REGRESSION: a lapsed subscription no longer reads as "try again"', () => {
    renderNotice([sendFaultFor(problem(402, 'NT-BIL-001'))]);
    // The code is on screen for the client to quote…
    expect(screen.getByText(/NT-BIL-001/)).toBeTruthy();
    // …and so is the one control that actually resolves it (D48 — the client
    // is the payer). Neither was reachable from this surface before.
    expect(screen.getByRole('button')).toBeTruthy();
    expect(document.body.textContent).toMatch(/subscription is not active/i);
  });

  it('⚠ shows NO reference for an opaque storage failure, and does not guess', () => {
    renderNotice([sendFaultFor(new PortalStorageError('Failed to fetch'))]);
    const text = document.body.textContent ?? '';
    expect(text).toMatch(/could not reach our storage/i);
    // A reference would be fabricated — there is no status behind a
    // cross-origin failure — and blaming the client's connection would be a
    // guess. Both are asserted absent, which is the whole point of the split.
    expect(text).not.toMatch(/Reference/);
    expect(text).not.toMatch(/check your connection/i);
  });

  it('names the file count only when the reasons genuinely differ', () => {
    renderNotice([sendFaultFor(problem(402, 'NT-BIL-001')), sendFaultFor(problem(400, 'NT-VAL-001', 'too big'))]);
    const text = document.body.textContent ?? '';
    expect(text).toMatch(/subscription is not active/i);
    expect(text).toMatch(/too big/);
  });

  it('renders nothing at all when nothing failed', () => {
    const { container } = renderNotice([]);
    expect(container.textContent).toBe('');
  });
});
