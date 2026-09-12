import type { CurrencyCode, Id, Instant, LocalDate, MinorUnits, UserId } from '../shared/common';
import type { Budget, BudgetPeriod, PeriodCap } from './budget-service';

/**
 * The outgoing port for M4 — the persistence seam. `DefaultBudgetService` talks to
 * this interface only; `DrizzleBudgetRepository` is the one place that sees a DB
 * handle (M1 §4 / master plan §6 rule 3), and
 * `test/support/in-memory-budget-repository.ts` mirrors the same constraints so the
 * service logic is unit-testable without Postgres.
 *
 * Two operations carry the module's invariants and must be *atomic in the store*,
 * not check-then-act in the caller:
 *   - `materialisePeriod` — `insert … on conflict (budget_id, period_key) do nothing`,
 *     then select. Two concurrent messages at a period boundary serialise on the
 *     unique index instead of producing two rows for the same cycle.
 *   - `upsertPeriodCap` — `insert … on conflict (category_id, period_key) do update`.
 *     Two `/budget` messages in one cycle end with one governing row, the later write.
 *
 * `X` is the *executor* type — the handle a caller uses to run M4's period
 * materialisation inside its own transaction. Drizzle: the transaction handle.
 * In-memory: whatever "world" object the test owns. It exists so M3 can record a
 * transaction and materialise its period atomically without either module learning
 * what a Drizzle transaction is (CLAUDE.md, "Transactions"); the pattern is M8's
 * `CapacityReader<X>` / `gate`, reused rather than reinvented.
 */

export interface NewBudgetPeriodInput {
  userId: UserId;
  budgetId: Id;
  periodKey: string;
  periodStart: LocalDate;
  periodEnd: LocalDate;
  now: Instant;
}

export interface UpsertBudgetInput {
  userId: UserId;
  categoryId: Id;
  now: Instant;
}

export interface UpsertPeriodCapInput {
  userId: UserId;
  categoryId: Id;
  periodKey: string;
  /** Null records a removal: no cap from this cycle on. */
  capMinorUnits: MinorUnits | null;
  currencyCode: CurrencyCode;
  now: Instant;
}

/** A `budget_period` row as stored. The service attaches the cap; the table has none. */
export type StoredBudgetPeriod = Omit<BudgetPeriod, 'capMinorUnits'>;

export interface BudgetReads {
  findActiveBudgets(userId: UserId): Promise<readonly Budget[]>;
  findActiveBudgetForCategory(userId: UserId, categoryId: Id): Promise<Budget | null>;
  findBudget(userId: UserId, budgetId: Id): Promise<Budget | null>;
  findPeriod(userId: UserId, budgetId: Id, periodKey: string): Promise<StoredBudgetPeriod | null>;

  /**
   * The row governing `periodKey` for one category: the greatest key at or before it,
   * or null when the category carried no cap row that early. A returned row may itself
   * carry a null cap (a removal) — the service reads both as "no cap".
   */
  findGoverningCap(userId: UserId, categoryId: Id, periodKey: string): Promise<PeriodCap | null>;

  /** The governing row for every category that has one at or before `periodKey`. */
  findGoverningCaps(userId: UserId, periodKey: string): Promise<readonly PeriodCap[]>;
}

export interface BudgetWrites {
  /**
   * Race-safe lazy materialisation. Returns the existing row when one is already
   * there, so a concurrent caller sees the same cycle rather than a second one.
   */
  materialisePeriod(input: NewBudgetPeriodInput): Promise<StoredBudgetPeriod>;

  /**
   * The standing rule for a category: touch the live row, or insert one. The
   * `budget_one_active_per_category` partial unique index is what makes "at most one
   * active budget per category" true regardless of concurrency.
   */
  upsertActiveBudget(input: UpsertBudgetInput): Promise<Budget>;

  /**
   * Insert or overwrite the cap row for `(categoryId, periodKey)`. Only ever called for
   * the *current* cycle — that is what keeps every past cycle's governing row immutable.
   */
  upsertPeriodCap(input: UpsertPeriodCapInput): Promise<PeriodCap>;

  /** `is_active = false`. Historical `budget_period` rows keep referencing it. */
  deactivateBudget(userId: UserId, budgetId: Id, now: Instant): Promise<boolean>;
}

export interface BudgetRepository<X> extends BudgetReads, BudgetWrites {
  /**
   * The same operations bound to a caller's transaction handle, so M3's `record` can
   * materialise a period and insert its ledger row in one database transaction
   * (M3 checklist step 2, "steps b–d in one DB transaction").
   */
  withExecutor(executor: X): BudgetReads & BudgetWrites;
}
