import { expect, test } from 'vitest';

import {
  captureDisplayName,
  captureIndex,
  CHASE_LINK_SUBMITTER_LABEL,
  CLIENT_PORTAL_SUBMITTER_LABEL,
  londonDate,
  personDisplayName,
  portalSubmitterLabel,
} from './portal-provenance.js';

/**
 * The naming composer (review items 21/43) — pure, so the edges are driven
 * directly: the capture mint's shape, the London date rendering, and every
 * fallback in the label ladder.
 */

const MEMBER = { firstName: 'Mubashir', lastName: 'Rahman', email: 'mub@zeplow.test' };

test('captureIndex matches ONLY the app\'s own mint', () => {
  expect(captureIndex('capture-2026-09-05-1.jpg')).toBe(1);
  expect(captureIndex('capture-2026-09-05-12.JPG')).toBe(12);
  expect(captureIndex('capture-2026-09-05-2.jpeg')).toBe(2);
  // Not the mint: a client's own file keeps its own name.
  expect(captureIndex('currys-receipt.jpg')).toBeNull();
  expect(captureIndex('capture.jpg')).toBeNull(); // `asJpegName`'s nameless fallback
  expect(captureIndex('capture-2026-09-05-1.pdf')).toBeNull();
  expect(captureIndex('xcapture-2026-09-05-1.jpg')).toBeNull();
});

test('londonDate renders the Europe/London calendar day, d Mmm yyyy', () => {
  // 23:30 UTC on 4 Sep is already 5 Sep in London (BST, UTC+1) — the repo's
  // "UTC in storage, Europe/London in rendering" invariant, on the boundary.
  expect(londonDate(new Date('2026-09-04T23:30:00.000Z'))).toBe('5 Sep 2026');
  // Winter: London is UTC, so the UTC day stands.
  expect(londonDate(new Date('2026-01-04T23:30:00.000Z'))).toBe('4 Jan 2026');
});

test('the label ladder: chase link → slug; named member → their words; nobody → the portal slug', () => {
  expect(portalSubmitterLabel({ chase: true, person: MEMBER, businessName: 'Zeplow Inc', capture: false })).toBe(
    CHASE_LINK_SUBMITTER_LABEL,
  );
  expect(portalSubmitterLabel({ chase: false, person: MEMBER, businessName: 'Zeplow Inc', capture: false })).toBe(
    'Uploaded by Mubashir Rahman (Zeplow Inc)',
  );
  expect(portalSubmitterLabel({ chase: false, person: MEMBER, businessName: 'Zeplow Inc', capture: true })).toBe(
    'Captured by Mubashir Rahman (Zeplow Inc)',
  );
  expect(portalSubmitterLabel({ chase: false, person: null, businessName: 'Zeplow Inc', capture: false })).toBe(
    CLIENT_PORTAL_SUBMITTER_LABEL,
  );
});

test('a nameless contact falls back to the address that signed in; a blank one to null', () => {
  expect(personDisplayName({ firstName: null, lastName: null, email: 'mub@zeplow.test' })).toBe('mub@zeplow.test');
  expect(personDisplayName({ firstName: '  ', lastName: null, email: null })).toBeNull();
  expect(personDisplayName(null)).toBeNull();
});

test('client-entered words are collapsed and clamped on their way into a label — data, never a paragraph', () => {
  const noisy = { firstName: 'A\nvery\tlong   name'.padEnd(120, 'x'), lastName: null, email: null };
  const label = portalSubmitterLabel({ chase: false, person: noisy, businessName: '  Zeplow\n Inc  ', capture: false });
  expect(label).not.toMatch(/[\n\t]/);
  expect(label.length).toBeLessThanOrEqual('Uploaded by '.length + 60 + ' ()'.length + 60);
  expect(label.endsWith('(Zeplow Inc)')).toBe(true);
});

test('the capture display name carries member · business · date, the tray sequence when > 1, and keeps .jpg', () => {
  const now = new Date('2026-09-05T10:00:00.000Z');
  expect(captureDisplayName({ person: MEMBER, businessName: 'Zeplow Inc', index: 1, now })).toBe(
    'Capture — Mubashir Rahman · Zeplow Inc · 5 Sep 2026.jpg',
  );
  expect(captureDisplayName({ person: MEMBER, businessName: 'Zeplow Inc', index: 3, now })).toBe(
    'Capture — Mubashir Rahman · Zeplow Inc · 5 Sep 2026 · 3.jpg',
  );
  // No person (a chase link, an unrostered invite): the member part is dropped,
  // never invented.
  expect(captureDisplayName({ person: null, businessName: 'Zeplow Inc', index: 1, now })).toBe(
    'Capture — Zeplow Inc · 5 Sep 2026.jpg',
  );
});
