/**
 * One-time pass that encrypts report text and chat content written before application-level PHI
 * encryption existed.
 *
 *   pnpm db:encrypt-phi
 *
 * Safe to re-run: values already carrying the enc:v1 prefix are skipped. It prints counts only.
 */
import { eq } from 'drizzle-orm';
import { encryptPhi, isEncryptedPhi } from '../lib/phiCrypto.js';
import { closeDb, withPlatformScope } from './client.js';
import { fileExtractions, reportConversations, reportMessages } from './schema.js';

export interface EncryptResult {
  extractions: number;
  messages: number;
  titles: number;
}

export async function encryptPlaintextPhi(): Promise<EncryptResult> {
  return withPlatformScope(async (tx) => {
    const result: EncryptResult = { extractions: 0, messages: 0, titles: 0 };

    const extractions = await tx
      .select({ id: fileExtractions.id, value: fileExtractions.extractedText })
      .from(fileExtractions);
    for (const row of extractions) {
      if (isEncryptedPhi(row.value)) continue;
      await tx
        .update(fileExtractions)
        .set({ extractedText: encryptPhi(row.value) })
        .where(eq(fileExtractions.id, row.id));
      result.extractions += 1;
    }

    const messages = await tx
      .select({ id: reportMessages.id, value: reportMessages.content })
      .from(reportMessages);
    for (const row of messages) {
      if (isEncryptedPhi(row.value)) continue;
      await tx
        .update(reportMessages)
        .set({ content: encryptPhi(row.value) })
        .where(eq(reportMessages.id, row.id));
      result.messages += 1;
    }

    const titles = await tx
      .select({ id: reportConversations.id, value: reportConversations.title })
      .from(reportConversations);
    for (const row of titles) {
      if (!row.value || isEncryptedPhi(row.value)) continue;
      await tx
        .update(reportConversations)
        .set({ title: encryptPhi(row.value) })
        .where(eq(reportConversations.id, row.id));
      result.titles += 1;
    }

    return result;
  });
}

if (process.argv[1]?.endsWith('encryptPhi.ts')) {
  encryptPlaintextPhi()
    .then((result) => console.log(JSON.stringify(result)))
    .catch((error) => {
      console.error(error instanceof Error ? error.message : error);
      process.exitCode = 1;
    })
    .finally(() => closeDb());
}
