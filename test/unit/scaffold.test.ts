import { describe, expect, it } from 'vitest';
import { SystemClock } from '../../src/core/shared/clock';
import { computeDailyTarget } from '../../src/core/allowance/daily-target';
import { periodFor } from '../../src/core/budgets/period';

/**
 * Phase 0 guardrails. Not domain coverage — that lands with each module. These assert
 * the two things M1 actually promises: the port surface is importable, and every
 * domain function is a compiler-enforced contract with an honest "not implemented"
 * body until its owning module fills it in.
 *
 * Two of the three original stubs are now real: `money.ts` (M6, covered by
 * `test/unit/money.test.ts`) and `period.ts` (M4, covered by
 * `test/unit/budgets/period.test.ts`). `computeDailyTarget` is the last one standing
 * and this file retires when M5 lands.
 */

describe('port surface', () => {
  it('re-exports the shared time source', () => {
    expect(typeof SystemClock).toBe('function');
    expect(new SystemClock().now()).toBeTypeOf('number');
  });
});

describe('domain stubs throw until their module lands', () => {
  it('computeDailyTarget (M5)', () => {
    expect(() => computeDailyTarget({ remaining: 0n, daysLeft: 1 })).toThrow('not implemented');
  });

  it('periodFor (M4) has landed — the stub is gone', () => {
    expect(periodFor('2026-09-06', '2026-01-15')).toEqual({
      key: '2026-08',
      start: '2026-08-15',
      end: '2026-09-14',
    });
  });
});
