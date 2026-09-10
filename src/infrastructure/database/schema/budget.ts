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
 * Tables: `budget` (the standing rule), `budget_period` (the frozen per-period snapshot).
 *
 * The two-table split exists so the daily-allowance formula divides by a cap that
 * cannot shift mid-period. Never add a period-key column to `transaction` — periods
 * are derived from `app_user.period_anchor_date`, not stored on the ledger.
 *
 * Schema coupling: `budget.category_id` -> `category.id` (this file depends on
 * `category.ts`); `transaction.budget_period_id` -> `budget_period.id` (that file
 * depends on this one). Coordinated with M3 in one migration (master plan §4).
 *
 * Conventions: see `identity.ts` header. Specifics from M4's plan:
 *   - `create unique index budget_one_active_per_category on budget (user_id, category_id) where is_active`.
 *   - `budget_period` unique `(budget_id, period_key)` — this is what makes lazy
 *     materialisation race-safe: two concurrent messages at a period boundary
 *     serialise on the index instead of producing two snapshots.
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
    capMinorUnits: bigint('cap_minor_units', { mode: 'bigint' }).notNull(),
    currencyCode: char('currency_code', { length: 3 }).notNull(),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    /** At most one live cap per category; superseded rows stay for their snapshots. */
    uniqueIndex('budget_one_active_per_category')
      .on(t.userId, t.categoryId)
      .where(sql`${t.isActive}`),
    index('budget_user').on(t.userId),
    check('budget_cap_positive', sql`${t.capMinorUnits} > 0`),
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
    /** Snapshot of the standing cap at materialisation — the frozen denominator. */
    capMinorUnits: bigint('cap_minor_units', { mode: 'bigint' }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('budget_period_budget_key_unique').on(t.budgetId, t.periodKey),
    index('budget_period_lookup').on(t.userId, t.periodStart, t.periodEnd),
    check('budget_period_range', sql`${t.periodStart} <= ${t.periodEnd}`),
    check('budget_period_cap_positive', sql`${t.capMinorUnits} > 0`),
  ],
);
