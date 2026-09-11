import type { MinorUnits } from '../shared/common';

/**
 * Pure daily-allowance formula (M1 §2, M5).
 *
 *   remaining    = period_cap - (expenses - refunds), to the end of yesterday
 *   days_left    = period_end - today_local + 1        // includes today
 *   daily_target = max(0, floor(remaining / days_left))
 *
 * Through the day: `available_today = daily_target - spent_today` (may go negative).
 *
 * Pure in the strict sense of CLAUDE.md, "Shared domain code": both inputs arrive as
 * arguments. `remaining` is computed by the caller from M4's frozen period cap and M3's
 * spend total; `daysLeft` from `daysInclusive(today, period.periodEnd)`, where "today"
 * came from an injected `Clock` and the user's immutable timezone. That is what makes
 * this testable at period boundaries, across DST transitions and at half-hour offsets
 * without mocking time.
 *
 * `daily_target` is computed once per `(user, category, date)` and **never recomputed
 * for that date** — M5's central invariant. Recomputing live from current spend would
 * spread a lunchtime overspend across the remaining days, `available_today` would
 * quietly stay positive, and the user would never see they had gone over.
 */
export function computeDailyTarget(input: {
  remaining: MinorUnits;
  daysLeft: number;
}): MinorUnits {
  const { remaining, daysLeft } = input;

  // `daysInclusive` counts both ends, so the last day of a period is 1, never 0. A
  // caller that produced 0 or a fraction has a bug upstream — fail loudly rather than
  // dividing by zero or silently truncating.
  if (!Number.isInteger(daysLeft) || daysLeft < 1) {
    throw new Error(`daily-target: daysLeft must be a positive integer, got ${daysLeft}`);
  }

  // Clamping first is what makes truncation safe: BigInt division truncates toward
  // zero rather than flooring, and the two differ only for negatives — which are
  // already gone by this point. An over-cap user gets 0 today, and tomorrow's target
  // is genuinely smaller because `remaining` shrank.
  if (remaining <= 0n) return 0n;

  return remaining / BigInt(daysLeft);
}
