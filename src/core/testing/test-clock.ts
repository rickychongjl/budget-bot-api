import type { Clock } from '../ports/clock';
import type { Instant } from '../ports/common';

/**
 * Settable `Clock` for unit tests (M1 §3) — this is what lets period/allowance maths
 * be exercised at arbitrary instants and across DST transitions without waiting for
 * real time to pass.
 */
export class TestClock implements Clock {
  #instant: Instant;

  constructor(start: Instant | Date | string = 0) {
    this.#instant = TestClock.#toInstant(start);
  }

  now(): Instant {
    return this.#instant;
  }

  /** Jump to an absolute instant. */
  set(to: Instant | Date | string): void {
    this.#instant = TestClock.#toInstant(to);
  }

  /** Move forward (or back, with a negative value) by whole milliseconds. */
  advance(ms: number): void {
    this.#instant += ms;
  }

  static #toInstant(value: Instant | Date | string): Instant {
    if (typeof value === 'number') return value;
    const ms = value instanceof Date ? value.getTime() : Date.parse(value);
    if (Number.isNaN(ms)) throw new Error(`TestClock: unparseable time ${String(value)}`);
    return ms;
  }
}
