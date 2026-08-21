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
  method: 'GET' | 'POST' | 'PUT' | 'PATCH';
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
