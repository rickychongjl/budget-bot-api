import type { Id, Instant, LocalDate, UserId } from '../../src/core/shared/common';
import type {
  AllowanceView,
  DailyAllowanceService,
  DueUser,
  SendOutcome,
} from '../../src/core/allowance/allowance-service';
import type { AllowanceNotifier } from '../../src/core/ledger';

/**
 * Records the recalculation triggers M6 sends M5, and the no-op notifications M3 does.
 *
 * `ledgerChanged` is recorded rather than ignored so a test can assert it stayed the
 * no-op M5 implements it as (see `DefaultAllowanceService.ledgerChanged` for why) —
 * the real one must never turn into a second round trip per logged expense.
 */
export class RecordingAllowanceService implements DailyAllowanceService, AllowanceNotifier {
  readonly recalculated: { userId: UserId; categoryId: Id | undefined }[] = [];
  readonly notified: { userId: UserId; localDate: LocalDate }[] = [];
  readonly archived: { userId: UserId; categoryId: Id }[] = [];

  findDue(_now: Instant, _limit: number): Promise<readonly DueUser[]> {
    return Promise.reject(new Error('not implemented (test double)'));
  }
  computeAndSend(): Promise<SendOutcome> {
    return Promise.reject(new Error('not implemented (test double)'));
  }
  async availableToday(userId: UserId, categoryId?: Id): Promise<readonly AllowanceView[]> {
    this.recalculated.push({ userId, categoryId });
    return [];
  }
  async ledgerChanged(userId: UserId, localDate: LocalDate): Promise<void> {
    this.notified.push({ userId, localDate });
  }
  async categoryArchived(userId: UserId, categoryId: Id): Promise<void> {
    this.archived.push({ userId, categoryId });
  }
}
