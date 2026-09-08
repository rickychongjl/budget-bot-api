import { and, eq } from 'drizzle-orm';
import type {
  BudgetReads,
  BudgetRepository,
  BudgetWrites,
  NewBudgetPeriodInput,
  UpsertBudgetInput,
} from '../../../core/budgets/budget-repository';
import type { Budget, BudgetPeriod } from '../../../core/budgets/budget-service';
import type { Id, Instant, MinorUnits, UserId } from '../../../core/shared/common';
import type { Database } from '../client';
import { budget, budgetPeriod } from '../schema/budget';

/**
 * `BudgetRepository` over Drizzle/Postgres — the only M4 code that touches a DB
 * handle, and the reason it lives in `infrastructure/` rather than `core/`.
 *
 * The module's one concurrency invariant is a constraint here, not a check in the
 * service: `materialisePeriod` is `insert … on conflict (budget_id, period_key) do
 * nothing` followed by a select, so two messages arriving either side of a period
 * boundary serialise on `budget_period_budget_key_unique` and both end up holding the
 * same snapshot. A read-then-insert would produce two.
 *
 * `updatePeriodCap` deliberately takes a `period_key` rather than a row id: the caller
 * has already decided it means the *current* period, and naming it that way makes a
 * past period's snapshot impossible to touch by accident.
 */

/** A Drizzle handle that may be the pool or an open transaction. Mirrors M8's. */
export type DatabaseExecutor = Database | Parameters<Parameters<Database['transaction']>[0]>[0];

type BudgetRow = typeof budget.$inferSelect;
type BudgetPeriodRow = typeof budgetPeriod.$inferSelect;

function toBudget(row: BudgetRow): Budget {
  return {
    id: row.id,
    userId: row.userId,
    categoryId: row.categoryId,
    capMinorUnits: row.capMinorUnits,
    currencyCode: row.currencyCode,
    isActive: row.isActive,
    createdAt: row.createdAt.getTime(),
    updatedAt: row.updatedAt.getTime(),
  };
}

function toPeriod(row: BudgetPeriodRow): BudgetPeriod {
  return {
    id: row.id,
    userId: row.userId,
    budgetId: row.budgetId,
    periodKey: row.periodKey,
    periodStart: row.periodStart,
    periodEnd: row.periodEnd,
    capMinorUnits: row.capMinorUnits,
    createdAt: row.createdAt.getTime(),
  };
}

function operations(x: DatabaseExecutor): BudgetReads & BudgetWrites {
  return {
    async findActiveBudgets(userId: UserId): Promise<readonly Budget[]> {
      const rows = await x
        .select()
        .from(budget)
        .where(and(eq(budget.userId, userId), eq(budget.isActive, true)));
      return rows.map(toBudget);
    },

    async findActiveBudgetForCategory(userId: UserId, categoryId: Id): Promise<Budget | null> {
      const [row] = await x
        .select()
        .from(budget)
        .where(
          and(eq(budget.userId, userId), eq(budget.categoryId, categoryId), eq(budget.isActive, true)),
        )
        .limit(1);
      return row ? toBudget(row) : null;
    },

    async findBudget(userId: UserId, budgetId: Id): Promise<Budget | null> {
      const [row] = await x
        .select()
        .from(budget)
        .where(and(eq(budget.userId, userId), eq(budget.id, budgetId)))
        .limit(1);
      return row ? toBudget(row) : null;
    },

    async findPeriod(userId: UserId, budgetId: Id, periodKey: string): Promise<BudgetPeriod | null> {
      const [row] = await x
        .select()
        .from(budgetPeriod)
        .where(
          and(
            eq(budgetPeriod.userId, userId),
            eq(budgetPeriod.budgetId, budgetId),
            eq(budgetPeriod.periodKey, periodKey),
          ),
        )
        .limit(1);
      return row ? toPeriod(row) : null;
    },

    async findPeriodsByKey(userId: UserId, periodKey: string): Promise<readonly BudgetPeriod[]> {
      const rows = await x
        .select()
        .from(budgetPeriod)
        .where(and(eq(budgetPeriod.userId, userId), eq(budgetPeriod.periodKey, periodKey)));
      return rows.map(toPeriod);
    },

    async materialisePeriod(input: NewBudgetPeriodInput): Promise<BudgetPeriod> {
      const inserted = await x
        .insert(budgetPeriod)
        .values({
          userId: input.userId,
          budgetId: input.budgetId,
          periodKey: input.periodKey,
          periodStart: input.periodStart,
          periodEnd: input.periodEnd,
          capMinorUnits: input.capMinorUnits,
          createdAt: new Date(input.now),
        })
        .onConflictDoNothing({ target: [budgetPeriod.budgetId, budgetPeriod.periodKey] })
        .returning();
      const row = inserted[0];
      if (row) return toPeriod(row);

      // Somebody else materialised it first — read theirs rather than retrying.
      const [existing] = await x
        .select()
        .from(budgetPeriod)
        .where(
          and(eq(budgetPeriod.budgetId, input.budgetId), eq(budgetPeriod.periodKey, input.periodKey)),
        )
        .limit(1);
      if (!existing) throw new Error(`budget_period vanished after conflict: ${input.periodKey}`);
      return toPeriod(existing);
    },

    async upsertActiveBudget(input: UpsertBudgetInput): Promise<Budget> {
      const updated = await x
        .update(budget)
        .set({
          capMinorUnits: input.capMinorUnits,
          currencyCode: input.currencyCode,
          updatedAt: new Date(input.now),
        })
        .where(
          and(
            eq(budget.userId, input.userId),
            eq(budget.categoryId, input.categoryId),
            eq(budget.isActive, true),
          ),
        )
        .returning();
      const existing = updated[0];
      if (existing) return toBudget(existing);

      const [created] = await x
        .insert(budget)
        .values({
          userId: input.userId,
          categoryId: input.categoryId,
          capMinorUnits: input.capMinorUnits,
          currencyCode: input.currencyCode,
          isActive: true,
          createdAt: new Date(input.now),
          updatedAt: new Date(input.now),
        })
        .returning();
      if (!created) throw new Error('budget insert returned no row');
      return toBudget(created);
    },

    async updatePeriodCap(userId: UserId, budgetId: Id, periodKey: string, cap: MinorUnits): Promise<void> {
      await x
        .update(budgetPeriod)
        .set({ capMinorUnits: cap })
        .where(
          and(
            eq(budgetPeriod.userId, userId),
            eq(budgetPeriod.budgetId, budgetId),
            eq(budgetPeriod.periodKey, periodKey),
          ),
        );
    },

    async deactivateBudget(userId: UserId, budgetId: Id, now: Instant): Promise<boolean> {
      const rows = await x
        .update(budget)
        .set({ isActive: false, updatedAt: new Date(now) })
        .where(and(eq(budget.userId, userId), eq(budget.id, budgetId), eq(budget.isActive, true)))
        .returning({ id: budget.id });
      return rows.length === 1;
    },
  };
}

export class DrizzleBudgetRepository implements BudgetRepository<DatabaseExecutor> {
  private readonly root: BudgetReads & BudgetWrites;

  constructor(private readonly db: Database) {
    this.root = operations(db);
  }

  withExecutor(executor: DatabaseExecutor): BudgetReads & BudgetWrites {
    return operations(executor);
  }

  findActiveBudgets(userId: UserId): Promise<readonly Budget[]> {
    return this.root.findActiveBudgets(userId);
  }
  findActiveBudgetForCategory(userId: UserId, categoryId: Id): Promise<Budget | null> {
    return this.root.findActiveBudgetForCategory(userId, categoryId);
  }
  findBudget(userId: UserId, budgetId: Id): Promise<Budget | null> {
    return this.root.findBudget(userId, budgetId);
  }
  findPeriod(userId: UserId, budgetId: Id, periodKey: string): Promise<BudgetPeriod | null> {
    return this.root.findPeriod(userId, budgetId, periodKey);
  }
  findPeriodsByKey(userId: UserId, periodKey: string): Promise<readonly BudgetPeriod[]> {
    return this.root.findPeriodsByKey(userId, periodKey);
  }
  materialisePeriod(input: NewBudgetPeriodInput): Promise<BudgetPeriod> {
    return this.root.materialisePeriod(input);
  }
  upsertActiveBudget(input: UpsertBudgetInput): Promise<Budget> {
    return this.root.upsertActiveBudget(input);
  }
  updatePeriodCap(userId: UserId, budgetId: Id, periodKey: string, cap: MinorUnits): Promise<void> {
    return this.root.updatePeriodCap(userId, budgetId, periodKey, cap);
  }
  deactivateBudget(userId: UserId, budgetId: Id, now: Instant): Promise<boolean> {
    return this.root.deactivateBudget(userId, budgetId, now);
  }
}
