import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // The workflow tests share one Postgres database and drive global state, so they run serially.
    fileParallelism: false,
    sequence: { concurrent: false },
    testTimeout: 30_000,
    hookTimeout: 30_000,
    env: {
      AUTH_PROVIDER: 'dev',
      ALLOW_DEV_AUTH: 'true',
      DEV_AUTH_SECRET: 'test-only-secret-that-is-at-least-32-characters',
      INTEGRATION_API_SECRET: 'test-integration-secret-at-least-32-characters',
      STRIPE_SECRET_KEY: 'sk_test_qinio_unit_tests_only',
      STRIPE_WEBHOOK_SECRET: 'whsec_qinio_unit_tests_only',
      PAYMENT_PROVIDER: 'mock',
      SIMULATION_ENABLED: 'true',
    },
  },
});
