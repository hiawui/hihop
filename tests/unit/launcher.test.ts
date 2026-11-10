import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { freePort, listen } from '../helpers.js';
import http from 'node:http';

const exec = promisify(execFile);
async function fixture(t: { after: (fn: () => Promise<void>) => void }) {
  const root = await mkdtemp(path.join(os.tmpdir(), "hihop cli 'test-"));
  const userHome = path.join(root, 'user');
  const home = path.join(userHome, '.hihop');
  const cli = path.join(root, 'scripts/hihop.mjs');
  const port = await freePort();
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: userHome,
    HIHOP_HOME: home,
    PATH: '/usr/bin:/bin',
  };
  delete env.HIHOP_WEB_PORT;
  delete env.HIHOP_DATA_DIR;
  for (const dir of ['scripts', 'dist/web', 'data', 'user'])
    await mkdir(path.join(root, dir), { recursive: true });
  await copyFile('scripts/hihop.mjs', cli);
  await writeFile(path.join(root, '.env'), `HIHOP_WEB_PORT=${port}\n`);
  await writeFile(
    path.join(root, 'dist/web/index.html'),
    '<title>HiHop</title>',
  );
  // Exercise the launcher/server readiness contract with a controlled child.
  await writeFile(
    path.join(root, 'dist/server.js'),
    `
    const http = require('node:http');
    const fs = require('node:fs');
    const path = require('node:path');
    const home = process.env.HIHOP_DATA_DIR;
    fs.mkdirSync(home, { recursive: true });
    if (!fs.existsSync(path.join(home, 'admin-token')))
      fs.writeFileSync(path.join(home, 'admin-token'), 'a'.repeat(64), { mode: 0o600 });
    let running = false;
    const app = http.createServer((req, res) => {
      if (req.headers.authorization !== 'Bearer ' + fs.readFileSync(path.join(home, 'admin-token'), 'utf8').trim()) {
        res.writeHead(401).end(); return;
      }
      if (req.url === '/api/service/start') {
        if (fs.existsSync(path.join(home, 'reject-start'))) {
          res.writeHead(500).end('{}'); return;
        }
        running = true;
      }
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ state: running ? 'running' : 'stopped', listener: { host: '127.0.0.1', port: 1080 } }));
    });
    app.listen(Number(process.env.HIHOP_WEB_PORT), '127.0.0.1', () => {
      console.log('fixture stdout');
      console.error('fixture stderr');
      process.send?.({ type: 'hihop:ready', port: Number(process.env.HIHOP_WEB_PORT) });
    });
    process.on('SIGTERM', () => app.close(() => process.exit(0)));
  `,
  );
  const run = (command: string) =>
    exec(process.execPath, [cli, command], {
      env,
      cwd: os.tmpdir(),
      timeout: 25000,
    });
  t.after(async () => {
    await run('stop');
    await rm(root, { recursive: true, force: true });
  });
  return { root, userHome, home, cli, env, port, run };
}

test('local launcher installs with private config copies, starts SOCKS5, and survives terminal exit', async (t) => {
  const f = await fixture(t);
  const source = path.join(f.root, 'data');
  await writeFile(path.join(source, 'config.json'), '{"test":"original"}');
  await writeFile(path.join(source, 'admin-token'), 'b'.repeat(64));
  await f.run('install');
  assert.equal(
    await readFile(path.join(f.home, 'config.json'), 'utf8'),
    '{"test":"original"}',
  );
  assert.equal((await stat(f.home)).mode & 0o777, 0o700);
  assert.equal(
    (await stat(path.join(f.home, 'config.json'))).mode & 0o777,
    0o600,
  );
  assert.equal(
    (await stat(path.join(f.home, 'admin-token'))).mode & 0o777,
    0o600,
  );
  await writeFile(path.join(source, 'config.json'), '{"test":"changed"}');
  await f.run('install');
  assert.equal(
    await readFile(path.join(f.home, 'config.json'), 'utf8'),
    '{"test":"original"}',
  );
  const bin = path.join(f.userHome, '.local/bin/hihop');
  assert.equal((await stat(bin)).mode & 0o777, 0o700);
  const launch = () =>
    exec(bin, ['start'], { env: f.env, cwd: '/', timeout: 25000 });
  assert.match((await launch()).stdout, /HiHop 代理已启动/);
  const stateFile = path.join(f.home, 'run/process.json');
  const state = JSON.parse(await readFile(stateFile, 'utf8'));
  assert.equal(state.port, f.port);
  assert.match((await f.run('status')).stdout, /代理状态：running/);
  await launch();
  assert.equal(JSON.parse(await readFile(stateFile, 'utf8')).pid, state.pid);
  const log = path.join(f.home, 'logs/hihop.log');
  assert.equal((await stat(log)).mode & 0o777, 0o600);
  const output = await readFile(log, 'utf8');
  assert.match(output, /fixture stdout/);
  assert.match(output, /fixture stderr/);
  await writeFile(log, 'x'.repeat(10 * 1024 * 1024));
  await f.run('restart');
  assert.notEqual(JSON.parse(await readFile(stateFile, 'utf8')).pid, state.pid);
  assert.equal((await stat(log + '.1')).size, 10 * 1024 * 1024);
  await f.run('stop');
  assert.match((await f.run('stop')).stdout, /未运行/);
  await assert.rejects(
    f.run('status'),
    (error: any) => error.code === 1 && /未运行/.test(error.stdout),
  );
  await assert.rejects(readFile(stateFile), { code: 'ENOENT' });
});

test('launcher ignores unrelated PID records, recovers stale locks and rejects active control locks', async (t) => {
  const f = await fixture(t);
  await mkdir(path.join(f.home, 'run'), { recursive: true });
  const stateFile = path.join(f.home, 'run/process.json');
  await writeFile(
    stateFile,
    JSON.stringify({ pid: process.pid, instance: randomUUID(), port: f.port }),
  );
  await f.run('stop');
  process.kill(process.pid, 0);
  const lock = path.join(f.home, 'run/control.lock');
  await writeFile(lock, String(process.pid));
  await assert.rejects(f.run('start'), (error: any) =>
    /另一个 HiHop 命令/.test(error.stderr),
  );
  await writeFile(lock, '99999999');
  await f.run('start');
  assert.match((await f.run('status')).stdout, /running/);
});

test('startup failures clean the detached child and never control a server occupying the port', async (t) => {
  const f = await fixture(t);
  let requests = 0;
  const other = http.createServer((_req, res) => {
    requests++;
    res.end('{}');
  });
  await listen(other, '127.0.0.1');
  const occupied = (other.address() as { port: number }).port;
  await writeFile(path.join(f.root, '.env'), `HIHOP_WEB_PORT=${occupied}\n`);
  try {
    await assert.rejects(f.run('start'), (error: any) =>
      /HiHop 启动失败/.test(error.stderr),
    );
    assert.equal(requests, 0);
    await assert.rejects(readFile(path.join(f.home, 'run/process.json')), {
      code: 'ENOENT',
    });
  } finally {
    await new Promise<void>((resolve) => other.close(() => resolve()));
  }
  await writeFile(path.join(f.root, '.env'), `HIHOP_WEB_PORT=${f.port}\n`);
  await writeFile(path.join(f.home, 'reject-start'), '');
  await assert.rejects(f.run('start'), (error: any) =>
    /HTTP 500/.test(error.stderr),
  );
  await assert.rejects(readFile(path.join(f.home, 'run/process.json')), {
    code: 'ENOENT',
  });
  await rm(path.join(f.home, 'reject-start'));
  await f.run('start');
  assert.match((await f.run('status')).stdout, /running/);
});
