import { sql } from 'drizzle-orm';
import {
  boolean,
  char,
  check,
  date,
  index,
  pgTable,
  text,
  time,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';

/**
 * M2 — Identity & Accounts owns this file.
 *
 * Tables: `app_user`, `channel_connection`.
 *
 * Conventions (M1 §4, binding): uuid PK `default gen_random_uuid()`; every timestamp
 * `timestamptz` UTC; a user-local calendar date is its own `date` column; money is
 * `bigint` minor units; every user-scoped table carries `user_id` with
 * `on delete cascade`; enums are `text` + `check`, never a Postgres enum; conditional
 * uniqueness is a partial unique index.
 *
 * `timezone` is non-null as specified by M2. The empty string is the internal value for
 * a newly registered user before step 1; it is never exposed as `UserSettings` or used
 * for local-date calculations. The set-once write is `update … where timezone = ''`.
 *
 * `onboarding_step` is added so the 5-step `/start` machine survives between Worker
 *     invocations without a separate draft table (steps 4–5 persist through M3/M4/M5).
 */

export const appUser = pgTable(
  'app_user',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    /** IANA zone after step 1; empty only for a newly registered, not-yet-onboarded user. */
    timezone: text('timezone').notNull(),
    currencyCode: char('currency_code', { length: 3 }).notNull().default('AUD'),
    /** The "budget start date" (M4's monthly anchor). Null only before onboarding step 3. */
    periodAnchorDate: date('period_anchor_date', { mode: 'string' }),
    /** Fixed 07:00 for everyone this pass (5 Sep decision); still stored per user. */
    reminderLocalTime: time('reminder_local_time').notNull().default('07:00'),
    status: text('status').notNull().default('active'),
    onboardingStep: text('onboarding_step').notNull().default('timezone'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (t) => [
    check('app_user_status_check', sql`${t.status} in ('active', 'suspended', 'deleted')`),
    check(
      'app_user_onboarding_step_check',
      sql`${t.onboardingStep} in ('timezone', 'currency', 'anchor_date', 'categories', 'reminders', 'done')`,
    ),
  ],
);

export const channelConnection = pgTable(
  'channel_connection',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    userId: uuid('user_id')
      .notNull()
      .references(() => appUser.id, { onDelete: 'cascade' }),
    channel: text('channel').notNull(),
    /** Telegram user id. Kept separate from `chat_id` on purpose — they diverge in groups. */
    externalId: text('external_id').notNull(),
    /** Where outbound messages go. */
    chatId: text('chat_id').notNull(),
    username: text('username'),
    isActive: boolean('is_active').notNull().default(true),
    linkedAt: timestamp('linked_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    /** What makes `register` idempotent — the DB, not an app-level check-then-insert. */
    unique('channel_connection_channel_external_id_unique').on(t.channel, t.externalId),
    index('channel_connection_user').on(t.userId),
    check('channel_connection_channel_check', sql`${t.channel} in ('telegram')`),
  ],
);
