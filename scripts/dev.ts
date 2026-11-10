import { build } from 'vite';
import { spawn, type ChildProcess } from 'node:child_process';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const watcher = await build({ build: { watch: {} } });
if (!('on' in watcher)) throw new Error('Vite watcher unavailable');
let backend: ChildProcess | undefined;
watcher.on('event', (event) => {
  if (event.code === 'ERROR') console.error('Web 构建失败，请修正源文件');
  if (event.code === 'BUNDLE_END') {
    void event.result.close();
    if (!backend)
      backend = spawn(
        process.execPath,
        [require.resolve('tsx/cli'), 'watch', 'src/server.ts'],
        { stdio: 'inherit', env: process.env },
      );
    else console.info('Web 已重建，刷新浏览器查看修改');
  }
});
for (const signal of ['SIGINT', 'SIGTERM'] as const)
  process.once(signal, () => {
    backend?.kill(signal);
    void watcher.close();
  });
