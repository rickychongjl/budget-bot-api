import { describe, expect, it } from 'vitest';
import { SystemClock } from '../../src/core/ports/clock';
import { TestClock } from '../../src/core/testing/test-clock';

describe('SystemClock', () => {
  it('returns the real wall-clock instant in epoch ms', () => {
    const before = Date.now();
    const now = new SystemClock().now();
    const after = Date.now();
    expect(now).toBeGreaterThanOrEqual(before);
    expect(now).toBeLessThanOrEqual(after);
  });
});

describe('TestClock', () => {
  it('is settable and does not move on its own', () => {
    const clock = new TestClock('2026-09-06T07:00:00.000Z');
    expect(new Date(clock.now()).toISOString()).toBe('2026-09-06T07:00:00.000Z');
    expect(clock.now()).toBe(clock.now());
  });

  it('advances by whole milliseconds, forward and back', () => {
    const clock = new TestClock(0);
    clock.advance(1_000);
    expect(clock.now()).toBe(1_000);
    clock.advance(-250);
    expect(clock.now()).toBe(750);
  });

  it('accepts an absolute reset', () => {
    const clock = new TestClock(0);
    clock.set(new Date('2027-01-01T00:00:00.000Z'));
    expect(new Date(clock.now()).toISOString()).toBe('2027-01-01T00:00:00.000Z');
  });

  it('rejects an unparseable time', () => {
    expect(() => new TestClock('not-a-date')).toThrow(/unparseable/);
  });
});
