/**
 * Per-channel size caps (SoT §4 Stage 1). Caps are asymmetric by design and
 * are enforced server-side regardless of any client-side compression
 * (Governance §11.3).
 */

export type Channel =
  | 'client' // chat upload, SMS secure link, WhatsApp intake, email to doc@
  | 'accountant_upload' // batch / ZIP web upload
  | 'bank_statement' // statements
  | 'vault'; // contracts and long agreements

export interface ChannelPolicy {
  readonly maxBytes: number;
  /** Page cap, where the channel has one (enforced in the PDF-safety step). */
  readonly maxPdfPages?: number;
}

const MB = 1024 * 1024;

export const CHANNEL_POLICY: Readonly<Record<Channel, ChannelPolicy>> = {
  client: { maxBytes: 25 * MB },
  accountant_upload: { maxBytes: 100 * MB },
  bank_statement: { maxBytes: 50 * MB, maxPdfPages: 300 },
  vault: { maxBytes: 100 * MB },
};
