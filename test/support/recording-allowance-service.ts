import type { Id, Instant, UserId } from '../../src/core/shared/common';
import type {
  AllowanceView,
  DailyAllowanceService,
  DueSend,
  SendOutcome,
} from '../../src/core/allowance/allowance-service';

/** Records the recalculation triggers M6 sends M5. */
export class RecordingAllowanceService implements DailyAllowanceService {
  readonly recalculated: { userId: UserId; categoryId: Id | undefined }[] = [];

  findDue(_now: Instant, _limit: number): Promise<readonly DueSend[]> {
    return Promise.reject(new Error('not implemented (M5)'));
  }
  computeAndSend(): Promise<SendOutcome> {
    return Promise.reject(new Error('not implemented (M5)'));
  }
  async availableToday(userId: UserId, categoryId?: Id): Promise<readonly AllowanceView[]> {
    this.recalculated.push({ userId, categoryId });
    return [];
  }
}
