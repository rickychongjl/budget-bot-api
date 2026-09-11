import type { Budget, BudgetPeriod } from '../budgets';
import type { GatedAction } from '../entitlements';
import type { Id, LocalDate, LocalTime, MinorUnits, UserId } from '../shared/common';

/**
 * What M5 needs *from other modules*, expressed as narrow contracts M5 owns.
 * `allowance-repository.ts` is the persistence seam; this is everything else.
 *
 * Each one is deliberately smaller than the collaborating module's full port, so M5
 * depends on the behaviour it uses rather than on M2/M3/M4/M8 wholesale, and unit tests
 * can supply a two-line fake. Same pattern as `core/ledger/collaborators.ts`.
 */

/**
 * M4's side. `DefaultBudgetService` satisfies this structurally, so the composition
 * root passes it straight in and M5 never reads `budget` or `budget_period` itself.
 */
export interface AllowanceBudgetReader {
  activeBudgets(userId: UserId): Promise<readonly Budget[]>;
  /** Upsert-then-select on `(budget_id, period_key)`; race-safe at a period boundary. */
  ensurePeriod(userId: UserId, budgetId: Id, localDate: LocalDate): Promise<BudgetPeriod>;
}

/**
 * M3's side. Both reads return `expenses - refunds`, excluding income by construction,
 * so M5 cannot accidentally get the wrong total.
 */
export interface AllowanceSpendReader {
  spendInPeriod(userId: UserId, budgetPeriodId: Id, upTo?: LocalDate): Promise<MinorUnits>;
  spentOn(userId: UserId, localDate: LocalDate, categoryId?: Id): Promise<MinorUnits>;
}

/**
 * What M2 knows that M5 needs: the immutable timezone (the day boundary the whole
 * module hangs off), the account currency (for rendering) and the reminder time.
 *
 * M5 reads `reminderLocalTime` from the column rather than hard-coding 07:00, per M2's
 * open question 6 — the value is fixed for everyone this pass, but the column is where
 * it lives and a future custom-time feature should not need to find every literal.
 */
export interface AllowanceUserSettings {
  timezone: string;
  currencyCode: string;
  reminderLocalTime: LocalTime;
}

export type AllowanceSettingsReader = (userId: UserId) => Promise<AllowanceUserSettings>;

/**
 * M8's capacity gate. `DefaultEntitlementService<X>.gate` satisfies this structurally,
 * which is the point: M5 flips `reminder_enabled` *inside* M8's transaction, so
 * "count, then enable" is one atomic step and two concurrent enables at 0/1 cannot both
 * succeed (M8's invariant).
 *
 * `gate` is not on the public `EntitlementService` interface — M8 kept the executor
 * type parameter off its port on purpose (CLAUDE.md, "Transactions") — so M5 declares
 * the shape it needs rather than widening M8's contract. Identical to M3's
 * `CategoryCapacityGate<X>`.
 */
export interface ReminderCapacityGate<X> {
  gate<T>(userId: UserId, action: GatedAction, write: (executor: X) => Promise<T>): Promise<T>;
}
