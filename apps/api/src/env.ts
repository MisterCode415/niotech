import { config } from 'dotenv';
import { z } from 'zod';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../../..');

config({ path: path.join(repoRoot, '.env'), quiet: true });

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  API_PORT: z.coerce.number().default(4000),
  WEB_ORIGIN: z.string().default('http://localhost:5173'),
  API_PUBLIC_URL: z.string().default('http://localhost:4000'),

  DATABASE_URL: z.string().default('postgres://nio:nio@localhost:5433/nio'),

  AUTH_PROVIDER: z.enum(['dev', 'auth0']).default('dev'),
  DEV_AUTH_SECRET: z.string().default('dev-only-secret-change-me'),
  AUTH0_DOMAIN: z.string().optional(),
  AUTH0_AUDIENCE: z.string().optional(),
  AUTH0_SPA_CLIENT_ID: z.string().optional(),
  AUTH0_M2M_CLIENT_ID: z.string().optional(),
  AUTH0_M2M_CLIENT_SECRET: z.string().optional(),

  PLATFORM_ADMIN_EMAIL: z.string().default('admin@niotech.test'),

  STORAGE_DRIVER: z.enum(['local']).default('local'),
  STORAGE_LOCAL_PATH: z.string().default('./storage'),

  SMTP_HOST: z.string().default('localhost'),
  SMTP_PORT: z.coerce.number().default(1025),
  SMTP_FROM: z.string().default('NIO Tech <no-reply@niotech.test>'),

  PAYMENT_PROVIDER: z.enum(['mock']).default('mock'),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error('Invalid environment configuration:');
  console.error(z.prettifyError(parsed.error));
  process.exit(1);
}

export const env = parsed.data;

export const storageRoot = path.isAbsolute(env.STORAGE_LOCAL_PATH)
  ? env.STORAGE_LOCAL_PATH
  : path.join(repoRoot, env.STORAGE_LOCAL_PATH);
