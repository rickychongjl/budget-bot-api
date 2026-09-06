/**
 * M4 — Budgets & Periods (Phase 2, coordinated with M3).
 *
 * Implements `BudgetService` (`./budget-service.ts`) against
 * `infrastructure/database/schema/budget.ts`. Owns monthly period derivation from
 * `period_anchor_date`, lazy period materialisation, the `budget` / `budget_period`
 * split, `/budget`. Period maths lives in `./period.ts` as a pure, clock-injected
 * function.
 *
 * The contract below is fixed; `DefaultBudgetService` and the repository
 * implementation are empty until the M4 agent's PR.
 */
export type { Budget, BudgetPeriod, BudgetService, Period } from './budget-service';
export { periodFor } from './period';
