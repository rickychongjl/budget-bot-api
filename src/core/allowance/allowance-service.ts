import type { Id, Instant, LocalDate, MinorUnits, UserId } from '../shared/common';

/**
 * M5 — Daily Allowance & Scheduler. Turns a cycle cap into one number the user can
 * act on today, delivered before they overspend.
 *
 * Interface from `docs/M5-daily-allowance-scheduler.md` ("Public interface"), with one
 * refinement made when M5 was built (M1's "the owning module may refine its committed
 * port" licence, the same one M3/M4 used for `currentBudgets` / `findByName`):
 *
 *   **`findDue` and `computeAndSend` are per-user, not per-(user, category).** The
 *   Phase 0 stub predated the 5 Sep bundling decision and returned `(user, category)`
 *   pairs. Delivery is one message per user covering every reminder-eligible category,
 *   and M5's own cron pseudo-code says "for each due *user* -> subrequest", so a
 *   per-category dispatch unit would have to be de-duplicated back to a user before it
 *   could be sent. `availableToday` is unchanged.
 */

/** A user with at least one reminder-eligible category still to be sent today. */
export interface DueUser {
  userId: UserId;
  /** The user's local date at the tick — the date the bundle is for. */
  localDate: LocalDate;
}

/**
 * Outcome of computing + delivering one user's bundled reminder. Every row included
 * in a bundle shares this outcome — never partially sent.
 */
export interface SendOutcome {
  status: 'sent' | 'skipped' | 'failed' | 'pending';
  /** For a retryable failure (429/5xx) — rows stay `pending`, the next tick retries. */
  retryable?: boolean;
  retryAfterSeconds?: number;
  /** How many categories the message actually covered. 0 means nothing survived revalidation. */
  categoryCount: number;
}

export interface AllowanceView {
  categoryId: Id;
  /** For rendering — M7 renders, never computes. */
  categoryName: string;
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
  /**
   * Users whose local time at `now` has reached their reminder time (fixed 07:00 this
   * pass) and who still have an unsent reminder-eligible category today. `limit` caps
   * the cron's fan-out — the Workers Free plan allows 50 subrequests per invocation.
   */
  findDue(now: Instant, limit: number): Promise<readonly DueUser[]>;

  /** Compute, bundle and deliver one user's reminder for their local today. */
  computeAndSend(userId: UserId): Promise<SendOutcome>;

  /** All budgeted categories if `categoryId` is omitted. Computes + persists a row on demand. */
  availableToday(userId: UserId, categoryId?: Id): Promise<readonly AllowanceView[]>;
}
