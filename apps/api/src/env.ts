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
  /**
   * The dev provider issues tokens for any known email with no password. Enabling it anywhere
   * reachable has to be a deliberate, explicit act, never something a missing variable can cause.
   */
  ALLOW_DEV_AUTH: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true'),
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

const DEFAULT_DEV_SECRET = 'dev-only-secret-change-me';

/**
 * Configuration mistakes that are harmless locally become serious once the app is reachable, so
 * they are refused at boot rather than logged as warnings. Failing to start is the safe outcome.
 */
function assertDeployableConfig(): void {
  if (env.NODE_ENV !== 'production') return;

  const problems: string[] = [];

  if (env.AUTH_PROVIDER === 'dev' && !env.ALLOW_DEV_AUTH) {
    problems.push(
      'AUTH_PROVIDER=dev issues tokens for any known email without a password. Set ALLOW_DEV_AUTH=true ' +
        'to confirm this is intended and keep the deployment private, or set AUTH_PROVIDER=auth0.',
    );
  }
  if (env.DEV_AUTH_SECRET === DEFAULT_DEV_SECRET) {
    problems.push(
      'DEV_AUTH_SECRET is still the committed default. Generate one with: openssl rand -base64 48',
    );
  }
  if (env.AUTH_PROVIDER === 'dev' && env.DEV_AUTH_SECRET.length < 32) {
    problems.push('DEV_AUTH_SECRET must be at least 32 characters.');
  }
  if (/:(nio|postgres|password)@/.test(env.DATABASE_URL)) {
    problems.push('DATABASE_URL still uses a default password. Set a generated one.');
  }
  if (env.WEB_ORIGIN.includes('localhost')) {
    problems.push(
      'WEB_ORIGIN is still localhost. It is printed into QR stickers and emailed links, so it must be ' +
        'the public URL or scanned kits will point nowhere.',
    );
  }

  if (problems.length > 0) {
    console.error('\nRefusing to start due to unsafe configuration:');
    for (const problem of problems) console.error(`  - ${problem}`);
    console.error('');
    process.exit(1);
  }
}

/** True when tokens can be minted without a password, which callers surface loudly. */
export const devAuthIsOpen = env.AUTH_PROVIDER === 'dev';

assertDeployableConfig();

export const storageRoot = path.isAbsolute(env.STORAGE_LOCAL_PATH)
  ? env.STORAGE_LOCAL_PATH
  : path.join(repoRoot, env.STORAGE_LOCAL_PATH);
