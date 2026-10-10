const SERIAL_ALPHABET = /^[0-9A-HJKMNP-TV-Z]{8}$/;

/**
 * Turns whatever someone typed off a kit label into its canonical `QK-XXXX-XXXX` form, or null.
 * Case, spaces and dashes are ignored, and the letters people confuse with digits (O, I, L) are
 * read as the digits they resemble, matching how the serial alphabet was chosen.
 */
export function normalizeKitSerial(input: string): string | null {
  let code = input.toUpperCase().replace(/[^0-9A-Z]/g, '');
  if (code.length === 10 && code.startsWith('QK')) code = code.slice(2);
  code = code.replace(/O/g, '0').replace(/[IL]/g, '1');
  if (!SERIAL_ALPHABET.test(code)) return null;
  return `QK-${code.slice(0, 4)}-${code.slice(4)}`;
}
