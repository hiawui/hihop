import type { Config } from './config/model.js';
export function log(
  level: Config['logLevel'],
  severity: 'error' | 'warning' | 'info' | 'debug',
  value: { code: string; message: string },
) {
  const levels = ['silent', 'error', 'warning', 'info', 'debug'];
  if (levels.indexOf(level) >= levels.indexOf(severity))
    console[severity === 'warning' ? 'warn' : severity](
      JSON.stringify({ level: severity, ...value }),
    );
}
