import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { once } from 'node:events';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ConfigManager } from '../../src/config/manager.js';
import { ConfigStore } from '../../src/config/storage.js';
import { type ProxyNode } from '../../src/config/model.js';
import { Router } from '../../src/routing/router.js';
import { ProxyService } from '../../src/proxy/service.js';
import { AUTO_PROBE_INTERVAL } from '../../src/proxy/probe.js';
import {
  ByteReader,
  address,
  u16,
  write,
} from '../../src/proxy/codec/bytes.js';
import { masterKey, ssSubkey } from '../../src/proxy/outbound/ss.js';
import { incrementLE, open, seal } from '../../src/proxy/outbound/crypto.js';
import { freePort, listen, socks } from '../helpers.js';

// Two authenticated SS endpoints tag returned application data, revealing which
// actual node each persistent connection uses across configuration changes.
async function ssEcho(label: string) {
  const peers = new Set<net.Socket>();
  const server = net.createServer({ allowHalfOpen: true }, (wire) => {
    peers.add(wire);
    wire.on('error', () => {});
    wire.once('close', () => peers.delete(wire));
    void (async () => {
      const reader = new ByteReader(wire);
      const master = masterKey('test-only', 16);
      const key = ssSubkey(master, await reader.exact(16));
      const nonce = Buffer.alloc(12);
      const frame = async () => {
        const length = await reader.read(18, true);
        if (!length) return undefined;
        const size = open('aes-128-gcm', key, nonce, length).readUInt16BE();
        incrementLE(nonce);
        const payload = open(
          'aes-128-gcm',
          key,
          nonce,
          await reader.exact(size + 16),
        );
        incrementLE(nonce);
        return payload;
      };
      assert.deepEqual(
        await frame(),
        Buffer.concat([address('example.test'), u16(80)]),
      );
      const salt = randomBytes(16);
      const responseKey = ssSubkey(master, salt);
      const responseNonce = Buffer.alloc(12);
      await write(wire, salt);
      for (;;) {
        const request = await frame();
        if (!request) break;
        const payload = Buffer.concat([Buffer.from(label), request]);
        const length = seal(
          'aes-128-gcm',
          responseKey,
          responseNonce,
          u16(payload.length),
        );
        incrementLE(responseNonce);
        const body = seal('aes-128-gcm', responseKey, responseNonce, payload);
        incrementLE(responseNonce);
        await write(wire, Buffer.concat([length, body]));
      }
      wire.end();
    })().catch(() => wire.destroy());
  });
  const port = await listen(server);
  const node: ProxyNode = {
    id: randomUUID(),
    name: label,
    type: 'ss',
    server: '127.0.0.1',
    port,
    cipher: 'aes-128-gcm',
    password: 'test-only',
    udp: false,
  };
  return {
    node,
    close: async () => {
      peers.forEach((peer) => peer.destroy());
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

test(
  'node switches preserve existing and handshaking connections; commit atomically, drain old routers, and stop all generations',
  { timeout: 10000 },
  async (t) => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'hihop-smooth-switch-'));
    const a = await ssEcho('A'),
      b = await ssEcho('B');
    const clients: { socket: net.Socket; reader: ByteReader }[] = [];
    const snapshots: { router: Router; closed: number }[] = [];
    const compile = Router.compile.bind(Router);
    t.mock.method(
      Router,
      'compile',
      async (...args: Parameters<typeof Router.compile>) => {
        const router = await compile(...args);
        const snapshot = { router, closed: 0 };
        snapshots.push(snapshot);
        const close = router.close.bind(router);
        t.mock.method(router, 'close', () => {
          snapshot.closed++;
          close();
        });
        return router;
      },
    );
    const binds = t.mock.method(ProxyService.prototype, 'bind');
    let fastest = 0;
    const store = new ConfigStore(path.join(dir, 'config.json'));
    const manager = await ConfigManager.create(store, async (c) =>
      c.nodes.map((n, i) => ({ id: n.id, latency: i === fastest ? 10 : 100 })),
    );
    t.after(async () => {
      await manager.stop();
      clients.forEach((c) => c.socket.destroy());
      await Promise.all([a.close(), b.close()]);
      await rm(dir, { recursive: true, force: true });
    });
    const wait = async (condition: () => boolean) => {
      for (let i = 0; i < 1000; i++) {
        if (condition()) return;
        await new Promise((resolve) => setTimeout(resolve, 1));
      }
      throw new Error('connection state timed out');
    };
    const port = await freePort();
    await manager.change(0, (c) => {
      c.socks.port = port;
      c.logLevel = 'silent';
      c.nodes = [a.node, b.node];
      c.rules[0].target = { kind: 'node', id: a.node.id };
      return c;
    });
    await manager.selectNode(manager.config.revision, {
      mode: 'manual',
      target: { kind: 'node', id: a.node.id },
    });
    await manager.start();
    const original = snapshots.at(-1)!;
    const connect = async () => {
      const client = await socks(port, 'example.test', 80);
      clients.push(client);
      return client;
    };
    const check = async (client: (typeof clients)[number], label: string) => {
      await write(client.socket, Buffer.from('ping'));
      assert.equal((await client.reader.exact(5)).toString(), `${label}ping`);
    };
    const first = await connect();
    await check(first, 'A');
    // Accepted before the switch, but SOCKS greeting and destination arrive later.
    const pendingSocket = net.connect({
      host: '127.0.0.1',
      port,
      allowHalfOpen: true,
    });
    pendingSocket.on('error', () => {});
    await once(pendingSocket, 'connect');
    const pending = {
      socket: pendingSocket,
      reader: new ByteReader(pendingSocket),
    };
    clients.push(pending);
    await wait(() => manager.status().connections === 2);
    await manager.selectNode(
      manager.config.revision,
      { mode: 'manual', target: { kind: 'node', id: b.node.id } },
      undefined,
      true,
    );
    const manual = snapshots.at(-1)!;
    await check(first, 'A');
    assert.equal(original.closed, 0);
    await write(pendingSocket, Buffer.from([5, 1, 0]));
    assert.deepEqual(await pending.reader.exact(2), Buffer.from([5, 0]));
    await write(
      pendingSocket,
      Buffer.concat([Buffer.from([5, 1, 0]), address('example.test'), u16(80)]),
    );
    assert.equal((await pending.reader.exact(10))[1], 0);
    await check(pending, 'A');
    const second = await connect();
    await check(second, 'B');
    assert.equal(manager.status().connections, 3);

    await manager.selectNode(
      manager.config.revision,
      { mode: 'auto', target: manager.selection().target },
      undefined,
      true,
    );
    await wait(() => !manager.selection().probing);
    const automatic = snapshots.at(-1)!;
    assert.deepEqual(manager.selection().target, {
      kind: 'node',
      id: a.node.id,
    });
    await check(second, 'B');
    const third = await connect();
    await check(third, 'A');
    fastest = 1;
    await manager.probeIfDue(Date.now() + AUTO_PROBE_INTERVAL + 1);
    await wait(() => !manager.selection().probing);
    const hourly = snapshots.at(-1)!;
    const fourth = await connect();
    await check(fourth, 'B');
    await check(third, 'A');
    await check(first, 'A');
    assert.equal(manager.status().connections, 5);

    const save = store.save.bind(store);
    const committed = await readFile(store.file, 'utf8');
    const revision = manager.config.revision;
    store.save = async () => {
      throw Object.assign(new Error('save failed'), { code: 'EACCES' });
    };
    await assert.rejects(
      manager.selectNode(revision, {
        mode: 'manual',
        target: { kind: 'node', id: a.node.id },
      }),
    );
    assert.equal(snapshots.at(-1)!.closed, 1);
    assert.equal(manager.config.revision, revision);
    assert.equal(await readFile(store.file, 'utf8'), committed);
    assert.equal(manager.status().state, 'running');
    await check(first, 'A');
    await check(second, 'B');
    const afterFailure = await connect();
    await check(afterFailure, 'B');

    let release!: () => void;
    let started!: () => void;
    const saving = new Promise<void>((resolve) => {
      started = resolve;
    });
    store.save = async (settings) => {
      started();
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      await save(settings);
    };
    const switching = manager.selectNode(revision, {
      mode: 'manual',
      target: { kind: 'node', id: a.node.id },
    });
    await saving;
    const beforeCommit = await connect();
    await check(beforeCommit, 'B');
    await check(first, 'A');
    release();
    await switching;
    store.save = save;
    const afterCommit = await connect();
    await check(afterCommit, 'A');
    await check(beforeCommit, 'B');
    assert.equal(binds.mock.callCount(), 1);
    assert.equal(manager.status().connections, 8);
    assert.equal(hourly.closed, 0);

    const end = async (client: (typeof clients)[number]) => {
      const closed = once(client.socket, 'close');
      client.socket.end();
      await closed;
    };
    await end(first);
    assert.equal(original.closed, 0);
    await end(pending);
    await wait(() => original.closed === 1);
    await end(second);
    await wait(() => manual.closed === 1);
    await end(third);
    await wait(() => automatic.closed === 1);
    await wait(() => manager.status().connections === 4);
    assert.equal(hourly.closed, 0);
    const ended = clients
      .filter((c) => !c.socket.destroyed)
      .map(async (c) => {
        await assert.rejects(c.reader.exact(1));
        c.socket.destroy();
      });
    await manager.stop();
    await Promise.all(ended);
    assert.equal(manager.status().connections, 0);
    assert.deepEqual(
      snapshots.map((snapshot) => snapshot.closed),
      snapshots.map(() => 1),
    );
  },
);
