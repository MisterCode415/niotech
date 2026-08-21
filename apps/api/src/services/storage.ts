import { mkdir, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { storageRoot } from '../env.js';

/**
 * Lab results are PHI, so bytes are written outside the web root and are only ever served
 * through an authenticated, tenant-checked route. The interface is shaped like an object store
 * so swapping in S3 later is a driver change rather than a call-site change.
 */
export interface StorageDriver {
  put(key: string, data: Buffer): Promise<void>;
  get(key: string): Promise<Buffer>;
}

class LocalStorageDriver implements StorageDriver {
  async put(key: string, data: Buffer): Promise<void> {
    const target = this.resolve(key);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, data);
  }

  async get(key: string): Promise<Buffer> {
    return readFile(this.resolve(key));
  }

  private resolve(key: string): string {
    const target = path.resolve(storageRoot, key);
    // Storage keys are server-generated, but a traversal here would expose the whole disk.
    if (!target.startsWith(path.resolve(storageRoot) + path.sep)) {
      throw new Error('Invalid storage key');
    }
    return target;
  }
}

export const storage: StorageDriver = new LocalStorageDriver();
