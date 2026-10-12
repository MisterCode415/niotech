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
  /** Optional privileged URL used only by the one-off migration process, never by the API pool. */
  MIGRATION_DATABASE_URL: z.string().optional(),

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
  SMTP_FROM: z.string().default('Qinio <no-reply@niotech.test>'),
  // Omitted for local capture (Mailpit accepts anything); required by every hosted relay.
  SMTP_USER: z.string().optional(),
  SMTP_PASS: z.string().optional(),

  PAYMENT_PROVIDER: z.enum(['mock', 'stripe']).default('mock'),
  STRIPE_SECRET_KEY: z.string().optional(),
  STRIPE_CONNECT_CLIENT_ID: z.string().optional(),
  STRIPE_WEBHOOK_SECRET: z.string().optional(),
  STRIPE_CURRENCY: z.string().length(3).default('usd'),
  STRIPE_PLATFORM_FEE_BPS: z.coerce.number().int().min(0).max(10_000).default(0),
  STRIPE_LIVE_MODE: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true'),
  /** Shared secret for the temporary provider-neutral server-to-server purchase adapter. */
  INTEGRATION_API_SECRET: z.string().min(32).optional(),
  /**
   * Enables the "Mock flow" that seeds synthetic orders at every queue stage. Local and the dev
   * deployment only; never set on an environment that holds real patients.
   */
  SIMULATION_ENABLED: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true'),
  /**
   * When true (Auth0 only), staff roles (bu_admin, doctor, lab, fulfillment, platform admin)
   * must present a token from a session that completed MFA. Leave false until the post-login
   * Action that stamps the MFA claim is deployed, or every staff member is locked out.
   */
  REQUIRE_STAFF_MFA: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true'),
  /**
   * Encrypts LLM provider API keys at rest. Production must not use the committed default.
   */
  APP_ENCRYPTION_KEY: z.string().default('dev-only-encryption-key-change-me'),
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
 * A managed database is reached over a network, unlike one sharing the container network or the
 * host, so the connection has to be encrypted. Hostnames that never leave the machine are exempt.
 */
function databaseIsRemote(url: string): boolean {
  const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', 'postgres', 'db']);
  try {
    return !LOCAL_HOSTS.has(new URL(url).hostname);
  } catch {
    // An unparseable URL will fail loudly at connection time; do not add a confusing second error.
    return false;
  }
}

/**
 * Configuration mistakes that are harmless locally become serious once the app is reachable, so
 * they are refused at boot rather than logged as warnings. Failing to start is the safe outcome.
 */
function assertDeployableConfig(): void {
  if (env.NODE_ENV !== 'production') return;

  const problems: string[] = [];

  if (env.AUTH_PROVIDER === 'dev') {
    problems.push(
      'AUTH_PROVIDER=dev issues tokens for any known email without a password and cannot be used ' +
        'in production. Configure Auth0 before exposing the application.',
    );
  }
  if (env.AUTH_PROVIDER === 'dev' && env.DEV_AUTH_SECRET === DEFAULT_DEV_SECRET) {
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
  if (databaseIsRemote(env.DATABASE_URL) && !/[?&]sslmode=/.test(env.DATABASE_URL)) {
    problems.push(
      'DATABASE_URL points at a remote host without sslmode, which would send PHI across the ' +
        'network in clear text. Append ?sslmode=require (or verify-full with a CA bundle).',
    );
  }
  if (env.WEB_ORIGIN.includes('localhost')) {
    problems.push(
      'WEB_ORIGIN is still localhost. It is printed into QR stickers and emailed links, so it must be ' +
        'the public URL or scanned kits will point nowhere.',
    );
  }
  if (env.SMTP_HOST.endsWith('example.com')) {
    problems.push(
      'SMTP_HOST is still the placeholder. Point it at a real relay, or set SMTP_HOST=mailpit and run ' +
        'with --profile mailpit to capture mail instead of sending it.',
    );
  }
  if (env.APP_ENCRYPTION_KEY === 'dev-only-encryption-key-change-me') {
    problems.push(
      'APP_ENCRYPTION_KEY is still the committed default. Generate one with: openssl rand -hex 32',
    );
  }
  if (env.PAYMENT_PROVIDER === 'stripe') {
    for (const key of [
      'STRIPE_SECRET_KEY',
      'STRIPE_CONNECT_CLIENT_ID',
      'STRIPE_WEBHOOK_SECRET',
    ] as const) {
      if (!env[key]) problems.push(`PAYMENT_PROVIDER=stripe requires ${key}.`);
    }
    if (env.STRIPE_SECRET_KEY) {
      const keyIsLive = env.STRIPE_SECRET_KEY.startsWith('sk_live_');
      const keyIsTest = env.STRIPE_SECRET_KEY.startsWith('sk_test_');
      if (!keyIsLive && !keyIsTest) problems.push('STRIPE_SECRET_KEY has an unrecognized mode.');
      if (env.STRIPE_LIVE_MODE !== keyIsLive) {
        problems.push('STRIPE_LIVE_MODE does not match STRIPE_SECRET_KEY.');
      }
    }
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

/** Mail is being captured locally (Mailpit) rather than relayed anywhere. */
export const smtpIsLocalCapture = ['localhost', '127.0.0.1', 'mailpit'].includes(env.SMTP_HOST);

assertDeployableConfig();

export const storageRoot = path.isAbsolute(env.STORAGE_LOCAL_PATH)
  ? env.STORAGE_LOCAL_PATH
  : path.join(repoRoot, env.STORAGE_LOCAL_PATH);
