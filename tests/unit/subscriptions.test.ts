import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import { ConfigManager } from '../../src/config/manager.js';
import { ConfigStore } from '../../src/config/storage.js';
import { initialConfig } from '../../src/config/model.js';
import { createApp } from '../../src/api/app.js';
import { AppError, abortable } from '../../src/errors.js';
import { freePort, listen, socks } from '../helpers.js';
import { write } from '../../src/proxy/codec/bytes.js';
import { importClash } from '../../src/import/clash.js';

const headers = {
  host: '127.0.0.1:7800',
  authorization: `Bearer ${'a'.repeat(64)}`,
};
const hour = 3600000;
const yaml = (version: number) => `mode: direct
proxy-groups: [{name: ignored, type: select, proxies: [a]}]
hosts: {version.test: 192.0.2.${version}}
dns:
  enable: true
  nameserver: [1.1.1.1]
  proxy-server-nameserver: [223.5.5.${version}]
proxies:
  - {name: a, type: ss, server: 127.0.0.1, port: 1234, cipher: aes-128-gcm, password: test-only}
  - {name: b, type: ss, server: 127.0.0.1, port: 1235, cipher: aes-128-gcm, password: test-only}`;

test('HTTP imports default to auto/4h; updates preserve identity, per-profile intervals and live inactive-profile connections', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'hihop-subscriptions-'));
  const store = new ConfigStore(path.join(dir, 'config.json'));
  let version = 1,
    downloads = 0,
    probes = 0;
  const manager = await ConfigManager.create(
    store,
    async (c) => {
      probes++;
      return c.nodes.map((n, i) => ({ id: n.id, latency: i === 1 ? 10 : 90 }));
    },
    async () => {
      downloads++;
      return yaml(version);
    },
  );
  const app = await createApp(manager, 'a'.repeat(64));
  const peers = new Set<net.Socket>();
  const echo = net.createServer((socket) => {
    peers.add(socket);
    socket.on('error', () => {});
    socket.pipe(socket);
  });
  const echoPort = await listen(echo);
  t.after(async () => {
    await app.close();
    peers.forEach((s) => s.destroy());
    await new Promise<void>((r) => echo.close(() => r()));
    await rm(dir, { recursive: true, force: true });
  });
  const request = (
    url: string,
    payload: object,
    method: 'POST' | 'PATCH' = 'POST',
  ) => app.inject({ method, url, headers, payload });
  const imported = await request('/api/imports/url', {
    revision: 0,
    url: 'https://example.com/a',
    name: 'A',
  });
  assert.equal(imported.statusCode, 200, imported.body);
  const a = imported.json().activeProfileId;
  assert.equal(imported.json().selection.mode, 'auto');
  assert.equal(
    imported.json().selection.target.id,
    imported.json().nodes[1].id,
  );
  const nodeIds = imported.json().nodes.map((n: any) => n.id);
  assert.equal(imported.json().profiles.at(-1).subscription.intervalHours, 4);
  const interval = await request(
    `/api/profiles/${a}/subscription`,
    { revision: 1, intervalHours: 2 },
    'PATCH',
  );
  assert.equal(interval.statusCode, 200);
  assert.equal(interval.json().profiles.at(-1).subscription.intervalHours, 2);
  for (const invalid of [0, -1, 10000, '4']) {
    assert.equal(
      (
        await request(
          `/api/profiles/${a}/subscription`,
          { revision: 2, intervalHours: invalid },
          'PATCH',
        )
      ).statusCode,
      400,
    );
  }
  assert.equal(
    (
      await request(
        `/api/profiles/${a}/subscription`,
        { revision: 0, intervalHours: 4 },
        'PATCH',
      )
    ).statusCode,
    409,
  );
  const second = await request('/api/imports/url', {
    revision: 2,
    url: 'http://example.com/b',
    name: 'B',
    intervalHours: 8,
  });
  assert.equal(second.statusCode, 200, second.body);
  const b = second.json().activeProfileId;
  await manager.selectNode(3, { mode: 'manual', target: { kind: 'direct' } });
  const port = await freePort();
  await manager.change(4, (c) => {
    c.socks.port = port;
    return c;
  });
  await manager.start();
  const client = await socks(port, '127.0.0.1', echoPort);
  t.after(() => client.socket.destroy());
  await write(client.socket, Buffer.from('a'));
  assert.equal((await client.reader.exact(1)).toString(), 'a');
  version = 2;
  const beforeProbes = probes,
    beforeDownloads = downloads;
  const refreshed = await request(`/api/profiles/${a}/refresh`, {});
  assert.equal(refreshed.statusCode, 200, refreshed.body);
  assert.equal(manager.profiles().activeProfileId, b);
  assert.equal(manager.profiles().profiles.length, 3);
  assert.equal(probes, beforeProbes);
  assert.equal(downloads, beforeDownloads + 1);
  assert.equal(manager.config.hosts['version.test'], '192.0.2.1');
  await write(client.socket, Buffer.from('b'));
  assert.equal((await client.reader.exact(1)).toString(), 'b');
  const saved = JSON.parse(await readFile(store.file, 'utf8'));
  const updated = saved.profiles.find((p: any) => p.id === a);
  assert.equal(updated.name, 'A');
  assert.deepEqual(
    updated.nodes.map((n: any) => n.id),
    nodeIds,
  );
  assert.equal(updated.hosts['version.test'], '192.0.2.2');
  assert.equal(updated.dns.proxyServerNameservers[0].host, '223.5.5.2');
  assert.equal(updated.subscription.intervalHours, 2);
  assert.equal(
    saved.profiles.find((p: any) => p.id === b).subscription.intervalHours,
    8,
  );
  assert.equal(manager.config.socks.port, port);
  const calls = downloads;
  await Promise.all([manager.refreshProfile(a), manager.refreshProfile(a)]);
  assert.equal(downloads, calls + 1);
  const committed = await readFile(store.file, 'utf8');
  const save = store.save.bind(store);
  store.save = async () => {
    throw new Error('private failure');
  };
  version = 3;
  await assert.rejects(manager.refreshProfile(a));
  store.save = save;
  assert.equal(await readFile(store.file, 'utf8'), committed);
  assert.ok(!JSON.stringify(manager.profiles()).includes('private failure'));
  await write(client.socket, Buffer.from('c'));
  assert.equal((await client.reader.exact(1)).toString(), 'c');
  const restored = await ConfigManager.create(store);
  assert.equal(
    restored.profiles().profiles.find((p) => p.id === a)?.subscription
      ?.intervalHours,
    2,
  );
  await manager.refreshProfile(b);
  assert.equal(manager.selection().mode, 'manual');
  assert.deepEqual(manager.selection().target, { kind: 'direct' });
  assert.equal(manager.config.hosts['version.test'], '192.0.2.3');
});

test('scheduler honors independent periods, retries failures without changing saved data, and restores schedules after restart', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'hihop-schedule-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  let now = 1000000;
  t.mock.method(Date, 'now', () => now);
  const store = new ConfigStore(path.join(dir, 'config.json'));
  const calls: string[] = [];
  let failing = false;
  const download = async (url: string) => {
    calls.push(url);
    if (failing) throw new AppError('DOWNLOAD_FAILED', '配置下载失败');
    return 'hosts: {updated.test: 192.0.2.1}';
  };
  const manager = await ConfigManager.create(store, undefined, download);
  await manager.addProfile(0, 'A', initialConfig(), {
    url: 'https://example.com/a',
    intervalHours: 4,
    lastUpdatedAt: now,
  });
  const a = manager.profiles().activeProfileId;
  await manager.addProfile(1, 'B', initialConfig(), {
    url: 'https://example.com/b',
    intervalHours: 8,
    lastUpdatedAt: now,
  });
  const b = manager.profiles().activeProfileId;
  now += 3 * hour;
  await manager.refreshDueProfiles();
  assert.deepEqual(calls, []);
  now += hour;
  await manager.refreshDueProfiles();
  assert.deepEqual(calls, ['https://example.com/a']);
  assert.equal(manager.profiles().activeProfileId, b);
  await manager.setUpdateInterval(manager.config.revision, b, 1);
  await manager.refreshDueProfiles();
  assert.deepEqual(calls, ['https://example.com/a', 'https://example.com/b']);
  const committed = await readFile(store.file, 'utf8');
  now += 4 * hour;
  failing = true;
  await manager.refreshDueProfiles();
  assert.equal(await readFile(store.file, 'utf8'), committed);
  const error = manager
    .profiles()
    .profiles.find((p) => p.id === a)?.subscription;
  assert.equal(error?.lastError?.code, 'DOWNLOAD_FAILED');
  assert.equal(error?.nextUpdateAt, now + 4 * hour);
  const count = calls.length;
  await manager.refreshDueProfiles();
  assert.equal(calls.length, count);
  failing = false;
  const restored = await ConfigManager.create(store, undefined, download);
  await restored.refreshDueProfiles();
  assert.equal(calls.length, count + 2);
  assert.ok(
    restored
      .profiles()
      .profiles.filter((p) => p.subscription)
      .every((p) => p.subscription!.lastUpdatedAt === now),
  );
});

test('app starts overdue updates and cancels an in-flight download on shutdown', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'hihop-updater-close-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  let started!: () => void;
  const downloading = new Promise<void>((r) => {
    started = r;
  });
  const manager = await ConfigManager.create(
    new ConfigStore(path.join(dir, 'config.json')),
    undefined,
    async (_url, signal) => {
      started();
      return abortable(new Promise<string>(() => {}), signal!);
    },
  );
  await manager.addProfile(0, 'overdue', initialConfig(), {
    url: 'https://example.com/sub',
    intervalHours: 4,
    lastUpdatedAt: 0,
  });
  const app = await createApp(manager, 'a'.repeat(64));
  t.after(() => app.close());
  await app.ready();
  await downloading;
  const committed = await readFile(manager.store.file, 'utf8');
  await app.close();
  assert.equal(await readFile(manager.store.file, 'utf8'), committed);
  assert.equal(
    manager.profiles().profiles.at(-1)?.subscription?.updating,
    false,
  );
});

test('active auto refresh merges a concurrent interval edit and rolls back when all new probes fail', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'hihop-refresh-race-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = new ConfigStore(path.join(dir, 'config.json'));
  let fail = false;
  let started!: () => void;
  let release!: (value: string) => void;
  const downloading = new Promise<void>((resolve) => {
    started = resolve;
  });
  let download = () =>
    new Promise<string>((resolve) => {
      release = resolve;
      started();
    });
  const manager = await ConfigManager.create(
    store,
    async (c) =>
      c.nodes.map((n, i) => ({
        id: n.id,
        latency: fail ? null : i === 1 ? 10 : 50,
      })),
    async () => download(),
  );
  await manager.addProfile(0, 'auto', importClash(yaml(1)).config, {
    url: 'https://example.com/auto',
    intervalHours: 4,
    lastUpdatedAt: Date.now(),
  });
  const id = manager.profiles().activeProfileId;
  const target = manager.selection().target;
  const job = manager.refreshProfile(id);
  await downloading;
  await manager.setUpdateInterval(1, id, 2);
  release(yaml(2));
  await job;
  assert.equal(
    manager.profiles().profiles.at(-1)?.subscription?.intervalHours,
    2,
  );
  assert.deepEqual(manager.selection().target, target);
  assert.equal(manager.config.hosts['version.test'], '192.0.2.2');
  const committed = await readFile(store.file, 'utf8');
  download = async () => yaml(3);
  fail = true;
  await assert.rejects(manager.refreshProfile(id), /所有节点探测失败/);
  assert.equal(await readFile(store.file, 'utf8'), committed);
  assert.equal(manager.config.revision, 3);
  assert.equal(manager.config.hosts['version.test'], '192.0.2.2');
  assert.deepEqual(manager.selection().target, target);
  assert.equal(
    manager.profiles().profiles.at(-1)?.subscription?.lastError?.code,
    'NO_AVAILABLE_NODE',
  );
});
