export class AppError extends Error {
  constructor(
    public code: string,
    message: string,
    public status = 400,
    public path?: string,
    public line?: number,
  ) {
    super(message);
  }
}
export function invariant(
  value: unknown,
  message: string,
  path?: string,
): asserts value {
  if (!value) throw new AppError('INVALID_CONFIG', message, 400, path);
}
export function abortable<T>(
  promise: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  if (signal.aborted) {
    void promise.catch(() => {});
    return Promise.reject(new AppError('ABORT_ERR', '操作已取消或超时'));
  }
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(new AppError('ABORT_ERR', '操作已取消或超时'));
    signal.addEventListener('abort', abort, { once: true });
    promise
      .then(resolve, reject)
      .finally(() => signal.removeEventListener('abort', abort));
  });
}
export function safeError(error: unknown): {
  code: string;
  message: string;
  path?: string;
  line?: number;
} {
  if (error instanceof AppError)
    return {
      code: error.code,
      message: error.message,
      path: error.path,
      line: error.line,
    };
  const code = (error as NodeJS.ErrnoException)?.code;
  const messages: Record<string, string> = {
    EADDRINUSE: '监听端口已被占用',
    EACCES: '没有访问权限',
    ECONNREFUSED: '连接被拒绝',
    ETIMEDOUT: '连接超时',
    ENOTFOUND: '域名解析失败',
    ECONNRESET: '连接已重置',
    ABORT_ERR: '操作已取消',
    ENOENT: '所需文件不存在',
  };
  return {
    code: code && code in messages ? code : 'OPERATION_FAILED',
    message:
      (code && messages[code]) ||
      '操作失败，请检查配置、网络或协议认证（VMess 请检查系统时间）',
  };
}
