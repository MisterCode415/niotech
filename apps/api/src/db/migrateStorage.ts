/**
 * One-time copy of lab PDFs from the VM's local volume into the Azure Blob container.
 *
 * Run inside the API container after switching STORAGE_DRIVER to azure_blob:
 *   docker compose ... run --rm api pnpm storage:migrate
 *
 * Safe to re-run: a blob that already exists with the expected size is skipped. It prints counts
 * only, never file names or patient data. The local volume is left untouched.
 */
import { env } from '../env.js';
import { AzureBlobStorageDriver, LocalStorageDriver, type StorageDriver } from '../services/storage.js';
import { closeDb, withPlatformScope } from './client.js';
import { files } from './schema.js';

export interface CopyResult {
  copied: number;
  skipped: number;
  missingLocally: number;
  sizeMismatch: number;
}

export async function copyFiles(
  rows: Array<{ storageKey: string; sizeBytes: number }>,
  source: StorageDriver,
  target: StorageDriver,
): Promise<CopyResult> {
  const result: CopyResult = { copied: 0, skipped: 0, missingLocally: 0, sizeMismatch: 0 };
  for (const row of rows) {
    if (await target.exists(row.storageKey)) {
      // Already present (earlier run, or uploaded through the blob driver after the switch).
      result.skipped += 1;
      continue;
    }
    let bytes: Buffer;
    try {
      bytes = await source.get(row.storageKey);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        result.missingLocally += 1;
        continue;
      }
      throw error;
    }
    if (bytes.byteLength !== row.sizeBytes) {
      // Do not copy something that does not match what the database recorded.
      result.sizeMismatch += 1;
      continue;
    }
    await target.put(row.storageKey, bytes, 'application/pdf');
    result.copied += 1;
  }
  return result;
}

async function main() {
  if (env.STORAGE_DRIVER !== 'azure_blob') {
    throw new Error('Set STORAGE_DRIVER=azure_blob (and the account URL) before migrating');
  }
  const rows = await withPlatformScope((tx) =>
    tx.select({ storageKey: files.storageKey, sizeBytes: files.sizeBytes }).from(files),
  );
  const result = await copyFiles(rows, new LocalStorageDriver(), AzureBlobStorageDriver.fromEnv());
  console.log(`files in database: ${rows.length}`);
  console.log(JSON.stringify(result));
  if (result.missingLocally > 0 || result.sizeMismatch > 0) {
    console.error('Some files could not be copied; investigate before removing the local volume.');
    process.exitCode = 1;
  }
}

// Only run when invoked directly, so tests can import copyFiles.
if (process.argv[1]?.endsWith('migrateStorage.ts')) {
  main()
    .catch((error) => {
      console.error(error instanceof Error ? error.message : error);
      process.exitCode = 1;
    })
    .finally(() => closeDb());
}
