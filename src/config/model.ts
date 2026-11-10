import { z } from 'zod';
import { isIP } from 'node:net';
import { randomUUID } from 'node:crypto';
import { domainToASCII } from 'node:url';
import ipaddr from 'ipaddr.js';
import { AppError, invariant } from '../errors.js';

const port = z.number().int().min(1).max(65535);
const text = z
  .string()
  .min(1)
  .max(255)
  .refine((s) => !/[\x00-\x20\x7f]/.test(s));
export const targetSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('direct') }),
  z.strictObject({ kind: z.literal('reject') }),
  z.strictObject({ kind: z.literal('node'), id: z.string().uuid() }),
]);
const base = {
  id: z.string().uuid(),
  name: z.string().min(1).max(255),
  server: text,
  port,
  udp: z.boolean().default(false),
};
export const nodeSchema = z.discriminatedUnion('type', [
  z.strictObject({
    ...base,
    type: z.literal('ss'),
    cipher: z.enum(['aes-128-gcm', 'aes-256-gcm', 'chacha20-ietf-poly1305']),
    password: z.string().min(1).max(4096),
  }),
  z.strictObject({
    ...base,
    type: z.literal('vmess'),
    uuid: z.string().uuid(),
    alterId: z.number().int().min(0).max(64),
    cipher: z.enum(['auto', 'aes-128-gcm']),
    tls: z.boolean(),
    servername: text.optional(),
    network: z.enum(['tcp', 'ws']),
    ws: z.strictObject({
      path: z.string().max(2048).startsWith('/'),
      host: text.optional(),
    }),
  }),
]);
// Retain legacy rule shapes for migration; active profiles emit only MATCH.
export const ruleSchema = z.strictObject({
  type: z.enum([
    'DOMAIN',
    'DOMAIN-SUFFIX',
    'DOMAIN-KEYWORD',
    'DST-PORT',
    'IP-CIDR',
    'IP-CIDR6',
    'GEOIP',
    'MATCH',
  ]),
  value: z.string().max(255),
  noResolve: z.boolean().default(false),
  target: targetSchema,
});
export const upstreamSchema = z.strictObject({
  transport: z.enum(['udp', 'tcp', 'tls']),
  host: text,
  port,
});
export const dnsSchema = z.strictObject({
  enable: z.boolean(),
  useHosts: z.boolean(),
  bootstrap: z.array(upstreamSchema).min(1).max(16),
  nameservers: z.array(upstreamSchema).min(1).max(16),
  proxyServerNameservers: z.array(upstreamSchema).max(16).default([]),
  policy: z.record(z.string(), z.array(upstreamSchema).min(1).max(16)),
});
export const socksSchema = z.strictObject({
  host: z.string().refine((s) => isIP(s) !== 0),
  port,
  auth: z
    .strictObject({
      username: z
        .string()
        .min(1)
        .refine((s) => Buffer.byteLength(s) <= 255),
      password: z
        .string()
        .min(1)
        .refine((s) => Buffer.byteLength(s) <= 255),
    })
    .optional(),
});
export const configSchema = z.strictObject({
  schemaVersion: z.literal(1),
  revision: z.number().int().nonnegative(),
  socks: socksSchema,
  logLevel: z.enum(['silent', 'error', 'warning', 'info', 'debug']),
  nodes: z.array(nodeSchema).max(2000),
  rules: z.array(ruleSchema).min(1).max(20000),
  hosts: z.record(
    z.string(),
    z.string().refine((s) => isIP(s) !== 0),
  ),
  dns: dnsSchema,
});
export type Config = z.infer<typeof configSchema>;
export type ProxyNode = z.infer<typeof nodeSchema>;
export type Target = z.infer<typeof targetSchema>;
export type Rule = z.infer<typeof ruleSchema>;
export type Upstream = z.infer<typeof upstreamSchema>;
export type Destination = { host: string; port: number };
export const direct: Target = { kind: 'direct' };
export function normalizeDomain(input: string): string {
  const result = domainToASCII(input.replace(/\.$/, '').toLowerCase());
  invariant(
    result &&
      result.length <= 253 &&
      result.split('.').every((s) => /^[a-z0-9_-]{1,63}$/.test(s)),
    '无效域名',
  );
  return result;
}
export function loopback(host: string): boolean {
  try {
    return ipaddr.process(host).range() === 'loopback';
  } catch {
    return false;
  }
}
export function validateConfig(input: unknown): Config {
  const parsed = configSchema.safeParse(input);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new AppError(
      'INVALID_CONFIG',
      '字段类型或取值无效',
      400,
      issue.path.join('.'),
    );
  }
  const c = parsed.data;
  invariant(
    loopback(c.socks.host) || c.socks.auth,
    '非回环 SOCKS5 必须启用认证',
    'socks.auth',
  );
  const names = new Set<string>(),
    ids = new Set<string>();
  for (const [i, node] of c.nodes.entries()) {
    invariant(
      !names.has(node.name) &&
        !['DIRECT', 'REJECT'].includes(node.name) &&
        !ids.has(node.id),
      '节点名称或 ID 重复/保留名',
      `nodes.${i}`,
    );
    if (!isIP(node.server)) normalizeDomain(node.server);
    names.add(node.name);
    ids.add(node.id);
  }
  invariant(
    c.rules.at(-1)?.type === 'MATCH',
    '最后一条规则必须是 MATCH',
    'rules',
  );
  for (const [i, rule] of c.rules.entries()) {
    const path = `rules.${i}`;
    invariant(
      rule.target.kind !== 'node' || ids.has(rule.target.id),
      '规则引用不存在的节点',
      path,
    );
    invariant(
      !rule.noResolve || ['IP-CIDR', 'IP-CIDR6', 'GEOIP'].includes(rule.type),
      'no-resolve 仅适用于 IP/GEOIP',
      path,
    );
    if (rule.type === 'MATCH')
      invariant(
        rule.value === '' && i === c.rules.length - 1,
        'MATCH 只能位于末尾且没有匹配值',
        path,
      );
    else if (['DOMAIN', 'DOMAIN-SUFFIX'].includes(rule.type))
      rule.value = normalizeDomain(rule.value);
    else if (rule.type === 'DOMAIN-KEYWORD') {
      invariant(rule.value.length > 0, '关键词不能为空', path);
      rule.value = rule.value.toLowerCase();
    } else if (rule.type === 'DST-PORT')
      invariant(
        /^\d+$/.test(rule.value) &&
          Number(rule.value) >= 1 &&
          Number(rule.value) <= 65535,
        '端口无效',
        path,
      );
    else if (rule.type === 'GEOIP')
      invariant(
        /^[A-Z]{2}$/.test(rule.value),
        '国家代码必须为两个大写字母',
        path,
      );
    else {
      try {
        const [ip, bits] = ipaddr.parseCIDR(rule.value);
        invariant(
          ip.kind() === (rule.type === 'IP-CIDR' ? 'ipv4' : 'ipv6'),
          'CIDR 地址族不匹配',
          path,
        );
        const bytes = ip.toByteArray();
        invariant(
          bytes.every((v, j) => j * 8 < bits || v === 0) &&
            (bits % 8 === 0 ||
              (bytes[Math.floor(bits / 8)] & ((1 << (8 - (bits % 8))) - 1)) ===
                0),
          'CIDR 必须使用网络地址',
          path,
        );
      } catch {
        throw new AppError(
          'INVALID_CONFIG',
          '无效或未规范化的 CIDR',
          400,
          path,
        );
      }
    }
  }
  const hosts = Object.entries(c.hosts).map(([k, v]) => [
    normalizeDomain(k),
    v,
  ]);
  invariant(
    new Set(hosts.map(([k]) => k)).size === hosts.length,
    '规范化后 hosts 域名重复',
    'hosts',
  );
  c.hosts = Object.fromEntries(hosts);
  for (const endpoint of c.dns.bootstrap)
    invariant(isIP(endpoint.host), '引导 DNS 必须使用 IP', 'dns.bootstrap');
  for (const endpoint of [
    ...c.dns.nameservers,
    ...c.dns.proxyServerNameservers,
    ...Object.values(c.dns.policy).flat(),
  ])
    if (!isIP(endpoint.host)) normalizeDomain(endpoint.host);
  const policies = Object.entries(c.dns.policy).map(
    ([key, value]) =>
      [
        key.startsWith('+.')
          ? `+.${normalizeDomain(key.slice(2))}`
          : normalizeDomain(key),
        value,
      ] as const,
  );
  invariant(
    new Set(policies.map(([k]) => k)).size === policies.length,
    '规范化后 DNS 策略重复',
    'dns.policy',
  );
  c.dns.policy = Object.fromEntries(policies);
  return c;
}
export function initialConfig(): Config {
  return {
    schemaVersion: 1,
    revision: 0,
    socks: { host: '127.0.0.1', port: 1080 },
    logLevel: 'info',
    nodes: [],
    rules: [{ type: 'MATCH', value: '', noResolve: false, target: direct }],
    hosts: {},
    dns: {
      enable: false,
      useHosts: true,
      bootstrap: [{ transport: 'udp', host: '1.1.1.1', port: 53 }],
      nameservers: [{ transport: 'udp', host: '1.1.1.1', port: 53 }],
      proxyServerNameservers: [],
      policy: {},
    },
  };
}
export function redact(c: Config) {
  return {
    ...c,
    socks: {
      ...c.socks,
      auth: c.socks.auth
        ? { username: c.socks.auth.username, hasPassword: true }
        : undefined,
    },
    nodes: c.nodes.map((n) => {
      if (n.type === 'ss') {
        const { password: _, ...rest } = n;
        return { ...rest, hasPassword: true };
      }
      const { uuid: _, ...rest } = n;
      return {
        ...rest,
        hasUuid: true,
        effectiveCipher: 'aes-128-gcm',
        authentication: n.alterId ? 'legacy' : 'AEAD',
      };
    }),
  };
}

export const selectionSchema = z.strictObject({
  mode: z.enum(['manual', 'auto']),
  target: targetSchema,
});
export type Selection = z.infer<typeof selectionSchema>;
export const subscriptionSchema = z.strictObject({
  url: z
    .string()
    .max(8192)
    .url()
    .refine((value) => {
      try {
        const url = new URL(value);
        return (
          ['http:', 'https:'].includes(url.protocol) &&
          !url.username &&
          !url.password &&
          !url.hash
        );
      } catch {
        return false;
      }
    }),
  intervalHours: z.number().min(0.25).max(8760).default(4),
  lastUpdatedAt: z.number().int().nonnegative(),
});
export type Subscription = z.infer<typeof subscriptionSchema>;
export type Profile = Pick<Config, 'nodes' | 'dns' | 'hosts'> & {
  id: string;
  name: string;
  selection: Selection;
  subscription?: Subscription;
};
export type Settings = {
  schemaVersion: 3;
  revision: number;
  socks: Config['socks'];
  logLevel: Config['logLevel'];
  activeProfileId: string;
  profiles: Profile[];
};
export function profileFrom(
  config: Config,
  name: string,
  id: string = randomUUID(),
  mode: Selection['mode'] = 'manual',
  subscription?: Subscription,
): Profile {
  const { nodes, dns, hosts } = config;
  const target = config.rules.at(-1)?.target ?? direct;
  return {
    id,
    name,
    nodes,
    dns,
    hosts,
    selection: { mode, target },
    ...(subscription ? { subscription } : {}),
  };
}
export function runtimeConfig(
  settings: Settings,
  profileId = settings.activeProfileId,
): Config {
  const profile = settings.profiles.find((p) => p.id === profileId);
  invariant(profile, '配置不存在', 'activeProfileId');
  return {
    schemaVersion: 1,
    revision: settings.revision,
    socks: settings.socks,
    logLevel: settings.logLevel,
    nodes: profile.nodes,
    // The transport engine consumes one unconditional target; user routing rules are removed.
    rules: [
      {
        type: 'MATCH',
        value: '',
        noResolve: false,
        target: profile.selection.target,
      },
    ],
    dns: profile.dns,
    hosts: profile.hosts,
  };
}
export function migrateConfig(
  config: Config,
  mode: Selection['mode'] = 'manual',
): Settings {
  const profile = profileFrom(config, '默认配置', undefined, mode);
  return {
    schemaVersion: 3,
    revision: config.revision,
    socks: config.socks,
    logLevel: config.logLevel,
    activeProfileId: profile.id,
    profiles: [profile],
  };
}
const settingsSchema = z.strictObject({
  schemaVersion: z.literal(3),
  revision: configSchema.shape.revision,
  socks: socksSchema,
  logLevel: configSchema.shape.logLevel,
  activeProfileId: z.string().uuid(),
  profiles: z
    .array(
      z.strictObject({
        id: z.string().uuid(),
        name: z.string().trim().min(1).max(255),
        nodes: configSchema.shape.nodes,
        selection: selectionSchema,
        subscription: subscriptionSchema.optional(),
        dns: dnsSchema,
        hosts: configSchema.shape.hosts,
      }),
    )
    .min(1)
    .max(100),
});
export function validateSettings(input: unknown): Settings {
  // Migrate the previous profile collection, keeping only its final outlet.
  if (
    input &&
    typeof input === 'object' &&
    'schemaVersion' in input &&
    input.schemaVersion === 2
  ) {
    const old = input as Omit<Settings, 'profiles'> & {
      profiles: (Profile & { rules?: Rule[] })[];
    };
    input = {
      ...old,
      schemaVersion: 3,
      profiles: old.profiles.map(({ rules, ...p }) => ({
        ...p,
        selection: { mode: 'manual', target: rules?.at(-1)?.target ?? direct },
      })),
    };
  }
  const parsed = settingsSchema.safeParse(input);
  invariant(parsed.success, '多配置数据无效');
  const settings = parsed.data;
  invariant(
    new Set(settings.profiles.map((p) => p.id)).size ===
      settings.profiles.length,
    '配置 ID 重复',
  );
  runtimeConfig(settings);
  settings.profiles = settings.profiles.map((p) =>
    profileFrom(
      validateConfig(runtimeConfig(settings, p.id)),
      p.name,
      p.id,
      p.selection.mode,
      p.subscription,
    ),
  );
  return settings;
}
