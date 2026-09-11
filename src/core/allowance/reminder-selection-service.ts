import type { Id, UserId } from '../shared/common';

/**
 * Which categories carry the daily 07:00 reminder. **Proposed by M2, owned by M5** —
 * claimed here in M5's PR, which also empties and removes the temporary `core/ports/`
 * holding pen (M3 had already claimed the other resident, `CategoryService`).
 *
 * The flag lives as `category.reminder_enabled` — one boolean on M3's table, agreed
 * 11 Sep, because it is genuinely a property of the category and `daily_allowance_send`
 * is per-day output that cannot hold it. M5 reads and writes that one column directly;
 * see `infrastructure/database/schema/category.ts` for the ownership note.
 *
 * `enable` calls M8's `gate({ kind: 'enable_reminder' })` atomically with its write
 * (M8's invariant); M2's onboarding also calls `assertAllowed` first so the refusal
 * arrives before any work, but this module is the real gate.
 *
 * The four original method signatures are unchanged, so M2's onboarding still compiles
 * against it exactly as written.
 */
export interface ReminderSelectionService {
  /** Ids of non-archived categories with the reminder enabled. */
  enabledCategoryIds(userId: UserId): Promise<readonly Id[]>;
  /**
   * Idempotent — enabling an already-enabled category is a no-op, not a second slot.
   *
   * Refuses `NO_BUDGET` when the category has no active budget: a reminder's whole
   * content is "you can spend $X today", which needs a cap to divide (agreed 11 Sep).
   * This is also what lets `daily_allowance_send.budget_period_id` stay `not null`.
   */
  enable(userId: UserId, categoryId: Id): Promise<void>;
  disable(userId: UserId, categoryId: Id): Promise<void>;
}
