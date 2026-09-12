import { and, desc, eq, lte } from 'drizzle-orm';
import type {
  BudgetReads,
  BudgetRepository,
  BudgetWrites,
  NewBudgetPeriodInput,
  StoredBudgetPeriod,
  UpsertBudgetInput,
  UpsertPeriodCapInput,
} from '../../../core/budgets/budget-repository';
import type { Budget, PeriodCap } from '../../../core/budgets/budget-service';
import type { Id, Instant, UserId } from '../../../core/shared/common';
import type { Database } from '../client';
import { budget, budgetPeriod, categoryPeriodCap } from '../schema/budget';

/**
 * `BudgetRepository` over Drizzle/Postgres — the only M4 code that touches a DB
 * handle, and the reason it lives in `infrastructure/` rather than `core/`.
 *
 * The module's concurrency invariants are constraints here, not checks in the
 * service: `materialisePeriod` is `insert … on conflict (budget_id, period_key) do
 * nothing` followed by a select, so two messages arriving either side of a period
 * boundary serialise on `budget_period_budget_key_unique` and both end up holding the
 * same cycle; `upsertPeriodCap` is `on conflict (category_id, period_key) do update`,
 * so two `/budget` messages in one cycle end with one governing row.
 *
 * The cap lookups are the module's one real query: the governing row for a cycle is
 * `period_key <= :cycle order by period_key desc limit 1`, and for every category at
 * once `distinct on (category_id)` with the same ordering. `'YYYY-MM'` keys sort
 * chronologically as text, which is what makes both an index scan.
 *
 * `upsertPeriodCap` deliberately takes a `period_key` rather than a row id: the caller
 * has already decided it means the *current* cycle, and naming it that way makes a
 * past cycle's governing row impossible to touch by accident.
 */

/** A Drizzle handle that may be the pool or an open transaction. Mirrors M8's. */
export type DatabaseExecutor = Database | Parameters<Parameters<Database['transaction']>[0]>[0];

type BudgetRow = typeof budget.$inferSelect;
type BudgetPeriodRow = typeof budgetPeriod.$inferSelect;
type PeriodCapRow = typeof categoryPeriodCap.$inferSelect;

function toBudget(row: BudgetRow): Budget {
  return {
    id: row.id,
    userId: row.userId,
    categoryId: row.categoryId,
    currencyCode: row.currencyCode,
    isActive: row.isActive,
    createdAt: row.createdAt.getTime(),
    updatedAt: row.updatedAt.getTime(),
  };
}

function toPeriod(row: BudgetPeriodRow): StoredBudgetPeriod {
  return {
    id: row.id,
    userId: row.userId,
    budgetId: row.budgetId,
    periodKey: row.periodKey,
    periodStart: row.periodStart,
    periodEnd: row.periodEnd,
    createdAt: row.createdAt.getTime(),
  };
}

function toPeriodCap(row: PeriodCapRow): PeriodCap {
  return {
    userId: row.userId,
    categoryId: row.categoryId,
    periodKey: row.periodKey,
    capMinorUnits: row.capMinorUnits,
    createdAt: row.createdAt.getTime(),
    updatedAt: row.updatedAt.getTime(),
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

    async findPeriod(userId: UserId, budgetId: Id, periodKey: string): Promise<StoredBudgetPeriod | null> {
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

    async findGoverningCap(userId: UserId, categoryId: Id, periodKey: string): Promise<PeriodCap | null> {
      const [row] = await x
        .select()
        .from(categoryPeriodCap)
        .where(
          and(
            eq(categoryPeriodCap.userId, userId),
            eq(categoryPeriodCap.categoryId, categoryId),
            lte(categoryPeriodCap.periodKey, periodKey),
          ),
        )
        .orderBy(desc(categoryPeriodCap.periodKey))
        .limit(1);
      return row ? toPeriodCap(row) : null;
    },

    async findGoverningCaps(userId: UserId, periodKey: string): Promise<readonly PeriodCap[]> {
      const rows = await x
        .selectDistinctOn([categoryPeriodCap.categoryId])
        .from(categoryPeriodCap)
        .where(and(eq(categoryPeriodCap.userId, userId), lte(categoryPeriodCap.periodKey, periodKey)))
        .orderBy(categoryPeriodCap.categoryId, desc(categoryPeriodCap.periodKey));
      return rows.map(toPeriodCap);
    },

    async materialisePeriod(input: NewBudgetPeriodInput): Promise<StoredBudgetPeriod> {
      const inserted = await x
        .insert(budgetPeriod)
        .values({
          userId: input.userId,
          budgetId: input.budgetId,
          periodKey: input.periodKey,
          periodStart: input.periodStart,
          periodEnd: input.periodEnd,
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
          currencyCode: input.currencyCode,
          isActive: true,
          createdAt: new Date(input.now),
          updatedAt: new Date(input.now),
        })
        .returning();
      if (!created) throw new Error('budget insert returned no row');
      return toBudget(created);
    },

    async upsertPeriodCap(input: UpsertPeriodCapInput): Promise<PeriodCap> {
      const now = new Date(input.now);
      const [row] = await x
        .insert(categoryPeriodCap)
        .values({
          userId: input.userId,
          categoryId: input.categoryId,
          periodKey: input.periodKey,
          capMinorUnits: input.capMinorUnits,
          createdAt: now,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: [categoryPeriodCap.categoryId, categoryPeriodCap.periodKey],
          set: { capMinorUnits: input.capMinorUnits, updatedAt: now },
        })
        .returning();
      if (!row) throw new Error('category_period_cap upsert returned no row');
      return toPeriodCap(row);
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
  findPeriod(userId: UserId, budgetId: Id, periodKey: string): Promise<StoredBudgetPeriod | null> {
    return this.root.findPeriod(userId, budgetId, periodKey);
  }
  findGoverningCap(userId: UserId, categoryId: Id, periodKey: string): Promise<PeriodCap | null> {
    return this.root.findGoverningCap(userId, categoryId, periodKey);
  }
  findGoverningCaps(userId: UserId, periodKey: string): Promise<readonly PeriodCap[]> {
    return this.root.findGoverningCaps(userId, periodKey);
  }
  materialisePeriod(input: NewBudgetPeriodInput): Promise<StoredBudgetPeriod> {
    return this.root.materialisePeriod(input);
  }
  upsertActiveBudget(input: UpsertBudgetInput): Promise<Budget> {
    return this.root.upsertActiveBudget(input);
  }
  upsertPeriodCap(input: UpsertPeriodCapInput): Promise<PeriodCap> {
    return this.root.upsertPeriodCap(input);
  }
  deactivateBudget(userId: UserId, budgetId: Id, now: Instant): Promise<boolean> {
    return this.root.deactivateBudget(userId, budgetId, now);
  }
}
