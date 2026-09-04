import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';

import DocumentViewer from './DocumentViewer';
import { AppIntlProvider } from '../../i18n/AppIntlProvider';
import type { Document } from '../../lib/types';

/**
 * The viewer is the surface the Documents screen was missing, and four of its
 * behaviours are the ones a test has to hold:
 *
 * 1. **`rel="noreferrer noopener"` on the download.** The URL is presigned —
 *    bearer authority over one of a client's financial records with no session
 *    behind it — and a `Referer` would carry it wherever the tab goes next.
 *    `ExportView.test.tsx` pins the identical rule on the identical reasoning;
 *    this is the second place in the app where a signed URL reaches an anchor.
 * 2. **Next / previous is keyboard-driven**, because an accountant walking a
 *    stack of receipts should not be reaching for a mouse between each one.
 * 3. **Rotation exists and is a view, not a write.** A phone photograph arrives
 *    sideways constantly; the original is never touched.
 * 4. **A new document resets the view.** A 400% zoom left over from the last
 *    receipt opens the next one into the middle of nowhere, and a rotation is
 *    not a claim about the following document.
 */

let live = true;
let image: { url: string; mimeType: string; filename: string | null } | null = null;
let contractError: string | null = null;

vi.mock('../../api/config', () => ({
  get API_ENABLED() {
    return live;
  },
}));

vi.mock('../../api/document-detail', () => ({
  useDocumentDetail: () => ({
    fields: [{ label: 'Total', value: '£420.00', confidence: 0.97, provenance: '' }],
    lineItems: [],
    state: 'TO_REVIEW',
    businessId: 'biz_nexora',
    codingSuggestion: null,
    events: [],
    image,
    isLoading: false,
    contractError,
  }),
}));

afterEach(() => {
  vi.clearAllMocks();
  live = true;
  image = null;
  contractError = null;
});

function doc(over: Partial<Document> = {}): Document {
  return {
    id: 'doc_1',
    clientId: 'biz_nexora',
    clientName: 'Nexora Solutions LLC',
    supplier: 'Bidfood',
    date: '14 Aug 2026',
    total: 420,
    category: 'Food & drink',
    status: 'review',
    source: 'email',
    uploader: 'invoice.jpg',
    currency: 'GBP',
    kind: 'cost',
    fields: [],
    lineItems: [],
    ...over,
  };
}

const DOCS = [doc(), doc({ id: 'doc_2', supplier: 'Currys' }), doc({ id: 'doc_3', supplier: 'Screwfix' })];

function open(index = 0) {
  const onIndex = vi.fn();
  const view = render(
    <AppIntlProvider>
      <DocumentViewer documents={DOCS} index={index} onIndex={onIndex} onClose={vi.fn()} />
    </AppIntlProvider>,
  );
  return { onIndex, view };
}

/* ── 1. the presigned URL never leaks through a Referer ─────────────────── */

test('⚠ the download anchor carries rel="noreferrer noopener" — the URL is a bearer credential', () => {
  image = { url: 'https://storage.example/doc_1.jpg?X-Amz-Signature=deadbeef', mimeType: 'image/jpeg', filename: 'invoice.jpg' };
  open();

  const link = screen.getByRole('link', { name: 'Download the original' });
  expect(link.getAttribute('rel')).toBe('noreferrer noopener');
  expect(link.getAttribute('href')).toContain('X-Amz-Signature');
});

test('a PDF is embedded with referrerPolicy="no-referrer" — the frame form of the same rule', () => {
  image = { url: 'https://storage.example/doc_1.pdf?X-Amz-Signature=deadbeef', mimeType: 'application/pdf', filename: null };
  open();

  const frame = screen.getByTitle('The original document, as a PDF');
  expect(frame.getAttribute('referrerpolicy')).toBe('no-referrer');
});

/* ── 2. walking the stack from the keyboard ─────────────────────────────── */

test('the arrow keys move through the stack without leaving the viewer', () => {
  const { onIndex } = open(1);

  expect(screen.getByText('2 of 3')).toBeTruthy();

  fireEvent.keyDown(document, { key: 'ArrowRight' });
  expect(onIndex).toHaveBeenCalledWith(2);

  fireEvent.keyDown(document, { key: 'ArrowLeft' });
  expect(onIndex).toHaveBeenLastCalledWith(0);
});

test('the ends of the stack are ends — no wrap, and the buttons say so', () => {
  const { onIndex } = open(0);

  expect(screen.getByRole('button', { name: 'Previous document' }).hasAttribute('disabled')).toBe(true);
  fireEvent.keyDown(document, { key: 'ArrowLeft' });
  expect(onIndex).not.toHaveBeenCalled();
});

test('a shortcut never fires while somebody is typing', () => {
  const { onIndex } = open(0);
  const input = document.createElement('input');
  document.body.appendChild(input);
  fireEvent.keyDown(input, { key: 'ArrowRight' });
  expect(onIndex).not.toHaveBeenCalled();
  input.remove();
});

/* ── 3 & 4. zoom and rotation, and the reset between documents ──────────── */

test('zoom and rotation are offered, act on the view, and reset when the document changes', () => {
  image = { url: 'https://storage.example/doc_1.jpg', mimeType: 'image/jpeg', filename: 'invoice.jpg' };
  const { view } = open(0);

  const original = screen.getByRole('img');
  expect(original.getAttribute('style')).toContain('rotate(0deg)');
  expect(screen.getByText('100%')).toBeTruthy();

  // The sideways phone photograph, put right.
  fireEvent.click(screen.getByRole('button', { name: 'Rotate right' }));
  expect(screen.getByRole('img').getAttribute('style')).toContain('rotate(90deg)');

  fireEvent.click(screen.getByRole('button', { name: 'Zoom in' }));
  expect(screen.getByText('150%')).toBeTruthy();

  // ⚠ Moving to the next document is a new view. A rotation is not a claim
  // about the following receipt, and a 400% zoom would open it onto nothing.
  view.rerender(
    <AppIntlProvider>
      <DocumentViewer documents={DOCS} index={1} onIndex={vi.fn()} onClose={vi.fn()} />
    </AppIntlProvider>,
  );
  fireEvent.keyDown(document, { key: 'ArrowRight' });
  expect(screen.getByText('100%')).toBeTruthy();
  expect(screen.getByRole('img').getAttribute('style')).toContain('rotate(0deg)');
});

/* ── the four states ────────────────────────────────────────────────────── */

test('a contract failure is an alert with the server’s own words, not a blank stage', () => {
  contractError = 'NT-VAL-001 — acceptedExtraction: Required';
  open();
  expect(screen.getByRole('alert').textContent).toContain('NT-VAL-001');
});

test('no original is said plainly, and never as an error', () => {
  image = null;
  open();
  expect(screen.getByText('No original to show')).toBeTruthy();
  expect(screen.queryByRole('alert')).toBeNull();
});

test('synthetic mode still walks: a stand-in stage, and every control still works', () => {
  live = false;
  open();

  expect(screen.getByText('Demonstration document')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Rotate left' }));
  expect(screen.getByRole('button', { name: 'Next document' })).toBeTruthy();
  // No original means nothing to download, and no button claiming otherwise.
  expect(screen.queryByRole('link', { name: 'Download the original' })).toBeNull();
});
