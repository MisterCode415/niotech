import { mkdir, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { BlobServiceClient, type ContainerClient } from '@azure/storage-blob';
import { DefaultAzureCredential } from '@azure/identity';
import { env, storageRoot } from '../env.js';

/**
 * Lab results are PHI, so bytes are written outside the web root and are only ever served
 * through an authenticated, tenant-checked route. Production uses an Azure Blob container
 * (encrypted, versioned, soft-delete protected); the local driver is for development and tests.
 */
export interface StorageDriver {
  put(key: string, data: Buffer, contentType?: string): Promise<void>;
  get(key: string): Promise<Buffer>;
  exists(key: string): Promise<boolean>;
}

export class LocalStorageDriver implements StorageDriver {
  constructor(private readonly root: string = storageRoot) {}

  async put(key: string, data: Buffer): Promise<void> {
    const target = this.resolve(key);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, data);
  }

  async get(key: string): Promise<Buffer> {
    return readFile(this.resolve(key));
  }

  async exists(key: string): Promise<boolean> {
    try {
      await readFile(this.resolve(key));
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw error;
    }
  }

  private resolve(key: string): string {
    const target = path.resolve(this.root, key);
    // Storage keys are server-generated, but a traversal here would expose the whole disk.
    if (!target.startsWith(path.resolve(this.root) + path.sep)) {
      throw new Error('Invalid storage key');
    }
    return target;
  }
}

/** The slice of ContainerClient the driver uses, so tests can substitute a fake. */
export type BlobContainer = Pick<ContainerClient, 'getBlockBlobClient'>;

/**
 * Azure Blob driver. Authenticates with the VM's managed identity (DefaultAzureCredential), so
 * there is no account key or connection string to leak. Writes never overwrite: a key that
 * already exists is an error, which keeps earlier PHI bytes intact even if a key were ever reused.
 */
export class AzureBlobStorageDriver implements StorageDriver {
  constructor(private readonly container: BlobContainer) {}

  static fromEnv(): AzureBlobStorageDriver {
    if (!env.AZURE_STORAGE_ACCOUNT_URL) {
      throw new Error('AZURE_STORAGE_ACCOUNT_URL is required when STORAGE_DRIVER=azure_blob');
    }
    const service = new BlobServiceClient(env.AZURE_STORAGE_ACCOUNT_URL, new DefaultAzureCredential());
    return new AzureBlobStorageDriver(service.getContainerClient(env.AZURE_STORAGE_CONTAINER));
  }

  async put(key: string, data: Buffer, contentType = 'application/octet-stream'): Promise<void> {
    this.assertKey(key);
    await this.container.getBlockBlobClient(key).uploadData(data, {
      blobHTTPHeaders: { blobContentType: contentType },
      conditions: { ifNoneMatch: '*' },
    });
  }

  async get(key: string): Promise<Buffer> {
    this.assertKey(key);
    return this.container.getBlockBlobClient(key).downloadToBuffer();
  }

  async exists(key: string): Promise<boolean> {
    this.assertKey(key);
    return this.container.getBlockBlobClient(key).exists();
  }

  private assertKey(key: string): void {
    // Blob names are not paths, but keys are server-generated "<buId>/<uuid>.<ext>"; refuse
    // anything else rather than let a malformed key address an unexpected blob.
    if (key.startsWith('/') || key.split('/').some((part) => part === '..' || part === '')) {
      throw new Error('Invalid storage key');
    }
  }
}

function createStorage(): StorageDriver {
  return env.STORAGE_DRIVER === 'azure_blob'
    ? AzureBlobStorageDriver.fromEnv()
    : new LocalStorageDriver();
}

export const storage: StorageDriver = createStorage();
