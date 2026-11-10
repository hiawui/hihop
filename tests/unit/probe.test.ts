import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import tls from 'node:tls';
import { Duplex, Readable, Writable } from 'node:stream';
import { once } from 'node:events';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import {
  ssOutbound,
  masterKey,
  ssSubkey,
} from '../../src/proxy/outbound/ss.js';
import { incrementLE, open, seal } from '../../src/proxy/outbound/crypto.js';
import {
  address,
  ByteReader,
  u16,
  write,
} from '../../src/proxy/codec/bytes.js';
import { socketConnect } from '../../src/proxy/transport/socket.js';
import { listen } from '../helpers.js';

test(
  'SS decoded stream carries a verified TLS handshake and HTTPS response',
  { timeout: 10000 },
  async (t) => {
    const cert = await readFile('tests/fixtures/tls-cert.pem');
    const key = await readFile('tests/fixtures/tls-key.pem');
    const context = tls.createSecureContext({ cert, key });
    const password = 'test-only';
    const peers = new Set<Duplex>();
    const failures: unknown[] = [];
    const response = 'HTTP/1.1 204 No Content\r\nConnection: close\r\n\r\n';
    const server = net.createServer((wire) => {
      peers.add(wire);
      wire.on('error', () => {});
      void (async () => {
        const reader = new ByteReader(wire);
        const master = masterKey(password, 16);
        const incomingKey = ssSubkey(master, await reader.exact(16));
        const incomingNonce = Buffer.alloc(12);
        const frame = async () => {
          const length = open(
            'aes-128-gcm',
            incomingKey,
            incomingNonce,
            await reader.exact(18),
          ).readUInt16BE();
          incrementLE(incomingNonce);
          const data = open(
            'aes-128-gcm',
            incomingKey,
            incomingNonce,
            await reader.exact(length + 16),
          );
          incrementLE(incomingNonce);
          return data;
        };
        assert.deepEqual(
          await frame(),
          Buffer.concat([address('localhost'), u16(443)]),
        );
        const salt = randomBytes(16);
        const outgoingKey = ssSubkey(master, salt);
        const outgoingNonce = Buffer.alloc(12);
        await write(wire, salt);
        const plain = Duplex.from({
          readable: Readable.from(
            (async function* () {
              while (!wire.destroyed) yield await frame();
            })(),
            { objectMode: false },
          ),
          writable: new Writable({
            write(data: Buffer, _encoding, cb) {
              const length = seal(
                'aes-128-gcm',
                outgoingKey,
                outgoingNonce,
                u16(data.length),
              );
              incrementLE(outgoingNonce);
              const payload = seal(
                'aes-128-gcm',
                outgoingKey,
                outgoingNonce,
                data,
              );
              incrementLE(outgoingNonce);
              write(wire, Buffer.concat([length, payload])).then(
                () => cb(),
                cb,
              );
            },
          }),
        });
        peers.add(plain);
        plain.on('error', () => {});
        const secure = new tls.TLSSocket(plain, {
          isServer: true,
          secureContext: context,
        });
        peers.add(secure);
        secure.on('error', () => {});
        let request = '';
        secure.on('data', (data: Buffer) => {
          request += data.toString();
          if (request.endsWith('\r\n\r\n')) {
            assert.match(request, /^GET \/generate_204 HTTP\/1\.1/);
            secure.write(response);
          }
        });
      })().catch((error) => {
        failures.push(error);
        wire.destroy();
      });
    });
    const port = await listen(server);
    const cancel = new AbortController();
    t.after(async () => {
      cancel.abort();
      peers.forEach((peer) => peer.destroy());
      await new Promise<void>((resolve) => server.close(() => resolve()));
    });
    const wire = await socketConnect('127.0.0.1', port, cancel.signal);
    const outbound = await ssOutbound(
      wire,
      {
        id: randomUUID(),
        name: 'local',
        type: 'ss',
        server: '127.0.0.1',
        port,
        cipher: 'aes-128-gcm',
        password,
        udp: false,
      },
      { host: 'localhost', port: 443 },
      cancel.signal,
    );
    const secure = tls.connect({
      socket: outbound,
      servername: 'localhost',
      ca: cert,
    });
    peers.add(secure);
    secure.on('error', () => {});
    await once(secure, 'secureConnect');
    assert.equal(secure.authorized, true);
    await write(
      secure,
      Buffer.from('GET /generate_204 HTTP/1.1\r\nHost: localhost\r\n\r\n'),
    );
    assert.equal(
      (await new ByteReader(secure).exact(response.length)).toString(),
      response,
    );
    assert.deepEqual(failures, []);
  },
);
