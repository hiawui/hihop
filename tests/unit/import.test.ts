import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { importClash, parseUpstream } from '../../src/import/clash.js';
import { initialConfig, validateConfig } from '../../src/config/model.js';
import { publicAddress, downloadConfig } from '../../src/import/download.js';

const example = await readFile('clash-example.yaml', 'utf8');
test('example imports nodes, DNS and hosts; ignores rules and groups and selects the first node', () => {
  const result = importClash(example);
  const c = result.config;
  assert.equal(c.nodes.length, 3);
  assert.equal(c.nodes[2].type, 'vmess');
  assert.equal((c.nodes[2] as any).alterId, 1);
  assert.equal(c.dns.policy['+.example.com'][0].port, 8080);
  assert.equal(c.hosts['example.local'], '127.0.0.1');
  assert.equal(c.rules.length, 1);
  assert.deepEqual(c.rules[0].target, { kind: 'node', id: c.nodes[0].id });
  assert.ok(result.warnings.some((w) => w.startsWith('rules 已忽略')));
  assert.ok(result.warnings.some((w) => w.startsWith('proxy-groups 已忽略')));
});
for (const [name, yaml] of Object.entries({
  duplicateKey: 'a: 1\na: 2',
  unknownField: 'tun: {enable: true}',
  tls: example.replace('skip-cert-verify: false', 'skip-cert-verify: true'),
  duplicateNode: example.replace('示例 VMess TCP 节点,', '示例 SS 节点,'),
  badTag: 'hosts: !exec echo',
})) {
  test(`invalid import blocks: ${name}`, () =>
    assert.throws(() => importClash(yaml)));
}
test('routing data is ignored even with unsupported rules, invalid targets, CIDRs and cyclic groups', () => {
  for (const rules of [
    '["FOO,example.com,missing"]',
    '["IP-CIDR,invalid/99,REJECT"]',
    '["DOMAIN,a.com,DIRECT,no-resolve"]',
    '["MATCH,missing"]',
    'invalid',
    'null',
  ]) {
    const c = importClash(`mode: Global
proxy-groups: [{name: a, proxies: [b]}, {name: b, proxies: [a]}]
rule-providers: {external: {type: http, url: https://invalid.test/rules}}
rules: ${rules}`);
    assert.deepEqual(c.config.rules, initialConfig().rules);
    assert.equal(c.warnings.filter((w) => w.includes('已忽略')).length, 4);
  }
});
test('invalid field reports YAML path and line without echoing value', () => {
  assert.throws(
    () => importClash('mode: rule\nsecret-token: never-echo-this\n'),
    (e: any) =>
      e.path === 'secret-token' &&
      e.line === 2 &&
      !e.message.includes('never-echo'),
  );
});
test('file BOM, inline mappings and single-document constraints', () => {
  assert.equal(importClash('\ufeff' + example).config.nodes.length, 3);
  assert.throws(() => importClash('---\nrules: ["MATCH,DIRECT"]\n---\na: b'));
  assert.throws(() => importClash('a: '.repeat(100) + '1'));
});
test('DNS endpoint parsing and explicit limits', () => {
  assert.deepEqual(parseUpstream('tcp://dns.example.com:8080'), {
    transport: 'tcp',
    host: 'dns.example.com',
    port: 8080,
  });
  assert.equal(parseUpstream('tls://[::1]:8853').host, '::1');
  assert.throws(() => parseUpstream('https://example.com'));
  const c = initialConfig();
  c.dns.bootstrap[0].host = 'dns.example.com';
  assert.throws(() => validateConfig(c));
});
test('proxy-server-nameserver imports separately and remains optional for existing configs', () => {
  const c = importClash(`dns:
  enable: true
  nameserver: [1.1.1.1]
  proxy-server-nameserver: [223.5.5.5, 'tls://dns.example.com:8853']`).config;
  assert.equal(c.dns.proxyServerNameservers.length, 2);
  assert.equal(c.dns.proxyServerNameservers[1].port, 8853);
  assert.equal(c.dns.nameservers[0].host, '1.1.1.1');
  const old: any = structuredClone(c);
  delete old.dns.proxyServerNameservers;
  assert.deepEqual(validateConfig(old).dns.proxyServerNameservers, []);
  assert.throws(() => importClash('dns: {proxy-server-nameserver: invalid}'));
});
test('URL boundary rejects private, mapped, link-local and credential URLs', async () => {
  for (const ip of [
    '127.0.0.1',
    '10.0.0.1',
    '169.254.169.254',
    '::1',
    '::ffff:127.0.0.1',
    'fc00::1',
    '192.168.1.1',
    '0.0.0.0',
  ])
    assert.equal(publicAddress(ip), false);
  assert.equal(publicAddress('1.1.1.1'), true);
  for (const url of [
    'file:///etc/passwd',
    'https://user:pass@example.com',
    'http://127.0.0.1/config',
    'http://[::ffff:127.0.0.1]/',
  ])
    await assert.rejects(downloadConfig(url));
});

test('HiHop owns all inbound settings; imported node and DNS endpoint ports remain intact', () => {
  const result = importClash(`port: invalid
socks-port: 999999
mixed-port: null
redir-port: 1234
tproxy-port: 5678
allow-lan: true
bind-address: '*'
authentication: [a:b, c:d]
`);
  assert.deepEqual(result.config.socks, initialConfig().socks);
});
