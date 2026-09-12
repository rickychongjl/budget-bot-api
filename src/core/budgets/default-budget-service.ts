import type { Clock } from '../shared/clock';
import type { Id, LocalDate, MinorUnits, UserId } from '../shared/common';
import { RefusalError } from '../shared/errors';
import { localDateAt } from '../shared/local-date';
import type {
  BudgetReads,
  BudgetRepository,
  BudgetWrites,
  StoredBudgetPeriod,
} from './budget-repository';
import type {
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
import { periodFor } from './period';

export interface BudgetServiceDeps<X> {
  repository: BudgetRepository<X>;
  /** M2's `IdentityService.getSettings` — M4 never reads `app_user` itself. */
  settingsOf: BudgetSettingsReader;
  clock: Clock;
  /** M5, so a cap change re-prices today's figure. Optional: M4's own tests run without it. */
  allowance?: BudgetAllowanceNotifier;
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
 * Nor is there one for carrying caps forward (Ricky, 12 Sep 2026). A cap is a row in
 * `category_period_cap` keyed by the cycle it was set in, and the cap for any cycle is
 * the row with the greatest key at or before it (`capFor`). Setting a cap writes the
 * current cycle's row; every later cycle reads it until a later row supersedes it, and
 * every earlier cycle keeps reading whatever governed it. A cycle opened late by a
 * backdated expense therefore gets the cap that applied *then* — the reason the cap is
 * no longer a column on `budget` or `budget_period`.
 *
 * `X` is the repository's executor type (a Drizzle transaction handle in production,
 * an arbitrary test "world" in memory) — see `ensurePeriodForCategory`.
 */
export class DefaultBudgetService<X> implements BudgetService, PeriodMaterialiser<X> {
  private readonly repository: BudgetRepository<X>;
  private readonly settingsOf: BudgetSettingsReader;
  private readonly clock: Clock;
  private readonly allowance: BudgetAllowanceNotifier | undefined;

  constructor(deps: BudgetServiceDeps<X>) {
    this.repository = deps.repository;
    this.settingsOf = deps.settingsOf;
    this.clock = deps.clock;
    this.allowance = deps.allowance;
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
    const period = await this.materialise(this.repository, budget, localDate, await this.anchorOf(userId));
    if (!period) {
      // Callers here (M5, `/stats`) ask for the current cycle of an active budget,
      // which always has a cap. Reaching this means a cycle from before the budget
      // existed — there is nothing to divide by, so say so rather than invent a figure.
      throw new RefusalError('RESOURCE_NOT_FOUND', 'That category had no budget in that cycle.');
    }
    return period;
  }

  /**
   * M3's seam. Runs inside the caller's transaction so a ledger row and the period it
   * belongs to commit together — a confirmed transaction whose category has an active
   * budget, dated in a cycle that budget carried a cap in, always has a
   * `budget_period_id` (M3's invariant, qualified 12 Sep).
   *
   * Returns null when the category has no active budget, or had no cap in that cycle
   * (a backdated expense into a cycle before the budget existed): recording an expense
   * that was uncapped at the time is normal, and it simply has no period to belong to.
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

  /**
   * The cycle covering `localDate`, with its governing cap attached — or null when no
   * cap governs that cycle, in which case nothing is materialised: a period row without
   * a cap would be a denominator of nothing.
   */
  private async materialise(
    store: BudgetReads & BudgetWrites,
    budget: Budget,
    localDate: LocalDate,
    anchorDate: LocalDate,
  ): Promise<BudgetPeriod | null> {
    const period = periodFor(localDate, anchorDate);
    const cap = await this.capFor(store, budget, period.key);
    if (cap === null) return null;

    const existing = await store.findPeriod(budget.userId, budget.id, period.key);
    if (existing) return withCap(existing, cap);
    // Upsert-then-select: `do nothing` on conflict means a concurrent caller that won
    // the race gets its row back here rather than a duplicate or an error.
    const row = await store.materialisePeriod({
      userId: budget.userId,
      budgetId: budget.id,
      periodKey: period.key,
      periodStart: period.start,
      periodEnd: period.end,
      now: this.clock.now(),
    });
    return withCap(row, cap);
  }

  /**
   * The cap governing one cycle for a budget's category: the history row with the
   * greatest key at or before it. A removal row (null cap) and no row at all both mean
   * "no cap in that cycle". A budget whose category was deleted has no history to read.
   */
  private async capFor(store: BudgetReads, budget: Budget, periodKey: string): Promise<MinorUnits | null> {
    if (budget.categoryId === null) return null;
    const governing = await store.findGoverningCap(budget.userId, budget.categoryId, periodKey);
    return governing?.capMinorUnits ?? null;
  }

  // ---- reads --------------------------------------------------------------------

  activeBudgets(userId: UserId): Promise<readonly Budget[]> {
    return this.repository.findActiveBudgets(userId);
  }

  async currentBudgets(userId: UserId, localDate: LocalDate): Promise<readonly BudgetView[]> {
    const anchorDate = anchorOf(await this.settingsOf(userId));
    const period = periodFor(localDate, anchorDate);
    const [budgets, caps] = await Promise.all([
      this.repository.findActiveBudgets(userId),
      this.repository.findGoverningCaps(userId, period.key),
    ]);
    const capByCategory = new Map(caps.map((c) => [c.categoryId, c.capMinorUnits]));
    return budgets.map((budget) => {
      const cap = budget.categoryId === null ? null : capByCategory.get(budget.categoryId) ?? null;
      if (cap === null) {
        // An active budget always has a governing cap: `setCap` writes one in the same
        // call that activates the row, and `deactivate` is the only writer of a null.
        // Not a refusal — this is the store contradicting itself, and it must be loud.
        throw new Error(`budget ${budget.id} is active but has no cap for cycle ${period.key}`);
      }
      return { budget, period, capMinorUnits: cap };
    });
  }

  // ---- writes -------------------------------------------------------------------

  /**
   * `/budget groceries 600` means "my budget is 600 now", not "from next month" — so
   * this writes the standing rule *and* the **current cycle's** cap row. Every later
   * cycle reads that row until a later one supersedes it (the carry-forward); every
   * earlier cycle keeps the row that governed it, so the change does not retroactively
   * affect transactions already made in past periods, as M7's confirmation copy says.
   *
   * "Now" includes today's daily figure (Ricky, 11 Sep). Once both M4 rows are written,
   * M5 is told so it can re-price today's persisted target — after, never inside, the
   * writes, and best-effort: M5 failing leaves the cap correct and the figure catching
   * up tomorrow, which is where it landed before this hook existed.
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

    const budget = await this.repository.upsertActiveBudget({ userId, categoryId, now });

    // Only the current cycle's row is ever written; an earlier cycle's governing row
    // stays byte-for-byte as it was, so historical allowance figures cannot shift under
    // the user. The cap is denominated in the account's currency as of now — M2 fixes
    // that once anything is logged, and the row records it either way.
    const current = periodFor(localDateAt(now, settings.timezone), anchorDate);
    await this.repository.upsertPeriodCap({
      userId,
      categoryId,
      periodKey: current.key,
      capMinorUnits: cap,
      currencyCode: settings.currencyCode,
      now,
    });

    // A day's target row references its period, so one can only exist once the period
    // does — no period row yet, nothing for M5 to re-price.
    const materialised = await this.repository.findPeriod(userId, budget.id, current.key);
    if (materialised) await this.notifyAllowance(userId, categoryId);
    return budget;
  }

  private async notifyAllowance(userId: UserId, categoryId: Id): Promise<void> {
    if (!this.allowance) return;
    try {
      await this.allowance.capChanged(userId, categoryId);
    } catch {
      // Swallowed deliberately — the cap is written; M5 computes tomorrow's from it regardless.
    }
  }

  /**
   * Preserves historical `budget_period` rows — they still reference the inactive
   * budget — and writes a null cap row for the current cycle, so the last cap does not
   * carry forward into cycles where there is no budget. Re-adding the budget later
   * overwrites that row (same cycle) or supersedes it (a later one).
   */
  async deactivate(userId: UserId, budgetId: Id): Promise<void> {
    const budget = await this.repository.findBudget(userId, budgetId);
    const now = this.clock.now();
    const removed = budget !== null && (await this.repository.deactivateBudget(userId, budgetId, now));
    if (!budget || !removed) throw new RefusalError('RESOURCE_NOT_FOUND', "That budget doesn't exist.");

    if (budget.categoryId === null) return;
    const settings = await this.settingsOf(userId);
    const current = periodFor(localDateAt(now, settings.timezone), anchorOf(settings));
    await this.repository.upsertPeriodCap({
      userId,
      categoryId: budget.categoryId,
      periodKey: current.key,
      capMinorUnits: null,
      currencyCode: settings.currencyCode,
      now,
    });
  }
}

function withCap(row: StoredBudgetPeriod, capMinorUnits: MinorUnits): BudgetPeriod {
  return { ...row, capMinorUnits };
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
