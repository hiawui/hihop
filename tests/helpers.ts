import net from 'node:net';
import { once } from 'node:events';
import { ByteReader, address, u16, write } from '../src/proxy/codec/bytes.js';
export async function listen(server: net.Server, host = '127.0.0.1') {
  server.listen(0, host);
  await once(server, 'listening');
  return (server.address() as net.AddressInfo).port;
}
export async function freePort() {
  const server = net.createServer();
  const port = await listen(server);
  await new Promise<void>((r) => server.close(() => r()));
  return port;
}
export async function socks(
  port: number,
  host: string,
  targetPort: number,
  auth?: { username: string; password: string },
  firstData?: Buffer,
) {
  const socket = net.connect({ host: '127.0.0.1', port, allowHalfOpen: true });
  socket.on('error', () => {});
  await once(socket, 'connect');
  const reader = new ByteReader(socket, undefined, 10000);
  await write(socket, Buffer.from([5, 1, auth ? 2 : 0]));
  const method = await reader.exact(2);
  if (method[1] === 255) throw new Error('SOCKS no auth method');
  if (auth) {
    await write(
      socket,
      Buffer.concat([
        Buffer.from([1, Buffer.byteLength(auth.username)]),
        Buffer.from(auth.username),
        Buffer.from([Buffer.byteLength(auth.password)]),
        Buffer.from(auth.password),
      ]),
    );
    if ((await reader.exact(2))[1] !== 0) {
      socket.destroy();
      throw new Error('SOCKS auth rejected');
    }
  }
  await write(
    socket,
    Buffer.concat([
      Buffer.from([5, 1, 0]),
      address(host),
      u16(targetPort),
      firstData ?? Buffer.alloc(0),
    ]),
  );
  const response = await reader.exact(10);
  if (response[1] !== 0) {
    socket.destroy();
    throw new Error(`SOCKS rejected ${response[1]}`);
  }
  return { socket, reader };
}
