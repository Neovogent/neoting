import { slug } from '../../lib/router';

/**
 * The business portal's four tabs, and where they live in the address.
 *
 * ## Why this is a module of its own
 *
 * Two shells render these tabs — the live one and the synthetic one — and they
 * stand at different addresses. A live client's portal is `/portal`, because
 * their session names exactly one workspace and there is nothing to
 * disambiguate; the synthetic shell is `/portal/:accountId`, because it hops
 * between seeded businesses. Both must produce and read the SAME tab slugs, so
 * the mapping is written once, as pure functions over path segments, and
 * tested rather than eyeballed in two components.
 *
 * ## The tab is the LAST segment, when it names one
 *
 * That is what lets both address shapes work without either shell knowing about
 * the other's:
 *
 *     /portal                     → Home
 *     /portal/capture             → Capture      (live)
 *     /portal/biz_1               → Home         (synthetic)
 *     /portal/biz_1/settings      → Settings     (synthetic)
 *
 * An unknown final segment is not an error and not a 404 — it is Home. A tab
 * name typed wrong should land the client somewhere they can use, not on a dead
 * end they cannot get out of on a phone.
 *
 * ## `key` is the machine value and is never rendered
 *
 * Navigation keys off it and the URL slugs it. Keying navigation off a
 * translated label breaks the moment the locale changes; the key never moves.
 *
 * ## SECTIONS live here too, and deliberately not in a second mapping
 *
 * Settings has six panels and they were `useState`, so `/portal/settings` always
 * opened on Business and **People could not be linked at all** — an accountant
 * telling a client "go to Settings, then People" had no address to send, and a
 * client who got there could not send it to their bookkeeper.
 *
 * They are added to THIS file rather than beside the screen for the reason the
 * tabs are here: the mapping between what the URL says and what is on screen has
 * to be one function, or the two halves drift and a link starts opening the
 * wrong panel. It is the same shape one level down — a section is the segment
 * AFTER the tab:
 *
 *     /portal/settings            → Settings, first section
 *     /portal/settings/people     → Settings, People
 *     /portal/biz_1/settings/plan → Settings, Plan   (synthetic)
 *
 * **The same fallback rule applies, one level down.** An unrecognised section is
 * not an error and not a blank panel — it is the FIRST section, exactly as an
 * unrecognised tab is Home. A tab name typed wrong should land the client
 * somewhere they can use, not on a dead end they cannot get out of on a phone,
 * and that is no less true of a section.
 */

export const PORTAL_TABS = ['Home', 'Upload', 'Capture', 'Settings'] as const;

export type PortalTab = (typeof PORTAL_TABS)[number];

/**
 * The sections each tab offers, in the order they are shown.
 *
 * **Total over `PortalTab` by the mapped type**, the way the API's release map
 * is total over `ProposalKind`: a fifth tab that fails to compile here has to
 * answer "does this have sections?" rather than inherit an empty default and
 * silently lose its addresses.
 */
export const PORTAL_SECTIONS: Readonly<Record<PortalTab, readonly string[]>> = {
  Home: [],
  Upload: [],
  Capture: [],
  // The client's own settings. `People` is why this exists — see the header.
  Settings: ['Business', 'Plan', 'Sending', 'Notifications', 'People', 'Security'],
};

/** Home is the bare address — it carries no segment of its own. */
const HOME: PortalTab = 'Home';

/** `'Settings'` → `'settings'`. Home has no slug; it IS the absence of one. */
export function slugForTab(tab: PortalTab): string | null {
  return tab === HOME ? null : slug(tab);
}

/** Whether a path segment names a tab. Used to decide what to strip. */
export function isTabSlug(segment: string | undefined): boolean {
  return segment !== undefined && PORTAL_TABS.some((t) => t !== HOME && slug(t) === segment);
}

/** The sections this tab offers. Empty for the three that have none. */
export function sectionsForTab(tab: PortalTab): readonly string[] {
  return PORTAL_SECTIONS[tab];
}

/**
 * `'People'` → `'people'`. **Machine-derived from the key, never the label** —
 * the same rule the tabs follow, and it matters more here: a translated label
 * would put the section name in the address, so a French client's link would
 * open nothing for an English one.
 */
export function slugForSection(section: string): string {
  return slug(section);
}

/** Whether a segment names a section OF THIS TAB. */
function isSectionSlugOf(tab: PortalTab, segment: string | undefined): boolean {
  return segment !== undefined && sectionsForTab(tab).some((s) => slug(s) === segment);
}

/**
 * Which tab an address is showing. Anything unrecognised is Home.
 *
 * ⚠ It reads the last segment and then, failing that, the one before it — which
 * is what makes `/portal/settings/people` a Settings address instead of a Home
 * one. Two positions and no more: a deeper path is not a shape this portal
 * produces, and scanning the whole list would make `/portal/settings/a/b/c`
 * resolve to Settings, which is a dead end wearing a working tab.
 */
export function tabFromPath(segments: readonly string[]): PortalTab {
  const last = segments[segments.length - 1];
  const direct = PORTAL_TABS.find((t) => t !== HOME && slug(t) === last);
  if (direct !== undefined) return direct;

  const previous = segments[segments.length - 2];
  const parent = PORTAL_TABS.find((t) => t !== HOME && slug(t) === previous);
  // Only a tab that HAS sections may claim a trailing segment. Without this,
  // `/portal/upload/anything` would read as Upload rather than falling home,
  // and a mistyped address would stop being recoverable.
  return parent !== undefined && sectionsForTab(parent).length > 0 ? parent : HOME;
}

/**
 * Which section an address is showing, or null for a tab that has none.
 *
 * **An unrecognised section is the FIRST one**, never null and never a blank
 * panel — the tab-level fallback, one level down. `/portal/settings` has no
 * section segment at all and lands on the first section for the same reason.
 */
export function sectionFromPath(segments: readonly string[]): string | null {
  const tab = tabFromPath(segments);
  const sections = sectionsForTab(tab);
  if (sections.length === 0) return null;
  const last = segments[segments.length - 1];
  return sections.find((s) => slug(s) === last) ?? sections[0]!;
}

/** Strip a trailing section, then a trailing tab, leaving the caller's own prefix. */
function baseOf(segments: readonly string[]): string[] {
  const parts = [...segments];
  const tab = PORTAL_TABS.find((t) => t !== HOME && slug(t) === parts[parts.length - 2]);
  if (tab !== undefined && isSectionSlugOf(tab, parts[parts.length - 1])) parts.pop();
  // A tab that has sections also owns an UNRECOGNISED trailing segment (that is
  // what `tabFromPath` just decided), so that segment has to come off too or the
  // rubbish would be carried into every address built from here.
  else if (tab !== undefined && sectionsForTab(tab).length > 0) parts.pop();
  if (isTabSlug(parts[parts.length - 1])) parts.pop();
  return parts;
}

/**
 * The address for a tab, keeping whatever prefix the caller is already
 * standing at — which is how one function serves `/portal` and
 * `/portal/:accountId` without being told which it is looking at.
 *
 * It carries NO section, so `/portal/settings` stays the address a tab click
 * produces and `sectionFromPath` answers it with the first section.
 */
export function pathForTab(segments: readonly string[], tab: PortalTab): string {
  const next = slugForTab(tab);
  const parts = next === null ? baseOf(segments) : [...baseOf(segments), next];
  return '/' + parts.map(encodeURIComponent).join('/');
}

/**
 * The address for one SECTION of a tab — what makes People linkable.
 *
 * The slug is emitted for every section including the first, so each one has a
 * distinct address a person can copy out of the bar and send. `/portal/settings`
 * remains valid and resolves to the first section; it is simply not what this
 * function produces.
 */
export function pathForSection(segments: readonly string[], tab: PortalTab, section: string): string {
  const tabSlug = slugForTab(tab);
  if (tabSlug === null || !sectionsForTab(tab).includes(section)) return pathForTab(segments, tab);
  const parts = [...baseOf(segments), tabSlug, slugForSection(section)];
  return '/' + parts.map(encodeURIComponent).join('/');
}
