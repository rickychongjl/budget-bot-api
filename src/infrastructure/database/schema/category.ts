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
 *
 * **`reminder_enabled` is M5's column on M3's table** — a deliberate, narrow exception
 * to CLAUDE.md's "one module owns each table", agreed 11 Sep (see `docs/build-log.md`,
 * M5's entry). M2's onboarding step 5, M8's `countReminderCategories` and M5's 07:00
 * dispatch all need "does this category carry a reminder", and it is genuinely a
 * property of the category rather than of a day's output — `daily_allowance_send` is
 * per-day and cannot hold it. M5's repository reads and writes this one column and
 * never touches the rest of the row; M3 clears it when it archives a category (via
 * `AllowanceNotifier.categoryArchived`) rather than writing it directly.
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
    /** M5-owned. Requires an active budget on the category to turn on; 1 Free / 5 Premium. */
    reminderEnabled: boolean('reminder_enabled').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('category_user_normalized_name_unique').on(t.userId, t.normalizedName),
    index('category_user_active').on(t.userId, t.sortOrder),
    /** Backs M8's capacity count and M5's due scan — both only ever want the enabled ones. */
    index('category_reminder_enabled').on(t.userId).where(sql`${t.reminderEnabled}`),
  ],
);
