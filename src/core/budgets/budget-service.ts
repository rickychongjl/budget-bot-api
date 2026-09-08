import type { CurrencyCode, Id, Instant, LocalDate, MinorUnits, UserId } from '../shared/common';

/**
 * M4 — Budgets & Periods. Owns what "this budgeting cycle" means. Every module that
 * needs a period boundary asks this one; nobody does date maths independently
 * (master plan §6). Monthly only this pass (round 3 revert).
 *
 * Interface lifted verbatim from `docs/M4-budgets-periods.md` ("Public interface").
 * Stub only.
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

export interface BudgetService {
  periodFor(userId: UserId, localDate: LocalDate): Promise<Period>;

  /** Upsert-then-select on `(budget_id, period_key)`; race-safe at a boundary. */
  ensurePeriod(userId: UserId, budgetId: Id, localDate: LocalDate): Promise<BudgetPeriod>;

  activeBudgets(userId: UserId): Promise<readonly Budget[]>;

  /** Writes the standing `budget` and the current period's snapshot; never a past one. */
  setCap(userId: UserId, categoryId: Id, cap: MinorUnits): Promise<Budget>;

  deactivate(userId: UserId, budgetId: Id): Promise<void>;
}
