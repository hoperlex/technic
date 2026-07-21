import { defineConfig } from 'drizzle-kit';

// Расширения (pgcrypto, citext, pg_trgm) включаются ops-ом вручную до миграций (§8).
// `drizzle-kit push` в проде запрещён; миграции применяются отдельным шагом.
export default defineConfig({
  schema: './src/db/schema.ts',
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.DATABASE_MIGRATION_URL ?? process.env.DATABASE_URL ?? '',
  },
  strict: true,
  verbose: true,
});
