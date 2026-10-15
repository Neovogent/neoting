import { lookup as dnsLookup, type LookupAddress } from 'node:dns';
import { Agent, request } from 'node:https';
import { BlockList, isIP, type LookupFunction } from 'node:net';

/**
 * The outbound-request SSRF guard (rush/public-api).
 *
 * Practices hand us URLs — webhook endpoints, Slack/Teams hooks, a browser's
 * push endpoint — and the worker then calls them from inside our network. A URL
 * that resolves to 127.0.0.1, the VPC, or the instance-metadata address would
 * turn that into a request forgery against ourselves. So:
 *
 * - {@link assertPublicHttpsUrl} refuses at save time, with a reason a person can read;
 * - {@link safeAgent} re-checks at CONNECT time, on the address actually dialled,
 *   which is what defeats DNS rebinding (a name that was public when saved and
 *   points inward when called). Every outbound call in this lane uses it.
 */

const blocked = new BlockList();
for (const [net, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
  ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15],
  ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
] as const) blocked.addSubnet(net, prefix, 'ipv4');
for (const [net, prefix] of [
  ['::', 128], ['::1', 128], ['64:ff9b::', 96], ['100::', 64], ['2001:db8::', 32],
  ['fc00::', 7], ['fe80::', 10], ['fec0::', 10], ['ff00::', 8],
] as const) blocked.addSubnet(net, prefix, 'ipv6');

/** True for any address a request from our network must never be allowed to reach. */
export function isPrivateAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 0) return true; // not an address at all — refuse rather than guess
  if (family === 4) return blocked.check(address, 'ipv4');
  // IPv4-mapped IPv6 (`::ffff:10.0.0.1`) reaches the IPv4 host it names.
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
  if (mapped?.[1] !== undefined) return blocked.check(mapped[1], 'ipv4');
  if (/^::ffff:/i.test(address)) return true;
  return blocked.check(address, 'ipv6');
}

export class UnsafeUrlError extends Error {}

/**
 * Parse and vet a URL a practice wants us to call. https only, no embedded
 * credentials, and every address its host resolves to must be public.
 * `allowedHosts` narrows further (Slack/Teams): a suffix match on the hostname.
 */
export async function assertPublicHttpsUrl(raw: string, allowedHosts?: readonly string[]): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new UnsafeUrlError('That is not a valid URL.');
  }
  if (url.protocol !== 'https:') throw new UnsafeUrlError('The URL must start with https://');
  if (url.username !== '' || url.password !== '') throw new UnsafeUrlError('The URL must not carry a username or password.');
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (allowedHosts !== undefined && !allowedHosts.some((h) => host === h || host.endsWith(`.${h}`))) {
    throw new UnsafeUrlError(`The URL must be on ${allowedHosts.join(' or ')}.`);
  }
  const addresses = isIP(host) !== 0 ? [host] : await resolveAll(host);
  if (addresses.length === 0 || addresses.some(isPrivateAddress)) {
    throw new UnsafeUrlError('The URL points at a private or internal address.');
  }
  return url;
}

function resolveAll(host: string): Promise<string[]> {
  return new Promise((resolve) => {
    dnsLookup(host, { all: true }, (error, addresses: LookupAddress[]) => {
      resolve(error ? [] : addresses.map((a) => a.address));
    });
  });
}

/**
 * A `dns.lookup` drop-in that refuses private answers. Handles both call shapes
 * Node uses (`all: true` under autoSelectFamily, single-address otherwise).
 */
export const safeLookup: LookupFunction = (hostname, options, callback) => {
  dnsLookup(hostname, { ...options, all: true }, (error, addresses: LookupAddress[]) => {
    if (error) return callback(error, '', 0);
    const bad = addresses.find((a) => isPrivateAddress(a.address));
    if (bad !== undefined || addresses.length === 0) {
      return callback(Object.assign(new Error(`refused: ${hostname} resolves to a private address`), { code: 'ESSRF' }), '', 0);
    }
    if ((options as { all?: boolean }).all === true) {
      return (callback as unknown as (e: null, a: LookupAddress[]) => void)(null, addresses);
    }
    const first = addresses[0] as LookupAddress;
    return callback(null, first.address, first.family);
  });
};

/** The one agent every outbound call in this lane uses — connect-time SSRF check, no keep-alive surprises. */
export const safeAgent = new Agent({ lookup: safeLookup, keepAlive: false });

export interface PostResult {
  readonly status: number | null;
  readonly error: string | null;
}

/**
 * POST a body to a vetted URL. Never follows redirects (a 3xx is a failure
 * like any other non-2xx — a redirect is how a public URL hands us an inward
 * one). Never throws: the caller records what happened.
 */
export function safePost(url: string, body: string, headers: Record<string, string>, timeoutMs = 10_000): Promise<PostResult> {
  return new Promise((resolve) => {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return resolve({ status: null, error: 'invalid URL' });
    }
    if (parsed.protocol !== 'https:') return resolve({ status: null, error: 'only https is allowed' });
    const req = request(
      parsed,
      {
        method: 'POST',
        agent: safeAgent,
        timeout: timeoutMs,
        headers: { 'content-type': 'application/json', 'user-agent': 'Neoting-Webhooks/1', ...headers, 'content-length': Buffer.byteLength(body) },
      },
      (res) => {
        res.resume(); // drain; the body is not ours to keep
        const status = res.statusCode ?? null;
        resolve({ status, error: status !== null && status >= 200 && status < 300 ? null : `HTTP ${status ?? '?'}` });
      },
    );
    req.on('timeout', () => req.destroy(new Error('timed out')));
    req.on('error', (error) => resolve({ status: null, error: error.message.slice(0, 300) }));
    req.end(body);
  });
}
