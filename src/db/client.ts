import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema';

/**
 * The one way domain code reaches Postgres (M1 §1): a native driver (`postgres.js`)
 * over a Hyperdrive connection string, wrapped in Drizzle. NOT the Neon serverless
 * driver — Hyperdrive and the serverless driver are alternatives, not layers.
 *
 * Repositories take a `Database`; nothing in `core/domain` ever sees this handle
 * (M1 §4 / master plan §6, rule 3).
 */
export type Database = ReturnType<typeof createDatabase>;

export function createDatabase(connectionString: string) {
  // `prepare: false` — Hyperdrive pools connections, so per-connection prepared
  // statements can't be relied on. `max` stays small: a Worker invocation is short-lived.
  const sql = postgres(connectionString, { prepare: false, max: 5 });
  return drizzle(sql, { schema });
}
