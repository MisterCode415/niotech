import { defineConfig } from 'drizzle-kit';
import { config } from 'dotenv';

config({ path: '../../.env', quiet: true });

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/db/schema.ts',
  out: './drizzle',
  dbCredentials: {
    url:
      process.env.MIGRATION_DATABASE_URL ??
      process.env.DATABASE_URL ??
      'postgres://nio:nio@localhost:5433/nio',
  },
  strict: true,
  verbose: true,
});
