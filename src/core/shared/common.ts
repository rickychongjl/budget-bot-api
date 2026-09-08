/**
 * Shared primitive types every port and domain module builds on (M1 §3–§4).
 * Kept deliberately small — DTOs live with the port that returns them.
 */

/** A v4 UUID string. All primary keys are `uuid default gen_random_uuid()` (M1 §4). */
export type Uuid = string;

/** Internal user id — `app_user.id`. No module outside M2 ever sees a Telegram id. */
export type UserId = Uuid;

/** Any other entity id (transaction, category, budget, …). */
export type Id = Uuid;

/**
 * A point in time, epoch milliseconds, UTC. Every stored timestamp is `timestamptz`
 * UTC; a user-local calendar date is derived at write time into a separate `date`
 * column (M1 §4). Domain code gets an `Instant` from an injected `Clock`, never
 * `Date.now()` (master plan §6, rule 3).
 */
export type Instant = number;

/** A calendar date in the user's immutable timezone, ISO `YYYY-MM-DD`. */
export type LocalDate = string;

/** A wall-clock time of day in the user's timezone, `HH:MM` (24h). */
export type LocalTime = string;

/**
 * Money, in minor units (cents), as `bigint`. Never `number`, never `numeric`,
 * never a float, at any layer (M1 §4 / master plan §6). The decimal→minor-units
 * conversion happens once, at the parser boundary, and validates scale first.
 */
export type MinorUnits = bigint;

/** ISO 4217 alpha-3, e.g. `'AUD'`. Copied onto each row, not joined from the user. */
export type CurrencyCode = string;

/** The only channel in scope this pass. The check-constraint seam is the whole abstraction. */
export type Channel = 'telegram';

export type Tier = 'free' | 'premium';

/**
 * Refusal codes shared across modules and rendered (never raw) by M7 — M11's
 * refusal-code table. Kept here so `EntitlementService` and the command handlers
 * agree on the spelling.
 */
export type RefusalCode =
  | 'ONBOARDING_REQUIRED'
  | 'INVALID_ARGUMENT'
  | 'CATEGORY_NOT_FOUND'
  | 'NO_BUDGET'
  | 'DAILY_MESSAGE_LIMIT'
  | 'FAIR_USE_LIMIT'
  | 'CATEGORY_LIMIT'
  | 'REMINDER_CATEGORY_LIMIT'
  | 'TIER_REQUIRED'
  | 'STALE_ACTION'
  | 'RESOURCE_NOT_FOUND'
  | 'NO_TRANSACTIONS'
  | 'NO_SUBSCRIPTION'
  | 'BILLING_UNAVAILABLE'
  | 'DELIVERY_FAILED'
  | 'TIMEZONE_IMMUTABLE'
  | 'NOT_YET_AVAILABLE';
