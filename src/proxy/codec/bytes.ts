import { type Duplex, type Readable, type Writable } from 'node:stream';
import { isIP } from 'node:net';
import ipaddr from 'ipaddr.js';
import { AppError, invariant } from '../../errors.js';

export const u16 = (n: number) => {
  const b = Buffer.alloc(2);
  b.writeUInt16BE(n);
  return b;
};
export class ByteReader {
  private pending = Buffer.alloc(0);
  constructor(
    public stream: Readable,
    private signal?: AbortSignal,
    private timeout = 15000,
  ) {}
  async read(n: number, eof = false): Promise<Buffer | null> {
    invariant(n >= 0 && n <= 65536, '协议长度超限');
    if (!n) return Buffer.alloc(0);
    while (this.pending.length < n) {
      this.signal?.throwIfAborted();
      const chunk = this.stream.read() as Buffer | null;
      if (chunk) {
        invariant(
          this.pending.length + chunk.length <= 2 * 1024 * 1024,
          '协议缓冲超限',
        );
        this.pending = Buffer.concat([this.pending, chunk]);
        continue;
      }
      if (this.stream.readableEnded || this.stream.destroyed) {
        if (this.stream.errored) throw this.stream.errored;
        if (eof && !this.pending.length) return null;
        throw new AppError('TRUNCATED_STREAM', '协议帧被截断');
      }
      await new Promise<void>((resolve, reject) => {
        const done = (error?: Error) => {
          clearTimeout(timer);
          this.stream.off('readable', ready);
          this.stream.off('end', ready);
          this.stream.off('close', ready);
          this.stream.off('error', failed);
          this.signal?.removeEventListener('abort', aborted);
          error ? reject(error) : resolve();
        };
        const ready = () => done();
        const failed = (e: Error) => done(e);
        const aborted = () => done(new AppError('ABORT_ERR', '操作已取消'));
        const timer = setTimeout(
          () => done(new AppError('ETIMEDOUT', '协议读取超时')),
          this.timeout,
        );
        timer.unref();
        this.stream
          .once('readable', ready)
          .once('end', ready)
          .once('close', ready)
          .once('error', failed);
        this.signal?.addEventListener('abort', aborted, { once: true });
      });
    }
    const result = this.pending.subarray(0, n);
    this.pending = this.pending.subarray(n);
    return result;
  }
  async exact(n: number): Promise<Buffer> {
    return (await this.read(n))!;
  }
  release() {
    if (this.pending.length) this.stream.unshift(this.pending);
    this.pending = Buffer.alloc(0);
  }
}
export async function write(stream: Writable, data: Buffer): Promise<void> {
  await new Promise<void>((resolve, reject) =>
    stream.write(data, (e) => (e ? reject(e) : resolve())),
  );
}
export function address(host: string, vmess = false): Buffer {
  const family = isIP(host);
  if (family)
    return Buffer.concat([
      Buffer.from([family === 4 ? 1 : vmess ? 3 : 4]),
      Buffer.from(ipaddr.parse(host).toByteArray()),
    ]);
  const name = Buffer.from(host);
  invariant(name.length > 0 && name.length <= 255, '目标域名长度无效');
  return Buffer.concat([Buffer.from([vmess ? 2 : 3, name.length]), name]);
}
export async function readAddress(
  reader: ByteReader,
  type: number,
): Promise<string> {
  if (type === 1 || type === 4)
    return ipaddr
      .fromByteArray([...(await reader.exact(type === 1 ? 4 : 16))])
      .toString();
  if (type === 3) {
    const size = (await reader.exact(1))[0];
    invariant(size > 0, '域名长度无效');
    const bytes = await reader.exact(size);
    invariant(
      bytes.every((byte) => byte >= 0x21 && byte <= 0x7e),
      '域名编码无效，请使用 ASCII / IDNA 域名',
    );
    const name = bytes.toString('ascii');
    invariant(!/[\x00-\x20\x7f-\xff]/.test(name), '域名编码无效');
    return name;
  }
  throw new AppError('ADDRESS_TYPE', '不支持的地址类型');
}
export function guardStream<T extends Duplex>(
  stream: T,
  signal?: AbortSignal,
): T {
  const cancel = () => stream.destroy(new AppError('ABORT_ERR', '操作已取消'));
  stream.on('error', () => {});
  if (signal?.aborted) cancel();
  else signal?.addEventListener('abort', cancel, { once: true });
  stream.once('close', () => signal?.removeEventListener('abort', cancel));
  return stream;
}
