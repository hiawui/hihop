import net from 'node:net';
import type { Duplex } from 'node:stream';
import { AppError, safeError } from '../errors.js';
import { log } from '../log.js';
import { Router } from '../routing/router.js';
import {
  socksHandshake,
  socksReply,
  connectStreams,
} from './inbound/socks5.js';
import { guardStream } from './codec/bytes.js';
import { socketConnect, nodeTransport } from './transport/socket.js';
import { ssOutbound } from './outbound/ss.js';
import { vmessOutbound } from './outbound/vmess/protocol.js';

export class ProxyService {
  private server?: net.Server;
  private sessions = new Map<AbortController, Promise<void>>();
  private accepting = false;
  private runtime: { router: Router; connections: number };
  lastError?: ReturnType<typeof safeError>;
  constructor(router: Router) {
    this.runtime = { router, connections: 0 };
  }
  get router() {
    return this.runtime.router;
  }
  replaceRouter(router: Router) {
    const previous = this.runtime;
    this.runtime = { router, connections: 0 };
    this.lastError = undefined;
    if (!previous.connections) previous.router.close();
  }
  get listening() {
    return !!this.server?.listening && this.accepting;
  }
  get connections() {
    return this.sessions.size;
  }
  async bind(): Promise<void> {
    const server = net.createServer({ allowHalfOpen: true }, (socket) => {
      if (!this.accepting || this.sessions.size >= 512) {
        socket.destroy();
        return;
      }
      const cancel = new AbortController();
      const runtime = this.runtime;
      runtime.connections++;
      let closed!: () => void;
      this.sessions.set(
        cancel,
        new Promise<void>((resolve) => {
          closed = resolve;
        }),
      );
      guardStream(socket, cancel.signal);
      socket.setNoDelay(true);
      socket.setTimeout(15000, () => socket.destroy());
      socket.once('close', () => {
        cancel.abort();
        this.sessions.delete(cancel);
        runtime.connections--;
        if (runtime !== this.runtime && !runtime.connections)
          runtime.router.close();
        closed();
      });
      void this.handle(socket, runtime.router, cancel.signal).catch((error) => {
        this.failure(error, runtime.router);
        socket.destroy();
      });
    });
    this.server = server;
    await new Promise<void>((resolve, reject) => {
      const failed = (error: Error) => {
        server.off('listening', ready);
        reject(error);
      };
      const ready = () => {
        server.off('error', failed);
        resolve();
      };
      server.once('error', failed).once('listening', ready);
      server.listen(this.router.config.socks);
    });
    server.on('error', (error) => {
      this.failure(error);
      this.accepting = false;
    });
  }
  activate() {
    this.accepting = true;
  }
  private failure(error: unknown, router = this.router) {
    this.lastError = safeError(error);
    if (!['ABORT_ERR', 'RULE_REJECT'].includes(this.lastError.code))
      log(router.config.logLevel, 'warning', this.lastError);
  }
  async stop(): Promise<void> {
    this.accepting = false;
    const closed = [...this.sessions.values()];
    for (const session of this.sessions.keys()) session.abort();
    if (this.server?.listening)
      await new Promise<void>((resolve) => this.server!.close(() => resolve()));
    await Promise.all(closed);
    this.server = undefined;
  }
  private async handle(
    socket: net.Socket,
    router: Router,
    signal: AbortSignal,
  ): Promise<void> {
    const target = await socksHandshake(socket, router.config, signal);
    let outbound: Duplex | undefined;
    try {
      const route = await router.route(target, signal);
      if (route.target.kind === 'reject')
        throw new AppError('RULE_REJECT', '连接被规则拒绝');
      if (route.target.kind === 'direct')
        outbound = await socketConnect(
          route.destination.host,
          route.destination.port,
          signal,
        );
      else {
        const node = router.config.nodes.find(
          (n) => n.id === (route.target as { id: string }).id,
        )!;
        const ip = await router.resolver.resolveProxyServer(
          node.server,
          signal,
        );
        const wire = await nodeTransport(node, ip, signal);
        try {
          outbound =
            node.type === 'ss'
              ? await ssOutbound(wire, node, route.destination, signal)
              : await vmessOutbound(wire, node, route.destination, signal);
        } catch (error) {
          wire.destroy();
          throw error;
        }
      }
      signal.throwIfAborted();
      await socksReply(socket, 0);
      socket.setTimeout(120000);
      outbound.on('error', (error) => {
        this.failure(error, router);
      });
      connectStreams(socket, outbound, signal);
    } catch (error) {
      outbound?.destroy();
      const code = (error as NodeJS.ErrnoException).code;
      const reply =
        code === 'RULE_REJECT'
          ? 2
          : code === 'ECONNREFUSED'
            ? 5
            : code === 'ENETUNREACH'
              ? 3
              : code === 'EHOSTUNREACH'
                ? 4
                : code === 'ETIMEDOUT'
                  ? 6
                  : 1;
      if (!socket.destroyed) await socksReply(socket, reply).catch(() => {});
      throw error;
    }
  }
}
