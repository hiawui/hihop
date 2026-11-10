import { createCipheriv, createDecipheriv, createHash } from 'node:crypto';
import { AppError } from '../../errors.js';
export const hash = (name: string, ...parts: Buffer[]) =>
  createHash(name).update(Buffer.concat(parts)).digest();
export function seal(
  algorithm: string,
  key: Buffer,
  nonce: Buffer,
  data: Buffer,
  aad?: Buffer,
): Buffer {
  const cipher = createCipheriv(algorithm, key, nonce, {
    authTagLength: 16,
  } as any) as ReturnType<typeof createCipheriv> & {
    setAAD(v: Buffer): void;
    getAuthTag(): Buffer;
  };
  if (aad) cipher.setAAD(aad);
  return Buffer.concat([
    cipher.update(data),
    cipher.final(),
    cipher.getAuthTag(),
  ]);
}
export function open(
  algorithm: string,
  key: Buffer,
  nonce: Buffer,
  data: Buffer,
  aad?: Buffer,
): Buffer {
  try {
    if (data.length < 16) throw new Error();
    const cipher = createDecipheriv(algorithm, key, nonce, {
      authTagLength: 16,
    } as any) as ReturnType<typeof createDecipheriv> & {
      setAAD(v: Buffer): void;
      setAuthTag(v: Buffer): void;
    };
    if (aad) cipher.setAAD(aad);
    cipher.setAuthTag(data.subarray(-16));
    return Buffer.concat([
      cipher.update(data.subarray(0, -16)),
      cipher.final(),
    ]);
  } catch {
    throw new AppError(
      'AUTH_FAILED',
      '代理数据认证失败，请检查节点凭据与系统时间',
    );
  }
}
export function incrementLE(nonce: Buffer): void {
  for (let i = 0; i < nonce.length; i++) {
    nonce[i] = (nonce[i] + 1) & 255;
    if (nonce[i]) return;
  }
  throw new AppError('COUNTER_EXHAUSTED', '会话计数器耗尽');
}
