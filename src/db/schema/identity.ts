/**
 * M2 — Identity & Accounts owns this file.
 *
 * Tables: `app_user`, `channel_connection`.
 *
 * The M2 agent adds the Drizzle table definitions here and nothing else touches this file.
 * Conventions (M1 §4, binding): uuid PK `default gen_random_uuid()`; every timestamp
 * `timestamptz` UTC; a user-local calendar date is its own `date` column; money is
 * `bigint` minor units; every user-scoped table carries `user_id` with
 * `on delete cascade`; enums are `text` + `check`, never a Postgres enum; conditional
 * uniqueness is a partial unique index.
 *
 * Notes carried from M2's plan:
 *   - `app_user.period_anchor_date` (nullable `date`) is the "budget start date" — M2 stores
 *     it, M4 interprets it. Coordinate the exact column with M4 before writing a migration.
 *   - `app_user.reminder_local_time` defaults to '07:00' (not 08:00 — 5 Sep decision).
 *   - `channel_connection` keeps `external_id` and `chat_id` as separate columns;
 *     `unique (channel, external_id)` is what makes `register` idempotent.
 */
export {};
