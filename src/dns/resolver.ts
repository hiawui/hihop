import dns from 'node:dns/promises';
import dgram from 'node:dgram';
import { randomInt } from 'node:crypto';
import { isIP } from 'node:net';
import packet from 'dns-packet';
import { AppError, invariant, abortable } from '../errors.js';
import {
  normalizeDomain,
  type Config,
  type Upstream,
} from '../config/model.js';
import { ByteReader, u16, write } from '../proxy/codec/bytes.js';
import { socketConnect } from '../proxy/transport/socket.js';

type Answer = {
  addresses: string[];
  ttl: number;
  nxdomain: boolean;
  cname?: string;
};
export class Resolver {
  private cache = new Map<string, { value: Answer; until: number }>();
  private controller = new AbortController();
  private exchanges = 0;
  private exchangeWaiters = new Set<() => void>();
  constructor(private config: Config) {}
  close() {
    this.controller.abort();
    this.cache.clear();
  }
  hostOverride(host: string): string | undefined {
    return this.config.dns.useHosts && !isIP(host)
      ? this.config.hosts[normalizeDomain(host)]
      : undefined;
  }
  async resolveProxyServer(
    host: string,
    signal?: AbortSignal,
  ): Promise<string> {
    return this.resolve(host, signal, true);
  }
  async resolve(
    host: string,
    signal?: AbortSignal,
    proxyServer = false,
  ): Promise<string> {
    if (isIP(host)) return host;
    host = normalizeDomain(host);
    const fixed = this.hostOverride(host);
    if (fixed) return fixed;
    const abort = AbortSignal.any([
      this.controller.signal,
      ...(signal ? [signal] : []),
      AbortSignal.timeout(10000),
    ]);
    if (!this.config.dns.enable) {
      const values = await abortable(dns.lookup(host, { all: true }), abort);
      abort.throwIfAborted();
      const value = values.find((v) => v.family === 4) ?? values[0];
      if (!value) throw new AppError('DNS_FAILED', '系统 DNS 无可用地址');
      return value.address;
    }
    if (proxyServer && this.config.dns.proxyServerNameservers.length)
      return this.resolveWith(
        host,
        this.config.dns.proxyServerNameservers,
        abort,
        false,
      );
    let selected = this.config.dns.nameservers;
    const policy = Object.entries(this.config.dns.policy)
      .filter(([pattern]) =>
        pattern.startsWith('+.')
          ? host === pattern.slice(2) || host.endsWith(`.${pattern.slice(2)}`)
          : host === pattern,
      )
      .sort(
        ([a], [b]) =>
          Number(a.startsWith('+.')) - Number(b.startsWith('+.')) ||
          b.length - a.length,
      );
    if (policy.length) selected = policy[0][1];
    return this.resolveWith(host, selected, abort, false);
  }
  private async resolveWith(
    host: string,
    upstreams: Upstream[],
    signal: AbortSignal,
    bootstrap: boolean,
  ): Promise<string> {
    for (const type of ['A', 'AAAA'] as const) {
      const response = await this.query(
        host,
        type,
        upstreams,
        signal,
        bootstrap,
        new Set(),
      );
      if (response.nxdomain) throw new AppError('DNS_NXDOMAIN', '域名不存在');
      if (response.addresses.length) return response.addresses[0];
    }
    throw new AppError('DNS_NO_ADDRESS', 'DNS 未返回可用地址');
  }
  private async query(
    host: string,
    type: 'A' | 'AAAA',
    upstreams: Upstream[],
    signal: AbortSignal,
    bootstrap: boolean,
    seen: Set<string>,
  ): Promise<Answer> {
    invariant(seen.size < 8 && !seen.has(host), 'DNS CNAME 循环或深度超限');
    seen.add(host);
    const key = JSON.stringify([host, type, upstreams, bootstrap]);
    const cached = this.cache.get(key);
    if (cached && cached.until > Date.now()) return cached.value;
    const cancel = new AbortController();
    const combined = AbortSignal.any([signal, cancel.signal]);
    let answer: Answer;
    try {
      answer = await Promise.any(
        upstreams.map(async (upstream) => {
          const address = isIP(upstream.host)
            ? upstream.host
            : await this.resolveWith(
                normalizeDomain(upstream.host),
                this.config.dns.bootstrap,
                combined,
                true,
              );
          return this.exchange(upstream, address, host, type, combined);
        }),
      );
    } catch {
      signal.throwIfAborted();
      throw new AppError('DNS_FAILED', '所有配置的 DNS 上游均失败');
    } finally {
      cancel.abort();
    }
    if (!answer.addresses.length && answer.cname && !answer.nxdomain) {
      const next = await this.query(
        answer.cname,
        type,
        upstreams,
        signal,
        bootstrap,
        seen,
      );
      answer = { ...next, ttl: Math.min(answer.ttl, next.ttl) };
    }
    if (this.cache.size >= 2048)
      this.cache.delete(this.cache.keys().next().value!);
    this.cache.set(key, {
      value: answer,
      until: Date.now() + Math.min(answer.ttl, 3600) * 1000,
    });
    return answer;
  }
  private async exchange(
    endpoint: Upstream,
    address: string,
    host: string,
    type: 'A' | 'AAAA',
    signal: AbortSignal,
  ): Promise<Answer> {
    await this.acquireExchange(signal);
    try {
      return await this.exchangeMessage(endpoint, address, host, type, signal);
    } finally {
      this.exchanges--;
      this.exchangeWaiters.values().next().value?.();
    }
  }
  private async acquireExchange(signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    if (this.exchanges < 64) {
      this.exchanges++;
      return;
    }
    await new Promise<void>((resolve, reject) => {
      const cleanup = () => {
        this.exchangeWaiters.delete(ready);
        signal.removeEventListener('abort', aborted);
      };
      const ready = () => {
        cleanup();
        this.exchanges++;
        resolve();
      };
      const aborted = () => {
        cleanup();
        reject(new AppError('ABORT_ERR', 'DNS 查询已取消或超时'));
      };
      this.exchangeWaiters.add(ready);
      signal.addEventListener('abort', aborted, { once: true });
    });
  }
  private async exchangeMessage(
    endpoint: Upstream,
    address: string,
    host: string,
    type: 'A' | 'AAAA',
    signal: AbortSignal,
  ): Promise<Answer> {
    const id = randomInt(0, 65536);
    const question = packet.encode({
      type: 'query',
      id,
      flags: packet.RECURSION_DESIRED,
      questions: [{ name: host, type }],
    });
    const timeout = AbortSignal.any([signal, AbortSignal.timeout(3000)]);
    const decode = (data: Buffer) => {
      invariant(data.length <= 65535 && data.length >= 12, 'DNS 消息长度无效');
      // dns-packet bounds-checks compressed pointers and rejects forward/cyclic references.
      const result = packet.decode(data);
      invariant(
        result.id === id &&
          result.type === 'response' &&
          ((result.flags ?? 0) & 0x7800) === 0 &&
          result.questions?.length === 1 &&
          result.questions[0].type === type &&
          (!result.questions[0].class || result.questions[0].class === 'IN') &&
          normalizeDomain(result.questions[0].name) === host,
        'DNS 响应问题或事务不匹配',
      );
      return result;
    };
    let response: packet.DecodedPacket;
    if (endpoint.transport === 'udp') {
      response = await new Promise((resolve, reject) => {
        const socket = dgram.createSocket(
          isIP(address) === 6 ? 'udp6' : 'udp4',
        );
        const finish = (error?: Error, value?: packet.DecodedPacket) => {
          timeout.removeEventListener('abort', abort);
          socket.close();
          error ? reject(error) : resolve(value!);
        };
        let done = false;
        const complete = (e?: Error, v?: packet.DecodedPacket) => {
          if (!done) {
            done = true;
            finish(e, v);
          }
        };
        const abort = () =>
          complete(new AppError('DNS_TIMEOUT', 'DNS 请求超时'));
        socket.on('error', (e) => complete(e));
        socket.on('message', (data) => {
          try {
            complete(undefined, decode(data));
          } catch {
            /* ignore unrelated/invalid datagrams until timeout */
          }
        });
        socket.connect(endpoint.port, address, () => {
          if (!done)
            socket.send(question, (e) => {
              if (e) complete(e);
            });
        });
        timeout.addEventListener('abort', abort, { once: true });
        if (timeout.aborted) abort();
      });
      if (response.flag_tc)
        response = decode(
          await this.tcpQuery(
            { ...endpoint, transport: 'tcp' },
            address,
            question,
            timeout,
          ),
        );
    } else
      response = decode(
        await this.tcpQuery(endpoint, address, question, timeout),
      );
    invariant(!response.flag_tc, 'TCP DNS 响应仍被截断');
    const rcode = (response.flags ?? 0) & 15;
    invariant(rcode === 0 || rcode === 3, 'DNS 上游返回错误');
    const records = response.answers ?? [];
    let current = host;
    let ttl = 3600;
    const localSeen = new Set<string>();
    for (let i = 0; i < 8; i++) {
      invariant(!localSeen.has(current), 'DNS CNAME 循环');
      localSeen.add(current);
      const addresses = records.filter(
        (r) => normalizeDomain(r.name) === current && r.type === type,
      ) as packet.StringAnswer[];
      if (addresses.length)
        return {
          addresses: addresses
            .map((r) => r.data)
            .filter((a) => isIP(a) === (type === 'A' ? 4 : 6)),
          ttl: Math.min(ttl, ...addresses.map((r) => r.ttl ?? 0)),
          nxdomain: false,
        };
      const alias = records.find(
        (r) => normalizeDomain(r.name) === current && r.type === 'CNAME',
      ) as packet.StringAnswer | undefined;
      if (!alias) break;
      ttl = Math.min(ttl, alias.ttl ?? 0);
      current = normalizeDomain(alias.data);
    }
    return {
      addresses: [],
      ttl: rcode === 3 ? 30 : ttl,
      nxdomain: rcode === 3,
      cname: current === host ? undefined : current,
    };
  }
  private async tcpQuery(
    endpoint: Upstream,
    address: string,
    query: Buffer,
    signal: AbortSignal,
  ): Promise<Buffer> {
    const socket = await socketConnect(
      address,
      endpoint.port,
      signal,
      endpoint.host,
      endpoint.transport === 'tls',
    );
    try {
      await write(socket, Buffer.concat([u16(query.length), query]));
      const reader = new ByteReader(socket, signal, 3000);
      return await reader.exact((await reader.exact(2)).readUInt16BE());
    } finally {
      socket.destroy();
    }
  }
}
