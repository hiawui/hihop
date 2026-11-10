import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import https from 'node:https';
import tls from 'node:tls';
import { gzipSync } from 'node:zlib';
import { readFile } from 'node:fs/promises';
import { listen } from '../helpers.js';
import { downloadConfig, type DownloadIO } from '../../src/import/download.js';
import { importClash } from '../../src/import/clash.js';

test('controlled HTTP downloader: equivalent file, redirects, status, compression, limits, timeout, cancel and pinning', async (t) => {
  const yaml = await readFile('clash-example.yaml', 'utf8');
  let requests = 0;
  const server = http.createServer((req, res) => {
    requests++;
    if (req.url === '/redirect') {
      res.writeHead(302, { Location: '/config?private-token=test-only' });
      res.end();
    } else if (req.url === '/private') {
      res.writeHead(302, { Location: 'http://127.0.0.1/secret' });
      res.end();
    } else if (req.url === '/loop') {
      res.writeHead(302, { Location: '/loop' });
      res.end();
    } else if (req.url === '/error') {
      res.writeHead(500);
      res.end('<html>error</html>');
    } else if (req.url === '/silent') {
      /* deadline must abort the response */
    } else if (req.url === '/huge') {
      res.setHeader('Content-Encoding', 'gzip');
      res.end(gzipSync('x'.repeat(2097153)));
    } else if (req.url === '/bad-gzip') {
      res.setHeader('Content-Encoding', 'gzip');
      res.end('bad');
    } else if (req.url === '/partial') {
      res.writeHead(200, { 'Content-Length': '100' });
      res.write('x');
      res.destroy();
    } else {
      res.setHeader('Content-Encoding', 'gzip');
      res.end(gzipSync(yaml));
    }
  });
  const port = await listen(server);
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  let resolutions = 0;
  const pins: string[] = [];
  const io: DownloadIO = {
    timeoutMs: 1000,
    lookup: async () => {
      resolutions++;
      return [{ address: '1.1.1.1', family: 4 }];
    },
    get: (url, options, cb) => {
      // Assert the production pinning callback, then direct test I/O to the fixture server.
      (options.lookup as any)(
        'fixture.test',
        {},
        (_error: null, address: string) => pins.push(address),
      );
      return http.get(
        new URL(url.pathname + url.search, `http://127.0.0.1:${port}`),
        { ...options, lookup: undefined },
        cb,
      );
    },
  };
  const loaded = await downloadConfig(
    'http://fixture.test/redirect',
    undefined,
    io,
  );
  assert.equal(loaded, yaml);
  const left = importClash(yaml),
    right = importClash(loaded);
  assert.equal(left.config.nodes.length, right.config.nodes.length);
  assert.deepEqual(
    left.config.rules.map((r) => [r.type, r.value, r.target.kind]),
    right.config.rules.map((r) => [r.type, r.value, r.target.kind]),
  );
  assert.equal(resolutions, 2);
  assert.deepEqual(pins, ['1.1.1.1', '1.1.1.1']);
  for (const route of [
    'private',
    'loop',
    'error',
    'huge',
    'bad-gzip',
    'partial',
  ])
    await assert.rejects(
      downloadConfig(`http://fixture.test/${route}`, undefined, io),
    );
  await assert.rejects(
    downloadConfig('http://fixture.test/silent', undefined, {
      ...io,
      timeoutMs: 25,
    }),
  );
  const cancel = new AbortController();
  const pending = downloadConfig(
    'http://fixture.test/silent',
    cancel.signal,
    io,
  );
  setTimeout(() => cancel.abort(), 10);
  await assert.rejects(pending);
  const before = requests;
  await assert.rejects(
    downloadConfig('http://fixture.test/config', undefined, {
      ...io,
      lookup: async () => [{ address: '127.0.0.1', family: 4 }],
    }),
  );
  assert.equal(requests, before);
  let changed = 0;
  await assert.rejects(
    downloadConfig('http://fixture.test/redirect', undefined, {
      ...io,
      lookup: async () => [
        { address: changed++ ? '127.0.0.1' : '1.1.1.1', family: 4 },
      ],
    }),
  );
});
test('controlled HTTPS: certificate verification and downgrade blocking', async (t) => {
  const cert = await readFile('tests/fixtures/tls-cert.pem'),
    key = await readFile('tests/fixtures/tls-key.pem');
  const server = https.createServer({ cert, key }, (req, res) => {
    if (req.url === '/down') {
      res.writeHead(302, { Location: 'http://fixture.test/config' });
      res.end();
    } else res.end('rules: ["MATCH,DIRECT"]');
  });
  const port = await listen(server);
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const io: DownloadIO = {
    timeoutMs: 1000,
    lookup: async () => [{ address: '1.1.1.1', family: 4 }],
    get: (url, options, cb) =>
      https.get(
        new URL(url.pathname, `https://127.0.0.1:${port}`),
        { ...options, lookup: undefined, servername: 'localhost' },
        cb,
      ),
  };
  const roots = tls.getCACertificates('default');
  await assert.rejects(
    downloadConfig('https://fixture.test/config', undefined, io),
  );
  tls.setDefaultCACertificates([...roots, cert]);
  assert.equal(
    await downloadConfig('https://fixture.test/config', undefined, io),
    'rules: ["MATCH,DIRECT"]',
  );
  await assert.rejects(
    downloadConfig('https://fixture.test/down', undefined, io),
  );
  tls.setDefaultCACertificates(roots);
});
