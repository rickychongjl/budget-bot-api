import type { BudgetService } from '../budgets';
import type { Clock } from '../shared/clock';
import type { Id, LocalDate, UserId } from '../shared/common';
import { RefusalError } from '../shared/errors';
import { addLocalDays, localDateAt } from '../shared/local-date';
import { normalizeCategoryName, toCategoryDisplayName } from './category-name';
import type { Category, CategoryService } from './category-service';
import type { AllowanceNotifier, CategoryCapacityGate, LedgerSettingsReader } from './collaborators';
import { DuplicateCategoryNameError, type LedgerRepository } from './ledger-repository';

export interface CategoryServiceDeps<X> {
  repository: LedgerRepository<X>;
  /** M8 — the atomic capacity gate around `create` and `reactivate`. */
  entitlements: CategoryCapacityGate<X>;
  /** M4 — asked for the current period's bounds by the archive gate. */
  budgets: Pick<BudgetService, 'periodFor'>;
  /** M2's `IdentityService.getSettings`. */
  settingsOf: LedgerSettingsReader;
  clock: Clock;
  /** M5 — omitted until Phase 3 lands. */
  allowance?: AllowanceNotifier;
}

/**
 * M3's category half. Owns naming, capacity participation and the archive rule.
 *
 * The archive rule is the one piece of this module with real product weight (master
 * plan §5.1, resolved round 4): **a category can only be archived if it has no
 * transactions in the current budget cycle.** History from earlier cycles does not
 * block it. That closes the "add, transact, archive, rename, repeat" capacity
 * loophole — you cannot free a slot you have used this cycle — while staying more
 * permissive across cycle boundaries than the alternatives that were considered.
 *
 * Because the gate lives entirely on the archive *action*, capacity itself needs no
 * special carve-out: it is simply the count of non-archived categories, which is what
 * `countActive` returns to M8.
 */
export class DefaultCategoryService<X> implements CategoryService {
  private readonly repository: LedgerRepository<X>;
  private readonly entitlements: CategoryCapacityGate<X>;
  private readonly budgets: Pick<BudgetService, 'periodFor'>;
  private readonly settingsOf: LedgerSettingsReader;
  private readonly clock: Clock;
  private readonly allowance: AllowanceNotifier | undefined;

  constructor(deps: CategoryServiceDeps<X>) {
    this.repository = deps.repository;
    this.entitlements = deps.entitlements;
    this.budgets = deps.budgets;
    this.settingsOf = deps.settingsOf;
    this.clock = deps.clock;
    this.allowance = deps.allowance;
  }

  list(userId: UserId, opts?: { includeArchived?: boolean }): Promise<readonly Category[]> {
    return this.repository.listCategories(userId, opts?.includeArchived === true);
  }

  findByName(userId: UserId, name: string): Promise<Category | null> {
    return this.repository.findCategoryByNormalizedName(userId, normalizeCategoryName(name));
  }

  countActive(userId: UserId): Promise<number> {
    return this.repository.countActiveCategories(userId);
  }

  /**
   * The insert runs inside M8's gating transaction, so the capacity count it was
   * checked against cannot change underneath it. Uniqueness is the database's job —
   * a read-then-insert would let two concurrent creations of the same name through.
   */
  async create(userId: UserId, name: string): Promise<Category> {
    const display = toCategoryDisplayName(name);
    const normalizedName = normalizeCategoryName(display);

    // A friendlier answer than the raw constraint violation for the common case. The
    // constraint still decides — this read can go stale, the unique index cannot.
    const existing = await this.repository.findCategoryByNormalizedName(userId, normalizedName);
    if (existing) throw duplicateCategory(existing);

    const sortOrder = (await this.repository.maxCategorySortOrder(userId)) + 1;
    const now = this.clock.now();

    try {
      return await this.entitlements.gate(userId, { kind: 'create_category' }, (executor) =>
        this.repository.withExecutor(executor).insertCategory({ userId, name: display, normalizedName, sortOrder, now }),
      );
    } catch (error) {
      if (error instanceof DuplicateCategoryNameError) {
        const winner = await this.repository.findCategoryByNormalizedName(userId, normalizedName);
        throw winner ? duplicateCategory(winner) : error;
      }
      throw error;
    }
  }

  async rename(userId: UserId, categoryId: Id, name: string): Promise<Category> {
    const display = toCategoryDisplayName(name);
    const normalizedName = normalizeCategoryName(display);
    const current = await this.requireCategory(userId, categoryId);

    if (current.normalizedName !== normalizedName) {
      const clash = await this.repository.findCategoryByNormalizedName(userId, normalizedName);
      if (clash && clash.id !== categoryId) throw duplicateCategory(clash);
    }

    try {
      const renamed = await this.repository.updateCategory(userId, categoryId, { name: display, normalizedName });
      if (!renamed) throw categoryNotFound();
      return renamed;
    } catch (error) {
      if (error instanceof DuplicateCategoryNameError) {
        throw new RefusalError('INVALID_ARGUMENT', `You already have a category called "${display}".`);
      }
      throw error;
    }
  }

  /**
   * Asks M4 for the current cycle's bounds, then refuses if any confirmed transaction
   * for this category sits inside them. No transaction in the current cycle: the
   * archive proceeds and the slot frees immediately, however much history the category
   * carries from earlier cycles.
   */
  async archive(userId: UserId, categoryId: Id): Promise<void> {
    const category = await this.requireCategory(userId, categoryId);
    if (category.isArchived) return;

    const settings = await this.settingsOf(userId);
    const today = localDateAt(this.clock.now(), settings.timezone);
    const period = await this.budgets.periodFor(userId, today);

    if (await this.repository.hasTransactionInPeriod(userId, categoryId, period.start, period.end)) {
      throw new RefusalError(
        'INVALID_ARGUMENT',
        `Can't archive ${category.name} — you've logged something in it this cycle. ` +
          `You can archive it once the next cycle starts on ${nextCycleStart(period.end)}.`,
      );
    }

    const archived = await this.repository.updateCategory(userId, categoryId, { isArchived: true });
    if (!archived) throw categoryNotFound();

    // Agreed 5 Sep: an archived category must not stay reminder-eligible. Coordinated
    // here rather than left to M5's dispatch check alone — though M5 rechecks too.
    await this.allowance?.categoryArchived(userId, categoryId);
  }

  /** Re-consumes a capacity slot, so it goes through M8 exactly like `create` does. */
  async reactivate(userId: UserId, categoryId: Id): Promise<Category> {
    const category = await this.requireCategory(userId, categoryId);
    if (!category.isArchived) return category;

    return this.entitlements.gate(userId, { kind: 'reactivate_category' }, async (executor) => {
      const revived = await this.repository
        .withExecutor(executor)
        .updateCategory(userId, categoryId, { isArchived: false });
      if (!revived) throw categoryNotFound();
      return revived;
    });
  }

  private async requireCategory(userId: UserId, categoryId: Id): Promise<Category> {
    const category = await this.repository.findCategory(userId, categoryId);
    if (!category) throw categoryNotFound();
    return category;
  }
}

function categoryNotFound(): RefusalError {
  return new RefusalError('CATEGORY_NOT_FOUND', "You don't have a category like that.");
}

function duplicateCategory(existing: Category): RefusalError {
  return new RefusalError(
    'INVALID_ARGUMENT',
    existing.isArchived
      ? `You already have an archived category called "${existing.name}" — restore that one instead.`
      : `You already have a category called "${existing.name}".`,
  );
}

/** `period.end` is inclusive, so the next cycle opens the following day. */
function nextCycleStart(periodEnd: LocalDate): LocalDate {
  return addLocalDays(periodEnd, 1);
}
