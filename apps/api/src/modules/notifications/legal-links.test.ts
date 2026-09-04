import { readFileSync } from 'node:fs';

import { describe, expect, test } from 'vitest';

import { buildLegalLinks, PRIVACY_NOTICE_PATH, TERMS_OF_SERVICE_PATH } from './legal-links.js';

const ORIGIN = 'https://app.neoting.neovogent.com';

describe('the legal links', () => {
  test('are origin + the published legal paths', () => {
    expect(buildLegalLinks(ORIGIN)).toEqual({
      termsLink: `${ORIGIN}/legal/terms-of-service`,
      privacyLink: `${ORIGIN}/legal/privacy-notice`,
    });
  });

  test('tolerate a trailing slash on the origin rather than doubling it', () => {
    expect(buildLegalLinks(`${ORIGIN}/`).termsLink).toBe(`${ORIGIN}${TERMS_OF_SERVICE_PATH}`);
  });
});

describe('⚠ the paths these mails point at, against the pages that serve them', () => {
  // The VERIFY_EMAIL_PATH lesson (notifications-signup-mailer.test.ts): the web
  // app is an SPA, so a moved legal route answers these links 200 with the app
  // shell and the reader silently lands on the contents page instead of the
  // terms. This reads the web package's one maker of a legal address and fails
  // if the halves drift.
  const documents = readFileSync('../web/src/views/legal/documents.ts', 'utf8');

  test('both slugs are in the web app’s published LEGAL_SLUGS list', () => {
    expect(documents).toContain("'terms-of-service'");
    expect(documents).toContain("'privacy-notice'");
  });

  test('the path shape matches the web app’s legalPath maker', () => {
    // `legalPath = (slug) => `/legal/${slug}`` — the prefix is the joint fact.
    expect(documents).toContain('`/legal/${slug}`');
    expect(TERMS_OF_SERVICE_PATH).toBe('/legal/terms-of-service');
    expect(PRIVACY_NOTICE_PATH).toBe('/legal/privacy-notice');
  });
});
