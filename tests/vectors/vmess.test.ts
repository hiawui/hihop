import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  kdf,
  alterIds,
  vmessRequest,
} from '../../src/proxy/outbound/vmess/protocol.js';
import { hash, seal } from '../../src/proxy/outbound/crypto.js';
import type { ProxyNode } from '../../src/config/model.js';
const vectors = JSON.parse(
  await readFile('tests/fixtures/vmess-vectors.json', 'utf8'),
);
const material = {
  key: Buffer.from(Array.from({ length: 16 }, (_, i) => i)),
  iv: Buffer.from(Array.from({ length: 16 }, (_, i) => i + 16)),
  response: 42,
  time: 1700000000n,
  authRandom: Buffer.from([1, 2, 3, 4]),
  headerNonce: Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]),
};
const node: Extract<ProxyNode, { type: 'vmess' }> = {
  id: '00112233-4455-4677-8899-aabbccddeeff',
  uuid: '00112233-4455-4677-8899-aabbccddeeff',
  name: 'test',
  type: 'vmess',
  server: 'localhost',
  port: 1,
  udp: false,
  alterId: 0,
  cipher: 'auto',
  tls: false,
  network: 'tcp',
  ws: { path: '/' },
};
test('Go standard-library oracle: recursive KDF and alterId=1 derivation', () => {
  assert.equal(
    kdf(material.key, 'AEAD Resp Header Len Key').toString('hex'),
    vectors.kdf,
  );
  assert.equal(
    alterIds(Buffer.from(node.uuid.replaceAll('-', ''), 'hex'), 1)[0].toString(
      'hex',
    ),
    vectors.alterId,
  );
});
for (const mode of ['aead', 'legacy'])
  test(`Go oracle: deterministic complete ${mode} request`, () => {
    assert.equal(
      vmessRequest(
        { ...node, alterId: mode === 'legacy' ? 1 : 0 },
        { host: 'example.com', port: 443 },
        material,
      ).toString('hex'),
      vectors[mode],
    );
  });
test('Go oracle: AEAD response key, IV and encrypted length', () => {
  const key = hash('sha256', material.key).subarray(0, 16),
    iv = hash('sha256', material.iv).subarray(0, 16);
  assert.equal(
    seal(
      'aes-128-gcm',
      kdf(key, 'AEAD Resp Header Len Key').subarray(0, 16),
      kdf(iv, 'AEAD Resp Header Len IV').subarray(0, 12),
      Buffer.from([0, 4]),
    ).toString('hex'),
    vectors.responseLength,
  );
});
