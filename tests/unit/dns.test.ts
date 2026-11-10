import { test } from 'node:test';
import assert from 'node:assert/strict';
import dgram from 'node:dgram';
import net from 'node:net';
import tls from 'node:tls';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import packet from 'dns-packet';
import { initialConfig } from '../../src/config/model.js';
import { Resolver } from '../../src/dns/resolver.js';
import { ByteReader, u16, write } from '../../src/proxy/codec/bytes.js';
import { listen } from '../helpers.js';

test('proxy-server DNS is isolated from ordinary queries and policies, with empty-list fallback and hosts precedence', async (t) => {
  const servers: dgram.Socket[] = [];
  const endpoint = async (address: string) => {
    const udp = dgram.createSocket('udp4');
    servers.push(udp);
    udp.on('message', (data, remote) => {
      const q = packet.decode(data);
      udp.send(
        packet.encode({
          type: 'response',
          id: q.id,
          questions: q.questions,
          answers: [
            { type: 'A', name: q.questions![0].name, ttl: 60, data: address },
          ],
        }),
        remote.port,
        remote.address,
      );
    });
    udp.bind(0, '127.0.0.1');
    await once(udp, 'listening');
    return {
      transport: 'udp' as const,
      host: '127.0.0.1',
      port: udp.address().port,
    };
  };
  const c = initialConfig();
  c.dns.enable = true;
  c.dns.nameservers = [await endpoint('192.0.2.1')];
  c.dns.policy = { 'node.test': [await endpoint('192.0.2.2')] };
  c.dns.proxyServerNameservers = [await endpoint('192.0.2.3')];
  const resolver = new Resolver(c);
  t.after(() => {
    resolver.close();
    servers.forEach((s) => s.close());
  });
  assert.equal(await resolver.resolve('ordinary.test'), '192.0.2.1');
  assert.equal(await resolver.resolve('node.test'), '192.0.2.2');
  assert.equal(await resolver.resolveProxyServer('node.test'), '192.0.2.3');
  c.dns.proxyServerNameservers = [];
  assert.equal(await resolver.resolveProxyServer('node.test'), '192.0.2.2');
  assert.equal(await resolver.resolveProxyServer('ordinary.test'), '192.0.2.1');
  c.hosts['node.test'] = '192.0.2.4';
  assert.equal(await resolver.resolveProxyServer('node.test'), '192.0.2.4');
  c.dns.enable = false;
  assert.equal(await resolver.resolveProxyServer('node.test'), '192.0.2.4');
});

test('DNS burst queues beyond 64 exchanges and cancels queued queries without exhausting capacity', async (t) => {
  const udp = dgram.createSocket('udp4');
  const c = initialConfig();
  const resolver = new Resolver(c);
  t.after(() => {
    resolver.close();
    udp.close();
  });
  const received = new Set<string>();
  udp.on('message', (data, remote) => {
    const q = packet.decode(data);
    const name = q.questions![0].name;
    received.add(name);
    setTimeout(() => {
      udp.send(
        packet.encode({
          type: 'response',
          id: q.id,
          questions: q.questions,
          answers: [{ type: 'A', name, ttl: 60, data: '192.0.2.1' }],
        }),
        remote.port,
        remote.address,
      );
    }, 20);
  });
  udp.bind(0, '127.0.0.1');
  await once(udp, 'listening');
  c.dns.enable = true;
  c.dns.nameservers = [
    { transport: 'udp', host: '127.0.0.1', port: udp.address().port },
  ];
  const queries = Array.from({ length: 80 }, (_, i) =>
    resolver.resolve(`node-${i}.test`),
  );
  const cancel = new AbortController();
  const cancelled = resolver.resolve('cancelled.test', cancel.signal);
  const rejection = assert.rejects(cancelled);
  cancel.abort();
  await rejection;
  assert.deepEqual(await Promise.all(queries), Array(80).fill('192.0.2.1'));
  assert.equal(received.has('cancelled.test'), false);
  assert.equal(await resolver.resolve('after-burst.test'), '192.0.2.1');
});

test('controlled DNS: UDP truncation retries TCP, TTL/CNAME/cache and NXDOMAIN', async (t) => {
  let queries = 0;
  const peers = new Set<net.Socket>();
  const respond = (data: Buffer, udp: boolean) => {
    const q = packet.decode(data);
    queries++;
    const question = q.questions![0];
    return packet.encode({
      type: 'response',
      id: q.id,
      flags:
        packet.RECURSION_DESIRED |
        (udp ? packet.TRUNCATED_RESPONSE : 0) |
        (question.name === 'missing.test' ? 3 : 0),
      questions: q.questions,
      answers: udp
        ? []
        : question.name === 'alias.test'
          ? [
              {
                type: 'CNAME',
                name: 'alias.test',
                ttl: 60,
                data: 'answer.test',
              },
            ]
          : question.name === 'missing.test'
            ? []
            : [{ type: 'A', name: question.name, ttl: 60, data: '192.0.2.15' }],
    });
  };
  const tcp = net.createServer((socket) => {
    peers.add(socket);
    socket.on('error', () => {});
    socket.once('close', () => peers.delete(socket));
    void (async () => {
      const reader = new ByteReader(socket);
      const q = await reader.exact((await reader.exact(2)).readUInt16BE());
      const response = respond(q, false);
      await write(socket, Buffer.concat([u16(response.length), response]));
      socket.end();
    })().catch(() => socket.destroy());
  });
  const port = await listen(tcp);
  const udp = dgram.createSocket('udp4');
  udp.on('message', (data, remote) =>
    udp.send(respond(data, true), remote.port, remote.address),
  );
  udp.bind(port, '127.0.0.1');
  await once(udp, 'listening');
  const c = initialConfig();
  c.dns.enable = true;
  c.dns.nameservers = [{ transport: 'udp', host: '127.0.0.1', port }];
  const resolver = new Resolver(c);
  t.after(async () => {
    resolver.close();
    udp.close();
    peers.forEach((s) => s.destroy());
    await new Promise<void>((r) => tcp.close(() => r()));
  });
  assert.equal(await resolver.resolve('alias.test'), '192.0.2.15');
  assert.equal(queries, 4);
  assert.equal(await resolver.resolve('alias.test'), '192.0.2.15');
  assert.equal(queries, 4);
  await assert.rejects(
    resolver.resolve('missing.test'),
    (e: any) => e.code === 'DNS_NXDOMAIN',
  );
  resolver.close();
  const fresh = new Resolver(c);
  assert.equal(await fresh.resolve('alias.test'), '192.0.2.15');
  assert.equal(queries, 10);
  fresh.close();
});
test('DNS policy: exact, longest suffix, upstream hostname bootstrap and DoT verification', async (t) => {
  const cert = await readFile('tests/fixtures/tls-cert.pem');
  const key = await readFile('tests/fixtures/tls-key.pem');
  tls.setDefaultCACertificates([...tls.getCACertificates('default'), cert]);
  const queries: string[] = [];
  const peers = new Set<net.Socket>();
  const tlsServer = tls.createServer({ cert, key }, (socket) => {
    peers.add(socket);
    socket.on('error', () => {});
    socket.once('close', () => peers.delete(socket));
    void (async () => {
      const reader = new ByteReader(socket);
      const q = packet.decode(
        await reader.exact((await reader.exact(2)).readUInt16BE()),
      );
      queries.push(`tls:${q.questions![0].name}`);
      const response = packet.encode({
        type: 'response',
        id: q.id,
        flags: 0,
        questions: q.questions,
        answers: [
          { type: 'A', name: q.questions![0].name, ttl: 1, data: '192.0.2.44' },
        ],
      });
      await write(socket, Buffer.concat([u16(response.length), response]));
      socket.end();
    })().catch(() => socket.destroy());
  });
  const tlsPort = await listen(tlsServer);
  const udp = dgram.createSocket('udp4');
  udp.on('message', (data, remote) => {
    const q = packet.decode(data);
    const host = q.questions![0].name;
    queries.push(`udp:${host}`);
    const response = packet.encode({
      type: 'response',
      id: q.id,
      flags: 0,
      questions: q.questions,
      answers: [
        {
          type: 'A',
          name: host,
          ttl: 1,
          data: host === 'localhost' ? '127.0.0.1' : '192.0.2.11',
        },
      ],
    });
    udp.send(response, remote.port, remote.address);
  });
  udp.bind(0, '127.0.0.1');
  await once(udp, 'listening');
  const port = (udp.address() as net.AddressInfo).port;
  const c = initialConfig();
  c.dns.enable = true;
  c.dns.bootstrap = [{ transport: 'udp', host: '127.0.0.1', port }];
  c.dns.nameservers = [{ transport: 'tls', host: 'localhost', port: tlsPort }];
  c.dns.policy = {
    '+.example.test': [{ transport: 'udp', host: '127.0.0.1', port }],
    '+.deep.example.test': c.dns.nameservers,
    'exact.example.test': c.dns.nameservers,
  };
  c.hosts['host.test'] = '127.0.0.7';
  const resolver = new Resolver(c);
  t.after(async () => {
    resolver.close();
    udp.close();
    peers.forEach((s) => s.destroy());
    await new Promise<void>((r) => tlsServer.close(() => r()));
  });
  assert.equal(await resolver.resolve('host.test'), '127.0.0.7');
  assert.equal(queries.length, 0);
  assert.equal(await resolver.resolve('www.example.test'), '192.0.2.11');
  assert.equal(await resolver.resolve('www.deep.example.test'), '192.0.2.44');
  assert.equal(await resolver.resolve('exact.example.test'), '192.0.2.44');
  assert.ok(queries.includes('udp:localhost'));
  assert.ok(queries.includes('tls:exact.example.test'));
  const invalid = structuredClone(c);
  invalid.dns.nameservers = [
    { transport: 'tls', host: 'wrong.example.test', port: tlsPort },
  ];
  // Bootstrap maps only localhost to loopback; hosts do not silently alter DNS upstream bootstrap.
  const bad = new Resolver(invalid);
  await assert.rejects(bad.resolve('outside.test'));
  bad.close();
});
test('DNS validates transaction and questions, supports AAAA, finite CNAME and cancellation', async (t) => {
  let queries = 0;
  const udp = dgram.createSocket('udp4');
  udp.on('message', (data, remote) => {
    const q = packet.decode(data);
    queries++;
    const question = q.questions![0];
    if (question.name === 'silent.test') return;
    const answers: packet.Answer[] =
      question.name === 'loop.test'
        ? [{ type: 'CNAME', name: 'loop.test', ttl: 1, data: 'loop.test' }]
        : question.type === 'A'
          ? []
          : [
              {
                type: 'AAAA',
                name: question.name,
                ttl: 0,
                data: '2001:db8::7',
              },
            ];
    const response = {
      type: 'response' as const,
      id: q.id,
      flags: 0,
      questions: q.questions,
      answers,
    };
    udp.send(
      packet.encode({ ...response, id: (q.id! + 1) & 65535 }),
      remote.port,
      remote.address,
    );
    udp.send(packet.encode(response), remote.port, remote.address);
  });
  udp.bind(0, '127.0.0.1');
  await once(udp, 'listening');
  const c = initialConfig();
  c.dns.enable = true;
  c.dns.nameservers = [
    {
      transport: 'udp',
      host: '127.0.0.1',
      port: (udp.address() as net.AddressInfo).port,
    },
  ];
  const resolver = new Resolver(c);
  t.after(() => {
    resolver.close();
    udp.close();
  });
  assert.equal(await resolver.resolve('v6.test'), '2001:db8::7');
  assert.equal(queries, 2);
  await resolver.resolve('v6.test');
  assert.equal(queries, 3, 'only the zero-TTL AAAA answer is queried again');
  await assert.rejects(resolver.resolve('loop.test'));
  const abort = new AbortController();
  const pending = resolver.resolve('silent.test', abort.signal);
  abort.abort();
  await assert.rejects(pending);
});
