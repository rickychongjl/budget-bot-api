import type { GatedAction } from '../entitlements';
import type { CurrencyCode, Id, LocalDate, UserId } from '../shared/common';

/**
 * What M3 needs *from other modules*, expressed as narrow contracts M3 owns.
 * `ledger-repository.ts` is the persistence seam; this is everything else.
 *
 * Each one is deliberately smaller than the collaborating module's full port, so M3
 * depends on the behaviour it uses rather than on M2/M5/M8 wholesale, and unit tests
 * can supply a two-line fake.
 */

/**
 * M8's capacity gate. `DefaultEntitlementService<X>.gate` satisfies this structurally,
 * which is the point: M3 runs its category insert *inside* M8's transaction, so
 * "count, then insert" is one atomic step and two concurrent creations at 9/10
 * cannot both succeed (M8's invariant, M3 checklist step 5).
 *
 * `gate` is not on the `EntitlementService` interface — M8 kept the executor type
 * parameter off its public port on purpose (CLAUDE.md, "Transactions") — so M3
 * declares the shape it needs rather than widening M8's contract.
 */
export interface CategoryCapacityGate<X> {
  gate<T>(userId: UserId, action: GatedAction, write: (executor: X) => Promise<T>): Promise<T>;
}

/**
 * What M2 knows that M3 needs on every write: the immutable timezone (`occurred_on` is
 * derived from it, once, at write time), the account currency (no conversion in v1),
 * and the backdating floor. `IdentityService.getSettings` satisfies this structurally,
 * so the composition root passes it straight in and M3 never reads `app_user`.
 */
export interface LedgerUserSettings {
  timezone: string;
  currencyCode: CurrencyCode;
  /** M3's backdating floor — an `occurred_on` before this is rejected (round 3). */
  accountCreatedOn: LocalDate;
}

export type LedgerSettingsReader = (userId: UserId) => Promise<LedgerUserSettings>;

/**
 * M5's side of two couplings M3's plan requires. Optional in the composition root
 * until M5 lands (Phase 3); M3 calls it after its own write has committed, and a
 * failure here never fails the user's transaction — the ledger is the system of
 * record, the reminder is a downstream effect.
 */
export interface AllowanceNotifier {
  /**
   * M3 checklist step 2e: recompute `available_today`, **not** `daily_target` — the
   * target is frozen for the date once computed (M5).
   */
  ledgerChanged(userId: UserId, localDate: LocalDate): Promise<void>;

  /**
   * Agreed 5 Sep, applies today and not just to future real removal: disable every
   * reminder selection referencing the category and invalidate pending scheduled
   * sends/retries. M5 must *also* recheck category eligibility immediately before
   * dispatch — invalidating the queue entry alone is not sufficient.
   */
  categoryArchived(userId: UserId, categoryId: Id): Promise<void>;
}
