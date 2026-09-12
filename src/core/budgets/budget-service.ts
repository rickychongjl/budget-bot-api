import type { CurrencyCode, Id, Instant, LocalDate, MinorUnits, UserId } from '../shared/common';

/**
 * M4 — Budgets & Periods. Owns what "this budgeting cycle" means. Every module that
 * needs a period boundary asks this one; nobody does date maths independently
 * (master plan §6). Monthly only this pass (round 3 revert).
 *
 * The five methods of `BudgetService` are lifted verbatim from
 * `docs/M4-budgets-periods.md` ("Public interface"). `currentBudgets` and
 * `PeriodMaterialiser` were added by the M4 agent — M1's note that "the owning module
 * may refine" its committed port, the same licence M8 used. Both are additive:
 * `currentBudgets` is the read `/budget` with no arguments needs (checklist step 7),
 * and `PeriodMaterialiser` is the seam that lets M3 record a transaction and
 * materialise its period in one database transaction without either module touching a
 * Drizzle handle (CLAUDE.md, "Transactions").
 *
 * Implemented by `DefaultBudgetService` (`./default-budget-service.ts`).
 */

/** The output of the pure `periodFor(localDate, anchorDate)` derivation. */
export interface Period {
  /** Labelled by start month, e.g. `'2026-09'` for a 25 Sep–24 Oct cycle. */
  key: string;
  start: LocalDate;
  /** Inclusive. */
  end: LocalDate;
}

/** The frozen per-period snapshot — a denominator that cannot shift mid-period. */
export interface BudgetPeriod {
  id: Id;
  userId: UserId;
  budgetId: Id;
  periodKey: string;
  periodStart: LocalDate;
  periodEnd: LocalDate;
  capMinorUnits: MinorUnits;
  createdAt: Instant;
}

/** The standing rule — the cap for a category as it stands right now. */
export interface Budget {
  id: Id;
  userId: UserId;
  categoryId: Id | null;
  capMinorUnits: MinorUnits;
  currencyCode: CurrencyCode;
  isActive: boolean;
  createdAt: Instant;
  updatedAt: Instant;
}

/**
 * What M4 needs to know about a user: their monthly anchor and the currency a new cap
 * is denominated in. M2's `IdentityService.getSettings` satisfies this structurally —
 * the composition root passes it straight in, so M4 never reads `app_user` itself
 * (master plan §2, rule 2).
 */
export interface BudgetUserSettings {
  timezone: string;
  currencyCode: CurrencyCode;
  /** The "budget start date" from onboarding step 3; null until then. */
  periodAnchorDate: LocalDate | null;
}

export type BudgetSettingsReader = (userId: UserId) => Promise<BudgetUserSettings>;

/**
 * M5's side of the one coupling a cap change creates (Ricky, 11 Sep: a raise today
 * gives you more to spend today). `DefaultAllowanceService` satisfies this
 * structurally. Optional in the composition root, and called only after M4's own
 * writes have completed — a failure here never fails the user's `/budget`; the cap is
 * the system of record and today's figure is a downstream effect. Same shape as M3's
 * `AllowanceNotifier`.
 */
export interface BudgetAllowanceNotifier {
  /** Re-price today's persisted daily target for the category from its new cap. */
  capChanged(userId: UserId, categoryId: Id): Promise<void>;
}

/**
 * One category's budget as the user experiences it right now — the standing rule and
 * the current cycle's frozen snapshot side by side. They differ only when a period was
 * materialised under a cap that has since been superseded, which is exactly the case
 * M4's checklist step 7 says to show both figures for.
 */
export interface BudgetView {
  budget: Budget;
  period: Period;
  /**
   * Null when nothing has been logged in this cycle yet, so no snapshot exists. A
   * missing row means "the cap applies, nothing spent" — never an error (M4's tests).
   */
  snapshotCapMinorUnits: MinorUnits | null;
}

/**
 * M4's outgoing-facing seam for M3. Kept separate from `BudgetService` so only the
 * caller that genuinely needs transactional materialisation carries the executor type
 * parameter; every other consumer imports the plain `BudgetService`.
 */
export interface PeriodMaterialiser<X> {
  /**
   * The `budget_period` covering `localDate` for whichever active budget owns
   * `categoryId`, materialising it if needed — or null when the category has no active
   * budget, in which case the transaction is recorded with a null `budget_period_id`.
   *
   * `executor` binds the write to the caller's open transaction.
   */
  ensurePeriodForCategory(
    userId: UserId,
    categoryId: Id,
    localDate: LocalDate,
    executor: X,
  ): Promise<BudgetPeriod | null>;
}

export interface BudgetService {
  periodFor(userId: UserId, localDate: LocalDate): Promise<Period>;

  /** Upsert-then-select on `(budget_id, period_key)`; race-safe at a boundary. */
  ensurePeriod(userId: UserId, budgetId: Id, localDate: LocalDate): Promise<BudgetPeriod>;

  activeBudgets(userId: UserId): Promise<readonly Budget[]>;

  /**
   * `/budget` with no arguments: every active budget with the cycle it sits in and
   * that cycle's snapshot, for `localDate` (the user's today). Materialises nothing.
   */
  currentBudgets(userId: UserId, localDate: LocalDate): Promise<readonly BudgetView[]>;

  /** Writes the standing `budget` and the current period's snapshot; never a past one. */
  setCap(userId: UserId, categoryId: Id, cap: MinorUnits): Promise<Budget>;

  deactivate(userId: UserId, budgetId: Id): Promise<void>;
}
