import { timingSafeEqual } from 'node:crypto';
import type { Socket } from 'node:net';
import type { Duplex } from 'node:stream';
import { AppError, invariant } from '../../errors.js';
import type { Config, Destination } from '../../config/model.js';
import { ByteReader, readAddress, write } from '../codec/bytes.js';

const equal = (a: Buffer, b: string) => {
  const value = Buffer.from(b);
  return a.length === value.length && timingSafeEqual(a, value);
};
export async function socksHandshake(
  socket: Socket,
  config: Config,
  signal: AbortSignal,
): Promise<Destination> {
  const reader = new ByteReader(socket, signal);
  const greeting = await reader.exact(2);
  invariant(greeting[0] === 5 && greeting[1] > 0, '仅支持 SOCKS5');
  const methods = await reader.exact(greeting[1]);
  const method = config.socks.auth ? 2 : 0;
  if (!methods.includes(method)) {
    await write(socket, Buffer.from([5, 255]));
    throw new AppError('SOCKS_AUTH', '未提供所需认证方法');
  }
  await write(socket, Buffer.from([5, method]));
  if (config.socks.auth) {
    const version = (await reader.exact(1))[0];
    const username = await reader.exact((await reader.exact(1))[0]);
    const password = await reader.exact((await reader.exact(1))[0]);
    const valid =
      version === 1 &&
      equal(username, config.socks.auth.username) &&
      equal(password, config.socks.auth.password);
    await write(socket, Buffer.from([1, valid ? 0 : 1]));
    if (!valid) throw new AppError('SOCKS_AUTH', 'SOCKS5 认证失败');
  }
  const request = await reader.exact(4);
  if (request[0] !== 5 || request[2] !== 0) {
    await socksReply(socket, 1);
    throw new AppError('SOCKS_REQUEST', '无效 SOCKS5 请求');
  }
  if (request[1] !== 1) {
    await socksReply(socket, 7);
    throw new AppError('SOCKS_COMMAND', '仅支持 TCP CONNECT');
  }
  if (![1, 3, 4].includes(request[3])) {
    await socksReply(socket, 8);
    throw new AppError('SOCKS_REQUEST', '不支持的地址类型');
  }
  const host = await readAddress(reader, request[3]);
  const port = (await reader.exact(2)).readUInt16BE();
  invariant(port !== 0, '目标端口不能为 0');
  reader.release();
  return { host, port };
}
export async function socksReply(socket: Socket, code: number): Promise<void> {
  await write(socket, Buffer.from([5, code, 0, 1, 0, 0, 0, 0, 0, 0]));
}
export function connectStreams(
  client: Socket,
  outbound: Duplex,
  signal: AbortSignal,
): void {
  const close = () => {
    client.destroy();
    outbound.destroy();
  };
  signal.addEventListener('abort', close, { once: true });
  client.once('error', close);
  outbound.once('error', close);
  client.once('close', () => {
    outbound.destroy();
    signal.removeEventListener('abort', close);
  });
  outbound.once('close', () => {
    if (!outbound.readableEnded || !outbound.writableFinished) client.destroy();
  });
  client.pipe(outbound);
  outbound.pipe(client);
}
