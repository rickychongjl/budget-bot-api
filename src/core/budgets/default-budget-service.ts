import type { Clock } from '../shared/clock';
import type { Id, LocalDate, MinorUnits, UserId } from '../shared/common';
import { RefusalError } from '../shared/errors';
import { localDateAt } from '../shared/local-date';
import type { BudgetReads, BudgetRepository, BudgetWrites } from './budget-repository';
import type {
  Budget,
  BudgetPeriod,
  BudgetService,
  BudgetSettingsReader,
  BudgetUserSettings,
  BudgetView,
  Period,
  PeriodMaterialiser,
} from './budget-service';
import { periodFor } from './period';

export interface BudgetServiceDeps<X> {
  repository: BudgetRepository<X>;
  /** M2's `IdentityService.getSettings` — M4 never reads `app_user` itself. */
  settingsOf: BudgetSettingsReader;
  clock: Clock;
}

/**
 * M4 — Budgets & Periods. Owns what "this budgeting cycle" means and how much the
 * user has agreed to spend in it. Every module that needs a period boundary asks this
 * one; nobody does date maths independently (master plan §2).
 *
 * All period arithmetic goes through the pure `periodFor` in `./period.ts`. There is
 * deliberately no second implementation hiding in a query — the repository is handed
 * already-derived bounds and never computes them.
 *
 * There is deliberately **no cron** for materialisation either: a nightly job opening
 * periods for every user does work proportional to the whole user base to serve the
 * few users active that day. A user who logs nothing in a cycle simply has no row,
 * and every read here treats that as "the cap applies, nothing spent".
 *
 * `X` is the repository's executor type (a Drizzle transaction handle in production,
 * an arbitrary test "world" in memory) — see `ensurePeriodForCategory`.
 */
export class DefaultBudgetService<X> implements BudgetService, PeriodMaterialiser<X> {
  private readonly repository: BudgetRepository<X>;
  private readonly settingsOf: BudgetSettingsReader;
  private readonly clock: Clock;

  constructor(deps: BudgetServiceDeps<X>) {
    this.repository = deps.repository;
    this.settingsOf = deps.settingsOf;
    this.clock = deps.clock;
  }

  // ---- period derivation --------------------------------------------------------

  async periodFor(userId: UserId, localDate: LocalDate): Promise<Period> {
    return periodFor(localDate, await this.anchorOf(userId));
  }

  /**
   * The anchor is collected at onboarding step 3. Without it there is no cycle to
   * derive, so this is `ONBOARDING_REQUIRED` rather than a guessed default — a
   * silently assumed anchor would bucket every transaction into the wrong month.
   */
  private async anchorOf(userId: UserId): Promise<LocalDate> {
    return anchorOf(await this.settingsOf(userId));
  }

  // ---- materialisation ----------------------------------------------------------

  async ensurePeriod(userId: UserId, budgetId: Id, localDate: LocalDate): Promise<BudgetPeriod> {
    const budget = await this.repository.findBudget(userId, budgetId);
    if (!budget) throw new RefusalError('RESOURCE_NOT_FOUND', "That budget doesn't exist.");
    return this.materialise(this.repository, budget, localDate, await this.anchorOf(userId));
  }

  /**
   * M3's seam. Runs inside the caller's transaction so a ledger row and the period it
   * belongs to commit together — a confirmed transaction whose category has an active
   * budget always has a `budget_period_id` (M3's invariant).
   *
   * Returns null when the category has no active budget: recording an expense against
   * an uncapped category is normal, and it simply has no period to belong to.
   */
  async ensurePeriodForCategory(
    userId: UserId,
    categoryId: Id,
    localDate: LocalDate,
    executor: X,
  ): Promise<BudgetPeriod | null> {
    const bound = this.repository.withExecutor(executor);
    const budget = await bound.findActiveBudgetForCategory(userId, categoryId);
    if (!budget) return null;
    return this.materialise(bound, budget, localDate, await this.anchorOf(userId));
  }

  private async materialise(
    store: BudgetReads & BudgetWrites,
    budget: Budget,
    localDate: LocalDate,
    anchorDate: LocalDate,
  ): Promise<BudgetPeriod> {
    const period = periodFor(localDate, anchorDate);
    const existing = await store.findPeriod(budget.userId, budget.id, period.key);
    if (existing) return existing;
    // Upsert-then-select: `do nothing` on conflict means a concurrent caller that won
    // the race gets its row back here rather than a duplicate or an error.
    return store.materialisePeriod({
      userId: budget.userId,
      budgetId: budget.id,
      periodKey: period.key,
      periodStart: period.start,
      periodEnd: period.end,
      capMinorUnits: budget.capMinorUnits,
      now: this.clock.now(),
    });
  }

  // ---- reads --------------------------------------------------------------------

  activeBudgets(userId: UserId): Promise<readonly Budget[]> {
    return this.repository.findActiveBudgets(userId);
  }

  async currentBudgets(userId: UserId, localDate: LocalDate): Promise<readonly BudgetView[]> {
    const anchorDate = anchorOf(await this.settingsOf(userId));
    const period = periodFor(localDate, anchorDate);
    const [budgets, snapshots] = await Promise.all([
      this.repository.findActiveBudgets(userId),
      this.repository.findPeriodsByKey(userId, period.key),
    ]);
    const capByBudget = new Map(snapshots.map((s) => [s.budgetId, s.capMinorUnits]));
    return budgets.map((budget) => ({
      budget,
      period,
      snapshotCapMinorUnits: capByBudget.get(budget.id) ?? null,
    }));
  }

  // ---- writes -------------------------------------------------------------------

  /**
   * `/budget groceries 600` means "my budget is 600 now", not "from next month" — so
   * this writes the standing rule *and* re-snapshots the current cycle if one has
   * already been materialised. Past cycles are never touched: that is the whole point
   * of the two-table split, and M7's confirmation copy says so explicitly (the change
   * does not retroactively affect transactions already made this period).
   *
   * The category is assumed to exist and belong to the user — the caller resolves a
   * name through M3 first, and the `budget_category_id_category_id_fk` foreign key is
   * the backstop. M4 does not read M3's table to re-check it (master plan §2, rule 2).
   */
  async setCap(userId: UserId, categoryId: Id, cap: MinorUnits): Promise<Budget> {
    if (cap <= 0n) {
      throw new RefusalError('INVALID_ARGUMENT', 'A budget has to be more than zero.');
    }
    const settings = await this.settingsOf(userId);
    const anchorDate = anchorOf(settings);
    const now = this.clock.now();

    const budget = await this.repository.upsertActiveBudget({
      userId,
      categoryId,
      capMinorUnits: cap,
      currencyCode: settings.currencyCode,
      now,
    });

    // Only the current cycle's snapshot moves; an earlier one stays byte-for-byte as
    // it was, so historical allowance figures cannot shift under the user.
    const current = periodFor(localDateAt(now, settings.timezone), anchorDate);
    const materialised = await this.repository.findPeriod(userId, budget.id, current.key);
    if (materialised) {
      await this.repository.updatePeriodCap(userId, budget.id, current.key, cap);
    }
    return budget;
  }

  /** Preserves historical `budget_period` rows — they still reference the inactive budget. */
  async deactivate(userId: UserId, budgetId: Id): Promise<void> {
    const removed = await this.repository.deactivateBudget(userId, budgetId, this.clock.now());
    if (!removed) throw new RefusalError('RESOURCE_NOT_FOUND', "That budget doesn't exist.");
  }
}

function anchorOf(settings: BudgetUserSettings): LocalDate {
  if (settings.periodAnchorDate === null) {
    throw new RefusalError(
      'ONBOARDING_REQUIRED',
      "You haven't set a budget start date yet — send /start to finish setting up.",
    );
  }
  return settings.periodAnchorDate;
}
