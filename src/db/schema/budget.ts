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
 * depends on this one). Coordinate the migration with M3 (master plan §4).
 *
 * Conventions: see `identity.ts` header. Specifics from M4's plan:
 *   - `create unique index budget_one_active_per_category on budget (user_id, category_id) where is_active`.
 *   - `budget_period` unique `(budget_id, period_key)`; `period_end` is inclusive.
 *   - Monthly only (round 3 revert) — no `period_type` column.
 */
export {};
