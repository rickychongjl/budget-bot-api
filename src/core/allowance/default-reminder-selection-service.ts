import type { Id, UserId } from '../shared/common';
import { RefusalError } from '../shared/errors';
import type { AllowanceRepository } from './allowance-repository';
import type { AllowanceBudgetReader, ReminderCapacityGate } from './collaborators';
import type { ReminderSelectionService } from './reminder-selection-service';

export interface ReminderSelectionServiceDeps<X> {
  repository: AllowanceRepository<X>;
  budgets: AllowanceBudgetReader;
  entitlements: ReminderCapacityGate<X>;
}

/**
 * M5's reminder selection, backed by `category.reminder_enabled`.
 *
 * Two rules do the work here, and both exist so the dispatch path can trust its inputs:
 *
 * 1. **A reminder requires an active budget on the category** (agreed 11 Sep). A
 *    reminder's whole content is "you can spend $X today", which needs a cap to divide;
 *    without one there is nothing to say. It is also what lets
 *    `daily_allowance_send.budget_period_id` stay `not null` — a reminder-eligible
 *    category always has a period to materialise.
 * 2. **Capacity and the flip are one atomic step**, inside M8's gate, so two concurrent
 *    enables by a Free user at 0/1 cannot both succeed (M8's invariant). The check runs
 *    *inside* the gate's transaction, not before it.
 */
export class DefaultReminderSelectionService<X> implements ReminderSelectionService {
  private readonly repository: AllowanceRepository<X>;
  private readonly budgets: AllowanceBudgetReader;
  private readonly entitlements: ReminderCapacityGate<X>;

  constructor(deps: ReminderSelectionServiceDeps<X>) {
    this.repository = deps.repository;
    this.budgets = deps.budgets;
    this.entitlements = deps.entitlements;
  }

  async enabledCategoryIds(userId: UserId): Promise<readonly Id[]> {
    const categories = await this.repository.listCategories(userId);
    return categories.filter((c) => c.reminderEnabled).map((c) => c.categoryId);
  }

  async enable(userId: UserId, categoryId: Id): Promise<void> {
    const category = await this.repository.findCategory(userId, categoryId);
    if (!category || category.isArchived) {
      throw new RefusalError('CATEGORY_NOT_FOUND', "I can't find that category.");
    }

    // Idempotent by contract: already on is a no-op, not a second slot. Checked before
    // the gate so a Free user at their limit can re-confirm an existing pick without
    // being refused for it.
    if (category.reminderEnabled) return;

    const budgets = await this.budgets.activeBudgets(userId);
    if (!budgets.some((b) => b.categoryId === categoryId)) {
      throw new RefusalError(
        'NO_BUDGET',
        `Set a budget on ${category.name} first — a reminder needs a cap to work out what you can spend.`,
      );
    }

    await this.entitlements.gate(userId, { kind: 'enable_reminder' }, async (executor) => {
      await this.repository.withExecutor(executor).setReminderEnabled(userId, categoryId, true);
    });
  }

  async disable(userId: UserId, categoryId: Id): Promise<void> {
    const category = await this.repository.findCategory(userId, categoryId);
    if (!category) {
      throw new RefusalError('CATEGORY_NOT_FOUND', "I can't find that category.");
    }
    // No gate: turning a reminder off frees capacity, it never consumes it.
    await this.repository.setReminderEnabled(userId, categoryId, false);
  }
}
