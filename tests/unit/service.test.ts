import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ConfigManager } from '../../src/config/manager.js';
import { initialConfig } from '../../src/config/model.js';
import { ConfigStore } from '../../src/config/storage.js';
import {
  ByteReader,
  address,
  u16,
  write,
} from '../../src/proxy/codec/bytes.js';
import { freePort, listen, socks } from '../helpers.js';
import { randomUUID } from 'node:crypto';

test('SOCKS DIRECT forwards pipelined data, half-close; REJECT never dials; authentication enforced', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'hihop-test-'));
  const manager = await ConfigManager.create(
    new ConfigStore(path.join(dir, 'config.json')),
  );
  const clients = new Set<net.Socket>();
  let dials = 0;
  const echo = net.createServer({ allowHalfOpen: true }, (socket) => {
    clients.add(socket);
    socket.on('close', () => clients.delete(socket));
    socket.on('error', () => {});
    dials++;
    socket.pipe(socket);
  });
  const targetPort = await listen(echo);
  const proxyPort = await freePort();
  t.after(async () => {
    await manager.stop();
    clients.forEach((s) => s.destroy());
    await new Promise<void>((r) => echo.close(() => r()));
    await rm(dir, { recursive: true, force: true });
  });
  await manager.change(0, (c) => {
    c.socks.port = proxyPort;
    c.socks.auth = { username: 'tester', password: 'test-only' };
    return c;
  });
  await manager.start();
  await assert.rejects(
    socks(proxyPort, '127.0.0.1', targetPort, {
      username: 'tester',
      password: 'wrong',
    }),
  );
  const { socket, reader } = await socks(
    proxyPort,
    '127.0.0.1',
    targetPort,
    { username: 'tester', password: 'test-only' },
    Buffer.from('first-packet'),
  );
  assert.equal((await reader.exact(12)).toString(), 'first-packet');
  const data = Buffer.alloc(200000, 37);
  await write(socket, data);
  assert.deepEqual(
    Buffer.concat([
      await reader.exact(65536),
      await reader.exact(65536),
      await reader.exact(65536),
      await reader.exact(3392),
    ]),
    data,
  );
  socket.end();
  await once(socket, 'close');
  const before = dials;
  await manager.change(1, (c) => {
    c.rules[0].target = { kind: 'reject' };
    return c;
  });
  await assert.rejects(
    socks(proxyPort, '127.0.0.1', targetPort, {
      username: 'tester',
      password: 'test-only',
    }),
    /SOCKS rejected 2/,
  );
  assert.equal(dials, before);
  const restored = await ConfigManager.create(
    new ConfigStore(path.join(dir, 'config.json')),
  );
  assert.equal(restored.config.revision, 2);
  assert.equal(restored.status().state, 'stopped');
  assert.equal((await stat(path.join(dir, 'config.json'))).mode & 0o777, 0o600);
});
test('SOCKS segmented handshake, unsupported commands and cleanup', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'hihop-test-'));
  const manager = await ConfigManager.create(
    new ConfigStore(path.join(dir, 'config.json')),
  );
  const port = await freePort();
  await manager.change(0, (c) => {
    c.socks.port = port;
    c.rules[0].target = { kind: 'reject' };
    return c;
  });
  await manager.start();
  t.after(async () => {
    await manager.stop();
    await rm(dir, { recursive: true, force: true });
  });
  for (const command of [1, 2, 3]) {
    const socket = net.connect(port, '127.0.0.1');
    socket.on('error', () => {});
    await once(socket, 'connect');
    const reader = new ByteReader(socket);
    for (const byte of [5, 1, 0]) await write(socket, Buffer.from([byte]));
    assert.deepEqual(await reader.exact(2), Buffer.from([5, 0]));
    await write(
      socket,
      Buffer.concat([
        Buffer.from([5, command, 0]),
        address('example.test'),
        u16(80),
      ]),
    );
    assert.equal((await reader.exact(10))[1], command === 1 ? 2 : 7);
    socket.destroy();
  }
});
test('revision conflicts, port bind rollback and atomic save failure restore committed listener', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'hihop-test-'));
  const store = new ConfigStore(path.join(dir, 'config.json'));
  const manager = await ConfigManager.create(store);
  const port = await freePort();
  const blocker = net.createServer();
  const blockedPort = await listen(blocker);
  t.after(async () => {
    await manager.stop();
    await new Promise<void>((r) => blocker.close(() => r()));
    await rm(dir, { recursive: true, force: true });
  });
  await manager.change(0, (c) => {
    c.socks.port = port;
    return c;
  });
  await manager.start();
  await assert.rejects(
    manager.change(0, (c) => c),
    (e: any) => e.status === 409,
  );
  await assert.rejects(
    manager.change(1, (c) => {
      c.socks.port = blockedPort;
      return c;
    }),
  );
  assert.equal(manager.status().state, 'running');
  assert.equal(manager.config.revision, 1);
  const committed = await readFile(store.file, 'utf8');
  const save = store.save.bind(store);
  store.save = async () => {
    throw Object.assign(new Error('private secret'), { code: 'EACCES' });
  };
  await assert.rejects(manager.change(1, (c) => c));
  assert.equal(manager.status().state, 'running');
  assert.equal(await readFile(store.file, 'utf8'), committed);
  assert.ok(!JSON.stringify(manager.status()).includes('private secret'));
  store.save = save;
  const results = await Promise.allSettled([
    manager.change(1, (c) => c),
    manager.change(1, (c) => c),
  ]);
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
});
test('failed restoration reports actual error, with no active listener or revision', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'hihop-restore-'));
  const store = new ConfigStore(path.join(dir, 'config.json'));
  const manager = await ConfigManager.create(store);
  const oldPort = await freePort(),
    newPort = await freePort();
  const blocker = net.createServer();
  t.after(async () => {
    await manager.stop();
    if (blocker.listening)
      await new Promise<void>((r) => blocker.close(() => r()));
    await rm(dir, { recursive: true, force: true });
  });
  await manager.change(0, (c) => {
    c.socks.port = oldPort;
    return c;
  });
  await manager.start();
  store.save = async () => {
    blocker.listen(oldPort, '127.0.0.1');
    await once(blocker, 'listening');
    throw new Error('save failed');
  };
  await assert.rejects(
    manager.change(1, (c) => {
      c.socks.port = newPort;
      return c;
    }),
  );
  assert.equal(manager.status().state, 'error');
  assert.equal(manager.status().activeRevision, null);
  assert.equal(manager.status().lastError?.code, 'RESTORE_FAILED');
  assert.equal(manager.config.revision, 1);
});
test('node dial failure never falls back to DIRECT', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'hihop-no-fallback-'));
  const manager = await ConfigManager.create(
    new ConfigStore(path.join(dir, 'config.json')),
    async (c) => c.nodes.map((n) => ({ id: n.id, latency: 10 })),
  );
  let directDials = 0;
  const target = net.createServer((socket) => {
    directDials++;
    socket.destroy();
  });
  const targetPort = await listen(target),
    proxyPort = await freePort(),
    unavailable = await freePort();
  t.after(async () => {
    await manager.stop();
    await new Promise<void>((r) => target.close(() => r()));
    await rm(dir, { recursive: true, force: true });
  });
  await manager.change(0, (c) => {
    const id = randomUUID();
    c.socks.port = proxyPort;
    c.logLevel = 'silent';
    c.nodes = [
      {
        id,
        name: 'unavailable',
        type: 'ss',
        server: '127.0.0.1',
        port: unavailable,
        cipher: 'aes-128-gcm',
        password: 'test-only',
        udp: false,
      },
    ];
    c.rules[0].target = { kind: 'node', id };
    return c;
  });
  await manager.start();
  await assert.rejects(
    socks(proxyPort, '127.0.0.1', targetPort),
    /SOCKS rejected 5/,
  );
  assert.equal(directDials, 0);
});

test('legacy config migration preserves settings and active profile data across restart', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'hihop-migrate-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = new ConfigStore(path.join(dir, 'config.json'));
  const old = initialConfig();
  old.revision = 7;
  old.socks = {
    host: '127.0.0.1',
    port: 11080,
    auth: { username: 'old', password: 'secret' },
  };
  old.hosts = { 'old.local': '127.0.0.7' };
  await writeFile(store.file, JSON.stringify(old));
  const manager = await ConfigManager.create(store);
  assert.deepEqual(manager.config, old);
  assert.equal(manager.profiles().profiles.length, 1);
  const originalId = manager.profiles().activeProfileId;
  await manager.addProfile(7, '新配置', initialConfig());
  const saved = JSON.parse(await readFile(store.file, 'utf8'));
  assert.equal(saved.schemaVersion, 3);
  assert.equal(saved.profiles[0].rules, undefined);
  assert.equal(saved.profiles.length, 2);
  assert.equal(saved.profiles[0].socks, undefined);
  const restored = await ConfigManager.create(store);
  await restored.activateProfile(8, originalId);
  assert.deepEqual(restored.config, { ...old, revision: 9 });
  assert.equal(restored.status().state, 'stopped');
});
test('running profile switches change routes and hosts at the same port; save failure rolls back the whole collection', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'hihop-profiles-'));
  const store = new ConfigStore(path.join(dir, 'config.json'));
  const manager = await ConfigManager.create(store);
  const echo = net.createServer((socket) => {
    socket.on('error', () => {});
    socket.pipe(socket);
  });
  const targetPort = await listen(echo);
  const port = await freePort();
  t.after(async () => {
    await manager.stop();
    await new Promise<void>((r) => echo.close(() => r()));
    await rm(dir, { recursive: true, force: true });
  });
  await manager.change(0, (c) => {
    c.socks.port = port;
    c.hosts = { 'profile.local': '127.0.0.1' };
    return c;
  });
  const originalId = manager.profiles().activeProfileId;
  await manager.start();
  const checkEcho = async () => {
    const { socket, reader } = await socks(
      port,
      'profile.local',
      targetPort,
      undefined,
      Buffer.from('ok'),
    );
    try {
      assert.equal((await reader.exact(2)).toString(), 'ok');
    } finally {
      socket.destroy();
    }
  };
  await checkEcho();
  const reject = initialConfig();
  reject.rules[0].target = { kind: 'reject' };
  await manager.addProfile(1, '拒绝', reject);
  const rejectedId = manager.profiles().activeProfileId;
  assert.equal(manager.status().listener?.port, port);
  assert.equal(manager.status().state, 'running');
  await assert.rejects(
    socks(port, '127.0.0.1', targetPort),
    /SOCKS rejected 2/,
  );
  await manager.activateProfile(2, originalId);
  await checkEcho();
  const committed = await readFile(store.file, 'utf8');
  const save = store.save.bind(store);
  store.save = async () => {
    throw Object.assign(new Error('save failure'), { code: 'EACCES' });
  };
  await assert.rejects(manager.activateProfile(3, rejectedId));
  await assert.rejects(manager.addProfile(3, '失败配置', reject));
  assert.equal(manager.profiles().activeProfileId, originalId);
  assert.equal(manager.profiles().profiles.length, 2);
  assert.equal(manager.config.revision, 3);
  assert.equal(manager.status().state, 'running');
  assert.equal(await readFile(store.file, 'utf8'), committed);
  await checkEcho();
  store.save = save;
});
