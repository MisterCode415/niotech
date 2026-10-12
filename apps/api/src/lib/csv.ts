/**
 * Minimal RFC 4180 CSV writer. Cells that start with a formula character get a leading apostrophe
 * so a spreadsheet shows them as text instead of evaluating them: audit exports carry names and
 * messages that users typed, and a "=HYPERLINK(...)" must not run when an auditor opens the file.
 */
function cell(value: unknown): string {
  if (value === null || value === undefined) return '';
  let text = value instanceof Date ? value.toISOString() : String(value);
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function toCsv<T extends Record<string, unknown>>(
  columns: ReadonlyArray<keyof T & string>,
  rows: readonly T[],
): string {
  const lines = [columns.join(',')];
  for (const row of rows) lines.push(columns.map((column) => cell(row[column])).join(','));
  return `${lines.join('\r\n')}\r\n`;
}
