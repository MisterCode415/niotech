import type { FastifyInstance } from 'fastify';
import type { Address } from '@nio/shared';

export const TEST_ADDRESS: Address = {
  line1: '44 Cedar Street',
  line2: 'Apt 3',
  city: 'Portland',
  region: 'OR',
  postalCode: '97205',
  country: 'US',
};

export async function login(app: FastifyInstance, email: string): Promise<string> {
  const response = await app.inject({
    method: 'POST',
    url: '/api/auth/dev/login',
    payload: { email },
  });
  if (response.statusCode !== 200) {
    throw new Error(`Login failed for ${email}: ${response.statusCode} ${response.body}`);
  }
  return response.json().accessToken as string;
}

export function auth(token: string) {
  return { authorization: `Bearer ${token}` };
}

interface CallOptions {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  url: string;
  token: string;
  payload?: unknown;
  expect?: number;
}

/** Thin wrapper that fails loudly with the server's message instead of an opaque status code. */
export async function call<T = Record<string, unknown>>(
  app: FastifyInstance,
  options: CallOptions,
): Promise<T> {
  const response = await app.inject({
    method: options.method,
    url: options.url,
    headers: auth(options.token),
    ...(options.payload === undefined ? {} : { payload: options.payload as object }),
  });

  const expected = options.expect ?? 200;
  if (response.statusCode !== expected) {
    throw new Error(
      `${options.method} ${options.url} expected ${expected}, got ${response.statusCode}: ${response.body}`,
    );
  }
  return response.json() as T;
}

/** Builds a multipart body by hand so the upload path is exercised exactly as a browser sends it. */
export function multipartBody(
  fieldName: string,
  filename: string,
  contentType: string,
  content: Buffer,
): { payload: Buffer; headers: Record<string, string> } {
  const boundary = `----nio${Math.random().toString(36).slice(2)}`;
  const head = Buffer.from(
    `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="${fieldName}"; filename="${filename}"\r\n` +
      `Content-Type: ${contentType}\r\n\r\n`,
  );
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`);

  return {
    payload: Buffer.concat([head, content, tail]),
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
  };
}

/** Smallest bytes that still identify as a PDF to the upload's content-type check. */
export const SAMPLE_PDF = Buffer.from(
  '%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n',
);

/** Digital PDF with extractable text for the report-discussion cache. */
function buildTextPdf(line: string): Buffer {
  const content = `BT /F1 12 Tf 72 720 Td (${line}) Tj ET`;
  const objects = [
    '1 0 obj<< /Type /Catalog /Pages 2 0 R >>endobj\n',
    '2 0 obj<< /Type /Pages /Kids [3 0 R] /Count 1 >>endobj\n',
    '3 0 obj<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources<< /Font<< /F1 5 0 R >> >> >>endobj\n',
    `4 0 obj<< /Length ${Buffer.byteLength(content)} >>stream\n${content}\nendstream\nendobj\n`,
    '5 0 obj<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>endobj\n',
  ];
  let body = '%PDF-1.4\n';
  const offsets = [0];
  for (const object of objects) {
    offsets.push(Buffer.byteLength(body));
    body += object;
  }
  const xrefStart = Buffer.byteLength(body);
  let xref = 'xref\n0 6\n0000000000 65535 f \n';
  for (let index = 1; index <= 5; index += 1) {
    xref += `${String(offsets[index]).padStart(10, '0')} 00000 n \n`;
  }
  body += `${xref}trailer<< /Size 6 /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`;
  return Buffer.from(body);
}

export const TEXT_PDF = buildTextPdf('Glucose 92 mg/dL reference 70-99');
