import type { IntegrationKind } from '@prisma/client';

import type { OAuthVendor } from '../../common/oauth/oauth.js';

/**
 * Google Drive and OneDrive, as data (D51).
 *
 * The same split the ledger's `vendors.ts` makes, and for the same reason:
 * every per-vendor CONSTANT lives here, every per-vendor BEHAVIOUR lives in
 * `drive-adapter.ts`, and `common/oauth/oauth.ts` reads this table without
 * branching on a name.
 *
 * ⚠ **These are not ledgers and this file is not in `publishing/`.** A drive
 * connection cannot post a transaction to anything; it copies a client's own
 * documents into the client's own storage. Putting them in the ledger's table
 * would have made them reachable from `vendorFor`, which is the one lookup that
 * decides whether something is a place bills can be sent.
 */

export type DriveSlug = 'google-drive' | 'onedrive';

export interface DriveVendor extends OAuthVendor {
  readonly kind: IntegrationKind;
  readonly slug: DriveSlug;
  /** Root of the drive API, without a trailing slash. */
  readonly apiBase: string;
  /**
   * The largest single file this vendor takes on its simple upload path.
   *
   * ⚠ Both are far above anything our intake accepts (a phone photo is single
   * -digit megabytes), so neither needs the resumable/chunked upload each
   * vendor also offers. That is why there is no chunking in `drive-adapter.ts`,
   * and this field is where that decision is recorded rather than assumed.
   */
  readonly simpleUploadMaxBytes: number;
}

export const DRIVES: Readonly<Record<DriveSlug, DriveVendor>> = {
  /**
   * ⚠ **`drive.file`, and the scope choice is the whole verification story.**
   *
   * Google splits Drive scopes into ordinary and RESTRICTED. `drive` and
   * `drive.readonly` are restricted: they need a security assessment that costs
   * money and takes weeks, and until it passes the app is capped and shows a
   * warning. **`drive.file` is NOT restricted** — it grants access only to
   * files and folders THIS APP CREATED, which is exactly and only what a
   * one-way copy needs.
   *
   * So we can never read a client's existing Drive, which is correct: nothing
   * in this product has any business doing that. The consequence to know is
   * that if a client deletes the folder we made, we cannot see the new one they
   * made by hand — the next run simply creates its own again.
   *
   * ⚠ **`access_type=offline` AND `prompt=consent` are both load-bearing.**
   * Without the first Google issues no refresh token at all. Without the
   * second it issues one only on a user's very FIRST authorisation — so a
   * client who disconnects and reconnects gets an access token that dies in an
   * hour and no way to renew it, which looks like a connection that worked for
   * an hour and then broke for no reason.
   */
  'google-drive': {
    kind: 'GOOGLE_DRIVE',
    slug: 'google-drive',
    label: 'Google Drive',
    authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    scope: 'https://www.googleapis.com/auth/drive.file',
    apiBase: 'https://www.googleapis.com/drive/v3',
    tokenEndpointAuth: 'body',
    // Google's refresh tokens do not rotate: the refresh response carries no
    // new one, and `refreshTokens` carries the old one forward — which is the
    // FreeAgent case the shared layer already handles.
    refreshIdleDays: null,
    authorizeParams: { access_type: 'offline', prompt: 'consent' },
    // 5 MB is the documented simple-upload ceiling for multipart.
    simpleUploadMaxBytes: 5 * 1024 * 1024,
  },

  /**
   * ⚠ **`offline_access` is a SCOPE here, not a parameter.** Microsoft issues
   * no refresh token without it, and unlike Google there is no `access_type` to
   * ask with — it is requested alongside `Files.ReadWrite` or not at all.
   *
   * ⚠ **Microsoft ROTATES refresh tokens.** The old one dies the moment it is
   * used, which puts this vendor in the same class as Xero, QuickBooks and
   * Sage: the conditional persist in `drive-token-store.ts` is what stops two
   * processes installing a token the other has already retired.
   *
   * `common` as the tenant so both personal Microsoft accounts and work/school
   * accounts can connect. A tenant-specific authority would refuse whichever
   * kind the client happens to have, which is not a choice we get to make for
   * them.
   */
  onedrive: {
    kind: 'ONEDRIVE',
    slug: 'onedrive',
    label: 'OneDrive',
    authorizeUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize',
    tokenUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/token',
    scope: 'offline_access Files.ReadWrite User.Read',
    apiBase: 'https://graph.microsoft.com/v1.0',
    tokenEndpointAuth: 'body',
    // Microsoft's refresh tokens are good for 90 days of inactivity.
    refreshIdleDays: 90,
    // 250 MB on the simple `PUT …:/content` path.
    simpleUploadMaxBytes: 250 * 1024 * 1024,
  },
};

/** The drive for an `IntegrationKind`, or null when the kind is not a drive at all. */
export function driveFor(kind: IntegrationKind): DriveVendor | null {
  return Object.values(DRIVES).find((drive) => drive.kind === kind) ?? null;
}

/** The drive for a URL slug, or null. Used by the connect/callback routes. */
export function driveBySlug(slug: string): DriveVendor | null {
  return (DRIVES as Record<string, DriveVendor | undefined>)[slug] ?? null;
}
