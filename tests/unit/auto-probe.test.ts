import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { initialConfig, type ProxyNode } from '../../src/config/model.js';
import { ConfigManager } from '../../src/config/manager.js';
import { ConfigStore } from '../../src/config/storage.js';
import { createApp } from '../../src/api/app.js';
import {
  AUTO_PROBE_INTERVAL,
  PROBE_TIMEOUT_MS,
  AUTO_PROBE_SAMPLES,
  fastestNode,
  probeNodes,
  type ProbeResult,
} from '../../src/proxy/probe.js';

const node = (name: string): ProxyNode => ({
  id: randomUUID(),
  name,
  type: 'ss',
  server: '127.0.0.1',
  port: 1234,
  password: 'test-only',
  cipher: 'aes-128-gcm',
  udp: false,
});

test('five consecutive probe passes trim each node independently and compare unrounded means; failed samples receive the measurement timeout as penalty', async () => {
  const c = initialConfig();
  c.nodes = ['a', 'b', 'c', 'd'].map(node);
  const samples: Record<string, (number | null)[]> = {
    a: [1, 500, 600, 700, 999999],
    b: [90, 101, 102, 103, 999999],
    c: [500, 500, null, 500, 500],
    d: [90, 101, 102, 102, 999999],
  };
  const counts = new Map<string, number>();
  const calls: string[] = [];
  const results = await probeNodes(
    c,
    undefined,
    async (n) => {
      const i = counts.get(n.name) ?? 0;
      counts.set(n.name, i + 1);
      calls.push(n.name);
      const sample = samples[n.name][i];
      if (sample === null) throw new Error('private detail');
      return sample;
    },
    AUTO_PROBE_SAMPLES,
  );
  assert.deepEqual(
    calls,
    Array.from({ length: 5 }, () => ['a', 'b', 'c', 'd']).flat(),
  );
  assert.deepEqual(
    results.map((r) => r.samples),
    Object.values(samples),
  );
  assert.equal(results[0].latency, 600);
  assert.equal(results[1].latency, 102);
  assert.equal(results[2].latency, 500);
  assert.match(results[2].error!, /1 次失败/);
  assert.equal(results[3].latency, 305 / 3);
  assert.equal(fastestNode(results), c.nodes[3].id);
  assert.ok(!JSON.stringify(results).includes('private detail'));

  const cancel = new AbortController();
  c.nodes = [node('cancel')];
  let attempts = 0;
  await assert.rejects(
    probeNodes(
      c,
      cancel.signal,
      async () => {
        attempts++;
        if (attempts === 3) cancel.abort();
        return 10;
      },
      AUTO_PROBE_SAMPLES,
    ),
  );
  assert.equal(attempts, 3);
});

test('failed samples participate at the actual probe timeout before trimming, including fully failed nodes', async (t) => {
  const deadlines: number[] = [];
  const timeout = AbortSignal.timeout.bind(AbortSignal);
  t.mock.method(AbortSignal, 'timeout', (delay: number) => {
    deadlines.push(delay);
    return timeout(delay);
  });
  const cases: Record<string, (number | null)[]> = {
    once: [10, 20, 30, 40, null],
    twice: [100, 200, null, 300, null],
    thrice: [100, null, 200, null, null],
    all: [null, null, null, null, null],
    stable: [50, 50, 50, 50, 50],
  };
  const c = initialConfig();
  c.nodes = Object.keys(cases).map(node);
  const counts = new Map<string, number>();
  const results = await probeNodes(
    c,
    undefined,
    async (n) => {
      const index = counts.get(n.name) ?? 0;
      counts.set(n.name, index + 1);
      const sample = cases[n.name][index];
      if (sample === null) throw new Error('private failure');
      return sample;
    },
    AUTO_PROBE_SAMPLES,
  );
  assert.deepEqual(
    results.map((r) => r.latency),
    [
      30,
      (PROBE_TIMEOUT_MS + 500) / 3,
      (2 * PROBE_TIMEOUT_MS + 200) / 3,
      PROBE_TIMEOUT_MS,
      50,
    ],
  );
  assert.deepEqual(
    results.map((r) => r.samples),
    Object.values(cases),
  );
  assert.equal(PROBE_TIMEOUT_MS, 4000);
  assert.equal(
    deadlines.filter((delay) => delay === PROBE_TIMEOUT_MS).length,
    c.nodes.length * AUTO_PROBE_SAMPLES,
  );
  assert.ok(results.every((r) => r.sampleTimeoutMs === PROBE_TIMEOUT_MS));
  assert.equal(fastestNode(results), c.nodes[0].id);
  assert.match(
    results[1].error!,
    new RegExp(`2 次失败.*测速超时 ${PROBE_TIMEOUT_MS} ms`),
  );
  assert.ok(!JSON.stringify(results).includes('private failure'));

  const dir = await mkdtemp(path.join(os.tmpdir(), 'hihop-failure-score-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const manager = await ConfigManager.create(
    new ConfigStore(path.join(dir, 'config.json')),
    (config, signal, _measure, count) =>
      probeNodes(
        config,
        signal,
        async () => {
          throw new Error('failed');
        },
        count,
      ),
  );
  t.after(() => manager.stop());
  await manager.addProfile(0, 'failed', c);
  assert.ok(
    manager.selection().latencies.every((r) => r.latency === PROBE_TIMEOUT_MS),
  );
  assert.deepEqual(manager.selection().target, {
    kind: 'node',
    id: c.nodes[0].id,
  });
  assert.equal(manager.selection().probeError, undefined);
});

test('hourly probes run only for the active automatic profile, deduplicate running rounds and throttle failures', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'hihop-hourly-probe-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  let now = 1000000;
  t.mock.method(Date, 'now', () => now);
  let hold = false;
  let fail = false;
  const calls: (1 | 5)[] = [];
  let finish!: (results: ProbeResult[]) => void;
  const store = new ConfigStore(path.join(dir, 'config.json'));
  const manager = await ConfigManager.create(
    store,
    async (c, _signal, _measure, count = 1) => {
      calls.push(count);
      return hold
        ? new Promise<ProbeResult[]>((resolve) => {
            finish = resolve;
          })
        : c.nodes.map((n, i) => ({
            id: n.id,
            latency: fail ? PROBE_TIMEOUT_MS : i === 0 ? 10 : 50,
            ...(fail ? { samples: [null, null, null, null, null] } : {}),
          }));
    },
  );
  t.after(() => manager.stop());
  const c = initialConfig();
  c.nodes = [node('a'), node('b')];
  await manager.addProfile(0, 'active', c);
  assert.deepEqual(calls, [5]);
  const waitForProbe = async () => {
    while (manager.selection().probing)
      await new Promise((r) => setImmediate(r));
  };
  now += AUTO_PROBE_INTERVAL - 1;
  await manager.probeIfDue();
  assert.equal(calls.length, 1);
  now++;
  hold = true;
  await manager.probeIfDue();
  assert.equal(manager.selection().probing, true);
  await Promise.all(Array.from({ length: 10 }, () => manager.probeIfDue()));
  assert.deepEqual(calls, [5, 5]);
  finish(c.nodes.map((n, i) => ({ id: n.id, latency: i === 1 ? 9 : 80 })));
  await waitForProbe();
  assert.deepEqual(manager.selection().target, {
    kind: 'node',
    id: c.nodes[1].id,
  });
  assert.equal(manager.status().state, 'stopped');
  hold = false;
  now += AUTO_PROBE_INTERVAL - 1;
  await manager.probeIfDue();
  assert.equal(calls.length, 2);
  now++;
  fail = true;
  await manager.probeIfDue();
  await waitForProbe();
  assert.equal(calls.length, 3);
  assert.equal(manager.selection().probeError, undefined);
  assert.ok(
    manager.selection().latencies.every((r) => r.latency === PROBE_TIMEOUT_MS),
  );
  assert.deepEqual(manager.selection().target, {
    kind: 'node',
    id: c.nodes[0].id,
  });
  await manager.probeIfDue();
  assert.equal(calls.length, 3);
  await manager.selectNode(manager.config.revision, {
    mode: 'manual',
    target: manager.selection().target,
  });
  now += 2 * AUTO_PROBE_INTERVAL;
  await manager.probeIfDue();
  assert.equal(calls.length, 3);
  fail = false;
  await manager.probeActive(manager.config.revision);
  await waitForProbe();
  assert.equal(calls.at(-1), 1);
  await manager.selectNode(
    manager.config.revision,
    { mode: 'auto', target: manager.selection().target },
    undefined,
    true,
  );
  await waitForProbe();
  assert.equal(calls.at(-1), 5);
  const count = calls.length;
  await manager.addProfile(manager.config.revision, 'empty', initialConfig());
  now += 2 * AUTO_PROBE_INTERVAL;
  await manager.probeIfDue();
  assert.equal(calls.length, count);

  // Restart a saved automatic profile: its first scheduled round is one hour after startup.
  const id = manager.profiles().profiles.find((p) => p.name === 'active')!.id;
  await manager.activateProfile(manager.config.revision, id);
  await waitForProbe();
  let restartedCalls = 0;
  const restarted = await ConfigManager.create(
    store,
    async (c, _signal, _measure, count) => {
      restartedCalls++;
      assert.equal(count, 5);
      return c.nodes.map((n) => ({ id: n.id, latency: 10 }));
    },
  );
  t.after(() => restarted.stop());
  await restarted.probeIfDue();
  assert.equal(restartedCalls, 0);
  now += AUTO_PROBE_INTERVAL;
  await restarted.probeIfDue();
  while (restarted.selection().probing)
    await new Promise((r) => setImmediate(r));
  assert.equal(restartedCalls, 1);
});

test('management app checks hourly probes without a browser and removes its timer on close', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'hihop-hourly-timer-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  t.mock.timers.enable({ apis: ['setInterval'] });
  const manager = await ConfigManager.create(
    new ConfigStore(path.join(dir, 'config.json')),
  );
  const check = t.mock.method(manager, 'probeIfDue', async () => {});
  const app = await createApp(manager, 'a'.repeat(64));
  t.after(() => app.close());
  await app.ready();
  assert.equal(check.mock.callCount(), 1);
  t.mock.timers.tick(60000);
  assert.equal(check.mock.callCount(), 2);
  await app.close();
  t.mock.timers.tick(AUTO_PROBE_INTERVAL);
  assert.equal(check.mock.callCount(), 2);
});
