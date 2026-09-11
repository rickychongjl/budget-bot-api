import { sql } from 'drizzle-orm';
import {
  bigint,
  check,
  date,
  index,
  pgTable,
  smallint,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
import { budgetPeriod } from './budget';
import { category } from './category';
import { appUser } from './identity';

/**
 * M5 — Daily Allowance & Scheduler owns this file.
 *
 * Tables: `daily_allowance_send`.
 *
 * Conventions: see `identity.ts` header. Specifics from M5's plan (resolved 5 Sep —
 * per-category targets, bundled delivery, fixed 07:00 local send):
 *   - One row per `(user_id, category_id, local_date)` — `unique (user_id, category_id, local_date)`.
 *     This constraint is the whole double-send guard: two concurrent ticks racing to
 *     insert the same day's target serialise on the index rather than both sending.
 *   - `daily_target_minor_units bigint not null` — written once per (user, category, date),
 *     never recomputed for that date. This is M5's central invariant: recomputing live
 *     would smear a lunchtime overspend across the remaining days and the user would
 *     never see they had gone over.
 *   - `budget_period_id` -> `budget_period(id) on delete cascade` (M4-owned table).
 *     Non-null is safe because a reminder requires an active budget on the category,
 *     so a period always materialises.
 *   - `delivery_status text check (... in ('not_applicable','pending','sent','failed','skipped'))`,
 *     default `'not_applicable'`; a budgeted-but-unreminded category's row stays
 *     `not_applicable` — it is never going to be sent, so it must not appear in the
 *     retry index.
 *   - Partial index: `where delivery_status = 'pending'` for the retry scan.
 */

export const dailyAllowanceSend = pgTable(
  'daily_allowance_send',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    userId: uuid('user_id')
      .notNull()
      .references(() => appUser.id, { onDelete: 'cascade' }),
    categoryId: uuid('category_id')
      .notNull()
      .references(() => category.id, { onDelete: 'cascade' }),
    /** The user-local calendar date this target is for. Never backfilled. */
    localDate: date('local_date', { mode: 'string' }).notNull(),
    /** Frozen once written. `available_today` is derived from it, never stored. */
    dailyTargetMinorUnits: bigint('daily_target_minor_units', { mode: 'bigint' }).notNull(),
    budgetPeriodId: uuid('budget_period_id')
      .notNull()
      .references(() => budgetPeriod.id, { onDelete: 'cascade' }),
    deliveryStatus: text('delivery_status').notNull().default('not_applicable'),
    /** Retry budget — 3 attempts on a retryable failure, then `failed`. */
    attempts: smallint('attempts').notNull().default(0),
    sentAt: timestamp('sent_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('daily_allowance_send_user_category_date_unique').on(t.userId, t.categoryId, t.localDate),
    check(
      'daily_allowance_send_status_check',
      sql`${t.deliveryStatus} in ('not_applicable', 'pending', 'sent', 'failed', 'skipped')`,
    ),
    index('daily_allowance_send_pending')
      .on(t.deliveryStatus)
      .where(sql`${t.deliveryStatus} = 'pending'`),
    /** The per-user read `/today` and the bundle both make. */
    index('daily_allowance_send_user_date').on(t.userId, t.localDate),
  ],
);
