import Fastify, { type FastifyRequest } from 'fastify';
import { timingSafeEqual, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { AppError, invariant, safeError } from '../errors.js';
import {
  redact,
  nodeSchema,
  initialConfig,
  selectionSchema,
} from '../config/model.js';
import { ConfigManager } from '../config/manager.js';
import { importClash, MAX_BYTES } from '../import/clash.js';

type Body = Record<string, any>;
export async function createApp(
  manager: ConfigManager,
  token: string,
  port = 7800,
  webRoot = path.resolve('dist/web'),
) {
  const app = Fastify({
    logger: false,
    bodyLimit: MAX_BYTES + 65536,
    requestTimeout: 90000,
    connectionTimeout: 90000,
    maxRequestsPerSocket: 100,
  });
  const shutdown = new AbortController();
  let importing = false;
  let inFlight = 0;
  let updateTimer: ReturnType<typeof setInterval> | undefined;
  let probeTimer: ReturnType<typeof setInterval> | undefined;
  let updating: Promise<void> | undefined;
  const updateSubscriptions = () => {
    if (updating || shutdown.signal.aborted) return;
    updating = manager
      .refreshDueProfiles(shutdown.signal)
      .catch(() => {})
      .finally(() => {
        updating = undefined;
      });
  };
  const probeIfDue = () => {
    if (!shutdown.signal.aborted) void manager.probeIfDue().catch(() => {});
  };
  app.addHook('onReady', async () => {
    updateTimer = setInterval(updateSubscriptions, 60000);
    updateTimer.unref();
    updateSubscriptions();
    probeTimer = setInterval(probeIfDue, 60000);
    probeTimer.unref();
    probeIfDue();
  });
  const body = (req: FastifyRequest): Body => {
    invariant(
      req.body && typeof req.body === 'object' && !Array.isArray(req.body),
      '请求需要 JSON 对象',
    );
    return req.body as Body;
  };
  const revision = (b: Body) => {
    invariant(Number.isInteger(b.revision), '缺少配置 revision');
    return b.revision as number;
  };
  const auth = (header: string | undefined) => {
    const value = Buffer.from(header?.replace(/^Bearer /, '') ?? '');
    const expected = Buffer.from(token);
    return value.length === expected.length && timingSafeEqual(value, expected);
  };
  app.addHook('onRequest', async (req, reply) => {
    const expected = new Set([
      `127.0.0.1:${port}`,
      `localhost:${port}`,
      `[::1]:${port}`,
    ]);
    if (!expected.has(req.headers.host ?? ''))
      throw new AppError('HOST_FORBIDDEN', '拒绝非预期 Host', 403);
    if (
      req.headers.origin &&
      req.headers.origin !== `http://${req.headers.host}`
    )
      throw new AppError('ORIGIN_FORBIDDEN', '拒绝跨域请求', 403);
    reply
      .header('X-Content-Type-Options', 'nosniff')
      .header('Referrer-Policy', 'no-referrer')
      .header(
        'Content-Security-Policy',
        "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
      );
    if (
      req.routeOptions.url !== '/' &&
      req.routeOptions.url !== '/assets/:name'
    ) {
      reply.header('Cache-Control', 'no-store');
      if (!auth(req.headers.authorization))
        throw new AppError('UNAUTHORIZED', '需要管理员 token', 401);
    }
    if (inFlight >= 32) throw new AppError('BUSY', '并发操作超限', 429);
    inFlight++;
    (req as FastifyRequest & { counted?: boolean }).counted = true;
  });
  app.addHook('onResponse', async (req) => {
    if ((req as FastifyRequest & { counted?: boolean }).counted) inFlight--;
  });
  app.setErrorHandler((error: Error & { statusCode?: number }, _req, reply) => {
    const status =
      error instanceof AppError
        ? error.status
        : error.statusCode === 413
          ? 413
          : error.statusCode === 400
            ? 400
            : 500;
    reply
      .code(status)
      .send(
        error.statusCode === 413
          ? { code: 'TOO_LARGE', message: '请求超过大小限制' }
          : safeError(error),
      );
  });
  app.get('/api/status', async () => manager.status());
  const publicConfig = () => {
    const { rules: _, ...config } = redact(manager.config);
    return {
      ...config,
      editRevision: manager.editRevision,
      selection: manager.selection(),
    };
  };
  const configResponse = () => ({
    ...publicConfig(),
    ...manager.profiles(),
  });
  const profileName = (b: Body, fallback: string) => {
    const name = b.name === undefined ? fallback : b.name;
    invariant(
      typeof name === 'string' &&
        name.trim().length > 0 &&
        name.trim().length <= 255,
      '配置名称须为 1–255 个字符',
      'name',
    );
    return name.trim();
  };
  app.get('/api/config', async () => configResponse());
  app.get('/api/profiles', async () => manager.profiles());
  app.post('/api/profiles', async (req) => {
    const b = body(req);
    await manager.addProfile(
      revision(b),
      profileName(b, '新配置'),
      initialConfig(),
    );
    return configResponse();
  });
  app.post<{ Params: { id: string } }>(
    '/api/profiles/:id/activate',
    async (req) => {
      await manager.activateProfile(revision(body(req)), req.params.id);
      return configResponse();
    },
  );
  app.patch<{ Params: { id: string } }>(
    '/api/profiles/:id/subscription',
    async (req) => {
      const b = body(req);
      invariant(
        Object.keys(b).every((key) =>
          ['revision', 'url', 'intervalHours'].includes(key),
        ),
        '更新配置包含不支持的字段',
      );
      invariant(
        b.url !== undefined || b.intervalHours !== undefined,
        '请填写 URL 或更新周期',
      );
      await manager.setSubscription(revision(b), req.params.id, {
        ...(b.url === undefined ? {} : { url: b.url }),
        ...(b.intervalHours === undefined
          ? {}
          : { intervalHours: b.intervalHours }),
      });
      return configResponse();
    },
  );
  app.delete<{ Params: { id: string } }>('/api/profiles/:id', async (req) => {
    await manager.deleteProfile(revision(body(req)), req.params.id);
    return configResponse();
  });
  app.post('/api/probes', async (req) =>
    manager.probeActive(revision(body(req))),
  );
  app.post<{ Params: { id: string } }>(
    '/api/profiles/:id/refresh',
    async (req) => {
      await manager.refreshProfile(req.params.id, shutdown.signal);
      return configResponse();
    },
  );
  app.get('/api/nodes', async () => ({
    nodes: redact(manager.config).nodes,
    revision: manager.config.revision,
  }));
  app.post('/api/nodes', async (req) => {
    const b = body(req);
    const parsed = nodeSchema.safeParse({ ...b.node, id: randomUUID() });
    invariant(parsed.success, '节点字段无效', 'node');
    await manager.change(revision(b), (c) => {
      c.nodes.push(parsed.data);
      if (c.nodes.length === 1)
        c.rules[0].target = { kind: 'node', id: parsed.data.id };
      return c;
    });
    return publicConfig();
  });
  app.patch<{ Params: { id: string } }>('/api/nodes/:id', async (req) => {
    const b = body(req);
    await manager.change(revision(b), (c) => {
      const index = c.nodes.findIndex((n) => n.id === req.params.id);
      invariant(index >= 0, '节点不存在');
      invariant(b.node && !('id' in b.node), '编辑不可修改节点 ID');
      c.nodes[index] = {
        ...(b.node.type && b.node.type !== c.nodes[index].type
          ? {}
          : c.nodes[index]),
        ...b.node,
        id: req.params.id,
      };
      return c;
    });
    return publicConfig();
  });
  app.delete<{ Params: { id: string } }>('/api/nodes/:id', async (req) => {
    const b = body(req);
    await manager.change(revision(b), (c) => {
      invariant(
        c.nodes.some((n) => n.id === req.params.id),
        '节点不存在',
      );
      c.nodes = c.nodes.filter((n) => n.id !== req.params.id);
      return c;
    });
    return publicConfig();
  });
  app.put('/api/selection', async (req) => {
    const b = body(req);
    const selection = selectionSchema.safeParse(b.selection);
    invariant(selection.success, '节点选择无效', 'selection');
    await manager.selectNode(
      revision(b),
      selection.data,
      shutdown.signal,
      true,
    );
    return publicConfig();
  });
  app.get('/api/dns', async () => ({
    dns: manager.config.dns,
    hosts: manager.config.hosts,
    revision: manager.config.revision,
  }));
  app.put('/api/dns', async (req) => {
    const b = body(req);
    await manager.change(revision(b), (c) => ({
      ...c,
      dns: b.dns,
      hosts: b.hosts,
    }));
    return publicConfig();
  });
  app.get('/api/settings', async () => {
    const c = redact(manager.config);
    return { socks: c.socks, logLevel: c.logLevel, revision: c.revision };
  });
  app.patch('/api/settings', async (req) => {
    const b = body(req);
    await manager.change(revision(b), (c) => {
      const socks = { ...c.socks, ...b.socks };
      if (b.socks?.auth && !b.socks.auth.password && c.socks.auth)
        socks.auth = {
          ...c.socks.auth,
          ...b.socks.auth,
          password: c.socks.auth.password,
        };
      if (b.socks?.auth === null) delete socks.auth;
      return { ...c, socks, logLevel: b.logLevel ?? c.logLevel };
    });
    return publicConfig();
  });
  app.post('/api/service/start', async () => manager.start());
  app.post('/api/service/stop', async () => manager.stop());
  for (const kind of ['file', 'url'] as const)
    app.post(`/api/imports/${kind}`, async (req, reply) => {
      if (importing)
        throw new AppError('IMPORT_BUSY', '已有导入任务，请稍后重试', 429);
      importing = true;
      const cancel = new AbortController();
      const aborted = () => {
        if (!reply.raw.writableFinished) cancel.abort();
      };
      reply.raw.once('close', aborted);
      try {
        const b = body(req);
        invariant(
          typeof b[kind === 'file' ? 'content' : 'url'] === 'string',
          '缺少配置内容或 URL',
        );
        const content =
          kind === 'file'
            ? b.content
            : await manager.downloadProfile(
                b.url,
                AbortSignal.any([cancel.signal, shutdown.signal]),
              );
        if (Buffer.byteLength(content) > MAX_BYTES)
          throw new AppError('TOO_LARGE', '配置超过 2 MiB', 413);
        const parsed = importClash(content);
        const name = profileName(b, kind === 'file' ? '导入配置' : '订阅配置');
        await manager.addProfile(
          revision(b),
          name,
          parsed.config,
          kind === 'url'
            ? {
                url: b.url,
                intervalHours: b.intervalHours ?? 4,
                lastUpdatedAt: Date.now(),
              }
            : undefined,
          AbortSignal.any([cancel.signal, shutdown.signal]),
        );
        return { ...configResponse(), warnings: parsed.warnings };
      } finally {
        importing = false;
        reply.raw.off('close', aborted);
      }
    });
  app.get('/', async (_req, reply) =>
    reply
      .type('text/html; charset=utf-8')
      .header('Cache-Control', 'no-cache')
      .send(await readFile(path.join(webRoot, 'index.html'))),
  );
  app.get<{ Params: { name: string } }>('/assets/:name', async (req, reply) => {
    // Vite build assets only; reject traversal, separators and arbitrary extensions.
    if (!/^[a-zA-Z0-9_-]+\.(js|css|svg)$/.test(req.params.name))
      throw new AppError('NOT_FOUND', '资源不存在', 404);
    try {
      return reply
        .type(
          req.params.name.endsWith('.js')
            ? 'text/javascript; charset=utf-8'
            : req.params.name.endsWith('.css')
              ? 'text/css; charset=utf-8'
              : 'image/svg+xml',
        )
        .send(await readFile(path.join(webRoot, 'assets', req.params.name)));
    } catch {
      throw new AppError('NOT_FOUND', '资源不存在', 404);
    }
  });
  app.addHook('preClose', async () => {
    clearInterval(updateTimer);
    clearInterval(probeTimer);
    shutdown.abort();
    await updating;
    await manager.stop();
  });
  return app;
}
