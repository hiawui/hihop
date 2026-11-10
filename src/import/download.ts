import http from 'node:http';
import https from 'node:https';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { createGunzip, createInflate, createBrotliDecompress } from 'node:zlib';
import ipaddr from 'ipaddr.js';
import { AppError, invariant, abortable } from '../errors.js';
import { MAX_BYTES } from './clash.js';

export function publicAddress(ip: string): boolean {
  try {
    return ipaddr.process(ip).range() === 'unicast';
  } catch {
    return false;
  }
}
// Injectable I/O is used by local adversarial HTTP tests. The API always uses defaults.
export type DownloadIO = {
  lookup: (host: string) => Promise<{ address: string; family: number }[]>;
  get: (
    url: URL,
    options: http.RequestOptions,
    callback: (res: http.IncomingMessage) => void,
  ) => http.ClientRequest;
  timeoutMs: number;
};
export async function downloadConfig(
  input: string,
  signal?: AbortSignal,
  io: Partial<DownloadIO> = {},
): Promise<string> {
  invariant(input.length <= 8192, '配置 URL 超过长度限制');
  const deadline = AbortSignal.any([
    AbortSignal.timeout(io.timeoutMs ?? 15000),
    ...(signal ? [signal] : []),
  ]);
  let next = input;
  for (let redirects = 0; redirects <= 3; redirects++) {
    let url: URL;
    try {
      url = new URL(next);
    } catch {
      throw new AppError('INVALID_URL', 'URL 无效');
    }
    invariant(
      ['http:', 'https:'].includes(url.protocol) &&
        !url.username &&
        !url.password &&
        !url.hash,
      '仅允许不含认证信息的 HTTP(S) URL',
    );
    const hostname = url.hostname.replace(/^\[|\]$/g, '');
    const results = isIP(hostname)
      ? [{ address: hostname, family: isIP(hostname) }]
      : await abortable(
          (io.lookup ?? ((host) => lookup(host, { all: true })))(hostname),
          deadline,
        );
    deadline.throwIfAborted();
    invariant(
      results.length && results.every((r) => publicAddress(r.address)),
      '配置下载仅允许公网地址',
    );
    const chosen = results[0];
    const response = await new Promise<http.IncomingMessage>(
      (resolve, reject) => {
        const request = (
          io.get ??
          ((url, options, callback) =>
            (url.protocol === 'https:' ? https : http).get(
              url,
              options,
              callback,
            ))
        )(
          url,
          {
            signal: deadline,
            agent: false,
            family: chosen.family,
            headers: {
              Accept: 'application/yaml,text/yaml,text/plain',
              'Accept-Encoding': 'gzip, deflate, br',
            },
            lookup: (_host, _opts, cb) =>
              cb(null, chosen.address, chosen.family),
          },
          resolve,
        );
        request.on('error', () =>
          reject(new AppError('DOWNLOAD_FAILED', '配置下载失败或超时', 502)),
        );
      },
    );
    if ([301, 302, 303, 307, 308].includes(response.statusCode!)) {
      response.destroy();
      invariant(
        redirects < 3 && response.headers.location,
        '重定向次数超限或缺少位置',
      );
      const redirect = new URL(response.headers.location, url);
      invariant(
        !(url.protocol === 'https:' && redirect.protocol !== 'https:'),
        'HTTPS 不允许降级',
      );
      next = redirect.href;
      continue;
    }
    if (response.statusCode !== 200) {
      response.destroy();
      throw new AppError('DOWNLOAD_STATUS', '配置服务器未返回成功响应', 502);
    }
    const length = Number(response.headers['content-length'] ?? 0);
    if (length > MAX_BYTES) {
      response.destroy();
      throw new AppError('TOO_LARGE', '配置超过 2 MiB', 413);
    }
    const encoding = response.headers['content-encoding'];
    const unzip =
      encoding === 'gzip'
        ? createGunzip()
        : encoding === 'deflate'
          ? createInflate()
          : encoding === 'br'
            ? createBrotliDecompress()
            : undefined;
    if (encoding && encoding !== 'identity' && !unzip) {
      response.destroy();
      throw new AppError('DOWNLOAD_ENCODING', '不支持的响应压缩');
    }
    let wireBytes = 0;
    response.on('data', (chunk: Buffer) => {
      wireBytes += chunk.length;
      if (wireBytes > MAX_BYTES)
        response.destroy(new AppError('TOO_LARGE', '配置超过 2 MiB', 413));
    });
    const stream = unzip ? response.pipe(unzip) : response;
    if (unzip) response.on('error', (e) => unzip.destroy(e));
    const chunks: Buffer[] = [];
    let size = 0;
    try {
      for await (const chunk of stream) {
        size += chunk.length;
        if (size > MAX_BYTES)
          throw new AppError('TOO_LARGE', '解压后的配置超过 2 MiB', 413);
        chunks.push(Buffer.from(chunk));
      }
      return new TextDecoder('utf-8', { fatal: true }).decode(
        Buffer.concat(chunks),
      );
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError('DOWNLOAD_FAILED', '下载未完整完成或编码无效', 502);
    } finally {
      response.destroy();
      unzip?.destroy();
    }
  }
  throw new AppError('DOWNLOAD_FAILED', '重定向次数超限', 502);
}
