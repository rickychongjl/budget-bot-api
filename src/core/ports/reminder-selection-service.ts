import type { Id, UserId } from '../shared/common';

/**
 * Which categories carry the daily 07:00 reminder. **Proposed by M2, owned by M5** —
 * see build-log (M2, open questions).
 *
 * M8 states "M5 checks reminder-category capacity here before enabling a reminder",
 * M11 routes `/remind` to M5/M2/M8, and M5's delivery pipeline is built around
 * "reminder-eligible categories" — but no committed schema or port holds the flag
 * (`category` has no `reminder_enabled`; `daily_allowance_send` is per-day output).
 * M2's onboarding step 5 needs to record the user's selection somewhere that is M5's,
 * so this is the smallest contract that lets it. M5 may fold it into
 * `DailyAllowanceService` or back it with a column on M3's `category` (coordinate).
 *
 * `enable` is expected to call M8's `assertAllowed({ kind: 'enable_reminder' })`
 * atomically with its write (M8 invariant); M2 also calls it first during onboarding so
 * the refusal arrives before any write.
 */
export interface ReminderSelectionService {
  /** Ids of non-archived categories with the reminder enabled. */
  enabledCategoryIds(userId: UserId): Promise<readonly Id[]>;
  /** Idempotent — enabling an already-enabled category is a no-op, not a second slot. */
  enable(userId: UserId, categoryId: Id): Promise<void>;
  disable(userId: UserId, categoryId: Id): Promise<void>;
}
