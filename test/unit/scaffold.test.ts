import { describe, expect, it } from 'vitest';
import * as ports from '../../src/core/ports';
import { computeDailyTarget } from '../../src/core/domain/allowance';
import { periodFor } from '../../src/core/domain/period';

/**
 * Phase 0 guardrails. Not domain coverage — that lands with M3/M4/M5. These assert
 * the two things M1 actually promises: the port surface is importable, and every
 * domain function is a compiler-enforced contract with an honest "not implemented"
 * body until its owning module fills it in. (`money.ts` was filled in by M6 —
 * see `test/unit/money.test.ts`.)
 */

describe('port surface', () => {
  it('re-exports the shared time source', () => {
    expect(typeof ports.SystemClock).toBe('function');
    expect(new ports.SystemClock().now()).toBeTypeOf('number');
  });
});

describe('domain stubs throw until their module lands', () => {
  it('computeDailyTarget (M5)', () => {
    expect(() => computeDailyTarget({ remaining: 0n, daysLeft: 1 })).toThrow('not implemented');
  });

  it('periodFor (M4)', () => {
    expect(() => periodFor('2026-09-06', '2026-01-15')).toThrow('not implemented');
  });
});
