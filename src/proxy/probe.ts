import tls from 'node:tls';
import { once } from 'node:events';
import type { Duplex } from 'node:stream';
import type { Config, ProxyNode } from '../config/model.js';
import { Resolver } from '../dns/resolver.js';
import { AppError, safeError } from '../errors.js';
import { ByteReader, guardStream, write } from './codec/bytes.js';
import { nodeTransport } from './transport/socket.js';
import { ssOutbound } from './outbound/ss.js';
import { vmessOutbound } from './outbound/vmess/protocol.js';

export type ProbeResult = {
  id: string;
  latency: number | null;
  error?: string;
  samples?: (number | null)[];
  sampleTimeoutMs?: number;
};
export const PROBE_HOST = 'www.gstatic.com';
export const AUTO_PROBE_SAMPLES = 5;
export const AUTO_PROBE_INTERVAL = 60 * 60 * 1000;
export const PROBE_TIMEOUT_MS = 4000;

// Include DNS, transport, proxy authentication and the HTTPS response in the delay.
export async function measureNode(
  node: ProxyNode,
  resolver: Resolver,
  signal: AbortSignal,
): Promise<number> {
  const started = performance.now();
  let wire: Duplex | undefined;
  let outbound: Duplex | undefined;
  let secure: tls.TLSSocket | undefined;
  try {
    const ip = await resolver.resolveProxyServer(node.server, signal);
    wire = await nodeTransport(node, ip, signal);
    const target = { host: PROBE_HOST, port: 443 };
    outbound =
      node.type === 'ss'
        ? await ssOutbound(wire, node, target, signal)
        : await vmessOutbound(wire, node, target, signal);
    secure = guardStream(
      tls.connect({
        socket: outbound,
        servername: PROBE_HOST,
        rejectUnauthorized: true,
      }),
      signal,
    );
    await once(secure, 'secureConnect', { signal });
    await write(
      secure,
      Buffer.from(
        `GET /generate_204 HTTP/1.1\r\nHost: ${PROBE_HOST}\r\nConnection: close\r\n\r\n`,
      ),
    );
    const reader = new ByteReader(secure, signal, PROBE_TIMEOUT_MS);
    let status = '';
    while (!status.endsWith('\r\n') && status.length < 1024)
      status += (await reader.exact(1)).toString('latin1');
    if (!/^HTTP\/1\.[01] 20[04](?: |\r)/.test(status))
      throw new AppError('PROBE_FAILED', '探测请求未返回成功状态');
    return Math.max(1, Math.round(performance.now() - started));
  } finally {
    secure?.destroy();
    outbound?.destroy();
    wire?.destroy();
  }
}

export async function probeNodes(
  config: Config,
  signal?: AbortSignal,
  measure = measureNode,
  sampleCount: 1 | 5 = 1,
): Promise<ProbeResult[]> {
  const rounds: ProbeResult[][] = [];
  for (let i = 0; i < sampleCount; i++) {
    signal?.throwIfAborted();
    rounds.push(await probeRound(config, signal, measure));
  }
  if (sampleCount === 1) return rounds[0];
  return config.nodes.map((node, i) => {
    const samples = rounds.map((round) => round[i].latency);
    const failures = samples.filter((sample) => sample === null).length;
    const error = rounds.find((round) => round[i].latency === null)?.[i].error;
    const sorted = samples
      .map((sample) => sample ?? PROBE_TIMEOUT_MS)
      .toSorted((a, b) => a - b);
    return {
      id: node.id,
      latency: sorted.slice(1, -1).reduce((sum, value) => sum + value, 0) / 3,
      samples,
      sampleTimeoutMs: PROBE_TIMEOUT_MS,
      ...(failures
        ? {
            error: `5 次探测中 ${failures} 次失败，失败样本按测速超时 ${PROBE_TIMEOUT_MS} ms 计算${error ? `（${error}）` : ''}`,
          }
        : {}),
    };
  });
}

async function probeRound(
  config: Config,
  signal: AbortSignal | undefined,
  measure: typeof measureNode,
): Promise<ProbeResult[]> {
  const resolver = new Resolver(config);
  const deadline = AbortSignal.any([
    AbortSignal.timeout(12000),
    ...(signal ? [signal] : []),
  ]);
  const results: ProbeResult[] = new Array(config.nodes.length);
  let next = 0;
  try {
    await Promise.all(
      Array.from({ length: Math.min(16, config.nodes.length) }, async () => {
        for (;;) {
          const i = next++;
          const node = config.nodes[i];
          if (!node) return;
          const cancel = new AbortController();
          const attempt = AbortSignal.any([
            deadline,
            cancel.signal,
            AbortSignal.timeout(PROBE_TIMEOUT_MS),
          ]);
          try {
            attempt.throwIfAborted();
            results[i] = {
              id: node.id,
              latency: await measure(node, resolver, attempt),
            };
          } catch (error) {
            results[i] = {
              id: node.id,
              latency: null,
              error: attempt.aborted
                ? '探测超时或已取消'
                : safeError(error).message,
            };
          } finally {
            cancel.abort();
          }
        }
      }),
    );
    signal?.throwIfAborted();
    return results;
  } finally {
    resolver.close();
  }
}

export function fastestNode(results: ProbeResult[]): string {
  const fastest = results
    .filter((r) => r.latency !== null)
    .sort((a, b) => a.latency! - b.latency!)[0];
  if (!fastest)
    throw new AppError('NO_AVAILABLE_NODE', '所有节点探测失败，已保留原出口');
  return fastest.id;
}
