import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { ConfigManager } from '../../src/config/manager.js';
import { ConfigStore } from '../../src/config/storage.js';
import { initialConfig, type ProxyNode } from '../../src/config/model.js';
import { probeNodes, fastestNode } from '../../src/proxy/probe.js';
import { abortable } from '../../src/errors.js';
import { freePort, listen } from '../helpers.js';
import { createApp } from '../../src/api/app.js';
import type { Config } from '../../src/config/model.js';
import type { ProbeResult } from '../../src/proxy/probe.js';

const node = (name: string, port = 1234): ProxyNode => ({
  id: randomUUID(),
  name,
  type: 'ss',
  server: '127.0.0.1',
  port,
  cipher: 'aes-128-gcm',
  password: 'test-only',
  udp: false,
});

test(
  'profile switches return before probes finish; stale probes never override another profile or manual choice',
  { timeout: 5000 },
  async (t) => {
    const dir = await mkdtemp(
      path.join(os.tmpdir(), 'hihop-background-probe-'),
    );
    let hold = false;
    const pending: {
      config: Config;
      signal?: AbortSignal;
      resolve: (results: ProbeResult[]) => void;
    }[] = [];
    const manager = await ConfigManager.create(
      new ConfigStore(path.join(dir, 'config.json')),
      async (config, signal) => {
        if (!hold)
          return config.nodes.map((n, i) => ({
            id: n.id,
            latency: i === 0 ? 10 : 100,
          }));
        // Deliberately ignore cancellation to check the final identity/fingerprint guard.
        return new Promise<ProbeResult[]>((resolve) =>
          pending.push({ config, signal, resolve }),
        );
      },
    );
    const app = await createApp(manager, 'a'.repeat(64));
    t.after(async () => {
      await app.close();
      await rm(dir, { recursive: true, force: true });
    });
    const c = initialConfig();
    c.nodes = [node('a1'), node('a2')];
    await manager.addProfile(0, 'A', c);
    const a = manager.profiles().activeProfileId;
    const other = initialConfig();
    other.nodes = [node('b1'), node('b2')];
    await manager.addProfile(1, 'B', other);
    const b = manager.profiles().activeProfileId;
    hold = true;
    const headers = {
      host: '127.0.0.1:7800',
      authorization: `Bearer ${'a'.repeat(64)}`,
    };
    const switchProfile = (id: string) =>
      app.inject({
        method: 'POST',
        url: `/api/profiles/${id}/activate`,
        headers,
        payload: { revision: manager.config.revision },
      });
    const switched = await switchProfile(a);
    assert.equal(switched.statusCode, 200, switched.body);
    assert.equal(switched.json().activeProfileId, a);
    assert.equal(switched.json().selection.probing, true);
    assert.equal(pending.length, 1);
    const second = await switchProfile(b);
    assert.equal(second.statusCode, 200, second.body);
    assert.equal(pending.length, 2);
    assert.equal(pending[0].signal?.aborted, true);
    pending[0].resolve(
      c.nodes.map((n, i) => ({ id: n.id, latency: i === 1 ? 1 : 20 })),
    );
    pending[1].resolve(
      other.nodes.map((n) => ({ id: n.id, latency: null, error: '连接超时' })),
    );
    while (manager.selection().probing)
      await new Promise((r) => setImmediate(r));
    assert.equal(manager.profiles().activeProfileId, b);
    assert.deepEqual(manager.selection().target, {
      kind: 'node',
      id: other.nodes[0].id,
    });
    assert.equal(manager.selection().probeError?.code, 'NO_AVAILABLE_NODE');
    assert.ok(manager.selection().latencies.every((r) => r.latency === null));
    assert.equal(
      manager.selection().probeCompletedVersion,
      manager.selection().probeVersion,
    );
    const choose = (mode: string, id: string) =>
      app.inject({
        method: 'PUT',
        url: '/api/selection',
        headers,
        payload: {
          revision: manager.config.revision,
          selection: { mode, target: { kind: 'node', id } },
        },
      });
    assert.equal((await choose('manual', other.nodes[0].id)).statusCode, 200);
    const revision = manager.config.revision;
    const probing = await app.inject({
      method: 'POST',
      url: '/api/probes',
      headers,
      payload: { revision },
    });
    assert.equal(probing.statusCode, 200);
    assert.equal(probing.json().probing, true);
    pending[2].resolve(
      other.nodes.map((n, i) => ({ id: n.id, latency: i === 1 ? 9 : 50 })),
    );
    while (manager.selection().probing)
      await new Promise((r) => setImmediate(r));
    assert.equal(manager.selection().mode, 'manual');
    assert.deepEqual(manager.selection().target, {
      kind: 'node',
      id: other.nodes[0].id,
    });
    assert.equal(manager.selection().latencies[1].latency, 9);
    assert.equal(manager.config.revision, revision);
    assert.equal(
      (
        await app.inject({
          method: 'POST',
          url: '/api/probes',
          headers,
          payload: { revision: 0 },
        })
      ).statusCode,
      409,
    );
    const previousCompletion = manager.selection().probeCompletedVersion;
    const auto = await choose('auto', other.nodes[0].id);
    assert.equal(auto.statusCode, 200);
    assert.equal(auto.json().selection.probing, true);
    assert.equal((await choose('manual', other.nodes[1].id)).statusCode, 200);
    assert.equal(pending[3].signal?.aborted, true);
    assert.equal(manager.selection().probeCompletedVersion, previousCompletion);
    pending[3].resolve(
      other.nodes.map((n, i) => ({ id: n.id, latency: i === 0 ? 1 : 20 })),
    );
    await new Promise((r) => setImmediate(r));
    assert.equal(manager.selection().mode, 'manual');
    assert.deepEqual(manager.selection().target, {
      kind: 'node',
      id: other.nodes[1].id,
    });
    const automatic = await choose('auto', other.nodes[1].id);
    const editRevision = automatic.json().editRevision;
    pending[4].resolve(
      other.nodes.map((n, i) => ({ id: n.id, latency: i === 0 ? 2 : 20 })),
    );
    while (manager.selection().probing)
      await new Promise((r) => setImmediate(r));
    assert.equal(manager.editRevision, editRevision);
    assert.equal(
      manager.selection().probeCompletedVersion,
      manager.selection().probeVersion,
    );
    assert.ok(manager.selection().probeCompletedVersion > previousCompletion);
    assert.equal(pending[4].signal?.aborted, false);
    assert.ok(manager.config.revision > editRevision);
    hold = false;
    await manager.change(manager.config.revision, (c) => {
      const n = c.nodes[0];
      if (n.type === 'ss') n.password = 'changed-private-password';
      return c;
    });
    assert.ok(manager.editRevision > editRevision);
  },
);

test(
  'manual/auto selection is independent, persists, reprobes on activation/start, and rolls back failed probes/saves',
  { timeout: 15000 },
  async (t) => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'hihop-selection-'));
    const store = new ConfigStore(path.join(dir, 'config.json'));
    let fastest = 1,
      calls = 0,
      fail = false;
    const manager = await ConfigManager.create(store, async (c) => {
      calls++;
      return c.nodes.map((n, i) => ({
        id: n.id,
        latency: fail ? null : i === fastest ? 12 : 90,
      }));
    });
    t.after(async () => {
      await manager.stop();
      await rm(dir, { recursive: true, force: true });
    });
    const c = initialConfig();
    c.nodes = [node('a'), node('b'), node('c')];
    await manager.addProfile(0, 'work', c);
    assert.equal(manager.selection().mode, 'auto');
    const workId = manager.profiles().activeProfileId;
    await manager.selectNode(1, {
      mode: 'manual',
      target: { kind: 'node', id: c.nodes[2].id },
    });
    assert.equal(calls, 1);
    await manager.selectNode(2, { mode: 'auto', target: { kind: 'direct' } });
    assert.deepEqual(manager.selection().target, {
      kind: 'node',
      id: c.nodes[1].id,
    });
    const committed = await readFile(store.file, 'utf8');
    fail = true;
    await assert.rejects(
      manager.selectNode(3, { mode: 'auto', target: { kind: 'direct' } }),
      /所有节点探测失败/,
    );
    assert.equal(await readFile(store.file, 'utf8'), committed);
    assert.equal(manager.config.revision, 3);
    assert.deepEqual(manager.selection().target, {
      kind: 'node',
      id: c.nodes[1].id,
    });
    fail = false;
    fastest = 0;
    const save = store.save.bind(store);
    store.save = async () => {
      throw new Error('save failed');
    };
    await assert.rejects(
      manager.selectNode(3, { mode: 'auto', target: { kind: 'direct' } }),
    );
    store.save = save;
    assert.equal(await readFile(store.file, 'utf8'), committed);
    assert.deepEqual(manager.selection().target, {
      kind: 'node',
      id: c.nodes[1].id,
    });
    const restored = await ConfigManager.create(store);
    assert.equal(restored.selection().mode, 'auto');
    assert.deepEqual(restored.selection().target, manager.selection().target);
    await manager.addProfile(3, 'home', initialConfig());
    assert.deepEqual(manager.selection().target, { kind: 'direct' });
    await manager.activateProfile(4, workId);
    while (manager.selection().probing)
      await new Promise((r) => setImmediate(r));
    assert.deepEqual(manager.selection().target, {
      kind: 'node',
      id: c.nodes[0].id,
    });
    await manager.change(manager.config.revision, (config) => {
      config.socks.port = 1080;
      return config;
    });
    const port = await freePort();
    await manager.change(manager.config.revision, (config) => {
      config.socks.port = port;
      return config;
    });
    fastest = 2;
    const callsBefore = calls;
    await Promise.all([manager.start(), manager.start()]);
    assert.equal(calls, callsBefore + 1);
    assert.deepEqual(manager.selection().target, {
      kind: 'node',
      id: c.nodes[2].id,
    });
    assert.equal(manager.status().listener?.port, port);
  },
);

test('schema 1 GEOIP rules migrate to the final outlet without a database', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'hihop-legacy-geoip-'));
  const store = new ConfigStore(path.join(dir, 'config.json'));
  const old = initialConfig();
  old.socks.port = await freePort();
  old.hosts = { 'legacy.test': '192.0.2.1' };
  old.rules.unshift({
    type: 'GEOIP',
    value: 'CN',
    noResolve: false,
    target: { kind: 'reject' },
  });
  await writeFile(store.file, JSON.stringify(old));
  const manager = await ConfigManager.create(store);
  t.after(async () => {
    await manager.stop();
    await rm(dir, { recursive: true, force: true });
  });
  assert.deepEqual(manager.config.rules, [old.rules.at(-1)]);
  assert.deepEqual(manager.config.hosts, old.hosts);
  assert.deepEqual(manager.selection().target, { kind: 'direct' });
  await manager.start();
  assert.equal(manager.status().state, 'running');
  await manager.change(0, (config) => config);
  const saved = JSON.parse(await readFile(store.file, 'utf8'));
  assert.equal(saved.schemaVersion, 3);
  assert.equal(saved.profiles[0].rules, undefined);
});

test(
  'schema 2 profiles migrate without rules; only the former final outlet is retained',
  { timeout: 15000 },
  async (t) => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'hihop-migration-'));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const store = new ConfigStore(path.join(dir, 'config.json'));
    const c = initialConfig();
    c.nodes = [node('old')];
    const profileId = randomUUID();
    await writeFile(
      store.file,
      JSON.stringify({
        schemaVersion: 2,
        revision: 0,
        socks: c.socks,
        logLevel: c.logLevel,
        activeProfileId: profileId,
        profiles: [
          {
            id: profileId,
            name: 'old',
            nodes: c.nodes,
            dns: c.dns,
            hosts: c.hosts,
            rules: [
              {
                type: 'GEOIP',
                value: 'CN',
                noResolve: false,
                target: { kind: 'reject' },
              },
              {
                type: 'MATCH',
                value: '',
                noResolve: false,
                target: { kind: 'node', id: c.nodes[0].id },
              },
            ],
          },
        ],
      }),
    );
    const manager = await ConfigManager.create(store);
    assert.equal(manager.config.rules.length, 1);
    assert.deepEqual(manager.selection().target, {
      kind: 'node',
      id: c.nodes[0].id,
    });
    await manager.change(0, (config) => config);
    const saved = JSON.parse(await readFile(store.file, 'utf8'));
    assert.equal(saved.schemaVersion, 3);
    assert.equal(saved.profiles[0].rules, undefined);
  },
);

test('probe workers limit concurrency, exclude failures, use delays rather than completion order and cancel', async () => {
  const c = initialConfig();
  c.nodes = Array.from({ length: 40 }, (_, i) => node(String(i)));
  let active = 0,
    maximum = 0;
  const results = await probeNodes(
    c,
    undefined,
    async (n, _resolver, signal) => {
      active++;
      maximum = Math.max(maximum, active);
      try {
        await abortable(new Promise<void>((r) => setTimeout(r, 2)), signal);
        if (n.name === '0') throw new Error('private credential');
        return n.name === '30' ? 1 : 100;
      } finally {
        active--;
      }
    },
  );
  assert.equal(maximum, 16);
  assert.equal(results.length, 40);
  assert.equal(results[0].latency, null);
  assert.ok(!JSON.stringify(results).includes('private credential'));
  assert.equal(fastestNode(results), c.nodes[30].id);
  assert.throws(
    () => fastestNode(results.map((r) => ({ ...r, latency: null }))),
    /所有节点探测失败/,
  );
  const cancel = new AbortController();
  cancel.abort();
  await assert.rejects(probeNodes(c, cancel.signal));
});

test(
  'successful TCP connection without a valid authenticated proxy response is unavailable',
  { timeout: 15000 },
  async (t) => {
    const peers = new Set<net.Socket>();
    const server = net.createServer((socket) => {
      peers.add(socket);
      socket.resume();
      socket.on('error', () => {});
      socket.end('HTTP/1.1 204 No Content\r\n\r\n');
    });
    const port = await listen(server);
    t.after(() => {
      peers.forEach((s) => s.destroy());
      return new Promise<void>((resolve) => server.close(() => resolve()));
    });
    const c = initialConfig();
    c.nodes = [node('not a proxy', port)];
    const results = await probeNodes(c);
    assert.equal(results[0].latency, null);
  },
);
