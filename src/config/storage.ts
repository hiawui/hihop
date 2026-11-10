import { randomBytes } from 'node:crypto';
import { mkdir, chmod, open, rename, readFile, unlink } from 'node:fs/promises';
import path from 'node:path';
import {
  initialConfig,
  validateConfig,
  migrateConfig,
  validateSettings,
  type Settings,
} from './model.js';

export async function privateDirectory(dir: string) {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700);
}
export async function atomicSave(file: string, content: string): Promise<void> {
  await privateDirectory(path.dirname(file));
  const temp = `${file}.${randomBytes(8).toString('hex')}.tmp`;
  try {
    const handle = await open(temp, 'wx', 0o600);
    try {
      await handle.writeFile(content, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temp, file);
  } finally {
    await unlink(temp).catch(() => {});
  }
}
export class ConfigStore {
  constructor(readonly file: string) {}
  async load(): Promise<Settings> {
    try {
      const data = JSON.parse(await readFile(this.file, 'utf8'));
      return data.schemaVersion === 1
        ? migrateConfig(validateConfig(data))
        : validateSettings(data);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT')
        return migrateConfig(initialConfig(), 'auto');
      throw error;
    }
  }
  async save(config: Settings) {
    await atomicSave(this.file, JSON.stringify(config, null, 2));
  }
}
export async function adminToken(file: string) {
  try {
    const value = (await readFile(file, 'utf8')).trim();
    if (!/^[a-f0-9]{64}$/.test(value))
      throw new Error('Invalid administrator token file');
    await chmod(file, 0o600);
    return value;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    const value = randomBytes(32).toString('hex');
    await atomicSave(file, value + '\n');
    return value;
  }
}
