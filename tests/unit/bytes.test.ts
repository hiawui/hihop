import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { ByteReader, readAddress } from '../../src/proxy/codec/bytes.js';

test('byte reader waits for partial frames without starving timers and releases pipelined bytes', async () => {
  const stream = new PassThrough();
  const reader = new ByteReader(stream, undefined, 1000);
  stream.write(Buffer.from('ab'));
  const pending = reader.exact(4);
  setTimeout(() => stream.write(Buffer.from('cdef')), 10);
  assert.equal((await pending).toString(), 'abcd');
  reader.release();
  assert.equal(stream.read().toString(), 'ef');
  stream.destroy();
});
test('byte reader rejects truncated data, abort and slow peers', async () => {
  const truncated = new PassThrough();
  truncated.end(Buffer.from('a'));
  await assert.rejects(new ByteReader(truncated).exact(2));
  const slow = new PassThrough();
  slow.write(Buffer.from('a'));
  await assert.rejects(new ByteReader(slow, undefined, 20).exact(2));
  slow.destroy();
  const stream = new PassThrough();
  const cancel = new AbortController();
  const p = new ByteReader(stream, cancel.signal).exact(1);
  cancel.abort();
  await assert.rejects(p);
  stream.destroy();
});
test('SOCKS domain bytes reject high bits instead of silently stripping them', async () => {
  const stream = new PassThrough();
  stream.end(Buffer.from([1, 0xe1]));
  await assert.rejects(readAddress(new ByteReader(stream), 3));
});
