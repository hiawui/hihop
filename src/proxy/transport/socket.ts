import net from 'node:net';
import tls from 'node:tls';
import { type Duplex } from 'node:stream';
import WebSocket, { createWebSocketStream } from 'ws';
import { AppError } from '../../errors.js';
import { guardStream } from '../codec/bytes.js';
import type { ProxyNode } from '../../config/model.js';

export async function socketConnect(
  host: string,
  port: number,
  signal?: AbortSignal,
  servername?: string,
  useTls = false,
): Promise<net.Socket> {
  signal?.throwIfAborted();
  const socket = guardStream(
    useTls
      ? tls.connect({
          host,
          port,
          servername:
            servername && !net.isIP(servername) ? servername : undefined,
          checkServerIdentity: (_name: string, cert: tls.PeerCertificate) =>
            tls.checkServerIdentity(servername ?? host, cert),
          rejectUnauthorized: true,
          allowHalfOpen: true,
        } as tls.ConnectionOptions)
      : net.connect({ host, port, allowHalfOpen: true }),
    signal,
  );
  socket.setNoDelay(true);
  socket.setTimeout(120000, () =>
    socket.destroy(new AppError('ETIMEDOUT', '连接空闲超时')),
  );
  await new Promise<void>((resolve, reject) => {
    const event = useTls ? 'secureConnect' : 'connect';
    const finish = (error?: Error) => {
      clearTimeout(timer);
      socket.off(event, ready);
      socket.off('error', failed);
      error ? reject(error) : resolve();
    };
    const ready = () => finish();
    const failed = (e: Error) => finish(e);
    const timer = setTimeout(
      () => socket.destroy(new AppError('ETIMEDOUT', '连接超时')),
      10000,
    );
    timer.unref();
    socket.once(event, ready).once('error', failed);
  });
  return socket;
}
export async function nodeTransport(
  node: ProxyNode,
  ip: string,
  signal: AbortSignal,
): Promise<Duplex> {
  if (node.type === 'ss' || node.network === 'tcp')
    return socketConnect(
      ip,
      node.port,
      signal,
      node.type === 'vmess' ? (node.servername ?? node.server) : undefined,
      node.type === 'vmess' && node.tls,
    );
  const host = net.isIP(node.server) === 6 ? `[${node.server}]` : node.server;
  const ws = new WebSocket(
    `${node.tls ? 'wss' : 'ws'}://${host}:${node.port}${node.ws.path}`,
    {
      headers: node.ws.host ? { Host: node.ws.host } : undefined,
      perMessageDeflate: false,
      followRedirects: false,
      maxPayload: 1024 * 1024,
      handshakeTimeout: 10000,
      rejectUnauthorized: true,
      family: net.isIP(ip),
      servername:
        node.servername ?? (net.isIP(node.server) ? undefined : node.server),
      checkServerIdentity: (_name: string, cert: tls.PeerCertificate) =>
        tls.checkServerIdentity(node.servername ?? node.server, cert),
      lookup: (
        _hostname: string,
        _options: unknown,
        callback: (error: null, address: string, family: number) => void,
      ) => callback(null, ip, net.isIP(ip)),
    } as unknown as WebSocket.ClientOptions,
  );
  ws.on('error', () => {});
  let stream: Duplex;
  ws.on('message', (_data, binary) => {
    if (!binary)
      stream.destroy(
        new AppError('PROTOCOL_ERROR', '不接受 WebSocket 文本消息'),
      );
  });
  // Attach before awaiting open: peers can send data in the same turn as upgrade.
  stream = guardStream(
    createWebSocketStream(ws, { allowHalfOpen: true }),
    signal,
  );
  stream.once('close', () => ws.terminate());
  const abort = () => ws.terminate();
  signal.addEventListener('abort', abort, { once: true });
  ws.once('close', () => signal.removeEventListener('abort', abort));
  try {
    await new Promise<void>((resolve, reject) => {
      const cleanup = () => {
        ws.off('open', opened);
        ws.off('error', failed);
        ws.off('close', closed);
      };
      const opened = () => {
        cleanup();
        resolve();
      };
      const failed = () => {
        cleanup();
        reject(new AppError('TRANSPORT_FAILED', 'WebSocket/TLS 连接失败'));
      };
      const closed = () => failed();
      ws.once('open', opened).once('error', failed).once('close', closed);
    });
    signal.throwIfAborted();
    if (stream.destroyed)
      throw (
        stream.errored ?? new AppError('TRANSPORT_FAILED', 'WebSocket 已关闭')
      );
    return stream;
  } catch (error) {
    stream.destroy();
    ws.terminate();
    throw error;
  }
}
