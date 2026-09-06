import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { expect, test, vi, beforeEach } from 'vitest';

import { AppIntlProvider } from '../../i18n/AppIntlProvider';
import { PortalDocumentList } from './PortalDocumentList';
import type { PortalSentDocument, PortalSentPage } from '../../api/onboarding';

/**
 * **The client's browsable document list** — review item 18.
 *
 * > *"there is option to see how many document is sent but no option to see the
 * > actual list of sent document with preview option download option"*
 *
 * What is pinned here, in order of cost-to-lose:
 *
 * 1. **A row can be OPENED**, and the open goes through
 *    `fetchPortalDocumentOriginal` — which is the whole item. It shipped as an
 *    inert row, and before 7 Sep the server would have answered every press with
 *    a 404 anyway (the grant held only the current sign-in's uploads).
 * 2. **A refusal says something honest and blames nobody.** The server answers
 *    ONE 404 for "not this client's" and for "your accountant took it back", so
 *    the copy may not claim to know which.
 * 3. **⚠ The practice's working state never reaches this screen.** `state`,
 *    `inbox`, `categoryCode` and `failureCode` are absent from `PortalDocument`
 *    by design; this asserts over the rendered text that none of that vocabulary
 *    appears, which is the guard that survives somebody widening the projection.
 * 4. **The two empties are different sentences** — nothing sent at all versus
 *    nothing matching the filter.
 */

vi.mock('../../api/onboarding', async () => {
  const actual = await vi.importActual<typeof import('../../api/onboarding')>('../../api/onboarding');
  return { ...actual, fetchPortalDocumentOriginal: vi.fn() };
});

const { fetchPortalDocumentOriginal } = await import('../../api/onboarding');

function doc(over: Partial<PortalSentDocument> = {}): PortalSentDocument {
  return {
    id: 'doc_1',
    supplier: 'Bidfood',
    date: '22 Aug 2026',
    total: 512.3,
    currency: 'GBP',
    channel: 'SMS_PORTAL',
    status: 'with_accountant',
    receivedAt: '2026-08-22T09:00:00.000Z',
    ...over,
  };
}

function show(page: PortalSentPage | null, props: Partial<Parameters<typeof PortalDocumentList>[0]> = {}) {
  return render(
    <AppIntlProvider>
      <PortalDocumentList
        documents={page}
        documentsFault={null}
        sessionToken="portal-bearer"
        emptyMessage="Nothing sent yet."
        {...props}
      />
    </AppIntlProvider>,
  );
}

beforeEach(() => {
  vi.mocked(fetchPortalDocumentOriginal).mockReset();
});

test('a row opens its original through the portal bearer, and shows it', async () => {
  vi.mocked(fetchPortalDocumentOriginal).mockResolvedValue({
    url: 'https://storage.local/w/biz/documents/doc_1?sig=x',
    mimeType: 'image/jpeg',
    filename: 'bidfood.jpg',
  });

  show({ rows: [doc()], hasMore: false });
  fireEvent.click(screen.getByRole('button', { name: 'Open' }));

  await waitFor(() => expect(screen.getByRole('dialog')).toBeInTheDocument());
  expect(fetchPortalDocumentOriginal).toHaveBeenCalledWith('portal-bearer', 'doc_1');

  // ⚠ The URL is bearer authority over a financial record with no session
  // behind it. Every element that touches it refuses to leak it as a Referer —
  // the rule `DocumentViewer` states in full, and the only mechanical guard it
  // has on this surface.
  const image = screen.getByRole('dialog').querySelector('img');
  expect(image?.getAttribute('referrerpolicy')).toBe('no-referrer');
  const download = screen.getByRole('link', { name: 'Download' });
  expect(download.getAttribute('rel')).toBe('noreferrer noopener');
  expect(download.getAttribute('href')).toContain('sig=x');
});

test('a PDF is handed to the browser as a real anchor, never framed', async () => {
  vi.mocked(fetchPortalDocumentOriginal).mockResolvedValue({
    url: 'https://storage.local/w/biz/documents/doc_1?sig=x',
    mimeType: 'application/pdf',
    filename: 'biffa.pdf',
  });

  show({ rows: [doc()], hasMore: false });
  fireEvent.click(screen.getByRole('button', { name: 'Open' }));
  await waitFor(() => expect(screen.getByRole('dialog')).toBeInTheDocument());

  // ⚠ No frame. iOS Safari shows the first page of a framed PDF and no way to
  // the rest, and some Android WebViews show a blank white box — on the one
  // surface in this product that is phone-first. See the component's header.
  expect(screen.getByRole('dialog').querySelector('iframe')).toBeNull();

  // A real link instead, which is also what makes it work: the presigned URL is
  // fetched on the press, so the gesture has expired and a `window.open` would
  // be blocked. The client's click on THIS is a fresh one.
  const open = screen.getByRole('link', { name: 'Open in a new tab' });
  expect(open.getAttribute('rel')).toBe('noreferrer noopener');
  expect(open.getAttribute('target')).toBe('_blank');
});

test('a refused open blames nobody — the server answers ONE 404 for two different facts', async () => {
  vi.mocked(fetchPortalDocumentOriginal).mockRejectedValue(new Error('404'));

  show({ rows: [doc()], hasMore: false });
  fireEvent.click(screen.getByRole('button', { name: 'Open' }));

  await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());
  const said = screen.getByRole('alert').textContent ?? '';
  expect(said).toContain('could not open');
  // Neither of the two things a 404 might mean may be asserted as the reason.
  expect(said).not.toMatch(/not allowed|permission|deleted|does not exist/i);
});

test('⚠ the practice’s working state never reaches a client’s screen', () => {
  show({
    rows: [
      doc({ id: 'a', status: 'processing', channel: 'EMAIL' }),
      doc({ id: 'b', status: 'needs_another_copy', channel: 'WHATSAPP', supplier: null, date: null, total: null }),
      doc({ id: 'c', status: 'filed', channel: 'WEB_UPLOAD' }),
    ],
    hasMore: false,
  });

  // The client's own five words, and how it arrived, in their words.
  expect(screen.getByText('Processing')).toBeInTheDocument();
  expect(screen.getByText('Needs another copy')).toBeInTheDocument();
  expect(screen.getByText('Filed')).toBeInTheDocument();

  // And nothing of the firm's. `PortalDocument` carries none of this, and the
  // day somebody widens it this is what fails.
  const text = document.body.textContent ?? '';
  for (const internal of ['TO_REVIEW', 'PUBLISHED', 'RECEIVED', 'REJECTED', 'ARCHIVED', 'COS_', 'NT-DOC', 'SMS_PORTAL', 'WEB_UPLOAD']) {
    expect(text).not.toContain(internal);
  }
});

test('the two empties are different sentences', () => {
  const { unmount } = show({ rows: [], hasMore: false }, { browse: true });
  expect(screen.getByText('Nothing sent yet.')).toBeInTheDocument();
  unmount();

  show({ rows: [doc({ status: 'filed' })], hasMore: false }, { browse: true });
  fireEvent.click(screen.getByRole('button', { name: 'Needs another copy' }));
  // Nothing matches the filter — which is NOT "you have never sent anything".
  expect(screen.getByText('Nothing with that status.')).toBeInTheDocument();
  expect(screen.queryByText('Nothing sent yet.')).not.toBeInTheDocument();
});

test('without a session token there is nothing to open with, so the affordance is absent rather than broken', () => {
  show({ rows: [doc()], hasMore: false }, { sessionToken: null });
  expect(screen.queryByRole('button', { name: 'Open' })).not.toBeInTheDocument();
  expect(screen.getByText('Bidfood')).toBeInTheDocument();
});
