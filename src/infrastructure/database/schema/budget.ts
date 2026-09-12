import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  char,
  check,
  date,
  index,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { category } from './category';
import { appUser } from './identity';

/**
 * M4 — Budgets & Periods owns this file.
 *
 * Tables: `budget` (a category is budgeted), `budget_period` (a materialised cycle),
 * `category_period_cap` (**the only place a cap amount lives** — Ricky, 12 Sep 2026).
 *
 * The cap moved out of `budget` and `budget_period` because a cap stored per
 * *materialised* period could only ever be right for periods something had touched: a
 * cycle nobody logged in, ran `/today` in, or was reminded in had no row, and opening it
 * later — a backdated expense — stamped whatever the standing cap was *then*. So caps
 * are a history keyed by category and cycle instead, and a period's cap is **the row
 * with the greatest `period_key` at or before that period**. A change writes the
 * current cycle's row; every later cycle reads it until a later row supersedes it;
 * every earlier cycle is untouched. That one lookup is the carry-forward, with no job
 * copying rows at rollover. `cap_minor_units` is null for a removal: "no cap from this
 * cycle on", so an older row cannot leak forward past a `/budget` removal.
 *
 * Never add a period-key column to `transaction` — periods are derived from
 * `app_user.period_anchor_date`, not stored on the ledger.
 *
 * Schema coupling: `budget.category_id` -> `category.id` (this file depends on
 * `category.ts`); `transaction.budget_period_id` -> `budget_period.id` (that file
 * depends on this one). Coordinated with M3 in one migration (master plan §4).
 *
 * Conventions: see `identity.ts` header. Specifics from M4's plan:
 *   - `create unique index budget_one_active_per_category on budget (user_id, category_id) where is_active`.
 *   - `budget_period` unique `(budget_id, period_key)` — this is what makes lazy
 *     materialisation race-safe: two concurrent messages at a period boundary
 *     serialise on the index instead of producing two rows for the same cycle.
 *   - `category_period_cap` unique `(category_id, period_key)` — one governing row per
 *     category per cycle; `setCap` is an upsert on it.
 *   - `period_end` is inclusive.
 *   - Monthly only (round 3 revert) — no `period_type` column.
 */

export const budget = pgTable(
  'budget',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    userId: uuid('user_id')
      .notNull()
      .references(() => appUser.id, { onDelete: 'cascade' }),
    /** Nulled rather than deleted if the category ever goes away; history survives. */
    categoryId: uuid('category_id').references(() => category.id, { onDelete: 'set null' }),
    /** The currency every cap for this category is denominated in — the account's. */
    currencyCode: char('currency_code', { length: 3 }).notNull(),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    /** At most one live budget per category; a removed one stays, inactive, for its periods. */
    uniqueIndex('budget_one_active_per_category')
      .on(t.userId, t.categoryId)
      .where(sql`${t.isActive}`),
    index('budget_user').on(t.userId),
  ],
);

export const budgetPeriod = pgTable(
  'budget_period',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    userId: uuid('user_id')
      .notNull()
      .references(() => appUser.id, { onDelete: 'cascade' }),
    budgetId: uuid('budget_id')
      .notNull()
      .references(() => budget.id, { onDelete: 'cascade' }),
    /** Labelled by start month: a cycle running 25 Sep–24 Oct is `'2026-09'`. */
    periodKey: text('period_key').notNull(),
    periodStart: date('period_start', { mode: 'string' }).notNull(),
    /** Inclusive. */
    periodEnd: date('period_end', { mode: 'string' }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('budget_period_budget_key_unique').on(t.budgetId, t.periodKey),
    index('budget_period_lookup').on(t.userId, t.periodStart, t.periodEnd),
    check('budget_period_range', sql`${t.periodStart} <= ${t.periodEnd}`),
  ],
);

/**
 * The cap history. A row says: from cycle `period_key` on, this category's cap is
 * `cap_minor_units` — until a row with a later key says otherwise. Read with
 * `where period_key <= :cycle order by period_key desc limit 1`; `'YYYY-MM'` keys sort
 * chronologically as text, which is what makes that a plain index scan.
 *
 * Keyed by category rather than budget so history survives a budget being removed and
 * re-added (each of which is a new `budget` row): the caps belong to the category.
 */
export const categoryPeriodCap = pgTable(
  'category_period_cap',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    userId: uuid('user_id')
      .notNull()
      .references(() => appUser.id, { onDelete: 'cascade' }),
    categoryId: uuid('category_id')
      .notNull()
      .references(() => category.id, { onDelete: 'cascade' }),
    /** The cycle this row takes effect from — always the cycle that was current when it was written. */
    periodKey: text('period_key').notNull(),
    /** Null means the budget was removed in this cycle: no cap from here on. */
    capMinorUnits: bigint('cap_minor_units', { mode: 'bigint' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('category_period_cap_category_key_unique').on(t.categoryId, t.periodKey),
    /** The per-user "every category's cap for this cycle" read behind `/budget` and `/stats`. */
    index('category_period_cap_user_key').on(t.userId, t.periodKey),
    check('category_period_cap_positive', sql`${t.capMinorUnits} is null or ${t.capMinorUnits} > 0`),
  ],
);
