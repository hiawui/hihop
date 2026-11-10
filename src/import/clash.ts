import { randomUUID } from 'node:crypto';
import { isIP } from 'node:net';
import {
  LineCounter,
  parseDocument,
  isCollection,
  isPair,
  isAlias,
  type Node as YamlNode,
} from 'yaml';
import { AppError, invariant } from '../errors.js';
import {
  initialConfig,
  validateConfig,
  type Config,
  type Upstream,
} from '../config/model.js';

export const MAX_BYTES = 2 * 1024 * 1024;
type Dict = Record<string, any>;
export type ImportResult = { config: Config; warnings: string[] };
const object = (v: unknown, path: string): Dict => {
  invariant(
    v && typeof v === 'object' && !Array.isArray(v),
    '需要映射对象',
    path,
  );
  return v as Dict;
};
function keys(v: Dict, allowed: string[], path: string) {
  for (const k of Object.keys(v))
    invariant(
      allowed.includes(k),
      '不支持的配置字段',
      path ? `${path}.${k}` : k,
    );
}
function list(v: unknown, path: string): any[] {
  invariant(Array.isArray(v), '需要列表', path);
  return v;
}
export function parseUpstream(value: unknown): Upstream {
  invariant(typeof value === 'string', 'DNS 上游必须为字符串');
  if (isIP(value)) return { transport: 'udp', host: value, port: 53 };
  let u: URL;
  try {
    u = new URL(value);
  } catch {
    throw new AppError('INVALID_CONFIG', '无效 DNS 上游');
  }
  invariant(
    ['tcp:', 'tls:'].includes(u.protocol) &&
      !u.username &&
      !u.password &&
      !u.search &&
      !u.hash &&
      (!u.pathname || u.pathname === '/'),
    '不支持的 DNS 上游',
  );
  return {
    transport: u.protocol === 'tls:' ? 'tls' : 'tcp',
    host: u.hostname.replace(/^\[|\]$/g, ''),
    port: Number(u.port || (u.protocol === 'tls:' ? 853 : 53)),
  };
}
export function importClash(content: string): ImportResult {
  invariant(Buffer.byteLength(content) <= MAX_BYTES, '文件超过 2 MiB');
  const lc = new LineCounter();
  const doc = parseDocument(content.replace(/^\uFEFF/, ''), {
    lineCounter: lc,
    uniqueKeys: true,
    customTags: [],
    strict: true,
  });
  if (doc.errors.length || doc.warnings.length)
    throw new AppError(
      'INVALID_YAML',
      'YAML 无效、存在重复 key 或不支持的 tag',
      400,
      undefined,
      doc.errors[0]?.linePos?.[0].line,
    );
  let count = 0;
  const walk = (n: unknown, depth: number) => {
    invariant(depth <= 32 && ++count <= 200000, 'YAML 结构超出限制');
    if (isAlias(n))
      throw new AppError('INVALID_YAML', '首版不接受 YAML alias，请展开后导入');
    if (isCollection(n)) n.items.forEach((x) => walk(x, depth + 1));
    if (isPair(n)) {
      walk(n.key, depth + 1);
      walk(n.value, depth + 1);
    }
  };
  walk(doc.contents, 0);
  try {
    const raw = object(doc.toJS({ maxAliasCount: 0 }), '');
    keys(
      raw,
      [
        'port',
        'mixed-port',
        'socks-port',
        'redir-port',
        'tproxy-port',
        'allow-lan',
        'bind-address',
        'authentication',
        'mode',
        'log-level',
        'external-controller',
        'unified-delay',
        'hosts',
        'dns',
        'proxies',
        'proxy-groups',
        'rules',
        'rule-providers',
      ],
      '',
    );
    const c = initialConfig();
    const warnings: string[] = [];
    // Inbound settings belong to HiHop, never to an imported profile.
    for (const field of [
      'port',
      'mixed-port',
      'socks-port',
      'redir-port',
      'tproxy-port',
      'allow-lan',
      'bind-address',
      'authentication',
      'log-level',
      'external-controller',
      'unified-delay',
    ])
      if (raw[field] !== undefined)
        warnings.push(`${field} 已忽略，监听、认证和日志由 HiHop 独立配置`);
    c.hosts = raw.hosts ?? {};
    if (raw.dns !== undefined) {
      const d = object(raw.dns, 'dns');
      keys(
        d,
        [
          'enable',
          'use-hosts',
          'default-nameserver',
          'nameserver',
          'proxy-server-nameserver',
          'nameserver-policy',
        ],
        'dns',
      );
      c.dns = {
        enable: d.enable ?? false,
        useHosts: d['use-hosts'] ?? true,
        bootstrap: d['default-nameserver']
          ? list(d['default-nameserver'], 'dns.default-nameserver').map(
              parseUpstream,
            )
          : c.dns.bootstrap,
        nameservers: d.nameserver
          ? list(d.nameserver, 'dns.nameserver').map(parseUpstream)
          : c.dns.nameservers,
        proxyServerNameservers: d['proxy-server-nameserver']
          ? list(
              d['proxy-server-nameserver'],
              'dns.proxy-server-nameserver',
            ).map(parseUpstream)
          : [],
        policy: Object.fromEntries(
          Object.entries(
            object(d['nameserver-policy'] ?? {}, 'dns.nameserver-policy'),
          ).map(([k, v]) => [
            k,
            (Array.isArray(v) ? v : [v]).map(parseUpstream),
          ]),
        ),
      };
      if (!c.dns.enable)
        warnings.push(
          'dns.enable=false：自定义 DNS 上游不使用，解析走系统解析器',
        );
    }
    const names = new Set(['DIRECT', 'REJECT']);
    const proxies = list(raw.proxies ?? [], 'proxies');
    invariant(proxies.length <= 2000, '节点超过 2,000 个', 'proxies');
    c.nodes = proxies.map((value, i) => {
      const p = object(value, `proxies.${i}`);
      keys(
        p,
        [
          'name',
          'server',
          'port',
          'type',
          'cipher',
          'udp',
          ...(p.type === 'vmess'
            ? [
                'uuid',
                'alterId',
                'tls',
                'skip-cert-verify',
                'servername',
                'network',
                'ws-opts',
              ]
            : ['password']),
        ],
        `proxies.${i}`,
      );
      invariant(
        p.type === 'ss' || p.type === 'vmess',
        '不支持的节点协议',
        `proxies.${i}.type`,
      );
      invariant(
        typeof p.name === 'string' && !names.has(p.name),
        '重复或保留节点名',
        `proxies.${i}.name`,
      );
      const id = randomUUID();
      names.add(p.name);
      const base = {
        id,
        name: p.name,
        server: p.server,
        port: p.port,
        udp: p.udp ?? false,
      };
      if (p.udp)
        warnings.push(`节点 ${i + 1} 声明 UDP；当前只提供 TCP 代理入口`);
      if (p.type === 'ss')
        return { ...base, type: 'ss', cipher: p.cipher, password: p.password };
      invariant(
        p['skip-cert-verify'] === undefined || p['skip-cert-verify'] === false,
        '不接受跳过 TLS 证书验证',
        `proxies.${i}.skip-cert-verify`,
      );
      const ws = object(p['ws-opts'] ?? {}, `proxies.${i}.ws-opts`);
      keys(ws, ['path', 'headers'], `proxies.${i}.ws-opts`);
      const headers = object(ws.headers ?? {}, `proxies.${i}.ws-opts.headers`);
      keys(headers, ['Host'], `proxies.${i}.ws-opts.headers`);
      warnings.push(
        `节点 ${i + 1}：VMess ${p.alterId ? 'legacy' : 'AEAD'}，auto 实际使用 AES-128-GCM`,
      );
      return {
        ...base,
        type: 'vmess',
        uuid: p.uuid,
        alterId: p.alterId ?? 0,
        cipher: p.cipher ?? 'auto',
        tls: p.tls ?? false,
        servername: p.servername,
        network: p.network ?? 'tcp',
        ws: { path: ws.path ?? '/', host: headers.Host },
      };
    }) as Config['nodes'];
    for (const field of ['mode', 'rules', 'proxy-groups', 'rule-providers'])
      if (raw[field] !== undefined)
        warnings.push(`${field} 已忽略，全部连接使用 HiHop 选择的出口`);
    if (c.nodes[0]) c.rules[0].target = { kind: 'node', id: c.nodes[0].id };
    return { config: validateConfig(c), warnings };
  } catch (error) {
    if (error instanceof AppError && error.path) {
      const path = error.path
        .split('.')
        .map((p) => (/^\d+$/.test(p) ? Number(p) : p));
      const n = doc.getIn(path, true) as YamlNode | undefined;
      if (n?.range) error.line = lc.linePos(n.range[0]).line;
    }
    throw error;
  }
}
