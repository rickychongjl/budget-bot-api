import type { Id, Instant, LocalDate, LocalTime, MinorUnits, UserId } from '../shared/common';

/**
 * M5's persistence seam. Covers `daily_allowance_send` **and** the `reminder_enabled`
 * column on M3's `category` table — both are M5's data, so they share one port and one
 * implementation rather than two that always travel together.
 *
 * On that column: it is a deliberate, narrow exception to CLAUDE.md's "one module owns
 * each table", agreed 11 Sep. See `infrastructure/database/schema/category.ts` and
 * M5's `docs/build-log.md` entry for why. M5 touches exactly that column.
 *
 * Generic over an executor `X` so a capacity count can be read inside M8's gating
 * transaction, exactly as `BudgetRepository<X>` and `LedgerRepository<X>` are.
 */

/** A `daily_allowance_send` row. */
export interface AllowanceSend {
  id: Id;
  userId: UserId;
  categoryId: Id;
  localDate: LocalDate;
  dailyTargetMinorUnits: MinorUnits;
  budgetPeriodId: Id;
  deliveryStatus: DeliveryStatus;
  attempts: number;
  sentAt: Instant | null;
  createdAt: Instant;
}

export type DeliveryStatus = 'not_applicable' | 'pending' | 'sent' | 'failed' | 'skipped';

export interface NewAllowanceSendInput {
  userId: UserId;
  categoryId: Id;
  localDate: LocalDate;
  dailyTargetMinorUnits: MinorUnits;
  budgetPeriodId: Id;
  deliveryStatus: DeliveryStatus;
}

/**
 * A category as the dispatch path needs it — enough to revalidate eligibility and to
 * render a line, without M5 needing M3's full `Category`.
 */
export interface ReminderCategory {
  categoryId: Id;
  name: string;
  isArchived: boolean;
  reminderEnabled: boolean;
}

/** One candidate user from the due scan, with everything the dispatch needs. */
export interface DueUserRow {
  userId: UserId;
  localDate: LocalDate;
  timezone: string;
  reminderLocalTime: LocalTime;
}

export interface DueWindow {
  /** The tick instant. Local time is derived per user, in SQL, from their own timezone. */
  now: Instant;
  /**
   * How long after a user's reminder time they stay due. Bounded catch-up: a dropped
   * tick or cron drift still delivers, but a user who onboards in the afternoon never
   * receives a "morning reminder" at 3pm.
   */
  windowMinutes: number;
}

export interface AllowanceReads {
  findSend(userId: UserId, categoryId: Id, localDate: LocalDate): Promise<AllowanceSend | null>;
  listSendsForDate(userId: UserId, localDate: LocalDate): Promise<readonly AllowanceSend[]>;

  /**
   * One indexed scan across users — the only cross-user query in the module. Postgres
   * does the timezone maths from each user's own `timezone`, so this does not degrade
   * into "fetch every user and filter in TypeScript".
   */
  findDueUsers(window: DueWindow, limit: number): Promise<readonly DueUserRow[]>;

  /**
   * Every non-archived category with its reminder flag, in display order. One query
   * serves both callers — the dispatch path filters to reminder-enabled, `/today`
   * wants all of them — and a user has at most 30, so filtering in memory is cheaper
   * than a second round trip.
   */
  listCategories(userId: UserId): Promise<readonly ReminderCategory[]>;

  findCategory(userId: UserId, categoryId: Id): Promise<ReminderCategory | null>;

  /**
   * M8's `CapacityReader.countReminderCategories`. Bind it to M8's gating transaction
   * with `withExecutor` rather than passing an executor here — see
   * `createReminderCapacityReader` in `./index.ts`.
   */
  countReminderCategories(userId: UserId): Promise<number>;
}

export interface AllowanceWrites {
  /**
   * Insert-or-read. The `(user_id, category_id, local_date)` unique constraint is the
   * double-send guard, so a conflict returns the row that won rather than retrying —
   * the same shape as M4's `materialisePeriod`.
   */
  insertSend(input: NewAllowanceSendInput): Promise<AllowanceSend>;

  /**
   * Move a whole bundle to a terminal state in one statement. Takes a set of ids
   * because every row in one send shares that send's outcome — never partially `sent`
   * and partially `pending` for the same attempt.
   */
  markSends(ids: readonly Id[], status: DeliveryStatus, now: Instant): Promise<void>;

  /** Retryable failure: rows stay `pending`, attempts + 1. Returns the new attempt count. */
  incrementAttempts(ids: readonly Id[]): Promise<number>;

  /**
   * Rewrite the frozen target on an existing row — the one write that moves it. Only
   * `DefaultAllowanceService.capChanged` calls this, and only for the user's current
   * local date: a cap change is the single event allowed to touch a persisted target
   * (M5, "Why the morning target is persisted"). Delivery state is left exactly as it
   * was — a `sent` row stays `sent`, so the bundle is never delivered twice.
   */
  updateTarget(
    userId: UserId,
    categoryId: Id,
    localDate: LocalDate,
    dailyTarget: MinorUnits,
  ): Promise<void>;

  setReminderEnabled(userId: UserId, categoryId: Id, enabled: boolean): Promise<void>;
}

export interface AllowanceRepository<X> extends AllowanceReads, AllowanceWrites {
  withExecutor(executor: X): AllowanceReads & AllowanceWrites;
}
