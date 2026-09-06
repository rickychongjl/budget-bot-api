import type { Instant } from './common';

/**
 * The injected time source (M1 §3). Domain code — period maths, allowance formula —
 * takes a `Clock` and never calls `Date.now()`, so it is unit-testable at arbitrary
 * instants and across daylight-saving transitions (master plan §6, rule 3).
 */
export interface Clock {
  now(): Instant;
}

/** Production implementation — wraps the real wall clock. */
export class SystemClock implements Clock {
  now(): Instant {
    return Date.now();
  }
}
