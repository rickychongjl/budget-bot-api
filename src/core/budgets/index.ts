/**
 * M4 — Budgets & Periods (Phase 2, coordinated with M3).
 *
 * Implements `BudgetService` (`./budget-service.ts`) against
 * `infrastructure/database/schema/budget.ts`. Owns monthly period derivation from
 * `period_anchor_date`, lazy period materialisation, the `budget` / `budget_period`
 * split, `/budget`. Period maths lives in `./period.ts` as a pure, clock-injected
 * function.
 *
 * Public surface: the contract, its implementation, and the pure period maths.
 * `budget-repository.ts` is the outgoing port — its Drizzle implementation lives in
 * `infrastructure/database/repositories/drizzle-budget-repository.ts` and is
 * deliberately **not** re-exported here; core must not depend on infrastructure.
 *
 * Wiring (composition root):
 *   const budgetRepository = new DrizzleBudgetRepository(db);
 *   const budgets = new DefaultBudgetService({
 *     repository: budgetRepository,
 *     settingsOf: (userId) => identity.getSettings(userId),
 *     clock,
 *   });
 */
export type {
  Budget,
  BudgetAllowanceNotifier,
  BudgetPeriod,
  BudgetService,
  BudgetSettingsReader,
  BudgetUserSettings,
  BudgetView,
  Period,
  PeriodMaterialiser,
} from './budget-service';

export type {
  BudgetReads,
  BudgetRepository,
  BudgetWrites,
  NewBudgetPeriodInput,
  UpsertBudgetInput,
} from './budget-repository';

export { DefaultBudgetService } from './default-budget-service';
export type { BudgetServiceDeps } from './default-budget-service';

export { MAX_PERIOD_START_DAY, periodFor, periodStartDay } from './period';
