import { randomBytes } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { signState, verifyState } from './oauth.js';
import { type LedgerTokens, opensWith, parseVaultKey, safeEqual, seal, unseal } from './token-vault.js';

const KEY = parseVaultKey('a'.repeat(64));
const OTHER = parseVaultKey('b'.repeat(64));

const TOKENS: LedgerTokens = {
  accessToken: 'access-1',
  refreshToken: 'refresh-1',
  accessExpiresAt: '2026-09-15T12:00:00.000Z',
  refreshExpiresAt: '2026-11-14T12:00:00.000Z',
  scope: 'accounting.invoices accounting.attachments',
};

describe('the sealing key', () => {
  it('accepts exactly 64 hex characters and nothing else', () => {
    expect(parseVaultKey('F'.repeat(64))).toHaveLength(32);
    expect(() => parseVaultKey('a'.repeat(63))).toThrow(/64 hex/);
    expect(() => parseVaultKey('a'.repeat(65))).toThrow(/64 hex/);
    expect(() => parseVaultKey('z'.repeat(64))).toThrow(/64 hex/);
    // ⚠ The one that matters: a short key must not be silently stretched.
    expect(() => parseVaultKey('secret')).toThrow(/64 hex/);
    expect(() => parseVaultKey('')).toThrow(/64 hex/);
  });
});

describe('sealing a connection', () => {
  it('round-trips every field', () => {
    expect(unseal(seal(TOKENS, KEY), KEY)).toEqual(TOKENS);
  });

  it('never repeats a blob — a fresh IV per seal', () => {
    const blobs = new Set(Array.from({ length: 50 }, () => seal(TOKENS, KEY)));
    expect(blobs.size).toBe(50);
  });

  it('does not leave the token readable in the blob', () => {
    const blob = seal(TOKENS, KEY);
    expect(blob).not.toContain('refresh-1');
    expect(blob).not.toContain('access-1');
  });

  it('refuses a blob sealed with a different key, and says nothing about it', () => {
    const blob = seal(TOKENS, KEY);
    expect(() => unseal(blob, OTHER)).toThrow(/could not be opened/);
    expect(opensWith(blob, OTHER)).toBe(false);
    expect(opensWith(blob, KEY)).toBe(true);
  });

  it('refuses a TAMPERED blob rather than returning plausible rubbish', () => {
    const [version, iv, tag, body] = seal(TOKENS, KEY).split('.') as [string, string, string, string];
    // One flipped character in the ciphertext. Without the auth tag this would
    // decrypt to something — which is the whole reason GCM is used here.
    const flipped = `${body.slice(0, -1)}${body.slice(-1) === 'A' ? 'B' : 'A'}`;
    expect(() => unseal([version, iv, tag, flipped].join('.'), KEY)).toThrow(/could not be opened/);
    expect(() => unseal([version, iv, 'AAAAAAAAAAAAAAAAAAAAAA', body].join('.'), KEY)).toThrow(/could not be opened/);
  });

  it('refuses a blob from a format this build does not know', () => {
    expect(() => unseal('v2.a.b.c', KEY)).toThrow(/not in a format/);
    expect(() => unseal('nonsense', KEY)).toThrow(/not in a format/);
    expect(() => unseal('', KEY)).toThrow(/not in a format/);
  });

  it('never puts the ciphertext in the error', () => {
    const blob = seal(TOKENS, KEY);
    try {
      unseal(blob, OTHER);
      expect.unreachable('should have thrown');
    } catch (error) {
      expect((error as Error).message).not.toContain(blob.slice(10, 30));
    }
  });

  it('carries a null refresh expiry through — FreeAgent states none', () => {
    const forever = { ...TOKENS, refreshExpiresAt: null, scope: null };
    expect(unseal(seal(forever, KEY), KEY)).toEqual(forever);
  });
});

describe('the OAuth state', () => {
  const NOW = Date.parse('2026-09-15T12:00:00.000Z');
  const PAYLOAD = { b: 'biz_1', v: 'xero', a: 'user_1' };

  it('round-trips the business, the vendor and the actor', () => {
    const state = verifyState(signState(PAYLOAD, KEY, NOW), KEY, NOW + 1000);
    expect(state.b).toBe('biz_1');
    expect(state.v).toBe('xero');
    expect(state.a).toBe('user_1');
  });

  it('refuses a state this server did not sign', () => {
    expect(() => verifyState(signState(PAYLOAD, OTHER, NOW), KEY, NOW)).toThrow(/not one this server issued/);
    expect(() => verifyState('forged.signature', KEY, NOW)).toThrow(/not one this server issued/);
  });

  it('refuses a TAMPERED payload — the business cannot be swapped', () => {
    const [body, signature] = signState(PAYLOAD, KEY, NOW).split('.') as [string, string];
    const swapped = Buffer.from(
      JSON.stringify({ ...JSON.parse(Buffer.from(body, 'base64url').toString('utf8')), b: 'biz_victim' }),
      'utf8',
    ).toString('base64url');
    expect(() => verifyState(`${swapped}.${signature}`, KEY, NOW)).toThrow(/not one this server issued/);
  });

  it('expires after ten minutes, with its own sentence', () => {
    const state = signState(PAYLOAD, KEY, NOW);
    expect(() => verifyState(state, KEY, NOW + 9 * 60 * 1000)).not.toThrow();
    expect(() => verifyState(state, KEY, NOW + 11 * 60 * 1000)).toThrow(/took too long/);
  });

  it('is unique per request — the nonce', () => {
    const states = new Set(Array.from({ length: 20 }, () => signState(PAYLOAD, KEY, NOW)));
    expect(states.size).toBe(20);
  });
});

describe('constant-time comparison', () => {
  it('is true only for equal strings and never throws on a length mismatch', () => {
    expect(safeEqual('abc', 'abc')).toBe(true);
    expect(safeEqual('abc', 'abd')).toBe(false);
    expect(safeEqual('abc', 'abcd')).toBe(false);
    expect(safeEqual('', '')).toBe(true);
    expect(safeEqual(randomBytes(16).toString('hex'), randomBytes(16).toString('hex'))).toBe(false);
  });
});
