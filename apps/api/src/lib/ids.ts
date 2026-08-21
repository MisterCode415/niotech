import { randomBytes, randomUUID } from 'node:crypto';

/** Base32 without I/L/O/U so printed order numbers cannot be misread off a label. */
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

function randomCode(length: number): string {
  const bytes = randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i += 1) {
    out += ALPHABET[bytes[i]! % ALPHABET.length];
  }
  return out;
}

export function generateOrderNumber(): string {
  const year = new Date().getUTCFullYear();
  return `NIO-${year}-${randomCode(6)}`;
}

/** 128 bits of entropy: the QR token is the only thing guarding a kit's scan endpoint. */
export function generateQrToken(): string {
  return randomBytes(16).toString('base64url');
}

export function generateStorageKey(businessUnitId: string, filename: string): string {
  const ext = filename.includes('.') ? `.${filename.split('.').pop()}` : '';
  return `${businessUnitId}/${randomUUID()}${ext}`;
}
