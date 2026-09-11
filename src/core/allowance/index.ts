import type { AllowanceRepository } from './allowance-repository';
import type { UserId } from '../shared/common';

/**
 * M5 — Daily Allowance & Scheduler (Phase 3).
 *
 * Owns the allowance formula (`./daily-target.ts`, pure), the `daily_allowance_send`
 * table, the reminder selection behind `category.reminder_enabled`, bundled 07:00
 * delivery, and the message renderers.
 *
 * **Deferred to Phase 4 (M7), agreed 11 Sep:** the `MessageSender` implementation, the
 * `INTERNAL_DISPATCH_SECRET`-guarded `/internal/send-allowance` route, and turning
 * `src/index.ts` into a real composition root with the cron fan-out. M5 is built
 * against the ports and fully tested; nothing here reaches Telegram yet. See
 * "Handed over from M5" in `docs/M7-telegram-gateway.md` for the exact list.
 *
 * Intended wiring, once that lands:
 *
 * ```ts
 * const allowanceRepository = new DrizzleAllowanceRepository(db);
 * const allowance = new DefaultAllowanceService({
 *   repository: allowanceRepository,
 *   budgets: budgetService,          // DefaultBudgetService satisfies AllowanceBudgetReader
 *   ledger: ledgerService,           // ... AllowanceSpendReader
 *   settingsOf: (id) => identity.getSettings(id),
 *   connections: identityConnectionDirectory,
 *   sender: telegramMessageSender,
 *   clock,
 * });
 * const reminders = new DefaultReminderSelectionService({
 *   repository: allowanceRepository,
 *   budgets: budgetService,
 *   entitlements: entitlementService,  // .gate, not on the public port
 * });
 * // M8's capacity seam — the count M5 owns:
 * const capacity = {
 *   countActiveCategories: (id, x) => ledgerRepository.withExecutor(x).countActiveCategories(id),
 *   countReminderCategories: createReminderCapacityReader(allowanceRepository),
 * };
 * ```
 */

export type {
  AllowanceView,
  DailyAllowanceService,
  DueUser,
  SendOutcome,
} from './allowance-service';

export type {
  AllowanceReads,
  AllowanceRepository,
  AllowanceSend,
  AllowanceWrites,
  DeliveryStatus,
  DueUserRow,
  DueWindow,
  NewAllowanceSendInput,
  ReminderCategory,
} from './allowance-repository';

export type {
  AllowanceBudgetReader,
  AllowanceSettingsReader,
  AllowanceSpendReader,
  AllowanceUserSettings,
  ReminderCapacityGate,
} from './collaborators';

export type { ReminderSelectionService } from './reminder-selection-service';

export { computeDailyTarget } from './daily-target';

export {
  escapeCategoryName,
  formatMoney,
  renderAllowanceLine,
  renderBundledReminder,
} from './messages';

export type {
  AllowanceConnectionDirectory,
  AllowanceServiceDeps,
} from './default-allowance-service';
export {
  DUE_WINDOW_MINUTES,
  DefaultAllowanceService,
  MAX_SEND_ATTEMPTS,
} from './default-allowance-service';

export type { ReminderSelectionServiceDeps } from './default-reminder-selection-service';
export { DefaultReminderSelectionService } from './default-reminder-selection-service';

/**
 * The reminder half of M8's `CapacityReader`. M8 compares this count against the tier
 * limit (1 Free / 5 Premium) but never reads the table itself — M5 owns the flag, so
 * M5 supplies the number, bound to M8's gating transaction so "count, then enable" is
 * atomic (master plan §2 rule 2; M8's invariant).
 */
export function createReminderCapacityReader<X>(
  repository: AllowanceRepository<X>,
): (userId: UserId, executor: X) => Promise<number> {
  return (userId, executor) => repository.withExecutor(executor).countReminderCategories(userId);
}
