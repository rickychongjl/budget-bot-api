/**
 * M4 — Budgets & Periods (Phase 2, coordinated with M3).
 *
 * Implements `BudgetService` (`core/ports/budget-service.ts`) against
 * `db/schema/budget.ts`. Owns monthly period derivation from `period_anchor_date`,
 * lazy period materialisation, the `budget` / `budget_period` split, `/budget`.
 * Period maths lives in `core/domain/period.ts` as a pure, clock-injected function.
 *
 * Empty until the M4 agent's PR.
 */
export {};
