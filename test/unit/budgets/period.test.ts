import { describe, expect, it } from 'vitest';
import { MAX_PERIOD_START_DAY, periodFor, periodStartDay } from '../../../src/core/budgets';
import { localDateAt } from '../../../src/core/shared/local-date';

/**
 * M4's "Tests to write": `periodFor` at every boundary — anchor day 28 in 28/29/30/31
 * day months, and DST transitions in Australian timezones.
 *
 * These are pure-function tests with no clock and no database, which is the whole
 * reason `periodFor` takes `localDate` as an argument instead of reading one.
 */

describe('periodStartDay', () => {
  it('is the anchor date day-of-month', () => {
    expect(periodStartDay('2026-09-01')).toBe(1);
    expect(periodStartDay('2026-09-15')).toBe(15);
    expect(periodStartDay('2026-09-28')).toBe(28);
  });

  it('caps at 28 — 29/30/31 would leave February undefined some years', () => {
    expect(periodStartDay('2026-01-29')).toBe(MAX_PERIOD_START_DAY);
    expect(periodStartDay('2026-01-30')).toBe(MAX_PERIOD_START_DAY);
    expect(periodStartDay('2026-01-31')).toBe(MAX_PERIOD_START_DAY);
  });
});

describe('periodFor — the month it belongs to', () => {
  it('labels a period by its start month, not the month it ends in', () => {
    // 25 Sep – 24 Oct is '2026-09' (M4's own example).
    expect(periodFor('2026-10-03', '2026-03-25')).toEqual({
      key: '2026-09',
      start: '2026-09-25',
      end: '2026-10-24',
    });
  });

  it('puts a date on or after the start day in the current month', () => {
    expect(periodFor('2026-09-25', '2026-03-25').key).toBe('2026-09');
    expect(periodFor('2026-09-26', '2026-03-25').key).toBe('2026-09');
  });

  it('puts a date before the start day in the previous month', () => {
    expect(periodFor('2026-09-24', '2026-03-25')).toEqual({
      key: '2026-08',
      start: '2026-08-25',
      end: '2026-09-24',
    });
  });

  it('rolls back across a year boundary', () => {
    expect(periodFor('2026-01-04', '2025-06-25')).toEqual({
      key: '2025-12',
      start: '2025-12-25',
      end: '2026-01-24',
    });
  });

  it('is a plain calendar month when the anchor is the first', () => {
    expect(periodFor('2026-09-17', '2026-01-01')).toEqual({
      key: '2026-09',
      start: '2026-09-01',
      end: '2026-09-30',
    });
  });
});

describe('periodFor — anchor day 28 across month lengths', () => {
  const anchor = '2026-01-28';

  it('28-day February: 28 Feb – 27 Mar', () => {
    expect(periodFor('2026-03-01', anchor)).toEqual({
      key: '2026-02',
      start: '2026-02-28',
      end: '2026-03-27',
    });
  });

  it('29-day February (2028 is a leap year): still 28 Feb – 27 Mar', () => {
    expect(periodFor('2028-02-28', anchor)).toEqual({
      key: '2028-02',
      start: '2028-02-28',
      end: '2028-03-27',
    });
  });

  it('30-day April: 28 Apr – 27 May', () => {
    expect(periodFor('2026-05-02', anchor)).toEqual({
      key: '2026-04',
      start: '2026-04-28',
      end: '2026-05-27',
    });
  });

  it('31-day January: 28 Jan – 27 Feb', () => {
    expect(periodFor('2026-02-10', anchor)).toEqual({
      key: '2026-01',
      start: '2026-01-28',
      end: '2026-02-27',
    });
  });

  it('a 29/30/31 anchor behaves identically, because it is capped to 28', () => {
    for (const capped of ['2026-01-29', '2026-01-30', '2026-01-31']) {
      expect(periodFor('2026-03-01', capped)).toEqual(periodFor('2026-03-01', anchor));
    }
  });
});

describe('periodFor — contiguity', () => {
  it('leaves no gap and no overlap between consecutive periods, all year', () => {
    const anchor = '2026-01-28';
    let cursor = periodFor('2026-01-28', anchor);
    for (let i = 0; i < 24; i++) {
      const next = periodFor(addDay(cursor.end), anchor);
      expect(next.start).toBe(addDay(cursor.end));
      expect(next.start <= next.end).toBe(true);
      cursor = next;
    }
  });
});

/**
 * The DST case that matters is not the arithmetic — `periodFor` is pure calendar
 * maths, so a transition inside a period cannot affect it — but the step *before* it:
 * turning "now" into the user's local date. Get that wrong at 00:30 local and the
 * transaction lands in the wrong period.
 */
describe('periodFor — across Australian DST transitions', () => {
  it('derives the same period regardless of the offset in force', () => {
    const anchor = '2026-01-05';
    // Sydney leaves DST at 03:00 on 5 Apr 2026 (UTC+11 -> UTC+10).
    const beforeSwitch = periodFor(localDateAt(Date.parse('2026-04-04T15:30:00Z'), 'Australia/Sydney'), anchor);
    const afterSwitch = periodFor(localDateAt(Date.parse('2026-04-05T15:30:00Z'), 'Australia/Sydney'), anchor);
    expect(beforeSwitch.key).toBe('2026-04');
    expect(afterSwitch.key).toBe('2026-04');
    expect(beforeSwitch).toEqual(afterSwitch);
  });

  it('an instant just before local midnight belongs to the day that is ending', () => {
    // 2026-04-04 23:30 in Sydney is 12:30Z that day (still UTC+11).
    expect(localDateAt(Date.parse('2026-04-04T12:30:00Z'), 'Australia/Sydney')).toBe('2026-04-04');
    // The same wall-clock moment a day later is UTC+10, so 13:30Z.
    expect(localDateAt(Date.parse('2026-04-05T13:30:00Z'), 'Australia/Sydney')).toBe('2026-04-05');
  });

  it('Brisbane never shifts, so the same instants read one hour earlier all year', () => {
    expect(localDateAt(Date.parse('2026-04-04T14:30:00Z'), 'Australia/Brisbane')).toBe('2026-04-05');
    expect(localDateAt(Date.parse('2026-04-04T13:30:00Z'), 'Australia/Brisbane')).toBe('2026-04-04');
  });

  it('a period that starts the day the clocks change still spans a whole month', () => {
    // Sydney enters DST at 02:00 on 4 Oct 2026; anchor day 4 puts a boundary on it.
    expect(periodFor('2026-10-04', '2026-02-04')).toEqual({
      key: '2026-10',
      start: '2026-10-04',
      end: '2026-11-03',
    });
    expect(periodFor('2026-10-03', '2026-02-04')).toEqual({
      key: '2026-09',
      start: '2026-09-04',
      end: '2026-10-03',
    });
  });
});

function addDay(date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}
