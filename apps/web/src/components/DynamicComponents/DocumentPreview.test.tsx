import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';

import { DocumentPreview } from './DocumentPreview';
import { AppIntlProvider } from '../../i18n/AppIntlProvider';
import type { DocumentDetail } from '../../api/document-detail';
import type { Document } from '../../lib/types';

/**
 * The live document detail: hover provenance over the real original, the
 * honest Path-to-Ready panel, and the staged `document.update-coding`
 * proposal — the only door a state change has (Governance §10).
 */

// Live mode for the whole file: the fork inside DocumentPreview is on data
// source, and these tests are about the live branch.
vi.mock('../../api/config', () => ({
  API_ENABLED: true,
  API_MOCKED: false,
  API_BASE_URL: '',
  dataSourceLabel: () => 'live API' as const,
}));

vi.mock('../../context/AppContext', () => ({
  useAppContext: () => ({ updateDocumentField: vi.fn(), logAudit: vi.fn() }),
}));

const updateCodingProposal = vi.fn(async (_request: unknown) => {});

// The hook is replaced (each test hands it the detail it needs); the pure
// helpers — parseCodingDraft, isEditableLabel — stay real, because the staged
// proposal's payload shape is exactly what is under test.
let detail: DocumentDetail;
let bankMatch: import('../../api/bank-match').DocumentBankMatchResult = { match: null, loading: false, error: false, refetch: () => {} };
const confirmBankMatch = vi.fn(async (_documentId: unknown, _match: unknown) => {});
// Offline by construction: the real hook would open a socket from jsdom.
// Default: no match — the section renders nothing; tests override `bankMatch`.
vi.mock('../../api/bank-match', () => ({
  useDocumentBankMatch: () => bankMatch,
  confirmDocumentBankMatch: (documentId: unknown, match: unknown) => confirmBankMatch(documentId, match),
}));

vi.mock('../../api/document-detail', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api/document-detail')>();
  return {
    ...actual,
    useDocumentDetail: () => detail,
    updateCodingProposal: (request: unknown) => updateCodingProposal(request as never),
    refreshDocument: vi.fn(async () => {}),
  };
});

afterEach(() => vi.clearAllMocks());

const LONG_DESCRIPTION =
  'Microsoft 365 Business Standard - Annual Subscription (May 12, 2025 – May 11, 2026)';

const doc: Document = {
  id: 'doc_f404e752a4fbb629b203dc04',
  clientId: 'biz_burger',
  clientName: 'American Burger',
  supplier: 'Nexora Solutions LLC',
  date: '12 May 2025',
  total: 54352.51,
  category: '—',
  status: 'review',
  source: 'web',
  uploader: 'Shakib',
  currency: 'USD',
  kind: 'cost',
  fields: [],
  lineItems: [],
};

function liveDetail(over: Partial<DocumentDetail> = {}): DocumentDetail {
  return {
    fields: [
      { label: 'Supplier', value: 'Nexora Solutions LLC', confidence: 0.95, provenance: 'AI suggested: bedrock' },
      // Blank provenance on purpose: the caption must fall back honestly.
      { label: 'Total', value: '£54,352.51', confidence: 0.93, provenance: '  ' },
      { label: 'Category', value: '—', confidence: 1, provenance: 'AI suggested: extraction' },
    ],
    lineItems: [{ description: LONG_DESCRIPTION, quantity: 150, total: 22500, tax: 0 }],
    state: 'TO_REVIEW',
    businessId: 'biz_burger',
    // The default is the world before this change: an uncoded document with
    // nothing said about why. Individual tests override it.
    codingSuggestion: null,
    // The correction checks' raw header snapshot — a plain INVOICE by default,
    // so no check fires unless a test makes one.
    checkContext: {
      docType: 'INVOICE',
      totalPence: 5_435_251,
      taxPence: 0,
      documentDate: '2025-05-12',
      currency: 'USD',
      extractionHadValues: true,
    },
    isLoading: false,
    contractError: null,
    image: { url: 'https://example.test/original.png', mimeType: 'image/png', filename: 'invoice.png' },
    events: [],
    ...over,
  };
}

function renderPreview(over: Partial<Document> = {}) {
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <AppIntlProvider>
        <DocumentPreview document={{ ...doc, ...over }} />
      </AppIntlProvider>
    </QueryClientProvider>,
  );
}

test('hovering a live field with no boundingBox frames the whole original — never an invented position — and cites its provenance', () => {
  detail = liveDetail();
  renderPreview();

  expect(screen.queryByTestId('provenance-band')).toBeNull();

  // mouseOver bubbles, so React derives the row's onMouseEnter from it.
  fireEvent.mouseOver(screen.getByText('Supplier'));

  const band = screen.getByTestId('provenance-band');
  // No fabricated coordinate: without a box the band is the full frame, not a
  // hash-positioned strip.
  expect(band.style.top).toBe('');
  expect(band.className).toContain('inset-0');
  expect(screen.getByText('AI suggested: bedrock')).toBeTruthy();
});

/** Tell jsdom the original has loaded at the given pixel size, firing onLoad. */
function loadOriginal(naturalWidth: number, naturalHeight: number) {
  const img = screen.getByRole('img');
  Object.defineProperty(img, 'naturalWidth', { value: naturalWidth, configurable: true });
  Object.defineProperty(img, 'naturalHeight', { value: naturalHeight, configurable: true });
  Object.defineProperty(img, 'complete', { value: true, configurable: true });
  fireEvent.load(img);
}

const SUPPLIER_BOX = { page: 1, x: 0.1, y: 0.2, width: 0.3, height: 0.05 };

test('a field whose boundingBox is on the displayed page paints the band AT that position', () => {
  detail = liveDetail({
    fields: [
      { label: 'Supplier', value: 'Nexora Solutions LLC', confidence: 0.95, provenance: 'AI suggested: bedrock', boundingBox: SUPPLIER_BOX },
      { label: 'Total', value: '£54,352.51', confidence: 0.93, provenance: 'AI suggested: bedrock' },
      { label: 'Category', value: '—', confidence: 1, provenance: 'AI suggested: extraction' },
    ],
  });
  renderPreview();

  // 750×1000 is exactly the frame's 3:4, so no letterboxing: the normalised
  // box maps straight to container percentages.
  loadOriginal(750, 1000);
  fireEvent.mouseOver(screen.getByText('Supplier'));

  const band = screen.getByTestId('provenance-band');
  expect(band.className).not.toContain('inset-0');
  // jsdom's CSSOM normalises "10.000%" to "10%" — the numbers are what matter.
  expect(band.style.left).toBe('10%');
  expect(band.style.top).toBe('20%');
  expect(band.style.width).toBe('30%');
  expect(band.style.height).toBe('5%');
});

test('a letterboxed original maps the box onto the rendered image, not the frame', () => {
  detail = liveDetail({
    fields: [
      { label: 'Supplier', value: 'Nexora Solutions LLC', confidence: 0.95, provenance: 'AI suggested: bedrock', boundingBox: SUPPLIER_BOX },
    ],
  });
  renderPreview();

  // A square image inside the 3:4 frame is letterboxed top and bottom: it
  // renders 75% tall, offset 12.5% — a band ignoring that would sit on the bar.
  loadOriginal(1000, 1000);
  fireEvent.mouseOver(screen.getByText('Supplier'));

  const band = screen.getByTestId('provenance-band');
  expect(band.style.left).toBe('10%');
  expect(band.style.top).toBe('27.5%'); // 12.5% offset + 20% of the 75% slice
  expect(band.style.height).toBe('3.75%'); // 5% of the 75% slice
});

test('a box on a page the preview is not showing falls back to the whole-frame band', () => {
  detail = liveDetail({
    fields: [
      { label: 'Supplier', value: 'Nexora Solutions LLC', confidence: 0.95, provenance: 'AI suggested: bedrock', boundingBox: { ...SUPPLIER_BOX, page: 2 } },
    ],
  });
  renderPreview();

  loadOriginal(750, 1000);
  fireEvent.mouseOver(screen.getByText('Supplier'));

  const band = screen.getByTestId('provenance-band');
  // The preview shows page 1; painting a page-2 position over it would mark
  // the wrong paper. Whole frame, existing caption.
  expect(band.style.top).toBe('');
  expect(band.className).toContain('inset-0');
  expect(screen.getByText('AI suggested: bedrock')).toBeTruthy();
});

test('until the image has loaded, a positioned band is withheld rather than painted over the letterbox', () => {
  detail = liveDetail({
    fields: [
      { label: 'Supplier', value: 'Nexora Solutions LLC', confidence: 0.95, provenance: 'AI suggested: bedrock', boundingBox: SUPPLIER_BOX },
    ],
  });
  renderPreview();

  // No loadOriginal: the aspect is unknown, so the mapping would be a guess.
  fireEvent.mouseOver(screen.getByText('Supplier'));

  const band = screen.getByTestId('provenance-band');
  expect(band.style.top).toBe('');
  expect(band.className).toContain('inset-0');
});

test('a field with no recorded provenance gets the honest fallback caption, not an empty line', () => {
  detail = liveDetail();
  renderPreview();

  fireEvent.mouseOver(screen.getByText('Total'));

  expect(screen.getByText(/its position on the page was not captured/)).toBeTruthy();
});

test('the Ready panel names the missing mandatory field and its edit stages the update-coding proposal', async () => {
  detail = liveDetail();
  renderPreview();

  // The server rule is Total + Supplier + Category; only Category is missing.
  expect(screen.getByText('Path to Ready')).toBeTruthy();
  expect(screen.getByText(/Ready needs a value for Category/)).toBeTruthy();
  expect(screen.getByText(/approving the correction that completes the set makes this document Ready/)).toBeTruthy();

  fireEvent.click(screen.getByRole('button', { name: 'Add Category' }));
  const input = screen.getByRole('textbox');
  fireEvent.change(input, { target: { value: '5100' } });
  fireEvent.keyDown(input, { key: 'Enter' });

  // The staged card is the Review → Approve gate: Approve is not mounted
  // until Read review has been opened.
  expect(await screen.findByText('Update coding')).toBeTruthy();
  expect(screen.queryByRole('button', { name: /Approve change/ })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: /Read review/ }));
  fireEvent.click(screen.getByRole('button', { name: /Approve change/ }));

  expect(updateCodingProposal).toHaveBeenCalledExactlyOnceWith({
    businessId: 'biz_burger',
    documentId: 'doc_f404e752a4fbb629b203dc04',
    fields: { categoryCode: '5100' },
  });
});

/** Stage a correction on Category and hand back the dialog it opens. */
async function stageCategoryCorrection(value = '5100') {
  fireEvent.click(screen.getByRole('button', { name: 'Add Category' }));
  const input = screen.getByRole('textbox');
  fireEvent.change(input, { target: { value } });
  fireEvent.keyDown(input, { key: 'Enter' });
  return screen.findByRole('dialog');
}

test('the staged correction is presented as a dialog, and Approve is STILL unmounted until Read review is opened', async () => {
  detail = liveDetail();
  renderPreview();

  // Nothing is on top of the document until a correction is staged.
  expect(screen.queryByRole('dialog')).toBeNull();

  const dialog = await stageCategoryCorrection();

  // The gate is the gate, in the dialog exactly as it was inline: the review
  // has not been opened, so [Approve change] does not exist to be pressed —
  // and nothing has reached the network either.
  expect(within(dialog).getByText('Update coding')).toBeTruthy();
  expect(within(dialog).queryByRole('button', { name: /Approve change/ })).toBeNull();
  expect(updateCodingProposal).not.toHaveBeenCalled();

  fireEvent.click(within(dialog).getByRole('button', { name: /Read review/ }));
  expect(within(dialog).getByRole('button', { name: /Approve change/ })).toBeTruthy();
});

test('Escape closes the dialog, creates nothing, and leaves the correction re-stageable', async () => {
  detail = liveDetail();
  renderPreview();

  await stageCategoryCorrection();

  // The dialog owns the key through the useEscape stack.
  fireEvent.keyDown(document, { key: 'Escape' });
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

  // Closing undecided is free: the proposal is minted by Approve and by
  // nothing else, so there is no pending record to cancel and no duplicate to
  // mint on the next visit.
  expect(updateCodingProposal).not.toHaveBeenCalled();

  // The door is still open — the Path-to-Ready button stages it again.
  const dialog = await stageCategoryCorrection();
  expect(within(dialog).getByText('Update coding')).toBeTruthy();
});

test('the dialog carries the review header without clipping it — full title and subtitle, both keyboard reachable', async () => {
  detail = liveDetail();
  renderPreview();

  const dialog = await stageCategoryCorrection();

  // The collision this dialog exists to end: the title read "Upd…" and the
  // subtitle wrapped under the button. Both are whole, and both carry their
  // own text as a title attribute rather than relying on width.
  expect(within(dialog).getByTitle('Update coding').textContent).toBe('Update coding');
  expect(within(dialog).getByTitle('Nexora Solutions LLC · Category')).toBeTruthy();
  // The frame's own dismissal is a real button, not a click-only scrim.
  expect(within(dialog).getByRole('button', { name: 'Close' })).toBeTruthy();
});

test('with every required field present the panel is honest about the missing confirm path and offers no dead button', () => {
  detail = liveDetail({
    fields: [
      { label: 'Supplier', value: 'Nexora Solutions LLC', confidence: 0.95, provenance: 'AI suggested: bedrock' },
      { label: 'Total', value: '£54,352.51', confidence: 0.93, provenance: 'AI suggested: bedrock' },
      { label: 'Category', value: '5100', confidence: 1, provenance: 'human confirmed' },
    ],
  });
  renderPreview();

  expect(screen.getByText(/has no proposal path yet/)).toBeTruthy();
  // No "confirm as-is" button exists to press: the payload cannot express it
  // (equal values collapse to zero changes server-side), so a button here
  // would be a control whose write does nothing.
  expect(screen.queryByRole('button', { name: /confirm/i })).toBeNull();
  expect(screen.queryByRole('button', { name: /^Add / })).toBeNull();
});

test('the panel exists only for To Review documents', () => {
  detail = liveDetail({ state: 'READY' });
  renderPreview();

  expect(screen.queryByText('Path to Ready')).toBeNull();
});

test('truncated values carry their full text as titles', () => {
  detail = liveDetail();
  renderPreview();

  // Twice: the header name and the Supplier field value both truncate.
  expect(screen.getAllByTitle('Nexora Solutions LLC').length).toBeGreaterThanOrEqual(2);
  expect(screen.getByTitle(LONG_DESCRIPTION)).toBeTruthy();
});

test('no bank-match section renders — the contract exposes no match read surface to build one from', () => {
  // Survey verdict, pinned: `BankTransaction` carries `matchState` but no
  // document id, and no endpoint exposes a suggested or confirmed match for a
  // document. Until that read surface exists (G7), the preview says nothing
  // about transactions rather than fabricating a pairing.
  detail = liveDetail();
  renderPreview();

  expect(screen.queryByText(/transaction/i)).toBeNull();
});

test('a suggested bank match renders with its line and Confirm stages the three-call ritual', async () => {
  detail = liveDetail();
  bankMatch = {
    match: {
      matchId: 'match_1',
      state: 'SUGGESTED',
      kind: 'EXACT',
      amount: -1299,
      date: '09 Aug 2026',
      label: 'Currys',
      transactionId: 'txn_003',
      businessId: 'biz_burger',
      confidence: 1,
    },
    loading: false,
    error: false,
    refetch: () => {},
  };
  renderPreview();

  expect(screen.getByText('Suggested bank match')).toBeTruthy();
  expect(screen.getByText(/Currys/)).toBeTruthy();

  fireEvent.click(screen.getByRole('button', { name: /Confirm match/ }));
  await waitFor(() => expect(confirmBankMatch).toHaveBeenCalledTimes(1));
  expect(confirmBankMatch.mock.calls[0]?.[0]).toBe(doc.id);
  bankMatch = { match: null, loading: false, error: false, refetch: () => {} };
});

test('a CONFIRMED match renders as matched, with no confirm button', () => {
  detail = liveDetail();
  bankMatch = {
    match: {
      matchId: 'match_1',
      state: 'CONFIRMED',
      kind: 'EXACT',
      amount: -1299,
      date: '09 Aug 2026',
      label: 'Currys',
      transactionId: 'txn_003',
      businessId: 'biz_burger',
      confidence: 1,
    },
    loading: false,
    error: false,
    refetch: () => {},
  };
  renderPreview();

  expect(screen.getByText('Matched bank transaction')).toBeTruthy();
  expect(screen.queryByRole('button', { name: /Confirm match/ })).toBeNull();
  bankMatch = { match: null, loading: false, error: false, refetch: () => {} };
});

/* ── the coding ladder's answer, on the screen that had an em dash ────────── */

const SUGGESTION = {
  outcome: 'SUGGEST' as const,
  basis: 'SUBSCRIPTION_TERM_UNDER_TWO_YEARS',
  note: 'Suggested — not applied — as Software subscriptions, on an annual term stated on the document.',
  categoryCode: 'SOFTWARE_SUBSCRIPTIONS',
  analysisAccount: 'Overheads: Software subscriptions',
  confidence: 0.82,
  escalationReason: null,
  candidateCategoryCodes: [],
};

const ESCALATION = {
  outcome: 'ESCALATE' as const,
  basis: 'NOTHING_MATCHED',
  note: 'The licence term is not stated on this document, so it cannot be settled as capital or revenue.',
  categoryCode: null,
  analysisAccount: null,
  confidence: null,
  escalationReason: 'SOFTWARE_TERM_UNKNOWN',
  candidateCategoryCodes: [],
};

test('an ESCALATION renders the engine’s sentence where the blank Category was — the reported bug', () => {
  detail = liveDetail({ codingSuggestion: ESCALATION });
  renderPreview();

  // What the accountant used to get: an em dash and nothing else. What they get
  // now: the named reason, worded by the engine that took the decision.
  expect(screen.getByText('No category suggested — here is why')).toBeTruthy();
  expect(screen.getByText(ESCALATION.note)).toBeTruthy();
  expect(screen.getByText(/NOTHING_MATCHED/)).toBeTruthy();

  // ⚠ An escalation offers no accept — there is nothing to accept.
  expect(screen.queryByRole('button', { name: /Accept this category/ })).toBeNull();

  // ⚠ And it is still honestly missing: a reason is not a category.
  expect(screen.getByText(/Ready needs a value for Category/)).toBeTruthy();
});

test('a SUGGESTION shows the code, its confidence and its working — and the Category row still reads “—”', () => {
  detail = liveDetail({ codingSuggestion: SUGGESTION });
  renderPreview();

  const panel = screen.getByTestId('coding-suggestion');
  expect(within(panel).getByText('Suggested category — not applied')).toBeTruthy();
  expect(within(panel).getByText(SUGGESTION.note)).toBeTruthy();
  expect(within(panel).getByText(/Overheads: Software subscriptions/)).toBeTruthy();
  expect(within(panel).getByText('82% confident')).toBeTruthy();
  expect(within(panel).getByText(/SUBSCRIPTION_TERM_UNDER_TWO_YEARS/)).toBeTruthy();

  // ⚠ THE INVARIANT. A suggestion is an opinion, so the document is exactly as
  // far from Ready as it was before the ladder said anything.
  expect(screen.getByText(/Ready needs a value for Category/)).toBeTruthy();
});

test('accepting a suggestion goes through Read review → Approve — unchanged, and not shortcut', async () => {
  detail = liveDetail({ codingSuggestion: SUGGESTION });
  renderPreview();

  fireEvent.click(screen.getByRole('button', { name: /Accept this category/ }));

  // The SAME gate a typed correction meets: Approve is not merely disabled
  // before the review is opened — it is not in the DOM.
  expect(await screen.findByText('Update coding')).toBeTruthy();
  expect(screen.queryByRole('button', { name: /Approve change/ })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: /Read review/ }));
  fireEvent.click(screen.getByRole('button', { name: /Approve change/ }));

  // The suggested CODE is what travels, never the analysis account label and
  // never a note — the same `UpdateCodingPayload` a typed correction carries.
  expect(updateCodingProposal).toHaveBeenCalledExactlyOnceWith({
    businessId: 'biz_burger',
    documentId: 'doc_f404e752a4fbb629b203dc04',
    fields: { categoryCode: 'SOFTWARE_SUBSCRIPTIONS' },
  });
});

test('a published document is offered no accept — its coding is locked server-side', () => {
  detail = liveDetail({ codingSuggestion: SUGGESTION });
  renderPreview({ status: 'published' });

  // The affordance goes rather than the refusal being discovered on approve.
  expect(screen.queryByTestId('coding-suggestion')).toBeNull();
});

test('no suggestion renders no panel at all', () => {
  detail = liveDetail();
  renderPreview();
  expect(screen.queryByTestId('coding-suggestion')).toBeNull();
});

/* ── the correction-integrity layer (items 22/36/46/47) ────────────────────── */

test('a warned correction opens on the WARNING, not the review — Ignore proceeds with the typed value, restated on the card', async () => {
  // The item-47 shape: money/category typed onto a document the pipeline read
  // as not a financial document.
  detail = liveDetail({
    checkContext: {
      docType: 'OTHER',
      totalPence: null,
      taxPence: null,
      documentDate: null,
      currency: 'GBP',
      extractionHadValues: false,
    },
  });
  renderPreview();

  const dialog = await stageCategoryCorrection();

  // The warning step, with exactly the two actions the ruling names — and no
  // review affordance behind it: [Read review] is not in the DOM yet.
  expect(within(dialog).getByText(/does not appear to be a financial document/)).toBeTruthy();
  expect(within(dialog).queryByRole('button', { name: /Read review/ })).toBeNull();
  expect(within(dialog).queryByRole('button', { name: /Approve change/ })).toBeNull();

  fireEvent.click(within(dialog).getByRole('button', { name: /Ignore — I’m sure/ }));

  // The ordinary Review → Approve card. Opening the review RESTATES the
  // ignored warning inside it (the server puts the same checks on the
  // proposal's own review render).
  expect(await within(dialog).findByText('Update coding')).toBeTruthy();
  fireEvent.click(within(dialog).getByRole('button', { name: /Read review/ }));
  expect(within(dialog).getByRole('alert').textContent).toContain('does not appear to be a financial document');
  fireEvent.click(within(dialog).getByRole('button', { name: /Approve change/ }));

  // Ignore proceeded with the ORIGINAL typed value — nothing was rewritten.
  expect(updateCodingProposal).toHaveBeenCalledExactlyOnceWith({
    businessId: 'biz_burger',
    documentId: 'doc_f404e752a4fbb629b203dc04',
    fields: { categoryCode: '5100' },
  });
});

test('[Go back and fix] returns the value to the field it came from, staging nothing', async () => {
  detail = liveDetail({
    checkContext: {
      docType: 'OTHER',
      totalPence: null,
      taxPence: null,
      documentDate: null,
      currency: 'GBP',
      extractionHadValues: false,
    },
  });
  renderPreview();

  const dialog = await stageCategoryCorrection();
  fireEvent.click(within(dialog).getByRole('button', { name: /Go back and fix/ }));

  // The dialog is gone, the edit input is back with the typed value, and no
  // proposal was ever created.
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  expect((screen.getByRole('textbox') as HTMLInputElement).value).toBe('5100');
  expect(updateCodingProposal).not.toHaveBeenCalled();
});

test('a clean correction never meets the warning step — the dialog opens straight on the review card', async () => {
  detail = liveDetail();
  renderPreview();
  const dialog = await stageCategoryCorrection();
  expect(within(dialog).getByText('Update coding')).toBeTruthy();
  expect(within(dialog).queryByRole('button', { name: /Ignore — I’m sure/ })).toBeNull();
});

test('a human-confirmed field reads "Confirmed by you", never a percentage (item 22)', () => {
  detail = liveDetail({
    fields: [
      {
        label: 'Tax amount',
        value: '$9,000.00',
        confidence: 1,
        provenance: 'human confirmed — corrected in review',
        humanConfirmed: true,
      },
      { label: 'Total', value: '$54,352.51', confidence: 0.93, provenance: 'AI suggested: bedrock' },
    ],
  });
  renderPreview();

  expect(screen.getByText('Confirmed by you')).toBeTruthy();
  // The machine-read row keeps its percentage; the human row must not have one.
  expect(screen.getByText('93% confident')).toBeTruthy();
  expect(screen.queryByText('100% confident')).toBeNull();
});

test('the Type gate is the Path-to-Ready panel’s FIRST line for an OTHER document (items 36/47)', () => {
  detail = liveDetail({
    fields: [
      { label: 'Supplier', value: 'gf', confidence: 1, provenance: 'human confirmed', humanConfirmed: true },
      { label: 'Total', value: '£76,543.00', confidence: 1, provenance: 'human confirmed', humanConfirmed: true },
      { label: 'Category', value: '—', confidence: 0, provenance: 'AI suggested: extraction' },
      { label: 'Type', value: 'OTHER', confidence: 0, provenance: 'AI suggested: extraction' },
    ],
    checkContext: {
      docType: 'OTHER',
      totalPence: 7_654_300,
      taxPence: null,
      documentDate: null,
      currency: 'GBP',
      extractionHadValues: false,
    },
  });
  renderPreview();

  const panel = screen.getByText('Path to Ready').parentElement as HTMLElement;
  expect(within(panel).getByText(/cannot be Ready until its Type is corrected to a financial type/)).toBeTruthy();
  // The gate leads: its sentence renders before the missing-fields offer.
  const text = panel.textContent ?? '';
  expect(text.indexOf('cannot be Ready until its Type')).toBeLessThan(text.indexOf('Ready needs a value for'));
  // And it offers the correction that answers it.
  expect(within(panel).getByRole('button', { name: /Correct the Type/ })).toBeTruthy();
});

test('an OTHER document wears the D46 flag on the preview header (item 47)', () => {
  detail = liveDetail();
  renderPreview({ docType: 'OTHER' });
  expect(screen.getByText('Not a financial document')).toBeTruthy();
});
