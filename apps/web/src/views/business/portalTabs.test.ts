import { describe, expect, test } from 'vitest';

import {
  PORTAL_SECTIONS,
  PORTAL_TABS,
  isTabSlug,
  pathForSection,
  pathForTab,
  sectionFromPath,
  sectionsForTab,
  slugForSection,
  slugForTab,
  tabFromPath,
} from './portalTabs';

/**
 * The tab↔address mapping, which two shells depend on and neither owns.
 *
 * It earns a suite because the two portals stand at DIFFERENT addresses — the
 * live one at `/portal`, the synthetic one at `/portal/:accountId` — and a
 * mapping that quietly worked for one and not the other would look like a
 * broken tab rather than a broken function. Everything here is pure, so it is
 * also the cheapest place to pin the two behaviours that are decisions:
 * Home carries no segment, and an unrecognised segment is Home rather than a
 * dead end.
 */

describe('slugForTab', () => {
  test('Home is the absence of a segment, and the rest slug', () => {
    expect(slugForTab('Home')).toBeNull();
    expect(slugForTab('Upload')).toBe('upload');
    expect(slugForTab('Capture')).toBe('capture');
    expect(slugForTab('Settings')).toBe('settings');
  });
});

describe('tabFromPath', () => {
  test('reads the live portal’s addresses', () => {
    expect(tabFromPath(['portal'])).toBe('Home');
    expect(tabFromPath(['portal', 'upload'])).toBe('Upload');
    expect(tabFromPath(['portal', 'capture'])).toBe('Capture');
    expect(tabFromPath(['portal', 'settings'])).toBe('Settings');
  });

  test('reads the synthetic portal’s account-scoped addresses', () => {
    expect(tabFromPath(['portal', 'ba_1'])).toBe('Home');
    expect(tabFromPath(['portal', 'ba_1', 'upload'])).toBe('Upload');
    expect(tabFromPath(['portal', 'ba_1', 'settings'])).toBe('Settings');
  });

  // A tab name typed wrong should land somewhere usable, not on a dead end a
  // client has to know to escape from on a phone.
  test('anything unrecognised is Home, including an account id and an empty path', () => {
    expect(tabFromPath(['portal', 'nonsense'])).toBe('Home');
    expect(tabFromPath(['portal', 'ba_1', 'nonsense'])).toBe('Home');
    expect(tabFromPath([])).toBe('Home');
  });
});

describe('pathForTab', () => {
  test('keeps whatever prefix the caller is standing at', () => {
    expect(pathForTab(['portal'], 'Capture')).toBe('/portal/capture');
    expect(pathForTab(['portal', 'ba_1'], 'Capture')).toBe('/portal/ba_1/capture');
  });

  test('replaces the current tab rather than appending to it', () => {
    expect(pathForTab(['portal', 'upload'], 'Settings')).toBe('/portal/settings');
    expect(pathForTab(['portal', 'ba_1', 'upload'], 'Settings')).toBe('/portal/ba_1/settings');
  });

  test('going Home drops the tab segment and nothing else', () => {
    expect(pathForTab(['portal', 'settings'], 'Home')).toBe('/portal');
    expect(pathForTab(['portal', 'ba_1', 'settings'], 'Home')).toBe('/portal/ba_1');
    expect(pathForTab(['portal', 'ba_1'], 'Home')).toBe('/portal/ba_1');
  });

  test('every tab round-trips from every address shape', () => {
    for (const base of [['portal'], ['portal', 'ba_1']]) {
      for (const tab of PORTAL_TABS) {
        const address = pathForTab(base, tab);
        const segments = address.split('/').filter(Boolean);
        expect(tabFromPath(segments)).toBe(tab);
      }
    }
  });

  test('an id is encoded, so one with a slash cannot invent a segment', () => {
    expect(pathForTab(['portal', 'a/b'], 'Upload')).toBe('/portal/a%2Fb/upload');
  });
});

describe('isTabSlug', () => {
  test('Home is not a slug — it is what an address without one means', () => {
    expect(isTabSlug('home')).toBe(false);
    expect(isTabSlug('upload')).toBe(true);
    expect(isTabSlug(undefined)).toBe(false);
    expect(isTabSlug('ba_1')).toBe(false);
  });
});

/**
 * Sections — the half that makes `/portal/settings/people` a thing a person can
 * send to somebody else.
 *
 * The section state used to be `useState`, so Settings always opened on Business
 * and People had no address at all. Every rule the tabs already follow applies
 * one level down, and these are the ones that are decisions rather than
 * plumbing: an unrecognised section falls back rather than blanking, the slug is
 * derived from the KEY and never a label, and a tab with no sections cannot
 * claim a trailing segment.
 */
describe('sections', () => {
  test('the section map is total over the tabs, and only Settings has any', () => {
    // The mapped type is what enforces totality; this asserts the SHAPE, so a
    // fifth tab silently given `[]` is at least visible here.
    expect(Object.keys(PORTAL_SECTIONS).sort()).toEqual([...PORTAL_TABS].sort());
    expect(sectionsForTab('Settings').length).toBeGreaterThan(0);
    for (const tab of ['Home', 'Upload', 'Capture'] as const) expect(sectionsForTab(tab)).toEqual([]);
  });

  test('the slug is derived from the key, never a translated label', () => {
    expect(slugForSection('People')).toBe('people');
    expect(slugForSection('Notifications')).toBe('notifications');
  });

  test('a section address still names its TAB — the regression that made this necessary', () => {
    // Read as Home before sections existed, which is why People could not be
    // linked: the address opened the portal's front page.
    expect(tabFromPath(['portal', 'settings', 'people'])).toBe('Settings');
    expect(tabFromPath(['portal', 'ba_1', 'settings', 'plan'])).toBe('Settings');
  });

  test('every section of every tab round-trips from every address shape', () => {
    for (const base of [['portal'], ['portal', 'ba_1']]) {
      for (const tab of PORTAL_TABS) {
        for (const section of sectionsForTab(tab)) {
          const segments = pathForSection(base, tab, section).split('/').filter(Boolean);
          expect(tabFromPath(segments)).toBe(tab);
          expect(sectionFromPath(segments)).toBe(section);
        }
      }
    }
  });

  test('People has its own address, and it is the one the task asked for', () => {
    expect(pathForSection(['portal'], 'Settings', 'People')).toBe('/portal/settings/people');
    expect(pathForSection(['portal'], 'Settings', 'Plan')).toBe('/portal/settings/plan');
    expect(pathForSection(['portal', 'ba_1'], 'Settings', 'People')).toBe('/portal/ba_1/settings/people');
  });

  test('an unrecognised section is the FIRST section, never a blank panel', () => {
    // The tab-level fallback, one level down. A client who mistypes must land
    // somewhere usable rather than on a dead end they cannot leave on a phone.
    expect(sectionFromPath(['portal', 'settings', 'nonsense'])).toBe('Business');
    expect(tabFromPath(['portal', 'settings', 'nonsense'])).toBe('Settings');
  });

  test('a bare tab address resolves to the first section', () => {
    expect(sectionFromPath(['portal', 'settings'])).toBe('Business');
    expect(sectionFromPath(['portal', 'ba_1', 'settings'])).toBe('Business');
  });

  test('a tab with NO sections cannot claim a trailing segment', () => {
    // Otherwise `/portal/upload/anything` would read as Upload, and a mistyped
    // address would stop being recoverable.
    expect(tabFromPath(['portal', 'upload', 'nonsense'])).toBe('Home');
    expect(sectionFromPath(['portal', 'upload'])).toBeNull();
  });

  test('a tab has no section, and a section of the wrong tab falls back to the tab', () => {
    expect(sectionFromPath(['portal'])).toBeNull();
    expect(pathForSection(['portal'], 'Upload', 'People')).toBe('/portal/upload');
    expect(pathForSection(['portal'], 'Home', 'People')).toBe('/portal');
  });

  test('switching tab from a section address drops the section', () => {
    // Without this the section segment would be carried onto the next tab and
    // every address built from here would accumulate rubbish.
    expect(pathForTab(['portal', 'settings', 'people'], 'Upload')).toBe('/portal/upload');
    expect(pathForTab(['portal', 'settings', 'people'], 'Home')).toBe('/portal');
    expect(pathForTab(['portal', 'settings', 'nonsense'], 'Home')).toBe('/portal');
    expect(pathForTab(['portal', 'ba_1', 'settings', 'people'], 'Home')).toBe('/portal/ba_1');
  });

  test('switching section from a section address replaces rather than appends', () => {
    expect(pathForSection(['portal', 'settings', 'people'], 'Settings', 'Plan')).toBe('/portal/settings/plan');
    expect(pathForSection(['portal', 'ba_1', 'settings', 'plan'], 'Settings', 'People')).toBe(
      '/portal/ba_1/settings/people',
    );
  });

  test('an id with a slash is still encoded, one level deeper', () => {
    expect(pathForSection(['portal', 'a/b'], 'Settings', 'People')).toBe('/portal/a%2Fb/settings/people');
  });
});
