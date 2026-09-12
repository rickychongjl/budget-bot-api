import type { PGlite } from '@electric-sql/pglite';
import journal from '../../src/infrastructure/database/migrations/meta/_journal.json';

/**
 * Builds a PGlite schema from the **committed migrations, in journal order** — the
 * same files `npm run db:migrate` applies to Neon and production, so a suite here
 * sees exactly the shape a deploy produces.
 *
 * Before this helper each PGlite suite hand-picked the migration files it thought it
 * needed. That drifted: `gateway.test.ts` applied `0003` and `0005` only, so it ran
 * against the pre-`0007` `budget` shape. Harmless there, but it is the kind of drift
 * that turns a real failure into a passing test. Reading `meta/_journal.json` means a
 * new migration is applied everywhere the moment it is committed, with nothing to
 * remember.
 *
 * Both directions of drift fail loudly at load time: a journal entry with no `.sql`
 * file, or a `.sql` file the journal does not know about.
 */

const MIGRATIONS_DIR = '../../src/infrastructure/database/migrations';

const sqlByPath = import.meta.glob<string>('../../src/infrastructure/database/migrations/*.sql', {
  query: '?raw',
  import: 'default',
  eager: true,
});

/** Every migration tag, oldest first — `0000_identity`, `0001_…`, … */
export const MIGRATION_TAGS: readonly string[] = [...journal.entries]
  .sort((a, b) => a.idx - b.idx)
  .map((entry) => entry.tag);

const sqlByTag = new Map<string, string>();
for (const [path, sql] of Object.entries(sqlByPath)) {
  const tag = path.slice(path.lastIndexOf('/') + 1, -'.sql'.length);
  if (!MIGRATION_TAGS.includes(tag)) {
    throw new Error(`${MIGRATIONS_DIR}/${tag}.sql is not in meta/_journal.json — was db:generate's output only partly committed?`);
  }
  sqlByTag.set(tag, sql);
}
for (const tag of MIGRATION_TAGS) {
  if (!sqlByTag.has(tag)) throw new Error(`meta/_journal.json lists ${tag} but ${MIGRATIONS_DIR}/${tag}.sql is missing`);
}

/**
 * Applies every migration in order. `through` stops after the named tag (inclusive)
 * — for a suite that needs to seed an *old* shape before running the migration that
 * moves the data, e.g. `migration-0007-category-period-cap.test.ts`.
 */
export async function applyMigrations(pg: PGlite, options: { through?: string } = {}): Promise<void> {
  const last = options.through === undefined ? MIGRATION_TAGS.length - 1 : MIGRATION_TAGS.indexOf(options.through);
  if (last === -1) throw new Error(`unknown migration tag ${options.through}`);
  for (const tag of MIGRATION_TAGS.slice(0, last + 1)) await applyMigration(pg, tag);
}

/** Applies one migration by tag. The caller is responsible for the ones before it. */
export async function applyMigration(pg: PGlite, tag: string): Promise<void> {
  const sql = sqlByTag.get(tag);
  if (sql === undefined) throw new Error(`unknown migration tag ${tag}`);
  await pg.exec(sql);
}
