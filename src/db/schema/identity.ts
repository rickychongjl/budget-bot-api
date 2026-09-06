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
 * Tables: `app_user`, `channel_connection` — column-for-column the SQL in
 * `docs/M2-identity-accounts.md` ("Schema").
 *
 * Conventions (M1 §4, binding): uuid PK `default gen_random_uuid()`; every timestamp
 * `timestamptz` UTC; a user-local calendar date is its own `date` column; money is
 * `bigint` minor units; every user-scoped table carries `user_id` with
 * `on delete cascade`; enums are `text` + `check`, never a Postgres enum; conditional
 * uniqueness is a partial unique index.
 *
 * Notes carried from M2's plan:
 *   - `app_user.period_anchor_date` (nullable `date`) is the "budget start date" — M2 stores
 *     it, M4 interprets it (`anchorDate.day`, capped at 28). Null until onboarding step 3.
 *   - `app_user.reminder_local_time` defaults to '07:00' (not 08:00 — 5 Sep decision).
 *   - `app_user.timezone` is `not null` per the doc, but `register` creates the row before
 *     onboarding step 1 collects a timezone. `''` is the "not yet set" sentinel;
 *     `setInitialTimezone` claims it atomically with `update … where timezone = ''`.
 *   - `channel_connection` keeps `external_id` and `chat_id` as separate columns;
 *     `unique (channel, external_id)` is what makes `register` idempotent.
 */

export const appUser = pgTable(
  'app_user',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** IANA zone, e.g. 'Australia/Brisbane'. `''` until onboarding step 1 sets it, once, ever. */
    timezone: text('timezone').notNull(),
    currencyCode: char('currency_code', { length: 3 }).notNull().default('AUD'),
    /** The user's "budget start date"; null only before onboarding step 3 completes. */
    periodAnchorDate: date('period_anchor_date', { mode: 'string' }),
    reminderLocalTime: time('reminder_local_time').notNull().default('07:00'),
    status: text('status').notNull().default('active'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true, mode: 'date' }),
  },
  (t) => [
    check('app_user_status_check', sql`${t.status} in ('active', 'suspended', 'deleted')`),
  ],
);

export const channelConnection = pgTable(
  'channel_connection',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => appUser.id, { onDelete: 'cascade' }),
    channel: text('channel').notNull(),
    /** Telegram user id. */
    externalId: text('external_id').notNull(),
    /** Where outbound messages go — equal to `external_id` for a private chat, diverges for groups. */
    chatId: text('chat_id').notNull(),
    username: text('username'),
    isActive: boolean('is_active').notNull().default(true),
    linkedAt: timestamp('linked_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (t) => [
    check('channel_connection_channel_check', sql`${t.channel} in ('telegram')`),
    unique('channel_connection_channel_external_id_unique').on(t.channel, t.externalId),
    index('channel_connection_user').on(t.userId),
  ],
);

export type AppUserRow = typeof appUser.$inferSelect;
export type ChannelConnectionRow = typeof channelConnection.$inferSelect;
