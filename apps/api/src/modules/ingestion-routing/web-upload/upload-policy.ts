import type { DocumentChannel } from '@neoting/contracts/model';

import { type Channel, CHANNEL_POLICY } from '../lib/sanitisation/channels.js';
import { ACCEPTED_FORMATS, mimeForFormat } from '../lib/sanitisation/index.js';

/**
 * Map the contract's arrival `DocumentChannel` to the internal size-cap channel
 * (SoT §4 Stage 1). The cap taxonomy in `channels.ts` is by SURFACE, not by the
 * public channel enum: `bank_statement` and `vault` are internal and not
 * reachable here. Web upload is the accountant batch (100 MB); the phone-ish
 * channels share the 25 MB client cap.
 */
const CAP_CHANNEL: Readonly<Record<DocumentChannel, Channel>> = {
  WEB_UPLOAD: 'accountant_upload',
  STRUCTURED_IMPORT: 'accountant_upload',
  API: 'accountant_upload',
  EMAIL: 'email',
  WHATSAPP: 'client',
  SMS_PORTAL: 'client',
  CHAT_UPLOAD: 'client',
};

export function maxBytesForChannel(channel: DocumentChannel): number {
  return CHANNEL_POLICY[CAP_CHANNEL[channel]].maxBytes;
}

// The declared-MIME allowlist is the MIME of every format the sanitiser accepts.
// A declared type off it is 415 — a cheap pre-filter at the door; magic bytes
// still decide the real type after the bytes land (Governance §11.4).
const ALLOWED_MIME: ReadonlySet<string> = new Set([...ACCEPTED_FORMATS].map(mimeForFormat));

export function isAllowedMime(declaredMime: string): boolean {
  // Strip any `; charset=…` parameter and normalise before matching.
  const base = declaredMime.split(';', 1)[0]?.trim().toLowerCase() ?? '';
  return ALLOWED_MIME.has(base);
}
