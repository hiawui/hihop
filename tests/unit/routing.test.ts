import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  initialConfig,
  validateConfig,
  type Rule,
} from '../../src/config/model.js';
import { Router } from '../../src/routing/router.js';

const rule = (type: Rule['type'], value: string, noResolve = false): Rule => ({
  type,
  value,
  noResolve,
  target: { kind: 'reject' },
});
const cases: [Rule, string, number][] = [
  [rule('DOMAIN', 'example.com'), 'EXAMPLE.com.', 443],
  [rule('DOMAIN-SUFFIX', 'example.com'), 'a.example.com', 443],
  [rule('DOMAIN-KEYWORD', 'ample'), 'example.com', 443],
  [rule('DST-PORT', '25'), 'example.com', 25],
  [rule('IP-CIDR', '192.0.2.0/24'), '192.0.2.10', 443],
  [rule('IP-CIDR6', '2001:db8::/32'), '2001:db8::1234', 443],
];
for (const [r, host, port] of cases)
  test(`${r.type} routes to REJECT`, async () => {
    const c = initialConfig();
    c.rules.unshift(r);
    const router = await Router.compile(validateConfig(c));
    try {
      assert.equal((await router.route({ host, port })).target.kind, 'reject');
    } finally {
      router.close();
    }
  });
test('suffix boundary, hosts and no-resolve semantics', async () => {
  const c = initialConfig();
  c.hosts['example.com'] = '192.0.2.23';
  c.rules = [
    rule('DOMAIN-SUFFIX', 'example.com'),
    rule('IP-CIDR', '192.0.2.0/24', true),
    { ...rule('MATCH', ''), target: { kind: 'reject' } },
  ];
  const router = await Router.compile(validateConfig(c));
  try {
    const r = await router.route({ host: 'example.com', port: 80 });
    assert.equal(r.rule, 0);
    assert.equal(r.destination.host, '192.0.2.23');
    assert.equal(
      (await router.route({ host: 'notexample.com', port: 80 })).rule,
      2,
    );
    assert.equal((await router.route({ host: '192.0.2.4', port: 80 })).rule, 1);
  } finally {
    router.close();
  }
});
test('a domain rule keeps the original domain for a proxy and skips local DNS', async () => {
  const c = initialConfig();
  c.rules = [rule('DOMAIN', 'example.invalid'), rule('MATCH', '')];
  const router = await Router.compile(validateConfig(c));
  let calls = 0;
  router.resolver.resolve = async () => {
    calls++;
    throw new Error('no DNS');
  };
  const route = await router.route({ host: 'example.invalid', port: 80 });
  assert.equal(route.destination.host, 'example.invalid');
  assert.equal(calls, 0);
  router.close();
});
test('IP routing fixes the resolved address; DNS failure never falls through', async () => {
  const c = initialConfig();
  c.rules.unshift(rule('IP-CIDR', '192.0.2.0/24'));
  const router = await Router.compile(validateConfig(c));
  router.resolver.resolve = async () => '192.0.2.10';
  assert.equal(
    (await router.route({ host: 'example.test', port: 80 })).destination.host,
    '192.0.2.10',
  );
  router.resolver.resolve = async () => {
    throw new Error('DNS unavailable');
  };
  await assert.rejects(router.route({ host: 'example.test', port: 80 }));
  router.close();
});
test('runtime compilation rejects legacy GEOIP rules without opening a database', async () => {
  const c = initialConfig();
  c.rules.unshift(rule('GEOIP', 'CN'));
  await assert.rejects(Router.compile(validateConfig(c)), {
    code: 'UNSUPPORTED_RULE',
    message: '不支持 GEOIP 路由规则',
  });
});
