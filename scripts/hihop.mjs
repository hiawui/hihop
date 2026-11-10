#!/usr/bin/env node
import { spawn, execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import {
  access,
  chmod,
  mkdir,
  open,
  readFile,
  rename,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loadEnvFile } from 'node:process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

process.umask(0o077);
const exec = promisify(execFile);
const script = fileURLToPath(import.meta.url);
const root = path.resolve(path.dirname(script), '..');
const home = path.resolve(
  process.env.HIHOP_HOME ?? path.join(os.homedir(), '.hihop'),
);
const runDir = path.join(home, 'run');
const logDir = path.join(home, 'logs');
const stateFile = path.join(runDir, 'process.json');
const lockFile = path.join(runDir, 'control.lock');
const logFile = path.join(logDir, 'hihop.log');
const server = path.join(root, 'dist/server.js');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const quote = (value) => "'" + value.replaceAll("'", "'\\''") + "'";

try {
  loadEnvFile(path.join(root, '.env'));
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}

async function privateDir(dir) {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700);
}

function alive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === 'ESRCH') return false;
    throw error;
  }
}

async function readState() {
  try {
    return JSON.parse(await readFile(stateFile, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT' || error instanceof SyntaxError) return null;
    throw error;
  }
}

async function managed(state) {
  if (!state || !/^[a-f0-9-]{36}$/.test(state.instance) || !alive(state.pid))
    return false;
  try {
    const { stdout } = await exec('ps', [
      '-p',
      String(state.pid),
      '-o',
      'args=',
    ]);
    return (
      stdout.trim() ===
      `${process.execPath} ${server} --hihop-instance=${state.instance}`
    );
  } catch (error) {
    if (error.code === 1) return false;
    throw error;
  }
}

async function withLock(task) {
  await privateDir(home);
  await privateDir(runDir);
  let handle;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      handle = await open(lockFile, 'wx', 0o600);
      break;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const owner = Number(await readFile(lockFile, 'utf8'));
      // An empty file may belong to a command that is still writing its PID.
      if (
        alive(owner) ||
        (!owner && Date.now() - (await stat(lockFile)).mtimeMs < 10000)
      )
        throw new Error('另一个 HiHop 命令正在执行，请稍后重试');
      await unlink(lockFile).catch((e) => {
        if (e.code !== 'ENOENT') throw e;
      });
    }
  }
  if (!handle) throw new Error('无法取得 HiHop 控制锁，请重试');
  try {
    await handle.writeFile(String(process.pid));
    return await task();
  } finally {
    await handle.close();
    await unlink(lockFile);
  }
}

async function api(state, endpoint, method = 'GET', timeout = 3000) {
  if (!Number.isInteger(state.port) || state.port < 1 || state.port > 65535)
    throw new Error('HiHop 运行状态中的管理端口无效');
  const token = (await readFile(path.join(home, 'admin-token'), 'utf8')).trim();
  const response = await fetch(
    `http://127.0.0.1:${state.port}/api/${endpoint}`,
    {
      method,
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(timeout),
    },
  );
  if (!response.ok)
    throw new Error(
      `HiHop 管理接口请求失败（HTTP ${response.status}），请查看 ${logFile}`,
    );
  return response.json();
}

async function terminate(state) {
  if (!(await managed(state))) return;
  process.kill(state.pid, 'SIGTERM');
  for (let i = 0; i < 80; i++) {
    if (!(await managed(state))) return;
    await sleep(100);
  }
  if (await managed(state)) process.kill(state.pid, 'SIGKILL');
  for (let i = 0; i < 20; i++) {
    if (!(await managed(state))) return;
    await sleep(100);
  }
  throw new Error('HiHop 进程尚未退出，请稍后重试');
}

async function enableProxy(state) {
  const status = await api(state, 'service/start', 'POST', 90000);
  if (status.state !== 'running')
    throw new Error(`HiHop 代理未就绪，请查看 ${logFile}`);
  console.log(
    `HiHop 代理已启动（PID ${state.pid}，SOCKS5 ${status.listener.host}:${status.listener.port}）`,
  );
  console.log(`管理页面：http://127.0.0.1:${state.port} · 日志：${logFile}`);
}

async function start() {
  const previous = await readState();
  if (await managed(previous)) {
    await enableProxy(previous);
    return;
  }
  await unlink(stateFile).catch((e) => {
    if (e.code !== 'ENOENT') throw e;
  });
  try {
    await access(server, constants.R_OK);
    await access(path.join(root, 'dist/web/index.html'), constants.R_OK);
  } catch {
    throw new Error(`尚未构建 HiHop，请先在 ${root} 执行 mise run build`);
  }
  const port = Number(process.env.HIHOP_WEB_PORT ?? 7800);
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error('HIHOP_WEB_PORT 必须为 1–65535');
  await privateDir(logDir);
  try {
    if ((await stat(logFile)).size >= 10 * 1024 * 1024)
      await rename(logFile, logFile + '.1');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const output = await open(logFile, 'a', 0o600);
  await output.chmod(0o600);
  let child;
  let state;
  try {
    await output.write(`\n[${new Date().toISOString()}] Starting HiHop\n`);
    const instance = randomUUID();
    child = spawn(process.execPath, [server, `--hihop-instance=${instance}`], {
      cwd: root,
      env: { ...process.env, HIHOP_DATA_DIR: home },
      detached: true,
      stdio: ['ignore', output.fd, output.fd, 'ipc'],
    });
    // Only this child's IPC readiness message allows management requests. An
    // unrelated server occupying the same port must never receive start/stop.
    const ready = new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`HiHop 启动超时，请查看 ${logFile}`)),
        15000,
      );
      const cleanup = () => {
        clearTimeout(timer);
        child.off('error', failed);
        child.off('exit', exited);
        child.off('message', message);
      };
      const failed = (error) => {
        cleanup();
        reject(error);
      };
      const exited = () =>
        failed(new Error(`HiHop 启动失败，请查看 ${logFile}`));
      const message = (value) => {
        if (value?.type === 'hihop:ready' && value.port === port) {
          cleanup();
          resolve();
        }
      };
      child.once('error', failed);
      child.once('exit', exited);
      child.on('message', message);
    });
    // Attach a rejection handler before the state write, which can itself fail.
    ready.catch(() => {});
    state = { pid: child.pid, instance, port };
    await writeFile(stateFile, JSON.stringify(state) + '\n', { mode: 0o600 });
    await ready;
    child.disconnect();
    child.unref();
    await enableProxy(state);
  } catch (error) {
    if (child?.connected) child.disconnect();
    child?.unref();
    if (state) await terminate(state);
    await unlink(stateFile).catch((e) => {
      if (e.code !== 'ENOENT') throw e;
    });
    throw error;
  } finally {
    await output.close();
  }
}

async function stop() {
  const state = await readState();
  const running = await managed(state);
  if (running) await terminate(state);
  await unlink(stateFile).catch((e) => {
    if (e.code !== 'ENOENT') throw e;
  });
  console.log(running ? 'HiHop 已停止' : 'HiHop 未运行');
}

async function status() {
  const state = await readState();
  if (!(await managed(state))) {
    console.log('HiHop 未运行');
    process.exitCode = 1;
    return;
  }
  const result = await api(state, 'status');
  console.log(`HiHop 后台运行（PID ${state.pid}），代理状态：${result.state}`);
  console.log(`管理页面：http://127.0.0.1:${state.port} · 日志：${logFile}`);
}

async function install() {
  await privateDir(home);
  const source = path.resolve(root, process.env.HIHOP_DATA_DIR ?? 'data');
  if (source !== home) {
    for (const name of ['config.json', 'admin-token']) {
      let content;
      try {
        content = await readFile(path.join(source, name));
      } catch (error) {
        if (error.code === 'ENOENT') continue;
        throw error;
      }
      let target;
      try {
        target = await open(path.join(home, name), 'wx', 0o600);
      } catch (error) {
        if (error.code === 'EEXIST') continue;
        throw error;
      }
      try {
        await target.writeFile(content);
      } finally {
        await target.close();
      }
      console.log(`已复制 ${name} 到 ${home}（源文件保留）`);
    }
  }
  const bin = path.join(os.homedir(), '.local/bin');
  await mkdir(bin, { recursive: true });
  const launcher = path.join(bin, 'hihop');
  const content = `#!/bin/sh\n# HiHop local launcher\nexec ${quote(process.execPath)} ${quote(script)} "$@"\n`;
  try {
    const existing = await readFile(launcher, 'utf8');
    if (!existing.startsWith('#!/bin/sh\n# HiHop local launcher\n'))
      throw new Error(`${launcher} 已存在且不是 HiHop 启动脚本，未覆盖`);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const temp = `${launcher}.${process.pid}.tmp`;
  try {
    await writeFile(temp, content, { mode: 0o700, flag: 'wx' });
    await rename(temp, launcher);
  } finally {
    await unlink(temp).catch((e) => {
      if (e.code !== 'ENOENT') throw e;
    });
  }
  console.log(`已安装 ${launcher}；使用 hihop start|stop|restart|status`);
}

try {
  const command = process.argv[2];
  if (process.argv.length > 3)
    throw new Error('用法：hihop start|stop|restart|status');
  switch (command) {
    case 'install':
      await withLock(install);
      break;
    case 'start':
      await withLock(start);
      break;
    case 'stop':
      await withLock(stop);
      break;
    case 'restart':
      await withLock(async () => {
        await stop();
        await start();
      });
      break;
    case 'status':
      await status();
      break;
    case '--help':
    case '-h':
      console.log(
        `用法：hihop start|stop|restart|status\n配置：${home}\n日志：${logFile}`,
      );
      break;
    default:
      throw new Error('用法：hihop start|stop|restart|status');
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
