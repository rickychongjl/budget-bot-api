import type {
  Budget,
  BudgetPeriod,
  BudgetReads,
  BudgetRepository,
  BudgetWrites,
  NewBudgetPeriodInput,
  UpsertBudgetInput,
} from '../../src/core/budgets';
import type { Id, Instant, MinorUnits, UserId } from '../../src/core/shared/common';
import { fakeId } from './fake-id';
import type { InMemoryStore } from './in-memory-store';

/**
 * `BudgetRepository` over an `InMemoryStore` — a test adapter, not evidence that
 * Drizzle or Postgres works (M3/M4 plans, "Testing"). It models the two guarantees
 * M4's service logic actually leans on:
 *
 *   - `materialisePeriod` is idempotent on `(budgetId, periodKey)`, standing in for
 *     `budget_period_budget_key_unique`;
 *   - `upsertActiveBudget` keeps at most one active budget per category, standing in
 *     for the `budget_one_active_per_category` partial unique index.
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

  async findPeriod(userId: UserId, budgetId: Id, periodKey: string): Promise<BudgetPeriod | null> {
    return (
      this.store.periods.find(
        (p) => p.userId === userId && p.budgetId === budgetId && p.periodKey === periodKey,
      ) ?? null
    );
  }

  async findPeriodsByKey(userId: UserId, periodKey: string): Promise<readonly BudgetPeriod[]> {
    return this.store.periods.filter((p) => p.userId === userId && p.periodKey === periodKey);
  }

  async materialisePeriod(input: NewBudgetPeriodInput): Promise<BudgetPeriod> {
    const existing = this.store.periods.find(
      (p) => p.budgetId === input.budgetId && p.periodKey === input.periodKey,
    );
    if (existing) return existing;
    const row: BudgetPeriod = {
      id: fakeId('period'),
      userId: input.userId,
      budgetId: input.budgetId,
      periodKey: input.periodKey,
      periodStart: input.periodStart,
      periodEnd: input.periodEnd,
      capMinorUnits: input.capMinorUnits,
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
      const updated: Budget = {
        ...existing,
        capMinorUnits: input.capMinorUnits,
        currencyCode: input.currencyCode,
        updatedAt: input.now,
      };
      this.store.budgets[index] = updated;
      return updated;
    }
    const row: Budget = {
      id: fakeId('budget'),
      userId: input.userId,
      categoryId: input.categoryId,
      capMinorUnits: input.capMinorUnits,
      currencyCode: input.currencyCode,
      isActive: true,
      createdAt: input.now,
      updatedAt: input.now,
    };
    this.store.budgets.push(row);
    return row;
  }

  async updatePeriodCap(userId: UserId, budgetId: Id, periodKey: string, cap: MinorUnits): Promise<void> {
    const index = this.store.periods.findIndex(
      (p) => p.userId === userId && p.budgetId === budgetId && p.periodKey === periodKey,
    );
    const existing = this.store.periods[index];
    if (existing) this.store.periods[index] = { ...existing, capMinorUnits: cap };
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
