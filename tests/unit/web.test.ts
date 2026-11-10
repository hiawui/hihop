import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import ts from 'typescript';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { ConfigManager } from '../../src/config/manager.js';
import { ConfigStore } from '../../src/config/storage.js';
import { createApp } from '../../src/api/app.js';
import { PROBE_TIMEOUT_MS } from '../../src/proxy/probe.js';

test('Web URL navigation restores pages after reload/login and follows browser history', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'hihop-web-routing-'));
  const manager = await ConfigManager.create(
    new ConfigStore(path.join(dir, 'config.json')),
  );
  const app = await createApp(manager, 'a'.repeat(64));
  const windows: JSDOM[] = [];
  t.after(async () => {
    for (const dom of windows) dom.window.close();
    await app.close();
    await rm(dir, { recursive: true, force: true });
  });
  const source = (await readFile('web/src/main.ts', 'utf8')).replace(
    /^import\s+['"]\.\/style\.css['"];?\s*$/m,
    '',
  );
  const script = ts.transpileModule(source, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2023,
      module: ts.ModuleKind.None,
    },
  }).outputText;
  const wait = async (check: () => boolean) => {
    for (let i = 0; i < 100; i++) {
      if (check()) return;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.fail('URL navigation did not render the expected page');
  };
  const load = async (url: string, authenticated = true) => {
    const dom = new JSDOM('<div id="app"></div>', {
      url,
      runScripts: 'outside-only',
    });
    windows.push(dom);
    const win = dom.window;
    if (authenticated)
      win.sessionStorage.setItem('hihop-token', 'a'.repeat(64));
    win.fetch = (async (url: string, options: RequestInit = {}) => {
      const response = await app.inject({
        method: (options.method ?? 'GET') as any,
        url,
        headers: {
          ...(options.headers as Record<string, string>),
          host: '127.0.0.1:7800',
        },
        payload: options.body as string | undefined,
      });
      return new Response(response.body, { status: response.statusCode });
    }) as any;
    win.eval(script);
    await wait(
      () => !!win.document.querySelector(authenticated ? 'nav' : '#login'),
    );
    return win;
  };
  const win = await load('http://127.0.0.1:7800/?keep=1');
  const document = win.document;
  const click = (selector: string) => {
    const link = document.querySelector<HTMLAnchorElement>(selector);
    assert.ok(link, selector);
    assert.ok(link.href.startsWith('http://127.0.0.1:7800/'));
    link.click();
  };
  assert.equal(win.location.hash, '#/overview');
  assert.equal(win.history.length, 1);
  click('aside [data-tab="proxy"]');
  assert.equal(win.location.hash, '#/proxy/nodes');
  click('[data-proxy-tab="dns"]');
  assert.equal(win.location.hash, '#/proxy/dns');
  const draft = document.querySelector<HTMLTextAreaElement>(
    '[name="nameservers"]',
  )!;
  draft.value = 'unsaved draft';
  const historyLength = win.history.length;
  click('[data-proxy-tab="dns"]');
  assert.equal(win.history.length, historyLength);
  assert.equal(document.querySelector('[name="nameservers"]'), draft);
  click('[data-proxy-tab="hosts"]');
  assert.equal(win.location.hash, '#/proxy/hosts');
  click('aside [data-tab="settings"]');
  assert.equal(win.location.hash, '#/settings');
  assert.equal(document.querySelector('h1')?.textContent, '监听设置');
  assert.equal(win.location.search, '?keep=1');
  win.history.back();
  await wait(() => !!document.querySelector('#hosts-form'));
  assert.equal(win.location.hash, '#/proxy/hosts');
  assert.equal(
    document.querySelector('nav [aria-current="page"]')?.textContent,
    '配置管理',
  );
  assert.equal(
    document.querySelector('[role="tab"][aria-selected="true"]')?.textContent,
    'hosts',
  );
  win.history.forward();
  await wait(() => !!document.querySelector('#settings-form'));
  assert.equal(win.location.hash, '#/settings');
  click('aside [data-tab="proxy"]');
  assert.equal(win.location.hash, '#/proxy/hosts');
  const reloaded = await load(win.location.href);
  assert.ok(reloaded.document.querySelector('#hosts-form'));
  assert.equal(reloaded.location.hash, '#/proxy/hosts');

  // Modified clicks retain native link behavior, including opening another tab.
  const modifiedClick = new win.MouseEvent('click', {
    bubbles: true,
    cancelable: true,
    ctrlKey: true,
  });
  document.addEventListener(
    'click',
    (event) => {
      assert.equal(event.defaultPrevented, false);
      event.preventDefault(); // Suppress jsdom's native navigation in this test.
    },
    { once: true },
  );
  document
    .querySelector('[data-proxy-tab="dns"]')!
    .dispatchEvent(modifiedClick);
  assert.equal(win.location.hash, '#/proxy/hosts');

  // Editing the address bar fragment also navigates without reloading the app.
  win.location.hash = '#/proxy/dns';
  await wait(() => !!document.querySelector('#dns-form'));
  win.location.hash = '#/unknown';
  await wait(() => document.querySelector('h1')?.textContent === '运行概览');
  assert.equal(win.location.hash, '#/overview');
  click('#content [data-tab="proxy"]');
  assert.equal(win.location.hash, '#/proxy/nodes');
  assert.ok(document.querySelector('#node-list'));

  for (const [route, selector, canonical = route] of [
    ['#/overview', '.cards'],
    ['#/settings', '#settings-form'],
    ['#/proxy/nodes', '#node-list'],
    ['#/proxy/dns', '#dns-form'],
    ['#/proxy/hosts', '#hosts-form'],
    ['#/proxy', '#node-list', '#/proxy/nodes'],
    ['#/proxy/dns/', '#dns-form', '#/proxy/dns'],
    ['#/proxy/invalid', '.cards', '#/overview'],
  ]) {
    const direct = await load(`http://127.0.0.1:7800/${route}`);
    assert.ok(direct.document.querySelector(selector), route);
    assert.equal(direct.location.hash, canonical);
    assert.equal(direct.history.length, 1);
  }

  const loggedOut = await load('http://127.0.0.1:7800/#/proxy/dns', false);
  loggedOut.document.querySelector<HTMLInputElement>('[name="token"]')!.value =
    'a'.repeat(64);
  loggedOut.document
    .querySelector('#login')!
    .dispatchEvent(
      new loggedOut.Event('submit', { bubbles: true, cancelable: true }),
    );
  await wait(() => !!loggedOut.document.querySelector('#dns-form'));
  assert.equal(loggedOut.location.hash, '#/proxy/dns');
});

test('Web DOM workflow: login, node create/edit, manual/auto selection, DNS, settings, modal import/subscription editing and independent profile switching', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'hihop-web-'));
  let holdProbe = false;
  let probeRequests = 0;
  let holdProbeResponse = false;
  let releaseProbeResponse: (() => void) | undefined;
  let finishProbe!: (results: { id: string; latency: number | null }[]) => void;
  const manager = await ConfigManager.create(
    new ConfigStore(path.join(dir, 'config.json')),
    async (c) =>
      holdProbe
        ? new Promise<{ id: string; latency: number | null }[]>((resolve) => {
            finishProbe = resolve;
          })
        : c.nodes.map((n, i) => ({ id: n.id, latency: i === 1 ? 10 : 100 })),
    async () => readFile('clash-example.yaml', 'utf8'),
  );
  const app = await createApp(manager, 'a'.repeat(64));
  const dom = new JSDOM('<div id="app"></div>', {
    url: 'http://127.0.0.1:7800',
    runScripts: 'outside-only',
  });
  const win = dom.window;
  const document = win.document;
  win.structuredClone = structuredClone;
  // jsdom lacks dialog's modal methods; all rendering and event handlers are the production code.
  win.HTMLDialogElement.prototype.showModal = function () {
    this.open = true;
  };
  win.HTMLDialogElement.prototype.close = function () {
    this.open = false;
  };
  win.fetch = (async (url: string, options: RequestInit = {}) => {
    if (url === '/api/probes' && options.method === 'POST') probeRequests++;
    const response = await app.inject({
      method: (options.method ?? 'GET') as any,
      url,
      headers: {
        ...(options.headers as Record<string, string>),
        host: '127.0.0.1:7800',
      },
      payload: options.body as string | undefined,
    });
    if (url === '/api/probes' && holdProbeResponse)
      await new Promise<void>((resolve) => {
        releaseProbeResponse = resolve;
      });
    return new Response(response.body, {
      status: response.statusCode,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as any;
  t.after(async () => {
    win.close();
    await app.close();
    await rm(dir, { recursive: true, force: true });
  });
  const source = (await readFile('web/src/main.ts', 'utf8')).replace(
    /^import\s+['"]\.\/style\.css['"];?\s*$/m,
    '',
  );
  win.eval(
    ts.transpileModule(source, {
      compilerOptions: {
        target: ts.ScriptTarget.ES2023,
        module: ts.ModuleKind.None,
      },
    }).outputText,
  );
  const wait = async (check: () => boolean) => {
    for (let i = 0; i < 100; i++) {
      if (check()) return;
      await new Promise((r) => setTimeout(r, 5));
    }
    throw new Error(
      `UI condition timed out: ${document.querySelector('#toast')?.textContent}`,
    );
  };
  const input = (
    name: string,
    value: string,
    root: Element = document.body,
  ) => {
    const el = root.querySelector<HTMLInputElement>(`[name="${name}"]`)!;
    assert.ok(el, name);
    el.value = value;
  };
  const click = (selector: string) => {
    const el = document.querySelector<HTMLButtonElement>(selector);
    assert.ok(el, selector);
    el.click();
  };
  const submit = (selector: string) =>
    document
      .querySelector(selector)!
      .dispatchEvent(
        new win.Event('submit', { bubbles: true, cancelable: true }),
      );
  input('token', 'a'.repeat(64));
  submit('#login');
  await wait(() => !!document.querySelector('aside [data-tab="proxy"]'));
  assert.deepEqual(
    [...document.querySelectorAll('aside nav a')].map((el) => el.textContent),
    ['运行概览', '配置管理', '监听设置'],
  );
  click('aside [data-tab="proxy"]');
  assert.equal(document.querySelector('h1')?.textContent, '配置管理');
  assert.ok(document.querySelector('#content #active-profile'));
  assert.deepEqual(
    [...document.querySelectorAll('[role="tab"]')].map((el) => el.textContent),
    ['代理节点', 'DNS', 'hosts'],
  );
  click('[data-action="add-node"]');
  input('name', 'test node');
  input('server', '127.0.0.1');
  input('password', 'test-only');
  submit('#node-form');
  await wait(
    () =>
      manager.config.nodes.length === 1 &&
      !document.querySelector<HTMLDialogElement>('dialog')?.open,
  );
  assert.ok(document.body.textContent?.includes('test node'));
  click('[data-action="edit-node"]');
  input('name', 'renamed');
  submit('#node-form');
  await wait(
    () =>
      manager.config.nodes[0].name === 'renamed' &&
      !document.querySelector<HTMLDialogElement>('dialog')?.open,
  );
  assert.equal((manager.config.nodes[0] as any).password, 'test-only');
  click('[data-action="select-node"]');
  await wait(
    () => document.querySelector('#toast')?.textContent === '已切换节点',
  );
  assert.equal(manager.selection().target.kind, 'node');
  click('[data-proxy-tab="hosts"]');
  input('hosts', 'example.local = 127.0.0.9');
  submit('#hosts-form');
  await wait(() => manager.config.hosts['example.local'] === '127.0.0.9');
  // Wait until the write refresh has finished before moving to another form.
  await wait(
    () =>
      document.querySelector<HTMLTextAreaElement>('[name="hosts"]')?.value ===
      'example.local = 127.0.0.9',
  );
  click('[data-proxy-tab="dns"]');
  assert.ok(document.querySelector('#dns-form .form-stack'));
  for (const label of document.querySelectorAll(
    '#dns-form .form-stack > label',
  ))
    assert.ok(label.querySelector('.hint')?.textContent);
  assert.ok(!document.querySelector('[name="hosts"]'));
  input('nameservers', '9.9.9.9');
  input('proxyServerNameservers', '223.5.5.5');
  submit('#dns-form');
  await wait(
    () =>
      manager.config.dns.nameservers[0].host === '9.9.9.9' &&
      document.querySelector('#toast')?.textContent === '配置已保存',
  );
  await wait(
    () =>
      document.querySelector<HTMLTextAreaElement>('[name="nameservers"]')
        ?.value === '9.9.9.9',
  );
  assert.equal(manager.config.hosts['example.local'], '127.0.0.9');
  assert.equal(manager.config.dns.proxyServerNameservers[0].host, '223.5.5.5');
  click('[data-proxy-tab="hosts"]');
  document.querySelector<HTMLInputElement>('[name="useHosts"]')!.checked =
    false;
  submit('#hosts-form');
  await wait(
    () =>
      manager.config.dns.useHosts === false &&
      document.querySelector<HTMLInputElement>('[name="useHosts"]')?.checked ===
        false,
  );
  assert.equal(manager.config.dns.nameservers[0].host, '9.9.9.9');
  click('[data-tab="settings"]');
  input('port', '1089');
  submit('#settings-form');
  await wait(() => manager.config.socks.port === 1089);
  await new Promise((r) => setTimeout(r, 10));
  const originalId = manager.profiles().activeProfileId;
  click('aside [data-tab="proxy"]');
  assert.ok(!document.querySelector('#url-form'));
  assert.ok(!document.querySelector('[data-action="edit-subscription"]'));
  click('[data-action="open-import"]');
  assert.ok(
    document.querySelector<HTMLDialogElement>('#profile-config-dialog')?.open,
  );
  assert.equal(
    document.querySelector<HTMLSelectElement>('#import-type')?.value,
    'url',
  );
  assert.deepEqual(
    [...document.querySelectorAll('#import-type option')].map((o) =>
      o.getAttribute('value'),
    ),
    ['url', 'file', 'blank'],
  );
  assert.ok(document.querySelector('#url-form'));
  assert.ok(!document.querySelector('#yaml-file'));
  assert.ok(!document.querySelector('#profile-form'));
  const chooseImportType = (value: string) => {
    const select = document.querySelector<HTMLSelectElement>('#import-type')!;
    select.value = value;
    select.dispatchEvent(new win.Event('change', { bubbles: true }));
  };
  chooseImportType('file');
  assert.ok(!document.querySelector('#url-form'));
  assert.ok(!document.querySelector('#profile-form'));
  const file = document.querySelector<HTMLInputElement>('#yaml-file')!;
  Object.defineProperty(file, 'files', {
    value: [
      {
        name: '工作.yaml',
        size: 4000,
        text: async () => readFile('clash-example.yaml', 'utf8'),
      },
    ],
  });
  file.dispatchEvent(new win.Event('change', { bubbles: true }));
  await wait(
    () =>
      manager.config.nodes.length === 3 &&
      document.querySelector('#toast')?.textContent === '配置已导入并切换',
  );
  const importedId = manager.profiles().activeProfileId;
  assert.equal(manager.config.socks.port, 1089);
  assert.equal(manager.profiles().profiles.length, 2);
  assert.equal(manager.profiles().profiles[1].name, '工作');
  assert.equal(manager.status().state, 'stopped');
  assert.equal(manager.selection().mode, 'auto');
  assert.equal(
    (manager.selection().target as any).id,
    manager.config.nodes[1].id,
  );
  assert.ok(!document.querySelector('#mapping-form'));
  assert.ok(!document.querySelector('[data-action="apply-import"]'));
  assert.ok(!document.body.textContent?.includes('replace-with-password'));
  const switchProfile = (id: string) => {
    const select =
      document.querySelector<HTMLSelectElement>('#active-profile')!;
    select.value = id;
    select.dispatchEvent(new win.Event('change', { bubbles: true }));
  };
  click('aside [data-tab="proxy"]');
  click('[data-proxy-tab="nodes"]');
  assert.equal(document.querySelectorAll('.node-title').length, 3);
  assert.ok(
    !document.querySelector<HTMLDialogElement>('#profile-config-dialog')?.open,
  );
  assert.ok(!document.querySelector('#url-form'));
  assert.ok(!document.querySelector('[data-action="edit-subscription"]'));
  assert.ok(!document.querySelector('#selection-form'));
  assert.ok(!document.querySelector('#selected-node'));
  const modeSelect = document.querySelector('#node-list #selection-mode')!;
  assert.ok(modeSelect);
  assert.equal(modeSelect.closest('label'), null);
  assert.equal(modeSelect.getAttribute('aria-label'), '节点选择方式');
  assert.deepEqual(
    [...modeSelect.querySelectorAll('option')].map((o) => o.textContent),
    ['手动选择', '自动探测'],
  );
  assert.ok(!document.querySelector('[data-action="select-direct"]'));
  assert.equal(
    document.querySelector('.profile-picker label')?.getAttribute('for'),
    'active-profile',
  );
  assert.ok(!document.body.textContent?.includes('切换配置时，'));
  input('mode', 'manual', document.querySelector('#node-list')!);
  document
    .querySelector('#selection-mode')!
    .dispatchEvent(new win.Event('change', { bubbles: true }));
  await wait(
    () => document.querySelector('#toast')?.textContent === '已切换节点',
  );
  input('mode', 'auto', document.querySelector('#node-list')!);
  document
    .querySelector('#selection-mode')!
    .dispatchEvent(new win.Event('change', { bubbles: true }));
  await wait(
    () => manager.selection().mode === 'auto' && !manager.selection().probing,
  );
  await wait(
    () =>
      !document.querySelector<HTMLSelectElement>('#selection-mode')?.disabled,
  );
  await win.eval('poll()');
  const completedVersion = manager.selection().probeCompletedVersion;
  click('[data-action="probe-nodes"]');
  await wait(
    () => manager.selection().probeCompletedVersion > completedVersion,
  );
  await wait(() => !manager.selection().probing);
  assert.equal(manager.selection().target.kind, 'node');
  assert.equal(
    (manager.selection().target as any).id,
    manager.config.nodes[1].id,
  );
  await win.eval('poll()');
  assert.ok(document.body.textContent?.includes('10 ms'));
  assert.equal(
    document.querySelector('#toast')?.textContent,
    '测速完成：3 个可用，0 个失败',
  );
  holdProbe = true;
  holdProbeResponse = true;
  const requestsBeforeProbe = probeRequests;
  click('[data-action="probe-nodes"]');
  assert.ok(
    document.querySelector<HTMLButtonElement>('[data-action="probe-nodes"]')
      ?.disabled,
  );
  click('[data-action="probe-nodes"]');
  assert.equal(probeRequests, requestsBeforeProbe + 1);
  await wait(() => manager.selection().probing);
  await wait(
    () =>
      !!document.querySelector<HTMLButtonElement>('[data-action="probe-nodes"]')
        ?.disabled,
  );
  await win.eval('poll()');
  assert.ok(
    document.querySelector<HTMLButtonElement>('[data-action="probe-nodes"]')
      ?.disabled,
  );
  assert.ok(document.body.textContent?.includes('测速中…'));
  click('[data-proxy-tab="dns"]');
  click('[data-proxy-tab="nodes"]');
  assert.ok(
    document.querySelector<HTMLButtonElement>('[data-action="probe-nodes"]')
      ?.disabled,
  );
  click('[data-action="open-import"]');
  input(
    'url',
    'https://draft.example/config',
    document.querySelector('#url-form')!,
  );
  await wait(() => !!releaseProbeResponse);
  finishProbe(
    manager.config.nodes.map((n, i) => ({
      id: n.id,
      latency: [200, 500, 501][i],
      sampleTimeoutMs: PROBE_TIMEOUT_MS + 1000,
      samples: [
        null,
        [200, 500, 501][i],
        [200, 500, 501][i],
        [200, 500, 501][i],
        999,
      ],
    })),
  );
  await wait(() => !manager.selection().probing);
  await win.eval('poll()');
  assert.ok(
    document.querySelector('#node-list')?.textContent?.includes('200 ms'),
  );
  assert.equal(document.querySelector('.latency-green')?.textContent, '200 ms');
  assert.equal(
    document.querySelector('.latency-orange')?.textContent,
    '500 ms',
  );
  assert.equal(document.querySelector('.latency-red')?.textContent, '501 ms');
  assert.ok(
    document
      .querySelector('.latency-green')
      ?.getAttribute('title')
      ?.includes('去掉最快和最慢后的平均延迟'),
  );
  assert.ok(
    document
      .querySelector('.latency-green')
      ?.getAttribute('title')
      ?.includes(`失败（${PROBE_TIMEOUT_MS + 1000} ms，按测速超时计分）`),
  );
  // A delayed start response must not replace the newer completed result.
  releaseProbeResponse!();
  holdProbeResponse = false;
  await wait(
    () =>
      !document.querySelector<HTMLButtonElement>('[data-action="probe-nodes"]')
        ?.disabled,
  );
  assert.ok(
    document.querySelector('#node-list')?.textContent?.includes('200 ms'),
  );
  assert.equal(
    document.querySelector('#toast')?.textContent,
    '测速完成：3 个可用，0 个失败',
  );
  const completionToast = document.querySelector('#toast');
  await win.eval('poll()');
  assert.equal(document.querySelector('#toast'), completionToast);
  assert.equal(
    document.querySelector<HTMLInputElement>('#url-form [name="url"]')?.value,
    'https://draft.example/config',
  );
  assert.ok(
    document.querySelector<HTMLDialogElement>('#profile-config-dialog')?.open,
  );
  click('[data-action="close-config-dialog"]');
  assert.ok(
    !document.querySelector<HTMLDialogElement>('#profile-config-dialog')?.open,
  );
  // A finished round reports failures, while cancellation never reports completion.
  click('[data-action="probe-nodes"]');
  await wait(() => manager.selection().probing);
  finishProbe(
    manager.config.nodes.map((n) => ({
      id: n.id,
      latency: PROBE_TIMEOUT_MS,
      sampleTimeoutMs: PROBE_TIMEOUT_MS,
      samples: [null, null, null, null, null],
    })),
  );
  await wait(() => !manager.selection().probing);
  await win.eval('poll()');
  assert.ok(
    document
      .querySelector('#toast')
      ?.textContent?.startsWith('测速完成：0 个可用，3 个失败'),
  );
  assert.ok(document.querySelector('#toast')?.classList.contains('error'));
  assert.equal(document.querySelectorAll('#node-list .latency-red').length, 3);
  assert.equal(
    document.querySelector('#node-list .latency-red')?.textContent,
    `${PROBE_TIMEOUT_MS} ms`,
  );
  assert.ok(
    !document.querySelector<HTMLButtonElement>('[data-action="probe-nodes"]')
      ?.disabled,
  );
  const lastCompletion = manager.selection().probeCompletedVersion;
  click('[data-action="probe-nodes"]');
  await wait(() => manager.selection().probing);
  click('[data-action="select-node"]');
  await wait(
    () => document.querySelector('#toast')?.textContent === '已切换节点',
  );
  finishProbe(manager.config.nodes.map((n) => ({ id: n.id, latency: 20 })));
  await new Promise((r) => setImmediate(r));
  await win.eval('poll()');
  assert.equal(manager.selection().probeCompletedVersion, lastCompletion);
  assert.equal(document.querySelector('#toast')?.textContent, '已切换节点');
  holdProbe = false;

  assert.ok(!document.querySelector('[data-proxy-tab="rules"]'));
  assert.ok(!document.querySelector('aside [data-tab="imports"]'));
  click('[data-proxy-tab="hosts"]');
  switchProfile(originalId);
  await wait(
    () =>
      manager.profiles().activeProfileId === originalId &&
      document.querySelector('#toast')?.textContent === '已切换配置',
  );
  assert.equal(manager.config.nodes[0].name, 'renamed');
  assert.equal(manager.config.hosts['example.local'], '127.0.0.9');
  assert.equal(manager.config.rules[0].target.kind, 'node');
  assert.equal(manager.config.socks.port, 1089);
  assert.equal(
    document.querySelector('[role="tab"][aria-selected="true"]')?.textContent,
    'hosts',
  );
  click('[data-proxy-tab="nodes"]');
  assert.equal(document.querySelector('.node-title')?.textContent, 'renamed');
  click('[data-proxy-tab="dns"]');
  assert.equal(
    document.querySelector<HTMLTextAreaElement>('[name="nameservers"]')?.value,
    '9.9.9.9',
  );
  assert.equal(
    document.querySelector<HTMLInputElement>('[name="enable"]')?.checked,
    false,
  );
  click('[data-proxy-tab="hosts"]');
  assert.equal(
    document.querySelector<HTMLTextAreaElement>('[name="hosts"]')?.value,
    'example.local = 127.0.0.9',
  );
  assert.equal(
    document.querySelector<HTMLInputElement>('[name="useHosts"]')?.checked,
    false,
  );
  switchProfile(importedId);
  await wait(
    () =>
      document.querySelector<HTMLTextAreaElement>('[name="hosts"]')?.value ===
      'example.local = 127.0.0.1',
  );
  assert.equal(manager.config.nodes.length, 3);
  assert.equal(manager.config.hosts['example.local'], '127.0.0.1');
  assert.equal(
    document.querySelector<HTMLInputElement>('[name="useHosts"]')?.checked,
    true,
  );
  click('[data-proxy-tab="dns"]');
  assert.ok(
    document
      .querySelector<HTMLTextAreaElement>('[name="nameservers"]')
      ?.value.includes('223.5.5.5'),
  );
  assert.equal(
    document.querySelector<HTMLInputElement>('[name="enable"]')?.checked,
    true,
  );
  click('[data-action="open-import"]');
  chooseImportType('blank');
  assert.ok(!document.querySelector('#url-form'));
  assert.ok(!document.querySelector('#yaml-file'));
  input('name', '空白', document.querySelector('#profile-form')!);
  submit('#profile-form');
  await wait(
    () =>
      manager.profiles().profiles.length === 3 &&
      document.querySelector('#toast')?.textContent === '配置已保存',
  );
  click('aside [data-tab="proxy"]');
  assert.equal(
    document.querySelector<HTMLSelectElement>('#active-profile')
      ?.selectedOptions[0].textContent,
    '空白',
  );
  assert.equal(manager.config.nodes.length, 0);
  assert.deepEqual(manager.config.hosts, {});
  assert.equal(manager.config.socks.port, 1089);
  assert.equal(manager.selection().mode, 'auto');
  click('[data-action="open-import"]');
  input(
    'url',
    'https://example.com/subscription',
    document.querySelector('#url-form')!,
  );
  assert.equal(
    document.querySelector<HTMLInputElement>('#url-form [name="intervalHours"]')
      ?.value,
    '4',
  );
  submit('#url-form');
  await wait(
    () => !!document.querySelector('[data-action="edit-subscription"]'),
  );
  assert.ok(!document.querySelector('#subscription-form'));
  assert.ok(
    !document.querySelector<HTMLDialogElement>('#profile-config-dialog')?.open,
  );
  click('[data-action="edit-subscription"]');
  assert.ok(
    document.querySelector<HTMLDialogElement>('#profile-config-dialog')?.open,
  );
  assert.ok(
    document.querySelector('#profile-config-dialog #subscription-form'),
  );
  assert.equal(
    document.querySelector('#profile-config-title')?.textContent,
    'HTTP(S) 配置管理',
  );
  assert.equal(
    document.querySelector<HTMLInputElement>(
      '#subscription-form [name="intervalHours"]',
    )?.value,
    '4',
  );
  input('intervalHours', '1.5', document.querySelector('#subscription-form')!);
  input(
    'url',
    'https://example.com/updated',
    document.querySelector('#subscription-form')!,
  );
  submit('#subscription-form');
  await wait(
    () =>
      manager.profiles().profiles.at(-1)?.subscription?.intervalHours === 1.5,
  );
  await wait(
    () => document.querySelector('#toast')?.textContent === '配置已保存',
  );
  assert.ok(
    !document.querySelector<HTMLDialogElement>('#profile-config-dialog')?.open,
  );
  click('[data-action="edit-subscription"]');
  assert.equal(
    document.querySelector<HTMLInputElement>('#subscription-form [name="url"]')
      ?.value,
    'https://example.com/updated',
  );
  click('[data-action="refresh-subscription"]');
  await wait(
    () => document.querySelector('#toast')?.textContent === '配置已更新',
  );
  assert.equal(
    manager.profiles().profiles.at(-1)?.subscription?.intervalHours,
    1.5,
  );
  assert.equal(
    manager.profiles().profiles.at(-1)?.subscription?.url,
    'https://example.com/updated',
  );
  assert.ok(
    document.querySelector<HTMLDialogElement>('#profile-config-dialog')?.open,
  );
  click('[data-action="close-config-dialog"]');
  const deletedId = manager.profiles().activeProfileId;
  click('[data-action="delete-profile"]');
  assert.ok(
    document.querySelector<HTMLDialogElement>('#profile-delete-dialog')?.open,
  );
  click('[data-action="cancel-delete-profile"]');
  assert.equal(manager.profiles().activeProfileId, deletedId);
  click('[data-action="delete-profile"]');
  click('[data-action="confirm-delete-profile"]');
  await wait(
    () => document.querySelector('#toast')?.textContent === '配置已删除',
  );
  assert.ok(!manager.profiles().profiles.some((p) => p.id === deletedId));
});
