import type { MinorUnits } from '../ports/common';

/**
 * Pure daily-allowance formula (M1 §2, M5).
 *
 * Stub — M5 owns the real implementation, as a pure function with an injected clock,
 * unit-tested at period boundaries, DST transitions, and half-hour offsets.
 *
 * Reference (from M5's plan):
 *   remaining    = period_cap - (expenses - refunds), to the end of yesterday
 *   days_left    = period_end - today_local + 1        // includes today
 *   daily_target = max(0, floor(remaining / days_left))
 * Through the day: available_today = daily_target - spent_today (may go negative).
 * `daily_target` is computed once per (user, category, date) and never recomputed.
 */
export function computeDailyTarget(_input: {
  remaining: MinorUnits;
  daysLeft: number;
}): MinorUnits {
  throw new Error('not implemented');
}
