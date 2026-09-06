import { defineConfig } from 'drizzle-kit';

/**
 * Drizzle Kit config — M1 §5 (Migrations).
 *
 * Forward-only: `drizzle-kit generate` produces SQL from `src/db/schema/*.ts`,
 * the generated SQL is committed and IS the source of truth. There are no down
 * migrations. CI applies these to a throwaway Neon branch per PR; the production
 * migration job must succeed before the Worker deploys.
 */
export default defineConfig({
  schema: './src/db/schema/index.ts',
  out: './src/db/migrations',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.DATABASE_URL ?? '',
  },
  strict: true,
  verbose: true,
});
