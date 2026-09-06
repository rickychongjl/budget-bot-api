import type { LocalDate } from '../shared/common';
import type { Period } from './budget-service';

/**
 * Pure monthly-period derivation (M1 §2, M4). Monthly only this pass.
 *
 * Stub — M4 owns the real implementation. It must be a pure function taking an
 * injected clock (for "today"), no DB access, unit-testable at every boundary:
 * anchor day 28 in 28/29/30/31-day months, and DST transitions in Australian zones.
 *
 * Reference (from M4's plan):
 *   startDay    = min(anchorDate.day, 28)   // 29/30/31 would leave February undefined
 *   anchorMonth = localDate.day >= startDay ? localDate.month : localDate.month - 1
 *   start       = anchorMonth.atDay(startDay)
 *   end         = start.plusMonths(1).minusDays(1)   // inclusive
 *   key         = anchorMonth 'yyyy-MM'              // labelled by start month
 */
export function periodFor(_localDate: LocalDate, _anchorDate: LocalDate): Period {
  throw new Error('not implemented');
}
