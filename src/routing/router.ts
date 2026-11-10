import { isIP } from 'node:net';
import ipaddr from 'ipaddr.js';
import { AppError } from '../errors.js';
import {
  normalizeDomain,
  type Config,
  type Destination,
  type Target,
} from '../config/model.js';
import { Resolver } from '../dns/resolver.js';

export class Router {
  private networks: Map<number, ReturnType<typeof ipaddr.parseCIDR>>;
  readonly resolver: Resolver;
  private constructor(readonly config: Config) {
    this.resolver = new Resolver(config);
    this.networks = new Map(
      config.rules.flatMap((r, i) =>
        r.type === 'IP-CIDR' || r.type === 'IP-CIDR6'
          ? [[i, ipaddr.parseCIDR(r.value)] as const]
          : [],
      ),
    );
  }
  static async compile(config: Config) {
    // Legacy config validation accepts GEOIP so migration can discard old rules.
    // It is never a supported runtime rule and requires no database dependency.
    if (config.rules.some((r) => r.type === 'GEOIP'))
      throw new AppError('UNSUPPORTED_RULE', '不支持 GEOIP 路由规则');
    return new Router(config);
  }
  close() {
    this.resolver.close();
  }
  async route(
    destination: Destination,
    signal?: AbortSignal,
  ): Promise<{ target: Target; destination: Destination; rule: number }> {
    const domain = isIP(destination.host)
      ? undefined
      : normalizeDomain(destination.host);
    let ip = isIP(destination.host)
      ? destination.host
      : this.resolver.hostOverride(destination.host);
    for (const [i, r] of this.config.rules.entries()) {
      let hit = false;
      if (r.type === 'MATCH') hit = true;
      else if (r.type === 'DOMAIN') hit = domain === r.value;
      else if (r.type === 'DOMAIN-SUFFIX')
        hit =
          !!domain && (domain === r.value || domain.endsWith(`.${r.value}`));
      else if (r.type === 'DOMAIN-KEYWORD')
        hit = !!domain?.includes(r.value.toLowerCase());
      else if (r.type === 'DST-PORT')
        hit = destination.port === Number(r.value);
      else {
        if (!ip && !r.noResolve)
          ip = await this.resolver.resolve(destination.host, signal);
        if (ip) {
          const [network, bits] = this.networks.get(i)!;
          const addr = ipaddr.parse(ip);
          hit = addr.kind() === network.kind() && addr.match(network, bits);
        }
      }
      if (hit) {
        if (r.target.kind === 'direct' && !ip)
          ip = await this.resolver.resolve(destination.host, signal);
        return {
          target: r.target,
          destination: {
            host: ip ?? domain ?? destination.host,
            port: destination.port,
          },
          rule: i,
        };
      }
    }
    throw new AppError('NO_ROUTE', '没有匹配路由');
  }
}
