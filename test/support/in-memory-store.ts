import type { AllowanceSend } from '../../src/core/allowance';
import type { Budget, PeriodCap, StoredBudgetPeriod } from '../../src/core/budgets';
import type { Category, Transaction } from '../../src/core/ledger';
import type { Id } from '../../src/core/shared/common';

/**
 * The shared "world" the in-memory M3 and M4 repositories both write to, and the
 * executor type (`X`) they are parameterised on. In production that type parameter is
 * a Drizzle transaction handle; here it is this object, which is exactly the point of
 * making it a parameter — neither core module learns what a database is.
 *
 * One store rather than one per repository, because M3's `record` materialises an M4
 * period and inserts an M3 row in a *single* transaction. A rollback has to undo both
 * or the atomicity test would be checking nothing.
 *
 * This is a test adapter and it models only the behaviour the units under test need
 * (M3's plan: "do not reproduce every PostgreSQL feature in an in-memory repository").
 * What it models honestly is uniqueness and rollback; what it does not model — real
 * concurrency, advisory locks, index behaviour — is covered by the integration suite
 * against real Postgres instead.
 */
export class InMemoryStore {
  categories: Category[] = [];
  transactions: Transaction[] = [];
  budgets: Budget[] = [];
  periods: StoredBudgetPeriod[] = [];
  periodCaps: PeriodCap[] = [];
  allowanceSends: AllowanceSend[] = [];
  /**
   * `category.reminder_enabled`, held beside the rows rather than on them: M3's
   * `Category` domain type does not expose the column (it is M5's), and inventing a
   * field on it here would make the fake diverge from the contract under test.
   */
  reminderEnabled = new Set<Id>();

  /** Rows are treated as immutable, so a shallow copy of each array is a real snapshot. */
  snapshot(): InMemoryStoreSnapshot {
    return {
      categories: [...this.categories],
      transactions: [...this.transactions],
      budgets: [...this.budgets],
      periods: [...this.periods],
      periodCaps: [...this.periodCaps],
      allowanceSends: [...this.allowanceSends],
      reminderEnabled: new Set(this.reminderEnabled),
    };
  }

  restore(snapshot: InMemoryStoreSnapshot): void {
    this.categories = [...snapshot.categories];
    this.transactions = [...snapshot.transactions];
    this.budgets = [...snapshot.budgets];
    this.periods = [...snapshot.periods];
    this.periodCaps = [...snapshot.periodCaps];
    this.allowanceSends = [...snapshot.allowanceSends];
    this.reminderEnabled = new Set(snapshot.reminderEnabled);
  }

  /** Snapshot, run, and undo every table on failure — the transaction boundary. */
  async transaction<T>(fn: () => Promise<T>): Promise<T> {
    const before = this.snapshot();
    try {
      return await fn();
    } catch (error) {
      this.restore(before);
      throw error;
    }
  }
}

export interface InMemoryStoreSnapshot {
  categories: readonly Category[];
  transactions: readonly Transaction[];
  budgets: readonly Budget[];
  periods: readonly StoredBudgetPeriod[];
  periodCaps: readonly PeriodCap[];
  allowanceSends: readonly AllowanceSend[];
  reminderEnabled: ReadonlySet<Id>;
}
