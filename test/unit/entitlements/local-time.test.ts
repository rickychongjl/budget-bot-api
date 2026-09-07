import { describe, expect, it } from 'vitest';
import {
  addLocalDays,
  formatLocalTime,
  localDateOf,
  localMidnightInstant,
  nextLocalMidnight,
  offsetMsAt,
} from '../../../src/core/entitlements/local-time';
import { at } from './harness';

const HOUR = 3_600_000;

describe('localDateOf', () => {
  it('derives the user-local calendar date, not the UTC one', () => {
    // 14:30Z on 6 Sep is already 7 Sep in Brisbane (+10) and still 6 Sep in London.
    expect(localDateOf(at('2026-09-06T14:30:00Z'), 'Australia/Brisbane')).toBe('2026-09-07');
    expect(localDateOf(at('2026-09-06T14:30:00Z'), 'Europe/London')).toBe('2026-09-06');
    expect(localDateOf(at('2026-09-06T14:30:00Z'), 'UTC')).toBe('2026-09-06');
  });

  it('handles the half-hour zones the master plan calls out (Adelaide, +9:30 in winter)', () => {
    expect(localDateOf(at('2026-09-06T14:29:59Z'), 'Australia/Adelaide')).toBe('2026-09-06');
    expect(localDateOf(at('2026-09-06T14:30:00Z'), 'Australia/Adelaide')).toBe('2026-09-07');
  });
});

describe('offsetMsAt', () => {
  it('reports the offset in force, including DST', () => {
    expect(offsetMsAt(at('2026-01-15T00:00:00Z'), 'Australia/Sydney')).toBe(11 * HOUR); // AEDT
    expect(offsetMsAt(at('2026-07-15T00:00:00Z'), 'Australia/Sydney')).toBe(10 * HOUR); // AEST
    expect(offsetMsAt(at('2026-07-15T00:00:00Z'), 'America/New_York')).toBe(-4 * HOUR);
  });
});

describe('localMidnightInstant / nextLocalMidnight', () => {
  it('is local 00:00 expressed as a UTC instant', () => {
    expect(localMidnightInstant('2026-09-07', 'Australia/Brisbane')).toBe(at('2026-09-06T14:00:00Z'));
    expect(localMidnightInstant('2026-09-07', 'UTC')).toBe(at('2026-09-07T00:00:00Z'));
  });

  it('is a 23-hour day across the Sydney DST start (4 Oct 2026, 02:00 → 03:00)', () => {
    const oct4 = localMidnightInstant('2026-10-04', 'Australia/Sydney'); // AEST, +10
    const oct5 = localMidnightInstant('2026-10-05', 'Australia/Sydney'); // AEDT, +11
    expect(oct4).toBe(at('2026-10-03T14:00:00Z'));
    expect(oct5).toBe(at('2026-10-04T13:00:00Z'));
    expect(oct5 - oct4).toBe(23 * HOUR);
  });

  it('is a 25-hour day across the Sydney DST end (5 Apr 2026, 03:00 → 02:00)', () => {
    const apr5 = localMidnightInstant('2026-04-05', 'Australia/Sydney');
    const apr6 = localMidnightInstant('2026-04-06', 'Australia/Sydney');
    expect(apr6 - apr5).toBe(25 * HOUR);
  });

  it('nextLocalMidnight is the first instant of the following local day', () => {
    // 23:59:59.999 Brisbane on 6 Sep → next midnight is 7 Sep 00:00 = 6 Sep 14:00Z.
    expect(nextLocalMidnight(at('2026-09-06T13:59:59.999Z'), 'Australia/Brisbane')).toBe(at('2026-09-06T14:00:00Z'));
    // Exactly at midnight, "next" is the *following* one, a full day away.
    expect(nextLocalMidnight(at('2026-09-06T14:00:00Z'), 'Australia/Brisbane')).toBe(at('2026-09-07T14:00:00Z'));
  });

  it('picks the first existing instant when a DST gap removes midnight itself (Santiago, 6 Sep 2026)', () => {
    // Chile springs forward at 24:00 → 01:00 on the first Sunday of September:
    // 2026-09-06 has no 00:00; its first instant is 04:00Z (shown locally as 01:00).
    const first = localMidnightInstant('2026-09-06', 'America/Santiago');
    expect(localDateOf(first, 'America/Santiago')).toBe('2026-09-06');
    expect(localDateOf(first - 1, 'America/Santiago')).toBe('2026-09-05');
  });
});

describe('addLocalDays', () => {
  it('rolls over month and year boundaries', () => {
    expect(addLocalDays('2026-09-30', 1)).toBe('2026-10-01');
    expect(addLocalDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addLocalDays('2028-02-28', 1)).toBe('2028-02-29');
  });
});

describe('formatLocalTime', () => {
  it('renders a short wall-clock label in the user zone', () => {
    expect(formatLocalTime(at('2026-09-06T14:00:00Z'), 'Australia/Brisbane')).toBe('12:00 am');
    expect(formatLocalTime(at('2026-09-06T03:05:00Z'), 'Australia/Brisbane')).toBe('1:05 pm');
  });
});
