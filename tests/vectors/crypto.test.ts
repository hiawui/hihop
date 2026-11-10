import { test } from 'node:test';
import assert from 'node:assert/strict';
import { masterKey, ssSubkey } from '../../src/proxy/outbound/ss.js';
import { seal, open, incrementLE } from '../../src/proxy/outbound/crypto.js';
import {
  crc32,
  fnv1a,
  bodyNonce,
} from '../../src/proxy/outbound/vmess/protocol.js';

test('NIST SP800-38D AES-128-GCM empty plaintext known answer', () => {
  const result = seal(
    'aes-128-gcm',
    Buffer.alloc(16),
    Buffer.alloc(12),
    Buffer.alloc(0),
  );
  assert.equal(result.toString('hex'), '58e2fccefa7e3061367f1d57a4e7455a');
  assert.equal(
    open('aes-128-gcm', Buffer.alloc(16), Buffer.alloc(12), result).length,
    0,
  );
});
test('EVP_BytesToKey MD5 password derivation (OpenSSL compatible)', () => {
  assert.equal(
    masterKey('password', 32).toString('hex'),
    '5f4dcc3b5aa765d61d8327deb882cf992b95990a9151374abd8ff8c5a7a0fe08',
  );
  assert.equal(
    ssSubkey(masterKey('password', 32), Buffer.alloc(32)).length,
    32,
  );
});
test('all SS ciphers reject modified/truncated tags before returning plaintext', () => {
  for (const [algorithm, size] of [
    ['aes-128-gcm', 16],
    ['aes-256-gcm', 32],
    ['chacha20-poly1305', 32],
  ] as const) {
    const encrypted = seal(
      algorithm,
      Buffer.alloc(size, 1),
      Buffer.alloc(12),
      Buffer.from('hello'),
    );
    encrypted[0] ^= 1;
    assert.throws(() =>
      open(algorithm, Buffer.alloc(size, 1), Buffer.alloc(12), encrypted),
    );
    assert.throws(() =>
      open(
        algorithm,
        Buffer.alloc(size, 1),
        Buffer.alloc(12),
        encrypted.subarray(0, 12),
      ),
    );
  }
});
test('nonce byte order and exhaustion prevent reuse', () => {
  const nonce = Buffer.alloc(12);
  nonce[0] = 255;
  incrementLE(nonce);
  assert.equal(nonce[1], 1);
  assert.equal(nonce[0], 0);
  assert.throws(() => incrementLE(Buffer.alloc(12, 255)));
  assert.equal(
    bodyNonce(Buffer.alloc(16), 258).toString('hex'),
    '010200000000000000000000',
  );
  assert.throws(() => bodyNonce(Buffer.alloc(16), 65536));
});
test('standard CRC32 and FNV-1a vectors', () => {
  assert.equal(crc32(Buffer.from('123456789')), 0xcbf43926);
  assert.equal(fnv1a(Buffer.from('hello')).toString('hex'), '4f9f2cab');
});
