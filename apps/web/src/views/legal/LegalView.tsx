import { useEffect, useState } from 'react';
import { ArrowLeft, ArrowRight, RefreshCw, ScrollText } from 'lucide-react';
import { defineMessages, useIntl } from 'react-intl';
import type { MessageDescriptor } from 'react-intl';
import { Wordmark } from '../../assets/Wordmark';
import { linkProps, usePath } from '../../lib/router';
import { LEGAL_SLUGS, isLegalSlug, legalPath, loadLegalDoc } from './documents';
import type { LegalDoc, LegalSlug } from './documents';

/**
 * The public legal pages at `/legal/*` (launch stage M4) — rendered from
 * `docs/legal/*.md` by the build-time transform, so the markdown stays the
 * source of truth and a correction is made once. Like the landing page these
 * render OUTSIDE every wall: no login gate and no session probe, because the
 * person reading them is deciding whether to sign in at all — or is a client
 * on a portal link with no workspace session to probe.
 *
 * These pages are read under stress, by someone deciding whether to trust us
 * with their clients' records, so the layout optimises for reading: one
 * column at a comfortable measure, the documents' own heading hierarchy and
 * clause numbers intact (support cites clauses by number), and in-page anchor
 * links working because the transform mints GitHub-style heading ids.
 *
 * While a document still carries `[PLACEHOLDER…]` markers it renders behind a
 * draft banner and the markers are highlighted, never hidden — M4's own
 * instruction is that such a page must not go LIVE, and an unmissable banner
 * is what keeps a preview honest while S6 resolves them. An unknown slug
 * falls back to the contents page rather than a dead end.
 */

const m = defineMessages({
  wordmarkTitle: {
    id: 'legal.legalView.wordmarkTitle',
    defaultMessage: 'Neo Accounting',
    description: 'Accessible name for the product wordmark on the legal pages. A product name — leave untranslated.',
  },
  headerNavLabel: { id: 'legal.legalView.headerNavLabel', defaultMessage: 'Legal pages' },
  backHome: { id: 'legal.legalView.backHome', defaultMessage: 'Back to the homepage' },

  indexTitle: { id: 'legal.legalView.indexTitle', defaultMessage: 'Legal' },
  indexLede: {
    id: 'legal.legalView.indexLede',
    defaultMessage:
      'The agreements and notices that govern Neo Accounting: what you are signing up to, what we do with personal data, and how to cancel.',
  },

  docTerms: { id: 'legal.legalView.docTerms', defaultMessage: 'Terms of Service' },
  docPrivacy: { id: 'legal.legalView.docPrivacy', defaultMessage: 'Privacy Notice' },
  docDpa: { id: 'legal.legalView.docDpa', defaultMessage: 'Data Processing Terms' },
  docRefunds: { id: 'legal.legalView.docRefunds', defaultMessage: 'Refunds and Cancellation' },

  draftBanner: {
    id: 'legal.legalView.draftBanner',
    defaultMessage:
      'This document is still a draft: {count, plural, one {one detail is} other {# details are}} awaiting confirmation and highlighted below. Please do not rely on it yet.',
  },

  loading: { id: 'legal.legalView.loading', defaultMessage: 'Loading' },
  failedBody: {
    id: 'legal.legalView.failedBody',
    defaultMessage: 'This page could not be loaded. Check your connection and try again.',
  },
  retryAction: { id: 'legal.legalView.retryAction', defaultMessage: 'Try again' },

  footerNavLabel: { id: 'legal.legalView.footerNavLabel', defaultMessage: 'All legal pages' },
});

// A Record over the registry's own slug union: a document added there
// without a label here fails the build rather than 404ing in production.
const DOC_LABEL: Record<LegalSlug, MessageDescriptor> = {
  'terms-of-service': m.docTerms,
  'privacy-notice': m.docPrivacy,
  'data-processing-terms': m.docDpa,
  'refund-and-cancellation': m.docRefunds,
};

const DOCUMENTS = LEGAL_SLUGS.map((slug) => ({ slug, label: DOC_LABEL[slug] }));

export function LegalView() {
  const intl = useIntl();
  const segments = usePath();
  const slug = segments[1];
  const known = isLegalSlug(slug) ? slug : null;

  // Arriving from another page keeps the old scroll position (pushState does
  // not reset it); a legal page opened at its top is the only honest start.
  // A deep link with an in-page anchor is handled after the document loads.
  useEffect(() => {
    if (!window.location.hash) window.scrollTo(0, 0);
  }, [known]);

  return (
    <div className="min-h-dvh bg-ground text-white font-sans selection:bg-brand/30 px-safe">
      <div className="max-w-3xl mx-auto px-5 sm:px-8">
        <header className="flex items-center justify-between gap-4 py-6">
          <a {...linkProps('/')} className="shrink-0">
            <Wordmark title={intl.formatMessage(m.wordmarkTitle)} size={18} className="text-white" />
          </a>
          <nav aria-label={intl.formatMessage(m.headerNavLabel)}>
            <a
              {...linkProps('/')}
              className="flex items-center gap-2 px-4 py-2 rounded-full text-[12px] font-bold text-zinc-400 border border-white/5 hover:text-white hover:border-white/15 transition-colors"
            >
              <ArrowLeft size={13} strokeWidth={2.5} aria-hidden="true" />
              {intl.formatMessage(m.backHome)}
            </a>
          </nav>
        </header>

        <main className="pb-10">{known ? <LegalDocument slug={known} /> : <LegalIndex />}</main>

        <footer className="border-t border-white/5 py-10 pb-safe-6">
          <nav aria-label={intl.formatMessage(m.footerNavLabel)}>
            <ul className="flex flex-wrap gap-x-5 gap-y-2">
              {DOCUMENTS.map((doc) => (
                <li key={doc.slug}>
                  <a
                    {...linkProps(legalPath(doc.slug))}
                    aria-current={doc.slug === known ? 'page' : undefined}
                    className={`text-[12px] font-semibold transition-colors ${
                      doc.slug === known ? 'text-white' : 'text-zinc-500 hover:text-white'
                    }`}
                  >
                    {intl.formatMessage(doc.label)}
                  </a>
                </li>
              ))}
            </ul>
          </nav>
        </footer>
      </div>
    </div>
  );
}

/** The contents page at `/legal`, and the landing spot for an unknown slug. */
function LegalIndex() {
  const intl = useIntl();
  return (
    <>
      <h1 className="pt-6 font-sans font-extrabold tracking-tight text-3xl sm:text-4xl text-white">
        {intl.formatMessage(m.indexTitle)}
      </h1>
      <p className="mt-4 max-w-2xl text-[15px] text-zinc-400 leading-relaxed">
        {intl.formatMessage(m.indexLede)}
      </p>
      <ul className="mt-8 flex flex-col gap-3">
        {DOCUMENTS.map((doc) => (
          <li key={doc.slug}>
            <a
              {...linkProps(legalPath(doc.slug))}
              className="flex items-center justify-between gap-4 p-5 rounded-3xl bg-card border border-white/5 hover:border-brand/40 transition-colors group"
            >
              <span className="flex items-center gap-4 min-w-0">
                <span className="w-10 h-10 rounded-2xl bg-brand/10 text-brand flex items-center justify-center shrink-0">
                  <ScrollText size={17} strokeWidth={2.25} aria-hidden="true" />
                </span>
                <span className="text-[15px] font-bold text-white tracking-tight">
                  {intl.formatMessage(doc.label)}
                </span>
              </span>
              <ArrowRight
                size={16}
                className="shrink-0 text-zinc-600 group-hover:text-white transition-colors"
                aria-hidden="true"
              />
            </a>
          </li>
        ))}
      </ul>
    </>
  );
}

type DocState = { status: 'loading' } | { status: 'ready'; doc: LegalDoc } | { status: 'failed' };

function LegalDocument({ slug }: { slug: LegalSlug }) {
  const intl = useIntl();
  const [state, setState] = useState<DocState>({ status: 'loading' });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setState({ status: 'loading' });
    loadLegalDoc[slug]().then(
      (doc) => {
        if (!cancelled) setState({ status: 'ready', doc });
      },
      () => {
        if (!cancelled) setState({ status: 'failed' });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [slug, attempt]);

  // A deep link like /legal/terms-of-service#9-price-and-payment can only be
  // honoured once the document exists in the DOM — the browser tried at page
  // load, before there was anything to scroll to.
  useEffect(() => {
    if (state.status !== 'ready') return;
    const anchor = window.location.hash.slice(1);
    if (anchor) document.getElementById(decodeURIComponent(anchor))?.scrollIntoView();
  }, [state]);

  if (state.status === 'loading') {
    return (
      <div role="status" aria-busy="true" aria-label={intl.formatMessage(m.loading)} className="pt-6 flex flex-col gap-4">
        <div className="h-9 w-2/3 rounded-full bg-white/[0.07] animate-pulse" />
        {[0, 1, 2, 3, 4].map((i) => (
          <div
            key={i}
            className="h-4 rounded-full bg-white/[0.04] animate-pulse"
            style={{ animationDelay: `${i * 90}ms` }}
          />
        ))}
      </div>
    );
  }

  if (state.status === 'failed') {
    return (
      <div role="alert" className="mt-6 p-6 rounded-3xl border border-red-500/20 bg-red-500/5 flex flex-col items-start gap-4">
        <p className="text-[14px] font-semibold text-red-400 leading-relaxed">
          {intl.formatMessage(m.failedBody)}
        </p>
        <button
          onClick={() => setAttempt((n) => n + 1)}
          className="flex items-center gap-2 px-5 py-2.5 rounded-full text-[13px] font-bold text-white bg-card border border-white/10 hover:border-brand/40 transition-colors"
        >
          <RefreshCw size={14} strokeWidth={2.5} aria-hidden="true" />
          {intl.formatMessage(m.retryAction)}
        </button>
      </div>
    );
  }

  return (
    <>
      {state.doc.placeholderCount > 0 && (
        <p
          role="note"
          className="mt-6 p-4 rounded-2xl border border-amber-500/20 bg-amber-500/5 text-[13px] font-semibold text-amber-400 leading-relaxed"
        >
          {intl.formatMessage(m.draftBanner, { count: state.doc.placeholderCount })}
        </p>
      )}
      {/* The document is repo-authored markdown rendered at build time — a
          trusted source, escaped by the transform. Nothing user-supplied can
          reach this sink. */}
      <article className="legal-prose pt-6" dangerouslySetInnerHTML={{ __html: state.doc.html }} />
    </>
  );
}
