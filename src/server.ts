import path from 'node:path';
import { loadEnvFile } from 'node:process';
import { ConfigStore, adminToken, privateDirectory } from './config/storage.js';
import { ConfigManager } from './config/manager.js';
import { createApp } from './api/app.js';
import { safeError } from './errors.js';

async function main() {
  try {
    loadEnvFile();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const dir = path.resolve(process.env.HIHOP_DATA_DIR ?? 'data');
  await privateDirectory(dir);
  const token = await adminToken(path.join(dir, 'admin-token'));
  const manager = await ConfigManager.create(
    new ConfigStore(path.join(dir, 'config.json')),
  );
  const port = Number(process.env.HIHOP_WEB_PORT ?? 7800);
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error('Invalid management port');
  const app = await createApp(manager, token, port);
  await app.listen({ host: '127.0.0.1', port });
  console.info(
    `HiHop 管理页面 http://127.0.0.1:${port} · 管理 token 请读取 ${path.join(dir, 'admin-token')} · 代理默认停止`,
  );
  let closing = false;
  for (const event of ['SIGINT', 'SIGTERM'] as const)
    process.on(event, () => {
      if (closing) return;
      closing = true;
      const timer = setTimeout(() => process.exit(1), 5000);
      timer.unref();
      void manager
        .stop()
        .then(() => app.close())
        .then(() => {
          clearTimeout(timer);
          process.exitCode = 0;
        })
        .catch(() => {
          process.exitCode = 1;
        });
    });
  process.send?.({ type: 'hihop:ready', port });
}
main().catch((error) => {
  console.error(safeError(error));
  process.exitCode = 1;
});
