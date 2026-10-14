import { createServer, type Server, type Socket } from 'node:net';

import { afterEach, expect, test } from 'vitest';

import { createClamdVirusScanner, parseClamdReply, VirusScanUnavailableError } from './clamd-virus-scanner.js';
import { EICAR_TEST_STRING } from './virus-scan.js';

/**
 * A fake clamd on a real TCP socket. No mocks of `node:net`: the thing under
 * test IS the wire protocol, so the test speaks it from the other end — reads
 * the command, reassembles the INSTREAM frames, and answers like the daemon.
 */
interface FakeClamd {
  readonly port: number;
  /** Every stream the fake fully received, reassembled from its frames. */
  readonly received: Buffer[];
  close(): Promise<void>;
}

type Reply = (received: Buffer) => string | null;

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

function fakeClamd(reply: Reply): Promise<FakeClamd> {
  const received: Buffer[] = [];
  const server = createServer((socket: Socket) => {
    let buffer = Buffer.alloc(0);
    let command: string | null = null;
    const chunks: Buffer[] = [];

    socket.on('data', (data: Buffer) => {
      buffer = Buffer.concat([buffer, data]);
      if (command === null) {
        const nul = buffer.indexOf(0);
        if (nul === -1) return;
        command = buffer.toString('utf8', 0, nul);
        buffer = buffer.subarray(nul + 1);
        if (command === 'zPING') {
          socket.end('PONG\0');
          return;
        }
        if (command !== 'zINSTREAM') {
          socket.end('UNKNOWN COMMAND\0');
          return;
        }
      }
      // Frame loop: <u32 BE length><bytes>; a zero length ends the stream.
      for (;;) {
        if (buffer.length < 4) return;
        const length = buffer.readUInt32BE(0);
        if (length === 0) {
          const whole = Buffer.concat(chunks);
          received.push(whole);
          const answer = reply(whole);
          if (answer === null) socket.destroy();
          else socket.end(`${answer}\0`);
          return;
        }
        if (buffer.length < 4 + length) return;
        chunks.push(Buffer.from(buffer.subarray(4, 4 + length)));
        buffer = buffer.subarray(4 + length);
      }
    });
  });
  servers.push(server);
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') throw new Error('no port');
      resolve({
        port: address.port,
        received,
        close: () => new Promise<void>((done) => server.close(() => done())),
      });
    });
  });
}

const CLEAN_REPLY = () => 'stream: OK';
const EICAR_REPLY = (bytes: Buffer) =>
  bytes.includes(Buffer.from(EICAR_TEST_STRING, 'latin1')) ? 'stream: Win.Test.EICAR_HDB-1 FOUND' : 'stream: OK';

test('a clean file streams to clamd intact and comes back not infected', async () => {
  const daemon = await fakeClamd(CLEAN_REPLY);
  const scanner = createClamdVirusScanner({ host: '127.0.0.1', port: daemon.port, chunkBytes: 7 });
  const bytes = Buffer.from('%PDF-1.4 a perfectly ordinary invoice, longer than one 7-byte frame');

  const verdict = await scanner.scan(bytes);

  expect(verdict).toEqual({ infected: false });
  // The whole point of the framing test: the daemon reassembled EXACTLY what we
  // sent, across several frames, with a zero-length terminator.
  expect(daemon.received).toHaveLength(1);
  expect(daemon.received[0]?.equals(bytes)).toBe(true);
});

test('the EICAR test file is reported infected with the signature clamd names', async () => {
  const daemon = await fakeClamd(EICAR_REPLY);
  const scanner = createClamdVirusScanner({ host: '127.0.0.1', port: daemon.port });

  const verdict = await scanner.scan(Buffer.from(EICAR_TEST_STRING, 'latin1'));

  expect(verdict).toEqual({ infected: true, signature: 'Win.Test.EICAR_HDB-1' });
});

test('an empty file is a valid (empty) stream, not an error', async () => {
  const daemon = await fakeClamd(CLEAN_REPLY);
  const scanner = createClamdVirusScanner({ host: '127.0.0.1', port: daemon.port });

  await expect(scanner.scan(Buffer.alloc(0))).resolves.toEqual({ infected: false });
  expect(daemon.received[0]?.length).toBe(0);
});

// ---------------------------------------------------------------------------
// FAIL CLOSED. Each of these is a way the daemon can fail to give a verdict,
// and every one must be a THROW — never `{ infected: false }`.
// ---------------------------------------------------------------------------

test('nothing listening → throws VirusScanUnavailableError, never passes the file', async () => {
  // Bind then close, so the port is known to be free.
  const daemon = await fakeClamd(CLEAN_REPLY);
  await daemon.close();
  const scanner = createClamdVirusScanner({ host: '127.0.0.1', port: daemon.port, timeoutMs: 2_000 });

  await expect(scanner.scan(Buffer.from('x'))).rejects.toBeInstanceOf(VirusScanUnavailableError);
});

test('clamd refusing the stream (size limit ERROR) is unavailable, not clean', async () => {
  const daemon = await fakeClamd(() => 'INSTREAM size limit exceeded. ERROR');
  const scanner = createClamdVirusScanner({ host: '127.0.0.1', port: daemon.port });

  await expect(scanner.scan(Buffer.from('big'))).rejects.toThrow(/size limit exceeded/);
});

test('the daemon closing without a reply is unavailable, not clean', async () => {
  const daemon = await fakeClamd(() => null);
  const scanner = createClamdVirusScanner({ host: '127.0.0.1', port: daemon.port });

  await expect(scanner.scan(Buffer.from('x'))).rejects.toBeInstanceOf(VirusScanUnavailableError);
});

test('a daemon that never answers hits the deadline and fails closed', async () => {
  // Accepts the connection, reads everything, replies with nothing, ever.
  const server = createServer((socket) => socket.on('data', () => undefined));
  servers.push(server);
  const port = await new Promise<number>((resolve) =>
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      resolve(address !== null && typeof address !== 'string' ? address.port : 0);
    }),
  );
  const scanner = createClamdVirusScanner({ host: '127.0.0.1', port, timeoutMs: 150 });

  await expect(scanner.scan(Buffer.from('x'))).rejects.toThrow(/no verdict within 150 ms/);
});

test('ping answers true against a live daemon and false against nothing', async () => {
  const daemon = await fakeClamd(CLEAN_REPLY);
  const live = createClamdVirusScanner({ host: '127.0.0.1', port: daemon.port });
  expect(await live.ping()).toBe(true);

  await daemon.close();
  const dead = createClamdVirusScanner({ host: '127.0.0.1', port: daemon.port });
  expect(await dead.ping()).toBe(false);
});

// ---------------------------------------------------------------------------
// The reply grammar on its own, so the three shapes are pinned by name.
// ---------------------------------------------------------------------------

test('parseClamdReply: OK, FOUND with its signature, and everything else refuses', () => {
  expect(parseClamdReply('stream: OK')).toEqual({ infected: false });
  expect(parseClamdReply('stream: Eicar-Signature FOUND')).toEqual({ infected: true, signature: 'Eicar-Signature' });
  expect(parseClamdReply('stream: Win.Trojan.Agent-1234567 FOUND')).toEqual({
    infected: true,
    signature: 'Win.Trojan.Agent-1234567',
  });
  expect(() => parseClamdReply('')).toThrow(VirusScanUnavailableError);
  expect(() => parseClamdReply('INSTREAM size limit exceeded. ERROR')).toThrow(VirusScanUnavailableError);
  expect(() => parseClamdReply('stream: Can\'t open file ERROR')).toThrow(VirusScanUnavailableError);
  // Not a verdict word we know — must not be read as clean.
  expect(() => parseClamdReply('stream: OKAY')).toThrow(VirusScanUnavailableError);
});
