import { randomBytes, hkdfSync } from 'node:crypto';
import { Duplex, Readable, Writable } from 'node:stream';
import { type Destination, type ProxyNode } from '../../config/model.js';
import { AppError, invariant } from '../../errors.js';
import {
  address,
  ByteReader,
  guardStream,
  u16,
  write,
} from '../codec/bytes.js';
import { hash, incrementLE, open, seal } from './crypto.js';
export function masterKey(password: string, size: number): Buffer {
  const blocks: Buffer[] = [];
  let previous = Buffer.alloc(0);
  while (blocks.length * 16 < size) {
    previous = hash('md5', previous, Buffer.from(password));
    blocks.push(previous);
  }
  return Buffer.concat(blocks).subarray(0, size);
}
export const ssSubkey = (key: Buffer, salt: Buffer) =>
  Buffer.from(
    hkdfSync('sha1', key, salt, Buffer.from('ss-subkey'), key.length),
  );
const salts = new Map<string, number>();
function remember(key: Buffer, salt: Buffer) {
  const now = Date.now();
  const id = hash('sha256', key, salt).toString('hex');
  if ((salts.get(id) ?? 0) > now)
    throw new AppError('REPLAY_DETECTED', '检测到重复 SS salt');
  if (salts.size >= 10000) {
    for (const [k, expiry] of salts) if (expiry < now) salts.delete(k);
  }
  if (salts.size >= 10000)
    throw new AppError('SESSION_LIMIT', 'salt 重放检测容量已满，请稍后重试');
  salts.set(id, now + 600000);
}
export async function ssOutbound(
  wire: Duplex,
  node: Extract<ProxyNode, { type: 'ss' }>,
  target: Destination,
  signal: AbortSignal,
): Promise<Duplex> {
  const size = node.cipher === 'aes-128-gcm' ? 16 : 32;
  const algorithm =
    node.cipher === 'chacha20-ietf-poly1305'
      ? 'chacha20-poly1305'
      : node.cipher;
  const master = masterKey(node.password, size);
  const salt = randomBytes(size);
  remember(master, salt);
  const key = ssSubkey(master, salt),
    nonce = Buffer.alloc(12);
  const encode = async (data: Buffer) => {
    for (let i = 0; i < data.length; i += 0x3fff) {
      const chunk = data.subarray(i, i + 0x3fff);
      const length = seal(algorithm, key, nonce, u16(chunk.length));
      incrementLE(nonce);
      const payload = seal(algorithm, key, nonce, chunk);
      incrementLE(nonce);
      await write(wire, Buffer.concat([length, payload]));
    }
  };
  await write(wire, salt);
  await encode(Buffer.concat([address(target.host), u16(target.port)]));
  const reader = new ByteReader(wire, signal, 120000);
  async function* decode() {
    const received = await reader.read(size, true);
    if (!received) return;
    remember(master, received);
    const responseKey = ssSubkey(master, received);
    const responseNonce = Buffer.alloc(12);
    for (;;) {
      const encrypted = await reader.read(18, true);
      if (!encrypted) return;
      const length = open(
        algorithm,
        responseKey,
        responseNonce,
        encrypted,
      ).readUInt16BE();
      incrementLE(responseNonce);
      invariant(length <= 0x3fff, 'SS 帧长度无效');
      const payload = open(
        algorithm,
        responseKey,
        responseNonce,
        await reader.exact(length + 16),
      );
      incrementLE(responseNonce);
      if (payload.length) yield payload;
    }
  }
  const output = Readable.from(decode(), { objectMode: false });
  const input = new Writable({
    write(data: Buffer, _encoding, cb) {
      encode(data).then(() => cb(), cb);
    },
    final(cb) {
      wire.end(cb);
    },
  });
  const stream = guardStream(
    Duplex.from({ readable: output, writable: input }),
    signal,
  );
  wire.on('error', (e) => stream.destroy(e));
  stream.once('close', () => wire.destroy());
  return stream;
}
