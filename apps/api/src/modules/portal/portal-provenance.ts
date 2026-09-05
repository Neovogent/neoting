/**
 * Who sent this document, in words a human reads (review items 21/43/62).
 *
 * Composed at INTENT time (`portal-upload.service.ts`) from facts the server
 * holds — the session's kind, the contact row the sign-in verified, the
 * business row — never from client words, and carried into the signed
 * `UploadClaims` so completion copies rather than re-derives. Pure, so the
 * tests drive it directly.
 *
 * Two provenance facts live here:
 *
 *  1. **The submitter label** — `documents.submitter_label`, which the web
 *     reads off `DocumentSummary.submitterLabel` to split the one `SMS_PORTAL`
 *     channel into its two honest surfaces: a chase link (`/p/:token`) and the
 *     signed-in client portal. The chase link is forwardable, so its holder is
 *     deliberately unnamed (`otp_sessions.contact_id` is NULL by design —
 *     "a guess in an audit column is worse than an absence"); a signed-in
 *     member proved control of a registered address, so they ARE named.
 *  2. **The capture display name** — a camera capture has no filename of its
 *     own (`capture-2026-09-05-1.jpg` is the app's own minted sentinel), so the
 *     document would fall through supplier → filename to nothing a human can
 *     tell apart. The generated name carries channel, member, business and the
 *     Europe/London date (UTC in storage, London in rendering).
 *
 * ⚠ The pattern below matches ONLY the app's own `captureFilename` mint
 * (`apps/web/.../portalCamera.ts`). It is a client-sent string, so matching it
 * is a client claim — safe, because the only consequence is display words: a
 * client naming a real file `capture-2026-09-05-1.jpg` gets the generated
 * display name instead of theirs, and nothing else changes. A client-typed
 * `note` (review item 11) always wins over the generated name.
 */

/** A chase-link upload: the holder is unnamed by design (forwardable link). */
export const CHASE_LINK_SUBMITTER_LABEL = 'uploaded-via-chase-link';

/** A signed-in portal upload whose session names no contact row. */
export const CLIENT_PORTAL_SUBMITTER_LABEL = 'uploaded-via-client-portal';

/** What the label composer needs to know about the signed-in member. */
export interface PortalUploadPerson {
  readonly firstName: string | null;
  readonly lastName: string | null;
  readonly email: string | null;
}

/**
 * The web's `captureFilename` mint: `capture-YYYY-MM-DD-N.jpg`. The trailing
 * number is a per-session sequence — kept in the display name (when > 1) so two
 * captures on one day stay tellable apart.
 */
const CAPTURE_FILENAME = /^capture-\d{4}-\d{2}-\d{2}-(\d+)\.jpe?g$/iu;

/** The capture sequence number, or null when the filename is not a capture mint. */
export function captureIndex(filename: string): number | null {
  const match = CAPTURE_FILENAME.exec(filename.trim());
  if (match === null) return null;
  const index = Number.parseInt(match[1] ?? '', 10);
  return Number.isFinite(index) ? index : null;
}

/**
 * A name or business string on its way into a label: whitespace collapsed
 * (which also removes control characters and newlines), clamped. Data, never
 * instructions — but also never allowed to become a paragraph.
 */
function words(value: string, max = 60): string {
  return value.replace(/\s+/gu, ' ').trim().slice(0, max).trim();
}

/** "First Last", falling back to the address that signed in, or null. */
export function personDisplayName(person: PortalUploadPerson | null): string | null {
  if (person === null) return null;
  const name = words([person.firstName ?? '', person.lastName ?? ''].join(' '));
  if (name !== '') return name;
  const email = words(person.email ?? '');
  return email === '' ? null : email;
}

export interface PortalSubmitterInput {
  /** `facts.chaseId !== null` — a chase-link session, whose holder is unnamed by design. */
  readonly chase: boolean;
  readonly person: PortalUploadPerson | null;
  readonly businessName: string;
  /** Whether the declared filename is the app's own capture mint. */
  readonly capture: boolean;
}

/** What `documents.submitter_label` records for a portal upload. */
export function portalSubmitterLabel(input: PortalSubmitterInput): string {
  if (input.chase) return CHASE_LINK_SUBMITTER_LABEL;
  const name = personDisplayName(input.person);
  if (name === null) return CLIENT_PORTAL_SUBMITTER_LABEL;
  const verb = input.capture ? 'Captured' : 'Uploaded';
  return `${verb} by ${name} (${words(input.businessName)})`;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;

/** A UTC instant → "5 Sep 2026" in Europe/London (the repo's d Mmm yyyy). */
export function londonDate(now: Date): string {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/London',
    day: 'numeric',
    month: '2-digit',
    year: 'numeric',
  }).formatToParts(now);
  const part = (type: string): string => parts.find((p) => p.type === type)?.value ?? '';
  const month = MONTHS[Number.parseInt(part('month'), 10) - 1] ?? '';
  return `${part('day')} ${month} ${part('year')}`;
}

export interface CaptureNameInput {
  readonly person: PortalUploadPerson | null;
  readonly businessName: string;
  /** From `captureIndex` — kept in the name when > 1 so same-day captures differ. */
  readonly index: number;
  readonly now: Date;
}

/**
 * `Capture — Mubashir Rahman · Zeplow Inc · 5 Sep 2026.jpg` (review item 43).
 *
 * The `.jpg` extension is kept because `formatFor` picks a reader off the
 * filename — a display name must never cost the pipeline the format. A session
 * naming no person (a chase link, an unrostered invite) drops the member part
 * rather than inventing one.
 */
export function captureDisplayName(input: CaptureNameInput): string {
  const pieces = [personDisplayName(input.person), words(input.businessName), londonDate(input.now)]
    .filter((piece): piece is string => piece !== null && piece !== '');
  const suffix = input.index > 1 ? ` · ${input.index}` : '';
  return `Capture — ${pieces.join(' · ')}${suffix}.jpg`;
}
