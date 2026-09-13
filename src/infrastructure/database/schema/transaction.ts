import { sql } from 'drizzle-orm';
import {
  bigint,
  char,
  check,
  date,
  index,
  numeric,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import { budgetPeriod } from './budget';
import { category } from './category';
import { appUser } from './identity';
import { parseEvent } from './observability';

/**
 * M3 — Categories & Ledger owns this file (ledger half).
 *
 * Tables: `transaction`.
 *
 * Conventions: see `identity.ts` header. Specifics from M3's plan:
 *   - `category_id` -> `category(id) on delete set null`;
 *     `budget_period_id` -> `budget_period(id) on delete set null` (M4-owned table).
 *   - `direction text check (direction in ('expense','income','refund'))`.
 *   - `amount_minor_units bigint not null check (amount_minor_units > 0)` — sign lives
 *     in `direction`, never in the amount.
 *   - `occurred_on date` (user-local, derived once at write time) is separate from
 *     `occurred_at timestamptz`.
 *   - `currency_code` is copied onto the row rather than joined from the user, so
 *     history still renders correctly if the default currency ever changes.
 *   - `parse_route text check (... in ('command','mechanical','mapping','llm'))`.
 *   - `status` defaults `'confirmed'`; the hot indexes are partial on
 *     `where status = 'confirmed'` — every read behind budget maths filters on it.
 *   - `parse_event_id` -> `parse_event(id) on delete set null` (M9-owned table,
 *     added M7 stage 4D closing M6's open question 2: `LedgerService.correct()` now
 *     calls `LedgerCorrectionNotifier.onTransactionCorrected` so `was_corrected`
 *     stops being permanently false). Nullable and `set null` rather than `cascade`:
 *     a transaction outlives the retention pass that may later prune its parse event.
 *
 * `category_name_snapshot` was proposed by M3's plan for the deferred "real category
 * removal" feature and **deliberately not built** — confirmed 8 Sep. It arrives with
 * the feature that needs it, in its own migration.
 */

export const transaction = pgTable(
  'transaction',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    userId: uuid('user_id')
      .notNull()
      .references(() => appUser.id, { onDelete: 'cascade' }),
    categoryId: uuid('category_id').references(() => category.id, { onDelete: 'set null' }),
    budgetPeriodId: uuid('budget_period_id').references(() => budgetPeriod.id, { onDelete: 'set null' }),
    direction: text('direction').notNull(),
    amountMinorUnits: bigint('amount_minor_units', { mode: 'bigint' }).notNull(),
    currencyCode: char('currency_code', { length: 3 }).notNull(),
    /** The user-local calendar date — what every period query buckets on. */
    occurredOn: date('occurred_on', { mode: 'string' }).notNull(),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull(),
    merchantDisplay: text('merchant_display'),
    normalizedMerchant: text('normalized_merchant'),
    note: text('note'),
    /** The original user message — retained so a correction can show what was sent. */
    rawText: text('raw_text'),
    parseRoute: text('parse_route').notNull(),
    parseConfidence: numeric('parse_confidence', { precision: 4, scale: 3 }),
    parseEventId: uuid('parse_event_id').references(() => parseEvent.id, { onDelete: 'set null' }),
    status: text('status').notNull().default('confirmed'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (t) => [
    index('transaction_user_date')
      .on(t.userId, t.occurredOn.desc())
      .where(sql`${t.status} = 'confirmed'`),
    index('transaction_period')
      .on(t.budgetPeriodId)
      .where(sql`${t.status} = 'confirmed'`),
    /** `deleteLast` picks the most recent *action*, not the most recent date. */
    index('transaction_user_created')
      .on(t.userId, t.createdAt.desc())
      .where(sql`${t.status} = 'confirmed'`),
    /** Backs the archive gate: "any transaction for this category in this period?" */
    index('transaction_category_date')
      .on(t.categoryId, t.occurredOn)
      .where(sql`${t.status} = 'confirmed'`),
    check('transaction_direction_check', sql`${t.direction} in ('expense', 'income', 'refund')`),
    check('transaction_amount_positive', sql`${t.amountMinorUnits} > 0`),
    check(
      'transaction_parse_route_check',
      sql`${t.parseRoute} in ('command', 'mechanical', 'mapping', 'llm')`,
    ),
    check('transaction_status_check', sql`${t.status} in ('confirmed', 'pending', 'deleted')`),
  ],
);
