import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { WebSocketServer } from 'ws';
import { randomUUID } from 'node:crypto';
import { nodeTransport } from '../../src/proxy/transport/socket.js';
import { ByteReader, write } from '../../src/proxy/codec/bytes.js';
import { listen } from '../helpers.js';
import type { ProxyNode } from '../../src/config/model.js';

test('WS adapter preserves path, query and Host, binary stream; rejects text and redirects', async (t) => {
  const server = http.createServer();
  const wss = new WebSocketServer({ noServer: true });
  const urls: string[] = [],
    hosts: string[] = [];
  server.on('upgrade', (req, socket, head) => {
    urls.push(req.url!);
    hosts.push(req.headers.host!);
    if (req.url === '/redirect') {
      socket.end(
        'HTTP/1.1 302 Found\r\nLocation: /new\r\nContent-Length: 0\r\n\r\n',
      );
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      if (req.url === '/text') ws.send('not binary');
      else ws.on('message', (data) => ws.send(data, { binary: true }));
    });
  });
  const port = await listen(server);
  t.after(() => {
    for (const client of wss.clients) client.terminate();
    wss.close();
    server.close();
  });
  const node: Extract<ProxyNode, { type: 'vmess' }> = {
    id: randomUUID(),
    name: 'test',
    type: 'vmess',
    server: 'not-resolved.invalid',
    port,
    uuid: randomUUID(),
    alterId: 0,
    cipher: 'auto',
    tls: false,
    network: 'ws',
    ws: { path: '/path?query=preserved', host: 'separate-host.test' },
    udp: false,
  };
  const cancel = new AbortController();
  const stream = await nodeTransport(node, '127.0.0.1', cancel.signal);
  await write(stream, Buffer.from('payload'));
  assert.equal((await new ByteReader(stream).exact(7)).toString(), 'payload');
  assert.deepEqual(urls, ['/path?query=preserved']);
  assert.deepEqual(hosts, ['separate-host.test']);
  stream.destroy();
  await assert.rejects(
    nodeTransport(
      { ...node, ws: { path: '/redirect' } },
      '127.0.0.1',
      cancel.signal,
    ),
  );
  await assert.rejects(
    async () => {
      const text = await nodeTransport(
        { ...node, ws: { path: '/text' } },
        '127.0.0.1',
        cancel.signal,
      );
      try {
        await new ByteReader(text).exact(1);
      } finally {
        text.destroy();
      }
    },
    (e: any) => e.code === 'PROTOCOL_ERROR',
  );
  cancel.abort();
});
