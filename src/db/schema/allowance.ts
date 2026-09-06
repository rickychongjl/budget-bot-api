/**
 * M5 — Daily Allowance & Scheduler owns this file.
 *
 * Tables: `daily_allowance_send`.
 *
 * Conventions: see `identity.ts` header. Specifics from M5's plan (resolved 5 Sep —
 * per-category targets, bundled delivery, fixed 07:00 local send):
 *   - One row per `(user_id, category_id, local_date)` — `unique (user_id, category_id, local_date)`.
 *   - `daily_target_minor_units bigint not null` — written once per (user, category, date),
 *     never recomputed for that date.
 *   - `budget_period_id` -> `budget_period(id) on delete cascade` (M4-owned table).
 *   - `delivery_status text check (... in ('not_applicable','pending','sent','failed','skipped'))`,
 *     default `'not_applicable'`; a budgeted-but-unreminded category's row stays `not_applicable`.
 *   - Partial index: `where delivery_status = 'pending'` for the retry scan.
 */
export {};
