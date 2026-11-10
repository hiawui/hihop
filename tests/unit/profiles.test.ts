import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { ConfigManager } from '../../src/config/manager.js';
import { ConfigStore } from '../../src/config/storage.js';
import { initialConfig } from '../../src/config/model.js';
import { createApp } from '../../src/api/app.js';
import { freePort, listen, socks } from '../helpers.js';
import { write } from '../../src/proxy/codec/bytes.js';

const token = 'a'.repeat(64);
const headers = { host: '127.0.0.1:7800', authorization: `Bearer ${token}` };

test('delete profiles transactionally; inactive deletion keeps live connections and last deletion preserves global listener settings', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'hihop-profile-delete-'));
  const store = new ConfigStore(path.join(dir, 'config.json'));
  const manager = await ConfigManager.create(store);
  const app = await createApp(manager, token);
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
  const original = manager.profiles().activeProfileId;
  await manager.addProfile(0, 'A', initialConfig());
  const a = manager.profiles().activeProfileId;
  await manager.addProfile(1, 'B', initialConfig());
  const b = manager.profiles().activeProfileId;
  const port = await freePort();
  await manager.change(2, (c) => {
    c.socks.port = port;
    c.logLevel = 'silent';
    return c;
  });
  await manager.start();
  const client = await socks(port, '127.0.0.1', echoPort);
  t.after(() => client.socket.destroy());
  const committed = await readFile(store.file, 'utf8');
  const save = store.save.bind(store);
  store.save = async () => {
    throw new Error('save failed');
  };
  await assert.rejects(manager.deleteProfile(3, a));
  store.save = save;
  assert.equal(await readFile(store.file, 'utf8'), committed);
  assert.equal(manager.profiles().profiles.length, 3);
  const deleted = await app.inject({
    method: 'DELETE',
    url: `/api/profiles/${a}`,
    headers,
    payload: { revision: 3 },
  });
  assert.equal(deleted.statusCode, 200, deleted.body);
  assert.equal(manager.profiles().activeProfileId, b);
  await write(client.socket, Buffer.from('alive'));
  assert.equal((await client.reader.exact(5)).toString(), 'alive');
  const stale = await app.inject({
    method: 'DELETE',
    url: `/api/profiles/${b}`,
    headers,
    payload: { revision: 3 },
  });
  assert.equal(stale.statusCode, 409);
  await manager.deleteProfile(4, b);
  assert.equal(manager.profiles().activeProfileId, original);
  await manager.deleteProfile(5, original);
  assert.equal(manager.profiles().profiles.length, 1);
  assert.notEqual(manager.profiles().activeProfileId, original);
  assert.equal(manager.profiles().profiles[0].name, '默认配置');
  assert.equal(manager.config.nodes.length, 0);
  assert.equal(manager.config.socks.port, port);
  assert.equal(manager.config.logLevel, 'silent');
  assert.equal(manager.status().state, 'running');
  const restored = await ConfigManager.create(store);
  assert.equal(restored.profiles().profiles.length, 1);
  assert.equal(restored.config.socks.port, port);
  await assert.rejects(manager.deleteProfile(6, a), /配置不存在/);
});

test('editing a subscription URL cancels old downloads; late results cannot overwrite the new source or clear its refresh job', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'hihop-profile-url-'));
  const store = new ConfigStore(path.join(dir, 'config.json'));
  const pending: {
    url: string;
    signal?: AbortSignal;
    resolve: (content: string) => void;
  }[] = [];
  const manager = await ConfigManager.create(
    store,
    undefined,
    async (url, signal) =>
      new Promise<string>((resolve) => pending.push({ url, signal, resolve })),
  );
  const app = await createApp(manager, token);
  t.after(async () => {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  });
  await manager.addProfile(0, 'subscription', initialConfig(), {
    url: 'https://example.com/old',
    intervalHours: 4,
    lastUpdatedAt: Date.now(),
  });
  const id = manager.profiles().activeProfileId;
  await app.ready();
  const old = manager.refreshProfile(id);
  const rejected = assert.rejects(old);
  const changed = await app.inject({
    method: 'PATCH',
    url: `/api/profiles/${id}/subscription`,
    headers,
    payload: {
      revision: 1,
      url: 'https://example.com/new',
      intervalHours: 1.5,
    },
  });
  assert.equal(changed.statusCode, 200, changed.body);
  assert.equal(pending.length, 1);
  assert.equal(pending[0].signal?.aborted, true);
  const job = manager.refreshProfile(id);
  assert.equal(pending[1].url, 'https://example.com/new');
  pending[0].resolve('hosts: {old.test: 192.0.2.1}');
  await rejected;
  assert.equal(
    manager.profiles().profiles.at(-1)?.subscription?.updating,
    true,
  );
  assert.equal(
    manager.profiles().profiles.at(-1)?.subscription?.lastError,
    undefined,
  );
  pending[1].resolve('hosts: {new.test: 192.0.2.2}');
  await job;
  assert.deepEqual(manager.config.hosts, { 'new.test': '192.0.2.2' });
  const source = manager.profiles().profiles.at(-1)?.subscription;
  assert.equal(source?.url, 'https://example.com/new');
  assert.equal(source?.intervalHours, 1.5);
  const revision = manager.config.revision;
  for (const url of [
    'file:///tmp/config',
    'not a url',
    'https://user:pass@example.com/',
  ]) {
    const response = await app.inject({
      method: 'PATCH',
      url: `/api/profiles/${id}/subscription`,
      headers,
      payload: { revision, url },
    });
    assert.equal(response.statusCode, 400, response.body);
  }
  const changedOnlyUrl = await app.inject({
    method: 'PATCH',
    url: `/api/profiles/${id}/subscription`,
    headers,
    payload: { revision, url: 'http://example.com/third' },
  });
  assert.equal(changedOnlyUrl.statusCode, 200);
  assert.equal(
    manager.profiles().profiles.at(-1)?.subscription?.intervalHours,
    1.5,
  );
  const restored = await ConfigManager.create(store);
  assert.equal(
    restored.profiles().profiles.at(-1)?.subscription?.url,
    'http://example.com/third',
  );
});

test('deleting a subscription aborts its download and never recreates the deleted profile', async (t) => {
  const dir = await mkdtemp(
    path.join(os.tmpdir(), 'hihop-profile-delete-refresh-'),
  );
  let resolve!: (content: string) => void;
  let signal: AbortSignal | undefined;
  const manager = await ConfigManager.create(
    new ConfigStore(path.join(dir, 'config.json')),
    undefined,
    async (_url, currentSignal) => {
      signal = currentSignal;
      return new Promise<string>((r) => {
        resolve = r;
      });
    },
  );
  t.after(() => rm(dir, { recursive: true, force: true }));
  await manager.addProfile(0, 'subscription', initialConfig(), {
    url: 'https://example.com/config',
    intervalHours: 4,
    lastUpdatedAt: Date.now(),
  });
  const id = manager.profiles().activeProfileId;
  const job = manager.refreshProfile(id);
  const rejected = assert.rejects(job);
  await manager.deleteProfile(1, id);
  assert.equal(signal?.aborted, true);
  resolve('hosts: {deleted.test: 192.0.2.1}');
  await rejected;
  assert.ok(!manager.profiles().profiles.some((p) => p.id === id));
  assert.equal(manager.config.hosts['deleted.test'], undefined);
});
