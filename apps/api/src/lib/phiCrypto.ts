import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';
import { env } from '../env.js';

const ALGO = 'aes-256-gcm';
const PREFIX = 'enc:v1:';

let cachedKey: Buffer | null = null;

/**
 * Separate from APP_ENCRYPTION_KEY so rotating the LLM credential key never has to re-encrypt
 * patient content, and a leak of one does not expose the other.
 */
function phiKey(): Buffer {
  if (cachedKey) return cachedKey;
  cachedKey = /^[0-9a-f]{64}$/i.test(env.PHI_ENCRYPTION_KEY)
    ? Buffer.from(env.PHI_ENCRYPTION_KEY, 'hex')
    : scryptSync(env.PHI_ENCRYPTION_KEY, 'qinio-phi-content', 32);
  return cachedKey;
}

export function isEncryptedPhi(stored: string): boolean {
  return stored.startsWith(PREFIX);
}

export function encryptPhi(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGO, phiKey(), iv);
  const encrypted = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return `${PREFIX}${iv.toString('base64')}.${cipher.getAuthTag().toString('base64')}.${encrypted.toString('base64')}`;
}

/** Rows written before encryption was introduced hold plaintext; they pass through until backfilled. */
export function decryptPhi(stored: string): string {
  if (!isEncryptedPhi(stored)) return stored;
  const [iv, tag, data] = stored.slice(PREFIX.length).split('.');
  if (!iv || !tag || data === undefined) throw new Error('Malformed encrypted PHI value');
  const decipher = createDecipheriv(ALGO, phiKey(), Buffer.from(iv, 'base64'));
  decipher.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(data, 'base64')), decipher.final()]).toString(
    'utf8',
  );
}
