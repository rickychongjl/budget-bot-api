import { sql } from 'drizzle-orm';
import { boolean, index, integer, pgTable, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core';
import { appUser } from './identity';

/**
 * M3 — Categories & Ledger owns this file (category half).
 *
 * Tables: `category`.
 *
 * Split out from `transaction.ts` on purpose: M4's `budget.category_id` FKs into
 * `category`, while `transaction.budget_period_id` FKs into M4's `budget_period` —
 * the coupling runs both ways, so M3 and M4 coordinate their schema PR (master plan §4).
 *
 * Conventions: see `identity.ts` header. Specifics from M3's plan:
 *   - `unique (user_id, normalized_name)` — one category per name per user, enforced
 *     by the database rather than a read-then-insert in the service. It covers
 *     archived rows too, so reviving a name means reactivating the row that holds it.
 *   - `is_archived boolean not null default false`; tier capacity is simply the count
 *     of non-archived rows (master plan §5.1, round 4) — no "used vs never used"
 *     carve-out, because the gate lives on the archive action itself.
 */

export const category = pgTable(
  'category',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    userId: uuid('user_id')
      .notNull()
      .references(() => appUser.id, { onDelete: 'cascade' }),
    /** As the user typed it — what `/history` and confirmations render. */
    name: text('name').notNull(),
    /** Case- and whitespace-insensitive key; the uniqueness the user actually means. */
    normalizedName: text('normalized_name').notNull(),
    sortOrder: integer('sort_order').notNull().default(0),
    isArchived: boolean('is_archived').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('category_user_normalized_name_unique').on(t.userId, t.normalizedName),
    index('category_user_active').on(t.userId, t.sortOrder),
  ],
);
