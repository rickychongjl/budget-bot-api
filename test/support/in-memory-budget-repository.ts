import type {
  Budget,
  BudgetReads,
  BudgetRepository,
  BudgetWrites,
  NewBudgetPeriodInput,
  PeriodCap,
  StoredBudgetPeriod,
  UpsertBudgetInput,
  UpsertPeriodCapInput,
} from '../../src/core/budgets';
import type { Id, Instant, UserId } from '../../src/core/shared/common';
import { fakeId } from './fake-id';
import type { InMemoryStore } from './in-memory-store';

/**
 * `BudgetRepository` over an `InMemoryStore` — a test adapter, not evidence that
 * Drizzle or Postgres works (M3/M4 plans, "Testing"). It models the three guarantees
 * M4's service logic actually leans on:
 *
 *   - `materialisePeriod` is idempotent on `(budgetId, periodKey)`, standing in for
 *     `budget_period_budget_key_unique`;
 *   - `upsertActiveBudget` keeps at most one active budget per category, standing in
 *     for the `budget_one_active_per_category` partial unique index;
 *   - `upsertPeriodCap` keeps one row per `(categoryId, periodKey)`, standing in for
 *     `category_period_cap_category_key_unique`, and the governing-cap reads pick the
 *     greatest key at or before the asked cycle — the lookup the real query does.
 *
 * It cannot model a real race — `test/integration/ledger-budgets.test.ts` does that
 * against Postgres.
 */
export class InMemoryBudgetRepository implements BudgetRepository<InMemoryStore> {
  constructor(private readonly store: InMemoryStore) {}

  withExecutor(executor: InMemoryStore): BudgetReads & BudgetWrites {
    return new InMemoryBudgetRepository(executor);
  }

  async findActiveBudgets(userId: UserId): Promise<readonly Budget[]> {
    return this.store.budgets.filter((b) => b.userId === userId && b.isActive);
  }

  async findActiveBudgetForCategory(userId: UserId, categoryId: Id): Promise<Budget | null> {
    return (
      this.store.budgets.find((b) => b.userId === userId && b.categoryId === categoryId && b.isActive) ?? null
    );
  }

  async findBudget(userId: UserId, budgetId: Id): Promise<Budget | null> {
    return this.store.budgets.find((b) => b.userId === userId && b.id === budgetId) ?? null;
  }

  async findPeriod(userId: UserId, budgetId: Id, periodKey: string): Promise<StoredBudgetPeriod | null> {
    return (
      this.store.periods.find(
        (p) => p.userId === userId && p.budgetId === budgetId && p.periodKey === periodKey,
      ) ?? null
    );
  }

  async findGoverningCap(userId: UserId, categoryId: Id, periodKey: string): Promise<PeriodCap | null> {
    return governing(this.store.periodCaps.filter((c) => c.userId === userId && c.categoryId === categoryId), periodKey);
  }

  async findGoverningCaps(userId: UserId, periodKey: string): Promise<readonly PeriodCap[]> {
    const byCategory = new Map<Id, PeriodCap[]>();
    for (const cap of this.store.periodCaps) {
      if (cap.userId !== userId) continue;
      byCategory.set(cap.categoryId, [...(byCategory.get(cap.categoryId) ?? []), cap]);
    }
    return [...byCategory.values()]
      .map((rows) => governing(rows, periodKey))
      .filter((cap): cap is PeriodCap => cap !== null);
  }

  async materialisePeriod(input: NewBudgetPeriodInput): Promise<StoredBudgetPeriod> {
    const existing = this.store.periods.find(
      (p) => p.budgetId === input.budgetId && p.periodKey === input.periodKey,
    );
    if (existing) return existing;
    const row: StoredBudgetPeriod = {
      id: fakeId('period'),
      userId: input.userId,
      budgetId: input.budgetId,
      periodKey: input.periodKey,
      periodStart: input.periodStart,
      periodEnd: input.periodEnd,
      createdAt: input.now,
    };
    this.store.periods.push(row);
    return row;
  }

  async upsertActiveBudget(input: UpsertBudgetInput): Promise<Budget> {
    const index = this.store.budgets.findIndex(
      (b) => b.userId === input.userId && b.categoryId === input.categoryId && b.isActive,
    );
    const existing = this.store.budgets[index];
    if (existing) {
      const updated: Budget = { ...existing, currencyCode: input.currencyCode, updatedAt: input.now };
      this.store.budgets[index] = updated;
      return updated;
    }
    const row: Budget = {
      id: fakeId('budget'),
      userId: input.userId,
      categoryId: input.categoryId,
      currencyCode: input.currencyCode,
      isActive: true,
      createdAt: input.now,
      updatedAt: input.now,
    };
    this.store.budgets.push(row);
    return row;
  }

  async upsertPeriodCap(input: UpsertPeriodCapInput): Promise<PeriodCap> {
    const index = this.store.periodCaps.findIndex(
      (c) => c.categoryId === input.categoryId && c.periodKey === input.periodKey,
    );
    const existing = this.store.periodCaps[index];
    if (existing) {
      const updated: PeriodCap = { ...existing, capMinorUnits: input.capMinorUnits, updatedAt: input.now };
      this.store.periodCaps[index] = updated;
      return updated;
    }
    const row: PeriodCap = {
      userId: input.userId,
      categoryId: input.categoryId,
      periodKey: input.periodKey,
      capMinorUnits: input.capMinorUnits,
      createdAt: input.now,
      updatedAt: input.now,
    };
    this.store.periodCaps.push(row);
    return row;
  }

  async deactivateBudget(userId: UserId, budgetId: Id, now: Instant): Promise<boolean> {
    const index = this.store.budgets.findIndex(
      (b) => b.userId === userId && b.id === budgetId && b.isActive,
    );
    const existing = this.store.budgets[index];
    if (!existing) return false;
    this.store.budgets[index] = { ...existing, isActive: false, updatedAt: now };
    return true;
  }
}

/** The row with the greatest key at or before `periodKey` — `'YYYY-MM'` compares as text. */
function governing(rows: readonly PeriodCap[], periodKey: string): PeriodCap | null {
  return rows
    .filter((c) => c.periodKey <= periodKey)
    .reduce<PeriodCap | null>((best, c) => (best === null || c.periodKey > best.periodKey ? c : best), null);
}
