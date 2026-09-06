import type { Id, Instant, LocalDate, MinorUnits, UserId } from './common';

/**
 * M5 — Daily Allowance & Scheduler. Turns a cycle cap into one number the user can
 * act on today, delivered before they overspend.
 *
 * Interface lifted from `docs/M5-daily-allowance-scheduler.md` ("Public interface") —
 * the per-category revision (master plan §5.2), not the page's original per-user
 * shape. Stub only.
 */

/** A (user, category) pair due for a send now — `findDue` returns pairs, not users. */
export interface DueSend {
  userId: UserId;
  categoryId: Id;
}

/**
 * Outcome of computing + delivering one user's bundled reminder. Every row included
 * in a bundle shares this outcome — never partially sent.
 */
export interface SendOutcome {
  status: 'sent' | 'skipped' | 'failed' | 'pending';
  /** For a retryable failure (429/5xx) — leave `pending`, retry next tick. */
  retryable?: boolean;
  retryAfterSeconds?: number;
}

export interface AllowanceView {
  categoryId: Id;
  /** Frozen for the date once computed — never recomputed for that date. */
  dailyTarget: MinorUnits;
  spentToday: MinorUnits;
  /** `dailyTarget - spentToday`. May be negative; shown negative. */
  availableToday: MinorUnits;
  periodEnd: LocalDate;
  /** Includes today, so the last day of a period divides by 1, never 0. */
  daysLeft: number;
}

export interface DailyAllowanceService {
  /** (user, category) pairs whose local time now matches the fixed 07:00 send. */
  findDue(now: Instant, limit: number): Promise<readonly DueSend[]>;

  computeAndSend(userId: UserId, categoryId: Id): Promise<SendOutcome>;

  /** All budgeted categories if `categoryId` is omitted. Computes + persists a row on demand. */
  availableToday(userId: UserId, categoryId?: Id): Promise<readonly AllowanceView[]>;
}
