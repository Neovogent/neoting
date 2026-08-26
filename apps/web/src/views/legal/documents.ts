/**
 * The four legal documents and how to fetch them (launch stage M4).
 *
 * Each loader is a dynamic import of the markdown itself — the
 * `neoting-legal-docs` plugin in `vite.config.ts` turns it into a
 * pre-rendered HTML module at build time — so every document is its own
 * chunk and opening the privacy notice never downloads the terms. The paths
 * reach out of `apps/web` on purpose: `docs/legal/` is the source of truth,
 * and a copy inside the app would be the second place a correction has to be
 * made (the legal pack's README forbids exactly that).
 *
 * The slugs are ADDRESSES, already published: the landing footer (M3) links
 * them, and the terms' own in-page anchors assume them. Renaming one is a
 * link-rot event, not a refactor.
 */

export interface LegalDoc {
  html: string;
  title: string;
  placeholderCount: number;
}

export const LEGAL_SLUGS = [
  'terms-of-service',
  'privacy-notice',
  'data-processing-terms',
  'refund-and-cancellation',
] as const;

export type LegalSlug = (typeof LEGAL_SLUGS)[number];

export const isLegalSlug = (value: string | undefined): value is LegalSlug =>
  LEGAL_SLUGS.includes(value as LegalSlug);

export const loadLegalDoc: Record<LegalSlug, () => Promise<LegalDoc>> = {
  'terms-of-service': () => import('../../../../../docs/legal/terms-of-service.md'),
  'privacy-notice': () => import('../../../../../docs/legal/privacy-notice.md'),
  'data-processing-terms': () => import('../../../../../docs/legal/data-processing-terms.md'),
  'refund-and-cancellation': () => import('../../../../../docs/legal/refund-and-cancellation.md'),
};

/** The public address of a legal page — one maker, used by every surface. */
export const legalPath = (slug: LegalSlug) => `/legal/${slug}`;
