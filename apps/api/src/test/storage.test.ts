import { describe, it, expect } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { productionStorageProblems } from '../env.js';
import {
  AzureBlobStorageDriver,
  LocalStorageDriver,
  type BlobContainer,
} from '../services/storage.js';
import { copyFiles } from '../db/migrateStorage.js';

/** In-memory stand-in for a blob container with the same create-only semantics. */
function fakeContainer() {
  const blobs = new Map<string, { data: Buffer; contentType?: string }>();
  const container = {
    getBlockBlobClient(key: string) {
      return {
        async uploadData(
          data: Buffer,
          options: {
            blobHTTPHeaders?: { blobContentType?: string };
            conditions?: { ifNoneMatch?: string };
          },
        ) {
          if (options.conditions?.ifNoneMatch === '*' && blobs.has(key)) {
            throw Object.assign(new Error('BlobAlreadyExists'), { statusCode: 409 });
          }
          blobs.set(key, { data, contentType: options.blobHTTPHeaders?.blobContentType });
        },
        async downloadToBuffer() {
          const blob = blobs.get(key);
          if (!blob) throw Object.assign(new Error('BlobNotFound'), { statusCode: 404 });
          return blob.data;
        },
        async exists() {
          return blobs.has(key);
        },
      };
    },
  } as unknown as BlobContainer;
  return { container, blobs };
}

describe('AzureBlobStorageDriver', () => {
  it('stores bytes with a content type and returns them', async () => {
    const { container, blobs } = fakeContainer();
    const driver = new AzureBlobStorageDriver(container);
    await driver.put('bu-1/a.pdf', Buffer.from('pdf'), 'application/pdf');
    expect(blobs.get('bu-1/a.pdf')?.contentType).toBe('application/pdf');
    expect((await driver.get('bu-1/a.pdf')).toString()).toBe('pdf');
    expect(await driver.exists('bu-1/a.pdf')).toBe(true);
    expect(await driver.exists('bu-1/other.pdf')).toBe(false);
  });

  it('refuses to overwrite an existing blob', async () => {
    const { container, blobs } = fakeContainer();
    const driver = new AzureBlobStorageDriver(container);
    await driver.put('bu-1/a.pdf', Buffer.from('first'));
    await expect(driver.put('bu-1/a.pdf', Buffer.from('second'))).rejects.toThrow();
    expect(blobs.get('bu-1/a.pdf')?.data.toString()).toBe('first');
  });

  it('rejects malformed keys', async () => {
    const driver = new AzureBlobStorageDriver(fakeContainer().container);
    for (const key of ['../x', '/abs', 'a//b', 'a/../b']) {
      await expect(driver.get(key)).rejects.toThrow('Invalid storage key');
    }
  });
});

describe('production storage guard', () => {
  it('refuses local storage', () => {
    expect(productionStorageProblems({ STORAGE_DRIVER: 'local' })).toHaveLength(1);
  });
  it('needs an account URL for blob storage', () => {
    expect(productionStorageProblems({ STORAGE_DRIVER: 'azure_blob' })).toHaveLength(1);
    expect(
      productionStorageProblems({
        STORAGE_DRIVER: 'azure_blob',
        AZURE_STORAGE_ACCOUNT_URL: 'https://x.blob.core.windows.net',
      }),
    ).toEqual([]);
  });
});

describe('copyFiles (storage:migrate)', () => {
  it('copies missing blobs, skips present ones, and reports problems', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'nio-storage-'));
    try {
      const local = new LocalStorageDriver(dir);
      await local.put('bu/new.pdf', Buffer.from('12345'));
      await local.put('bu/done.pdf', Buffer.from('abc'));
      await local.put('bu/wrong-size.pdf', Buffer.from('xx'));

      const { container, blobs } = fakeContainer();
      const remote = new AzureBlobStorageDriver(container);
      await remote.put('bu/done.pdf', Buffer.from('abc'));

      const rows = [
        { storageKey: 'bu/new.pdf', sizeBytes: 5 },
        { storageKey: 'bu/done.pdf', sizeBytes: 3 },
        { storageKey: 'bu/gone.pdf', sizeBytes: 9 },
        { storageKey: 'bu/wrong-size.pdf', sizeBytes: 99 },
      ];
      expect(await copyFiles(rows, local, remote)).toEqual({
        copied: 1,
        skipped: 1,
        missingLocally: 1,
        sizeMismatch: 1,
      });
      expect(blobs.get('bu/new.pdf')?.data.toString()).toBe('12345');
      expect(blobs.has('bu/wrong-size.pdf')).toBe(false);

      // Re-running changes nothing.
      expect((await copyFiles(rows, local, remote)).copied).toBe(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
