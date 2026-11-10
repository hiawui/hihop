import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import tls from 'node:tls';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile, copyFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {
  initialConfig,
  validateConfig,
  type ProxyNode,
} from '../../src/config/model.js';
import { Router } from '../../src/routing/router.js';
import { ProxyService } from '../../src/proxy/service.js';
import { write } from '../../src/proxy/codec/bytes.js';
import { freePort, listen, socks } from '../helpers.js';

const exec = promisify(execFile);
const IMAGE =
  'v2fly/v2fly-core@sha256:fc3df0da123b82d473d5251ece521cfdfa18ac70abd4da9bde4f120c3e17dc82';
test(
  'independent V2Ray 4.31.3: SS three ciphers + VMess AEAD/legacy × TCP/TLS/WS/WSS',
  { timeout: 180000 },
  async (t) => {
    try {
      await exec('docker', ['version'], { timeout: 10000 });
      await exec('docker', ['image', 'inspect', IMAGE], { timeout: 10000 });
    } catch {
      throw new Error(
        `独立互通测试需要运行中的 Docker 与已拉取镜像 ${IMAGE}，不跳过测试`,
      );
    }
    const dir = await mkdtemp(path.join(os.tmpdir(), 'hihop-reference-'));
    const name = `hihop-test-${randomBytes(6).toString('hex')}`;
    let started = false;
    const sockets = new Set<net.Socket>();
    let targetConnections = 0;
    const echo = net.createServer({ allowHalfOpen: true }, (socket) => {
      sockets.add(socket);
      socket.on('error', () => {});
      socket.once('close', () => sockets.delete(socket));
      targetConnections++;
      socket.pipe(socket);
    });
    const targetPort = await listen(echo, '0.0.0.0');
    const afterEof = net.createServer({ allowHalfOpen: true }, (socket) => {
      sockets.add(socket);
      socket.on('error', () => {});
      socket.once('close', () => sockets.delete(socket));
      // V2Ray does not propagate FIN to the final target. Delay the response until
      // after the SOCKS client's write EOF to verify Hihop preserves the read side.
      const chunks: Buffer[] = [];
      let size = 0;
      socket.on('data', (chunk) => {
        chunks.push(chunk);
        size += chunk.length;
        if (size === 8192)
          setTimeout(() => socket.end(Buffer.concat(chunks)), 50);
      });
    });
    const eofPort = await listen(afterEof, '0.0.0.0');
    t.after(async () => {
      sockets.forEach((s) => s.destroy());
      await new Promise<void>((r) => echo.close(() => r()));
      await new Promise<void>((r) => afterEof.close(() => r()));
      if (started) await exec('docker', ['rm', '-f', name]).catch(() => {});
      await rm(dir, { recursive: true, force: true });
    });
    await copyFile('tests/fixtures/tls-cert.pem', path.join(dir, 'cert.pem'));
    await copyFile('tests/fixtures/tls-key.pem', path.join(dir, 'key.pem'));
    tls.setDefaultCACertificates([
      ...tls.getCACertificates('default'),
      await readFile('tests/fixtures/tls-cert.pem', 'utf8'),
    ]);
    const uuid = randomUUID(),
      password = randomBytes(24).toString('hex');
    const nodes: ProxyNode[] = [];
    const inbounds: any[] = [];
    const args = [
      'run',
      '--detach',
      '--rm',
      '--platform',
      'linux/amd64',
      '--name',
      name,
      '--add-host',
      'host.docker.internal:host-gateway',
      '-v',
      `${dir}:/etc/hihop:ro`,
    ];
    const add = async (
      node: ProxyNode,
      settings: any,
      streamSettings?: any,
    ) => {
      const port = await freePort();
      node.port = port;
      nodes.push(node);
      const internal = 20000 + nodes.length;
      args.push('-p', `127.0.0.1:${port}:${internal}`);
      inbounds.push({
        listen: '0.0.0.0',
        port: internal,
        protocol: node.type === 'ss' ? 'shadowsocks' : 'vmess',
        settings,
        streamSettings,
      });
    };
    for (const cipher of [
      'aes-128-gcm',
      'aes-256-gcm',
      'chacha20-ietf-poly1305',
    ] as const)
      await add(
        {
          id: randomUUID(),
          name: cipher,
          type: 'ss',
          server: '127.0.0.1',
          port: 1,
          cipher,
          password,
          udp: false,
        },
        { method: cipher, password, network: 'tcp' },
      );
    for (const alterId of [0, 1])
      for (const network of ['tcp', 'ws'] as const)
        for (const secure of [false, true]) {
          const node: ProxyNode = {
            id: randomUUID(),
            name: `vmess-${alterId}-${network}-${secure ? 'tls' : 'plain'}`,
            type: 'vmess',
            server: '127.0.0.1',
            port: 1,
            uuid,
            alterId,
            cipher: 'auto',
            tls: secure,
            servername: 'localhost',
            network,
            ws: { path: '/hihop-test?token=test-only', host: 'ws.test' },
            udp: false,
          };
          await add(
            node,
            { clients: [{ id: uuid, alterId }] },
            {
              network,
              security: secure ? 'tls' : 'none',
              tlsSettings: secure
                ? {
                    certificates: [
                      {
                        certificateFile: '/etc/hihop/cert.pem',
                        keyFile: '/etc/hihop/key.pem',
                      },
                    ],
                  }
                : undefined,
              wsSettings:
                network === 'ws'
                  ? { path: '/hihop-test', headers: { Host: 'ws.test' } }
                  : undefined,
            },
          );
        }
    await writeFile(
      path.join(dir, 'config.json'),
      JSON.stringify({
        log: { loglevel: 'debug' },
        inbounds,
        outbounds: [{ protocol: 'freedom', settings: {} }],
      }),
      { mode: 0o600 },
    );
    await exec(
      'docker',
      [...args, IMAGE, 'v2ray', '-config', '/etc/hihop/config.json'],
      { timeout: 30000 },
    );
    started = true;
    for (let attempt = 0; attempt < 100; attempt++) {
      const logs = await exec('docker', ['logs', name]);
      if ((logs.stdout + logs.stderr).includes('started')) break;
      if (attempt === 99) throw new Error('独立服务端未报告启动成功');
      await new Promise((r) => setTimeout(r, 100));
    }
    // Poll readiness with real TCP connects; no false-positive protocol checks.
    for (let attempt = 0; attempt < 60; attempt++) {
      try {
        await new Promise<void>((resolve, reject) => {
          const socket = net.connect(nodes[0].port, '127.0.0.1');
          socket.setTimeout(300);
          socket.once('connect', () => {
            socket.destroy();
            resolve();
          });
          socket.once('error', reject);
          socket.once('timeout', () => {
            socket.destroy();
            reject(new Error('timeout'));
          });
        });
        break;
      } catch {
        if (attempt === 59) throw new Error('独立测试服务端未就绪');
        await new Promise((r) => setTimeout(r, 100));
      }
    }
    for (const node of nodes.filter(
      (n) =>
        !process.env.HIHOP_TEST_PROTOCOL ||
        n.name === process.env.HIHOP_TEST_PROTOCOL,
    ))
      await t.test(node.name, { timeout: 15000 }, async () => {
        const c = initialConfig();
        c.socks.port = await freePort();
        c.nodes = [node];
        c.rules[0].target = { kind: 'node', id: node.id };
        const router = await Router.compile(validateConfig(c));
        const proxy = new ProxyService(router);
        await proxy.bind();
        proxy.activate();
        const before = targetConnections;
        try {
          const payload = randomBytes(100000);
          const { socket, reader } = await socks(
            c.socks.port,
            'host.docker.internal',
            targetPort,
            undefined,
            payload.subarray(0, 17),
          );
          try {
            assert.deepEqual(await reader.exact(17), payload.subarray(0, 17));
            await write(socket, payload.subarray(17));
            const received = Buffer.concat([
              await reader.exact(65536),
              await reader.exact(34447),
            ]);
            assert.deepEqual(received, payload.subarray(17));
            assert.equal(
              targetConnections,
              before + 1,
              'independent endpoint must see the connection',
            );
            socket.end();
            assert.equal(await reader.read(1, true), null);
            assert.equal(
              socket.readableEnded,
              true,
              'response EOF must be graceful',
            );
          } finally {
            socket.destroy();
          }
          const half = await socks(
            c.socks.port,
            'host.docker.internal',
            eofPort,
          );
          try {
            const body = randomBytes(8192);
            half.socket.end(body);
            assert.deepEqual(
              await half.reader.exact(body.length),
              body,
              'delayed response after client write EOF must survive',
            );
            assert.equal(await half.reader.read(1, true), null);
            assert.equal(half.socket.readableEnded, true);
          } finally {
            half.socket.destroy();
          }
        } catch (error) {
          console.error('Proxy failure', node.name, proxy.lastError);
          const logs = await exec('docker', ['logs', '--tail', '25', name]);
          console.error(logs.stdout + logs.stderr);
          throw error;
        } finally {
          await proxy.stop();
          router.close();
        }
      });
  },
);
