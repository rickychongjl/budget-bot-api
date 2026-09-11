import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  date,
  index,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { appUser } from './identity';

/**
 * M8 — Entitlements & Limits owns this file.
 *
 * Tables: `entitlement`, `usage_counter`. SQL shape finalised from the provisional
 * schema in `docs/M8-entitlements-limits.md`; the *policy* it serves is settled there.
 *
 * Conventions (M1 §4, binding): uuid PK `default gen_random_uuid()`; every timestamp
 * `timestamptz` UTC; a user-local calendar date is its own `date` column computed at
 * write time from the injected `Clock` and the user's immutable timezone; every
 * user-scoped table carries `user_id ... on delete cascade`; enums are `text` +
 * `check`, never a Postgres enum; conditional uniqueness is a partial unique index.
 */

/**
 * `entitlement` — what the user has paid for. One row per grant; at most one row per
 * user may be `active` (partial unique index `entitlement_one_active`). A user with no
 * active row is Free. `tierOf` re-reads this on every call and also honours
 * `current_period_end` — an `active` row whose period has lapsed resolves to Free
 * even before the Phase 2 billing state machine flips `status`.
 *
 * Billing (Stars checkout / renewal / refund) is Phase 2 — nothing in this pass
 * inserts rows here except tests and a manual grant (`source = 'manual'`).
 */
export const entitlement = pgTable(
  'entitlement',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => appUser.id, { onDelete: 'cascade' }),
    tier: text('tier').notNull(),
    source: text('source').notNull(),
    externalSubscriptionId: text('external_subscription_id'),
    status: text('status').notNull(),
    currentPeriodEnd: timestamp('current_period_end', { withTimezone: true, mode: 'date' }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    check('entitlement_tier_check', sql`${t.tier} in ('free', 'premium')`),
    check('entitlement_source_check', sql`${t.source} in ('telegram_stars', 'manual')`),
    check(
      'entitlement_status_check',
      sql`${t.status} in ('active', 'expired', 'cancelled', 'refunded')`,
    ),
    uniqueIndex('entitlement_one_active')
      .on(t.userId)
      .where(sql`${t.status} = 'active'`),
  ],
);

/**
 * `usage_counter` — one row per *admitted* inbound user message, keyed by M7's stable
 * logical `message_id`. The primary key is what makes admission exactly-once: a
 * Telegram redelivery of the same message hits the same key and is reported as a
 * duplicate, never counted twice. A refused (over-limit) attempt writes nothing.
 *
 *   - `admitted_at` (UTC) drives the rolling 120-minute fair-use window —
 *     index `usage_counter_window (user_id, admitted_at)`.
 *   - `local_date` is the user-local calendar date at admission, computed at write
 *     time from the user's immutable IANA timezone — index
 *     `usage_counter_daily (user_id, local_date)` serves the Free daily cap.
 *
 *   - `counts_toward_daily` separates the two limits this table serves. Every admitted
 *     row counts toward fair use; only rows written after onboarding finished count
 *     toward the Free daily cap (index `usage_counter_daily` still serves both).
 *
 * Deliberately not the original entries/llm_calls metrics shape: M9 owns metrics;
 * this table holds only the counters that gate behaviour.
 */
export const usageCounter = pgTable(
  'usage_counter',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => appUser.id, { onDelete: 'cascade' }),
    messageId: text('message_id').notNull(),
    admittedAt: timestamp('admitted_at', { withTimezone: true, mode: 'date' }).notNull(),
    localDate: date('local_date', { mode: 'string' }).notNull(),
    /**
     * False for a message admitted while the user was still onboarding. The row still
     * exists — fair use counts it, because that limit is abuse protection and is never
     * waived — but the Free daily cap skips it. Added by M7 stage 4B; see the
     * `admitMessage` options argument in `core/entitlements/entitlement-service.ts`
     * for why the two limits had to be separable.
     */
    countsTowardDaily: boolean('counts_toward_daily').notNull().default(true),
  },
  (t) => [
    primaryKey({ name: 'usage_counter_pkey', columns: [t.userId, t.messageId] }),
    index('usage_counter_window').on(t.userId, t.admittedAt),
    index('usage_counter_daily').on(t.userId, t.localDate),
  ],
);
