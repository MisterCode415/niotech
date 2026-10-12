import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';
import { env } from '../env.js';

const ALGO = 'aes-256-gcm';

function encryptionKey(): Buffer {
  if (/^[0-9a-f]{64}$/i.test(env.APP_ENCRYPTION_KEY)) {
    return Buffer.from(env.APP_ENCRYPTION_KEY, 'hex');
  }
  return scryptSync(env.APP_ENCRYPTION_KEY, 'qinio-llm-keys', 32);
}

export function encryptSecret(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGO, encryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return `${iv.toString('base64')}.${cipher.getAuthTag().toString('base64')}.${encrypted.toString('base64')}`;
}

export function decryptSecret(stored: string): string {
  if (!stored) return '';
  const [iv, tag, data] = stored.split('.');
  if (!iv || !tag || !data) return '';
  const decipher = createDecipheriv(ALGO, encryptionKey(), Buffer.from(iv, 'base64'));
  decipher.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(data, 'base64')), decipher.final()]).toString(
    'utf8',
  );
}

export function maskSecret(plain: string): string {
  if (!plain) return '';
  if (plain.length <= 8) return '••••';
  return `${plain.slice(0, 3)}••••${plain.slice(-4)}`;
}
