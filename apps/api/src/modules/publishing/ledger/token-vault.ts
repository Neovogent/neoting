import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from 'node:crypto';

import { z } from 'zod';

/**
 * The per-connection token vault (D50, build brief Stage 1).
 *
 * ## Why the ciphertext lives in `integrations.token_ref` and not in AWS
 *
 * The brief asked for one Secrets Manager secret per connection, on the grounds
 * that Secrets Manager is "already wired". It is — for PLATFORM credentials, at
 * TASK START, through the ECS agent's `valueFrom` injection. That mechanism
 * cannot carry a value that is minted when a practice presses Connect and
 * replaced every time a token rotates, and `infra/envs/<env>/secrets.tf` says so in
 * capitals: *"A client's Xero refresh token must never be written here"*, for
 * two reasons that both still hold — $0.40/connection/month, and a tenancy
 * boundary enforced by IAM instead of by RLS, the inversion Governance §5.2
 * exists to prevent. The task role is deliberately granted no Secrets Manager
 * read at all.
 *
 * So the SECRET here is the one platform key that seals every connection —
 * `INTEGRATION_TOKEN_KEY`, which lives in Secrets Manager exactly like
 * `SESSION_SECRET` does, in the same `auth` group and by the same ceremony —
 * and what lands in the database is a sealed blob nobody holding a database
 * dump can open. Tenancy stays on RLS, the per-connection cost is zero, and no
 * schema change was needed. Shakib chose this over both alternatives on
 * 15 Sep 2026.
 *
 * ## The format
 *
 * `v1.<iv>.<tag>.<ciphertext>`, each part base64url. AES-256-GCM, a fresh
 * 12-byte IV per seal (never reused — GCM's one unforgivable misuse), and the
 * 16-byte auth tag carried alongside so `unseal` fails loudly on a tampered or
 * truncated blob rather than returning plausible rubbish.
 *
 * The version prefix is not decoration: rotating `INTEGRATION_TOKEN_KEY`
 * re-seals every connection, and a future `v2` (a different cipher, a key id) has
 * to be distinguishable from this one at read time or the rotation cannot be
 * staged.
 */

/** What a sealed blob holds once opened. Vendor-shaped, so one type covers all four. */
export const LedgerTokensSchema = z.object({
  accessToken: z.string().min(1),
  /**
   * ⚠ Xero, QuickBooks and Sage all ROTATE this: the old value dies the moment
   * it is used. FreeAgent's is effectively permanent. Persisting the new one
   * atomically is the single most likely source of a silent, unrecoverable bug
   * in this whole feature — see `token-store.ts`.
   */
  refreshToken: z.string().min(1),
  /** UTC ISO instant the ACCESS token stops working. */
  accessExpiresAt: z.string().datetime(),
  /**
   * UTC ISO instant the REFRESH token stops working if nobody uses it — the
   * clock the scheduler runs against. Xero 60 days, Sage 31, QuickBooks 100,
   * FreeAgent ~20 years. Null when the vendor states none.
   */
  refreshExpiresAt: z.string().datetime().nullable(),
  /** The granted scope string, as the vendor echoed it. Diagnostic only. */
  scope: z.string().nullable(),
});

export type LedgerTokens = z.infer<typeof LedgerTokensSchema>;

const VERSION = 'v1';
const IV_BYTES = 12;
const KEY_BYTES = 32;

/**
 * The sealing key, parsed once at the boundary.
 *
 * 64 hex characters, which is `openssl rand -hex 32` — the same instruction
 * `.env.example` already carries for `SESSION_SECRET`. Refusing anything
 * shorter rather than hashing it up to length is deliberate: a short key that
 * silently works is a short key that stays.
 */
export function parseVaultKey(value: string): Buffer {
  if (!/^[0-9a-fA-F]{64}$/.test(value)) {
    throw new Error(
      'INTEGRATION_TOKEN_KEY must be 64 hex characters (32 bytes) — generate one with `openssl rand -hex 32`',
    );
  }
  return Buffer.from(value, 'hex');
}

export function seal(tokens: LedgerTokens, key: Buffer): string {
  if (key.length !== KEY_BYTES) throw new Error('vault key must be 32 bytes');
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const body = Buffer.concat([
    cipher.update(JSON.stringify(LedgerTokensSchema.parse(tokens)), 'utf8'),
    cipher.final(),
  ]);
  return [VERSION, b64(iv), b64(cipher.getAuthTag()), b64(body)].join('.');
}

/**
 * Open a sealed blob, or throw.
 *
 * Every failure is the same class — the blob does not open — and the message
 * never repeats any part of it. A decryption error that quotes its input is how
 * ciphertext ends up in a log.
 */
export function unseal(blob: string, key: Buffer): LedgerTokens {
  if (key.length !== KEY_BYTES) throw new Error('vault key must be 32 bytes');
  const parts = blob.split('.');
  if (parts.length !== 4 || parts[0] !== VERSION) {
    throw new Error('the stored ledger credentials are not in a format this build can open');
  }
  const [, ivPart, tagPart, bodyPart] = parts as [string, string, string, string];
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, unb64(ivPart));
    decipher.setAuthTag(unb64(tagPart));
    const plain = Buffer.concat([decipher.update(unb64(bodyPart)), decipher.final()]).toString('utf8');
    return LedgerTokensSchema.parse(JSON.parse(plain));
  } catch {
    // Not the underlying message: node's GCM failure and a Zod failure say
    // different things about the same secret, and neither is useful to a caller.
    throw new Error('the stored ledger credentials could not be opened — the connection must be reconnected');
  }
}

/**
 * Whether a blob was sealed with THIS key, without throwing and without
 * decrypting twice. Used by the re-seal path when `INTEGRATION_TOKEN_KEY`
 * rotates.
 */
export function opensWith(blob: string, key: Buffer): boolean {
  try {
    unseal(blob, key);
    return true;
  } catch {
    return false;
  }
}

/**
 * Constant-time comparison for the OAuth `state` value.
 *
 * It lives here rather than in `oauth.ts` because it is the same class of
 * mistake as an IV reuse: `a === b` on a CSRF token leaks its prefix through
 * timing, and the one line that fixes it is easy to leave out of a file about
 * redirects.
 */
export function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

function b64(buffer: Buffer): string {
  return buffer.toString('base64url');
}

function unb64(value: string): Buffer {
  return Buffer.from(value, 'base64url');
}
