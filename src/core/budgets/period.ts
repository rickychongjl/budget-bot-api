import type { LocalDate } from '../shared/common';
import { addLocalDays, addLocalMonths, formatLocalDate, parseLocalDate } from '../shared/local-date';
import type { Period } from './budget-service';

/**
 * Pure monthly-period derivation (M1 §2, M4). Monthly only this pass — round 2's
 * fortnightly/weekly expansion and its `period_type` column were reverted (master
 * plan §5.4a), so there is exactly one cycle shape and no branching.
 *
 * Pure in the strict sense of CLAUDE.md, "Shared domain code": no clock, no DB, no
 * environment. "Today" arrives as `localDate`, derived by the caller from an injected
 * `Clock` and the user's immutable timezone — which is what makes this testable at
 * arbitrary instants and across DST transitions without mocking time.
 *
 * A period is **derived, never stored**: changing `period_anchor_date` re-buckets all
 * history instantly and correctly. Never add a period-key column to `transaction`.
 */

/**
 * 29, 30 and 31 are capped to 28 because they would leave February with no valid
 * start date in some years — and a cycle that silently skips a month is worse than
 * one that starts a few days early.
 */
export const MAX_PERIOD_START_DAY = 28;

/** The day-of-month the user's cycle turns over, derived from their budget start date. */
export function periodStartDay(anchorDate: LocalDate): number {
  return Math.min(parseLocalDate(anchorDate).day, MAX_PERIOD_START_DAY);
}

/**
 * The monthly period containing `localDate` for a user whose budget starts on
 * `anchorDate`.
 *
 *   startDay    = min(anchorDate.day, 28)
 *   anchorMonth = localDate.day >= startDay ? localDate.month : localDate.month - 1
 *   start       = anchorMonth.atDay(startDay)
 *   end         = start.plusMonths(1).minusDays(1)   // inclusive
 *   key         = anchorMonth 'yyyy-MM'              // labelled by start month
 *
 * A cycle running 25 Sep–24 Oct is `'2026-09'`. Consecutive periods are contiguous
 * by construction: one period's `end` is always the day before the next's `start`.
 */
export function periodFor(localDate: LocalDate, anchorDate: LocalDate): Period {
  const { year, month, day } = parseLocalDate(localDate);
  const startDay = periodStartDay(anchorDate);

  // `startDay` is at most 28, so this date exists in every month of every year and
  // needs no clamping of its own.
  const startOfThisMonth = formatLocalDate({ year, month, day: startDay });
  const start = day >= startDay ? startOfThisMonth : addLocalMonths(startOfThisMonth, -1);
  const end = addLocalDays(addLocalMonths(start, 1), -1);

  return { key: start.slice(0, 7), start, end };
}
