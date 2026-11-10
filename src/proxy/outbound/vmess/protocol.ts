import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
  randomInt,
} from 'node:crypto';
import { Duplex, Readable, Writable } from 'node:stream';
import { type Destination, type ProxyNode } from '../../../config/model.js';
import { AppError, invariant } from '../../../errors.js';
import {
  address,
  ByteReader,
  guardStream,
  u16,
  write,
} from '../../codec/bytes.js';
import { hash, open, seal } from '../crypto.js';

type Digest = (data: Buffer) => Buffer;
function hmacWith(digest: Digest, key: Buffer): Digest {
  if (key.length > 64) key = digest(key);
  const inner = Buffer.alloc(64, 0x36),
    outer = Buffer.alloc(64, 0x5c);
  for (let i = 0; i < key.length; i++) {
    inner[i] ^= key[i];
    outer[i] ^= key[i];
  }
  return (data) =>
    digest(Buffer.concat([outer, digest(Buffer.concat([inner, data]))]));
}
export function kdf(key: Buffer, ...paths: (Buffer | string)[]): Buffer {
  let digest = hmacWith(
    (data) => hash('sha256', data),
    Buffer.from('VMess AEAD KDF'),
  );
  for (const path of paths) digest = hmacWith(digest, Buffer.from(path));
  return digest(key);
}
export function fnv1a(data: Buffer): Buffer {
  let value = 0x811c9dc5;
  for (const byte of data) value = Math.imul(value ^ byte, 0x01000193) >>> 0;
  const result = Buffer.alloc(4);
  result.writeUInt32BE(value);
  return result;
}
export function crc32(data: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let j = 0; j < 8; j++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
export function alterIds(uuid: Buffer, count: number): Buffer[] {
  const ids: Buffer[] = [];
  let previous = uuid;
  for (let i = 0; i < count; i++) {
    let data = Buffer.concat([
      previous,
      Buffer.from('16167dc8-16b6-4e6d-b8bb-65dd68113a81'),
    ]);
    let next = hash('md5', data);
    while (next.equals(previous)) {
      data = Buffer.concat([
        data,
        Buffer.from('533eff8a-4113-4b10-b5ce-0f5d76b98cd2'),
      ]);
      next = hash('md5', data);
    }
    ids.push(next);
    previous = next;
  }
  return ids;
}
export function aeadHeader(
  commandKey: Buffer,
  header: Buffer,
  timestamp: bigint,
  random: Buffer,
  nonce: Buffer,
): Buffer {
  const auth = Buffer.alloc(16);
  auth.writeBigUInt64BE(timestamp);
  random.copy(auth, 8, 0, 4);
  auth.writeUInt32BE(crc32(auth.subarray(0, 12)), 12);
  const aes = createCipheriv(
    'aes-128-ecb',
    kdf(commandKey, 'AES Auth ID Encryption').subarray(0, 16),
    null,
  );
  aes.setAutoPadding(false);
  const id = Buffer.concat([aes.update(auth), aes.final()]);
  const length = seal(
    'aes-128-gcm',
    kdf(commandKey, 'VMess Header AEAD Key_Length', id, nonce).subarray(0, 16),
    kdf(commandKey, 'VMess Header AEAD Nonce_Length', id, nonce).subarray(
      0,
      12,
    ),
    u16(header.length),
    id,
  );
  const payload = seal(
    'aes-128-gcm',
    kdf(commandKey, 'VMess Header AEAD Key', id, nonce).subarray(0, 16),
    kdf(commandKey, 'VMess Header AEAD Nonce', id, nonce).subarray(0, 12),
    header,
    id,
  );
  return Buffer.concat([id, length, nonce, payload]);
}
export type SessionMaterial = {
  key: Buffer;
  iv: Buffer;
  response: number;
  time: bigint;
  authRandom: Buffer;
  headerNonce: Buffer;
};
export function vmessRequest(
  node: Extract<ProxyNode, { type: 'vmess' }>,
  destination: Destination,
  material: SessionMaterial,
): Buffer {
  const uuid = Buffer.from(node.uuid.replaceAll('-', ''), 'hex');
  const commandKey = hash(
    'md5',
    uuid,
    Buffer.from('c48619fe-8f02-49e0-b9e9-edf763e17e21'),
  );
  // S=1 only: AES-GCM chunks with plain uint16 lengths; masking/padding disabled.
  const content = Buffer.concat([
    Buffer.from([1]),
    material.iv,
    material.key,
    Buffer.from([material.response, 1, 3, 0, 1]),
    u16(destination.port),
    address(destination.host, true),
  ]);
  const header = Buffer.concat([content, fnv1a(content)]);
  if (!node.alterId)
    return aeadHeader(
      commandKey,
      header,
      material.time,
      material.authRandom,
      material.headerNonce,
    );
  const time = Buffer.alloc(8);
  time.writeBigUInt64BE(material.time);
  const ids = alterIds(uuid, node.alterId);
  const auth = createHmac('md5', ids[0]).update(time).digest();
  const iv = hash('md5', time, time, time, time);
  const cipher = createCipheriv('aes-128-cfb', commandKey, iv);
  return Buffer.concat([auth, cipher.update(header), cipher.final()]);
}
export function bodyNonce(iv: Buffer, counter: number): Buffer {
  if (counter > 65535)
    throw new AppError('COUNTER_EXHAUSTED', 'VMess 会话计数器耗尽，请重新连接');
  const nonce = Buffer.from(iv.subarray(0, 12));
  nonce.writeUInt16BE(counter);
  return nonce;
}
export async function vmessOutbound(
  wire: Duplex,
  node: Extract<ProxyNode, { type: 'vmess' }>,
  target: Destination,
  signal: AbortSignal,
): Promise<Duplex> {
  const material = {
    key: randomBytes(16),
    iv: randomBytes(16),
    response: randomInt(256),
    time: BigInt(Math.floor(Date.now() / 1000)),
    authRandom: randomBytes(4),
    headerNonce: randomBytes(8),
  };
  await write(wire, vmessRequest(node, target, material));
  const responseKey = hash(
    node.alterId ? 'md5' : 'sha256',
    material.key,
  ).subarray(0, 16);
  const responseIv = hash(
    node.alterId ? 'md5' : 'sha256',
    material.iv,
  ).subarray(0, 16);
  let sent = 0;
  const encode = async (data: Buffer) => {
    for (let i = 0; i < data.length; i += 16368) {
      const payload = seal(
        'aes-128-gcm',
        material.key,
        bodyNonce(material.iv, sent++),
        data.subarray(i, i + 16368),
      );
      await write(wire, Buffer.concat([u16(payload.length), payload]));
    }
  };
  const reader = new ByteReader(wire, signal, 120000);
  const responseOpen = (
    stage: string,
    key: Buffer,
    nonce: Buffer,
    data: Buffer,
  ) => {
    try {
      return open('aes-128-gcm', key, nonce, data);
    } catch {
      throw new AppError(
        `VMESS_${stage}_AUTH`,
        'VMess 响应认证失败，请检查节点凭据、协议版本和系统时间',
      );
    }
  };
  async function* decode() {
    let header: Buffer;
    if (!node.alterId) {
      const length = responseOpen(
        'LENGTH',
        kdf(responseKey, 'AEAD Resp Header Len Key').subarray(0, 16),
        kdf(responseIv, 'AEAD Resp Header Len IV').subarray(0, 12),
        await reader.exact(18),
      ).readUInt16BE();
      invariant(length >= 4 && length <= 1024, 'VMess 响应头长度无效');
      header = responseOpen(
        'HEADER',
        kdf(responseKey, 'AEAD Resp Header Key').subarray(0, 16),
        kdf(responseIv, 'AEAD Resp Header IV').subarray(0, 12),
        await reader.exact(length + 16),
      );
    } else {
      const cipher = createDecipheriv('aes-128-cfb', responseKey, responseIv);
      header = cipher.update(await reader.exact(4));
      if (header[3])
        header = Buffer.concat([
          header,
          cipher.update(await reader.exact(header[3])),
        ]);
    }
    invariant(
      header[0] === material.response &&
        header[1] === 0 &&
        header[2] === 0 &&
        header[3] === 0 &&
        header.length === 4,
      'VMess 响应认证失败或不支持动态端口/连接复用',
    );
    let received = 0;
    for (;;) {
      const lengthBytes = await reader.read(2, true);
      // V2Ray can close the transport at a complete frame boundary instead of sending EOS.
      if (!lengthBytes) return;
      const length = lengthBytes.readUInt16BE();
      invariant(length >= 16 && length <= 16384, 'VMess 帧长无效');
      const payload = responseOpen(
        'BODY',
        responseKey,
        bodyNonce(responseIv, received++),
        await reader.exact(length),
      );
      if (!payload.length) return;
      yield payload;
    }
  }
  const output = Readable.from(decode(), { objectMode: false });
  const input = new Writable({
    write(data: Buffer, _encoding, cb) {
      encode(data).then(() => cb(), cb);
    },
    final(cb) {
      void (async () => {
        const payload = seal(
          'aes-128-gcm',
          material.key,
          bodyNonce(material.iv, sent++),
          Buffer.alloc(0),
        );
        // VMess EOS ends the request direction. Keep WS/TLS open for the response.
        await write(wire, Buffer.concat([u16(payload.length), payload]));
      })().then(() => cb(), cb);
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
