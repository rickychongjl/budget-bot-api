import type { Instant, LocalDate, Tier, UserId } from '../ports/common';

/**
 * M8's outgoing ports — what the entitlements module needs from the outside world.
 * The incoming contract is `EntitlementService` (`./entitlement-service.ts`); these
 * are the seams the implementation is built on, so the policy is unit-testable
 * without a database (`test/support/in-memory-entitlement-repository.ts`) and the
 * real thing runs over Drizzle
 * (`infrastructure/database/repositories/drizzle-entitlement-repository.ts`).
 *
 * `X` is the *executor* type — the handle a caller uses to run its own domain write
 * inside the same transaction as a capacity check (`DefaultEntitlementService.gate`).
 * Drizzle: the transaction handle. In-memory: whatever "world" object the test owns.
 */

/** A projection of one `entitlement` row — only what tier resolution needs. */
export interface EntitlementRow {
  tier: Tier;
  status: 'active' | 'expired' | 'cancelled' | 'refunded';
  currentPeriodEnd: Instant | null;
}

export interface UsageRow {
  userId: UserId;
  messageId: string;
  admittedAt: Instant;
  localDate: LocalDate;
}

export interface WindowUsage {
  /** Admitted messages with `admittedAt > after` (strictly — an event exactly `windowMs` old has left). */
  count: number;
  /** The earliest `admittedAt` inside the window, or null when `count` is 0. */
  earliest: Instant | null;
}

/** Read side; the same operations are available inside and outside a transaction. */
export interface EntitlementReads {
  /** The user's `status = 'active'` row, if any. At most one exists (partial unique index). */
  findActiveEntitlement(userId: UserId): Promise<EntitlementRow | null>;
  hasUsage(userId: UserId, messageId: string): Promise<boolean>;
  getUsageInWindow(userId: UserId, after: Instant): Promise<WindowUsage>;
  countUsageOnLocalDate(userId: UserId, localDate: LocalDate): Promise<number>;
}

export type UserLockScope = 'admission' | 'capacity';

export interface EntitlementTransaction<X> extends EntitlementReads {
  /** The caller's handle for running its own writes in this transaction. */
  readonly executor: X;
  /**
   * Serialise every concurrent check-and-write for this user within `scope` until the
   * transaction ends (Postgres: `pg_advisory_xact_lock`). This is what turns
   * "count then insert" into one atomic admission under concurrent redelivery.
   */
  lockUser(userId: UserId, scope: UserLockScope): Promise<void>;
  /** Record one admitted message. Must be idempotent on `(userId, messageId)`. */
  recordUsage(row: UsageRow): Promise<void>;
}

export interface EntitlementRepository<X> extends EntitlementReads {
  runInTransaction<T>(fn: (tx: EntitlementTransaction<X>) => Promise<T>): Promise<T>;
}

/**
 * The counts other modules own: M3's non-archived category count and M5's
 * reminder-enabled category count. M8 never reads those tables itself (master plan
 * §2 rule 2) — it compares what the owner supplies against the tier limit. Both
 * take the executor so they read inside the gating transaction.
 */
export interface CapacityReader<X> {
  countActiveCategories(userId: UserId, executor: X): Promise<number>;
  countReminderCategories(userId: UserId, executor: X): Promise<number>;
}

/** M2's immutable timezone — production wiring adapts `IdentityService.getSettings`. */
export type TimezoneReader = (userId: UserId) => Promise<string>;
