import { describe, expect, it } from 'vitest';

import { ApiKeyContextResolver, apiKeyTokenFrom, type VerifiedApiKey } from './api-key-context-resolver.js';
import { currentApiKey, runWithRequestContext } from './request-context.js';
import type { ScopeContext } from '../db/scope-context.js';

const KEY_CTX: ScopeContext = { actorId: 'usr_api_1', practiceId: 'prac_a', sessionScope: 'user', grantedItemIds: [] };
const SESSION_CTX: ScopeContext = { actorId: 'usr_human', practiceId: 'prac_a', sessionScope: 'user', grantedItemIds: [] };

function resolver(known: Record<string, VerifiedApiKey>) {
  const seen: string[] = [];
  const r = new ApiKeyContextResolver(
    { verifyApiKey: async (token) => { seen.push(token); return known[token] ?? null; } },
    { resolve: () => SESSION_CTX },
  );
  return { r, seen };
}

const headers = (authorization?: string) => (name: string) => (name === 'authorization' ? authorization : undefined);

describe('ApiKeyContextResolver', () => {
  it('resolves a known key to its own practice context and records its scopes', async () => {
    const { r } = resolver({ nt_live_prac_a_secret: { keyId: 'key_1', scopes: ['documents:read'], context: KEY_CTX } });
    await runWithRequestContext(headers('Bearer nt_live_prac_a_secret'), async () => {
      await expect(r.resolve(headers('Bearer nt_live_prac_a_secret'))).resolves.toEqual(KEY_CTX);
      expect(currentApiKey()).toEqual({ keyId: 'key_1', scopes: ['documents:read'] });
    });
  });

  it('refuses an unknown or revoked key with 401 rather than falling through to the session', async () => {
    const { r } = resolver({});
    await expect(r.resolve(headers('Bearer nt_live_prac_a_nope'))).rejects.toMatchObject({ code: 'NT-AUTH-001' });
  });

  it('leaves cookies and portal bearers to the wrapped resolver, without touching the key store', async () => {
    const { r, seen } = resolver({});
    await expect(r.resolve(headers())).resolves.toEqual(SESSION_CTX);
    await expect(r.resolve(headers('Bearer portal-token'))).resolves.toEqual(SESSION_CTX);
    expect(seen).toEqual([]);
  });

  it('only recognises the nt_live_ prefix as an API key', () => {
    expect(apiKeyTokenFrom('Bearer nt_live_abc_def')).toBe('nt_live_abc_def');
    expect(apiKeyTokenFrom('bearer  nt_live_abc_def ')).toBe('nt_live_abc_def');
    expect(apiKeyTokenFrom('Bearer something-else')).toBeUndefined();
    expect(apiKeyTokenFrom(undefined)).toBeUndefined();
  });
});
