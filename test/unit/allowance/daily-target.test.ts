import { describe, expect, it } from 'vitest';
import { computeDailyTarget } from '../../../src/core/allowance';
import { daysInclusive } from '../../../src/core/shared/local-date';
import { periodFor } from '../../../src/core/budgets';

/**
 * The pure half of M5. Everything here is `(remaining, daysLeft) -> target` — no clock,
 * no database, no timezone — which is what lets the boundary cases be stated directly
 * instead of being staged through a fixture.
 */

describe('computeDailyTarget', () => {
  it('spreads what is left over the days that remain, including today', () => {
    // $300 left, 10 days including today -> $30 a day.
    expect(computeDailyTarget({ remaining: 30_000n, daysLeft: 10 })).toBe(3_000n);
  });

  it('gives the whole remainder on the last day of a period', () => {
    // The invariant that matters: days_left includes today, so the last day divides by
    // 1, never 0. Getting this wrong is a crash, not a wrong number.
    expect(computeDailyTarget({ remaining: 4_250n, daysLeft: 1 })).toBe(4_250n);
  });

  it('truncates rather than rounding up, so the targets never over-promise', () => {
    // $10.00 over 3 days is $3.33, not $3.34 — three days at $3.34 would exceed the cap.
    expect(computeDailyTarget({ remaining: 1_000n, daysLeft: 3 })).toBe(333n);
  });

  it('reports zero once the cap is spent, not a negative daily target', () => {
    expect(computeDailyTarget({ remaining: 0n, daysLeft: 5 })).toBe(0n);
  });

  it('reports zero when already over the cap', () => {
    // The overspend is still visible — it shows up as a negative `available_today` and
    // in tomorrow's genuinely smaller remaining balance — but the *target* floors at 0.
    expect(computeDailyTarget({ remaining: -12_500n, daysLeft: 7 })).toBe(0n);
  });

  it('agrees with a true floor, because negatives are clamped before the division', () => {
    // BigInt division truncates toward zero rather than flooring, and the two disagree
    // only for negatives. Clamping first is what makes the doc's `floor` honest.
    for (const remaining of [-1n, -999n, -1_000_000n]) {
      const truncated = computeDailyTarget({ remaining, daysLeft: 7 });
      const floored = 0n; // max(0, floor(negative / positive)) is always 0
      expect(truncated).toBe(floored);
    }
  });

  it('handles a cap far larger than the period, without precision loss', () => {
    // bigint, not number: this is past Number.MAX_SAFE_INTEGER in cents.
    expect(computeDailyTarget({ remaining: 90_071_992_547_409_930n, daysLeft: 30 })).toBe(
      3_002_399_751_580_331n,
    );
  });

  it('refuses a days-left of zero rather than dividing by it', () => {
    expect(() => computeDailyTarget({ remaining: 100n, daysLeft: 0 })).toThrow('positive integer');
  });

  it('refuses a negative or fractional days-left', () => {
    expect(() => computeDailyTarget({ remaining: 100n, daysLeft: -1 })).toThrow();
    expect(() => computeDailyTarget({ remaining: 100n, daysLeft: 2.5 })).toThrow();
  });
});

describe('computeDailyTarget composed with M4 periods', () => {
  const anchor = '2026-01-05';

  it('day one of a cycle divides by the whole cycle', () => {
    const period = periodFor('2026-09-05', anchor);
    const daysLeft = daysInclusive('2026-09-05', period.end);
    // 5 Sep - 4 Oct inclusive is 30 days.
    expect(daysLeft).toBe(30);
    expect(computeDailyTarget({ remaining: 60_000n, daysLeft })).toBe(2_000n);
  });

  it('the last day of a cycle divides by one', () => {
    const period = periodFor('2026-10-04', anchor);
    expect(period.end).toBe('2026-10-04');
    expect(daysInclusive('2026-10-04', period.end)).toBe(1);
  });

  it('rolls over to a fresh, larger days-left on the next day', () => {
    const lastDay = daysInclusive('2026-10-04', periodFor('2026-10-04', anchor).end);
    const firstDayOfNext = daysInclusive('2026-10-05', periodFor('2026-10-05', anchor).end);
    expect(lastDay).toBe(1);
    expect(firstDayOfNext).toBe(31); // 5 Oct - 4 Nov
  });

  it('counts days correctly across the Sydney DST transition', () => {
    // Sydney enters DST on 4 Oct 2026. Days are calendar days, not 24-hour spans, so
    // the 23-hour day still counts as one — this is why the maths lives on LocalDate.
    expect(daysInclusive('2026-10-03', '2026-10-05')).toBe(3);
  });
});
