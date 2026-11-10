import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ConfigManager } from '../../src/config/manager.js';
import { ConfigStore } from '../../src/config/storage.js';
import { createApp } from '../../src/api/app.js';

const token = 'a'.repeat(64);
const headers = { host: '127.0.0.1:7800', authorization: `Bearer ${token}` };
test('API: auth, Host/Origin, secrets, stable IDs, references and revisions', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'hihop-api-'));
  const manager = await ConfigManager.create(
    new ConfigStore(path.join(dir, 'config.json')),
    async (c) => c.nodes.map((n) => ({ id: n.id, latency: 10 })),
  );
  const app = await createApp(manager, token);
  t.after(async () => {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  });
  assert.equal(
    (await app.inject({ url: '/api/config', headers: { host: headers.host } }))
      .statusCode,
    401,
  );
  assert.equal(
    (
      await app.inject({
        url: '/api/config',
        headers: { ...headers, host: 'attacker.test:7800' },
      })
    ).statusCode,
    403,
  );
  assert.equal(
    (
      await app.inject({
        url: '/api/config',
        headers: { ...headers, origin: 'https://attacker.test' },
      })
    ).statusCode,
    403,
  );
  const added = await app.inject({
    method: 'POST',
    url: '/api/nodes',
    headers,
    payload: {
      revision: 0,
      node: {
        type: 'ss',
        name: 'test',
        server: '127.0.0.1',
        port: 1234,
        cipher: 'aes-128-gcm',
        password: 'never-output-password',
      },
    },
  });
  assert.equal(added.statusCode, 200);
  assert.ok(!added.body.includes('never-output-password'));
  const id = added.json().nodes[0].id;
  const updated = await app.inject({
    method: 'PATCH',
    url: `/api/nodes/${id}`,
    headers,
    payload: { revision: 1, node: { name: 'renamed' } },
  });
  assert.equal(updated.json().nodes[0].id, id);
  assert.equal(
    (manager.config.nodes[0] as any).password,
    'never-output-password',
  );
  assert.equal(
    (await app.inject({ url: '/api/rules', headers })).statusCode,
    404,
  );
  assert.equal(added.json().rules, undefined);
  const selection = await app.inject({
    method: 'PUT',
    url: '/api/selection',
    headers,
    payload: {
      revision: 2,
      selection: { mode: 'manual', target: { kind: 'node', id } },
    },
  });
  assert.equal(selection.statusCode, 200, selection.body);
  assert.equal(selection.json().selection.target.id, id);
  assert.equal(
    (
      await app.inject({
        method: 'DELETE',
        url: `/api/nodes/${id}`,
        headers,
        payload: { revision: 3 },
      })
    ).statusCode,
    200,
  );
  assert.deepEqual(manager.selection().target, { kind: 'direct' });
  assert.equal(
    (
      await app.inject({
        method: 'PATCH',
        url: `/api/nodes/${id}`,
        headers,
        payload: { revision: 0, node: { name: 'stale' } },
      })
    ).statusCode,
    409,
  );
  assert.ok(
    !(await app.inject({ url: '/api/config', headers })).body.includes(
      'never-output-password',
    ),
  );
});
test('direct imports add independent profiles, keep global settings, persist edits and reject stale writes', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'hihop-api-'));
  const store = new ConfigStore(path.join(dir, 'config.json'));
  const manager = await ConfigManager.create(store, async (c) =>
    c.nodes.map((n, i) => ({ id: n.id, latency: i === 1 ? 10 : 100 })),
  );
  const app = await createApp(manager, token);
  t.after(async () => {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  });
  const write = (
    url: string,
    payload: object,
    method: 'POST' | 'PUT' | 'PATCH' = 'POST',
  ) => app.inject({ method, url, headers, payload });
  await write(
    '/api/settings',
    {
      revision: 0,
      socks: {
        port: 1089,
        auth: { username: 'user', password: 'global-secret' },
      },
      logLevel: 'debug',
    },
    'PATCH',
  );
  const originalId = manager.profiles().activeProfileId;
  const content = await readFile('clash-example.yaml', 'utf8');
  const imported = await write('/api/imports/file', {
    content,
    revision: 1,
    name: '工作',
  });
  assert.equal(imported.statusCode, 200, imported.body);
  const first = imported.json();
  assert.equal(first.nodes.length, 3);
  assert.equal(first.rules, undefined);
  assert.deepEqual(first.selection.target, {
    kind: 'node',
    id: first.nodes[1].id,
  });
  assert.equal(first.selection.mode, 'auto');
  assert.equal(first.profiles.length, 2);
  assert.equal(first.profiles[1].name, '工作');
  assert.equal(first.socks.port, 1089);
  assert.equal(manager.config.socks.auth?.password, 'global-secret');
  assert.equal(manager.config.logLevel, 'debug');
  assert.equal(manager.status().state, 'stopped');
  assert.ok(!imported.body.includes('replace-with-password'));
  assert.ok(!imported.body.includes('global-secret'));
  assert.equal(first.importId, undefined);
  const firstId = first.activeProfileId;
  await write(
    '/api/dns',
    {
      revision: 2,
      dns: manager.config.dns,
      hosts: { 'work.local': '127.0.0.8' },
    },
    'PUT',
  );
  const second = await write('/api/imports/file', {
    revision: 3,
    name: '家庭',
    content:
      'socks-port: 9999\nhosts: {home.local: 127.0.0.9}\nrules: ["MATCH,REJECT"]',
  });
  assert.equal(second.statusCode, 200, second.body);
  assert.equal(second.json().profiles.length, 3);
  assert.equal(manager.config.nodes.length, 0);
  assert.equal(manager.selection().target.kind, 'direct');
  assert.deepEqual(manager.config.hosts, { 'home.local': '127.0.0.9' });
  assert.equal(manager.config.dns.enable, false);
  assert.equal(manager.config.socks.port, 1089);
  const secondId = second.json().activeProfileId;
  assert.equal(
    (await write(`/api/profiles/${firstId}/activate`, { revision: 4 }))
      .statusCode,
    200,
  );
  assert.equal(manager.config.nodes.length, 3);
  assert.deepEqual(manager.config.hosts, { 'work.local': '127.0.0.8' });
  assert.equal(manager.config.dns.enable, true);
  const committed = await readFile(store.file, 'utf8');
  for (const payload of [
    { content: 'tun: {enable: true}', revision: 5 },
    { content: 'rules: ["MATCH,DIRECT"]', revision: 0 },
    { content: 'rules: ["MATCH,DIRECT"]' },
  ])
    assert.ok((await write('/api/imports/file', payload)).statusCode >= 400);
  assert.equal(await readFile(store.file, 'utf8'), committed);
  assert.equal(
    (await write(`/api/profiles/${secondId}/activate`, { revision: 0 }))
      .statusCode,
    409,
  );
  assert.equal(
    (await write('/api/profiles/missing/activate', { revision: 5 })).statusCode,
    400,
  );
  const restored = await ConfigManager.create(store);
  assert.equal(restored.profiles().activeProfileId, firstId);
  assert.equal(restored.profiles().profiles.length, 3);
  assert.deepEqual(restored.config.hosts, manager.config.hosts);
  assert.equal(restored.config.socks.auth?.password, 'global-secret');
  assert.equal(
    (await write(`/api/profiles/${originalId}/activate`, { revision: 5 }))
      .statusCode,
    200,
  );
  assert.equal(manager.config.nodes.length, 0);
  assert.deepEqual(manager.config.hosts, {});
  assert.equal(manager.config.socks.port, 1089);
});
