import { describe, expect, it } from 'vitest';
import {
  CURATED_AU_TIMEZONES,
  allTimezones,
  searchTimezones,
} from '../../../src/core/identity/timezones';
import {
  localDateAt,
  validateCurrencyCode,
  validateLocalDate,
  validateLocalTime,
  validateTimezone,
} from '../../../src/core/identity/validation';

describe('validateTimezone', () => {
  it('accepts and canonicalises IANA ids', () => {
    expect(validateTimezone('Australia/Brisbane')).toBe('Australia/Brisbane');
    expect(validateTimezone('australia/adelaide')).toBe('Australia/Adelaide');
    expect(validateTimezone('Pacific/Auckland')).toBe('Pacific/Auckland');
  });

  it('rejects garbage, blanks, and non-strings', () => {
    for (const bad of ['Mars/Base', '', '   ', 'GMT+10:00 Brisbane', 42, null, undefined]) {
      expect(() => validateTimezone(bad)).toThrow(/IANA/);
    }
  });
});

describe('validateLocalDate / validateLocalTime / validateCurrencyCode', () => {
  it('local date must be a real YYYY-MM-DD', () => {
    expect(validateLocalDate('2024-02-29')).toBe('2024-02-29');
    for (const bad of ['2026-02-29', '2026-04-31', '2026-1-5', '20260105', 'today', 20260105]) {
      expect(() => validateLocalDate(bad)).toThrow(/YYYY-MM-DD/);
    }
  });

  it('local time is HH:MM, and normalises Postgres HH:MM:SS', () => {
    expect(validateLocalTime('07:00')).toBe('07:00');
    expect(validateLocalTime('07:00:00')).toBe('07:00');
    expect(validateLocalTime('23:59')).toBe('23:59');
    for (const bad of ['7:00', '24:00', '07:60', '07:00:30', '0700', '']) {
      expect(() => validateLocalTime(bad)).toThrow(/HH:MM/);
    }
  });

  it('currency is upper-case alpha-3', () => {
    expect(validateCurrencyCode('AUD')).toBe('AUD');
    for (const bad of ['aud', 'AU', 'AUDD', 'A$D', '']) {
      expect(() => validateCurrencyCode(bad)).toThrow(/ISO 4217/);
    }
  });
});

describe('localDateAt', () => {
  it('derives the user-local calendar date from a UTC instant', () => {
    const instant = Date.parse('2026-09-05T15:30:00.000Z');
    expect(localDateAt(instant, 'Australia/Brisbane')).toBe('2026-09-06'); // +10 → 01:30 next day
    expect(localDateAt(instant, 'Australia/Adelaide')).toBe('2026-09-06'); // +9:30 → 01:00 next day
    expect(localDateAt(instant, 'Australia/Perth')).toBe('2026-09-05'); // +8 → 23:30 same day
    expect(localDateAt(instant, 'UTC')).toBe('2026-09-05');
  });

  it('honours daylight saving in zones that observe it', () => {
    // Sydney enters DST on 2026-10-04 at 02:00 → +11. 13:30Z is 00:30 on 5 Oct in Sydney.
    expect(localDateAt(Date.parse('2026-10-04T13:30:00.000Z'), 'Australia/Sydney')).toBe('2026-10-05');
    // Brisbane (no DST) is still 23:30 on 4 Oct.
    expect(localDateAt(Date.parse('2026-10-04T13:30:00.000Z'), 'Australia/Brisbane')).toBe('2026-10-04');
  });
});

describe('timezone picker', () => {
  it('curated AU list has the expected zones and every id is canonical', () => {
    const ids = CURATED_AU_TIMEZONES.map((z) => z.id);
    expect(ids).toEqual([
      'Australia/Sydney',
      'Australia/Melbourne',
      'Australia/Brisbane',
      'Australia/Perth',
      'Australia/Adelaide',
      'Australia/Hobart',
      'Australia/Darwin',
    ]);
    const all = new Set(allTimezones());
    for (const id of ids) expect(all.has(id), id).toBe(true);
  });

  it('search matches city names first, is case-insensitive, and caps results', () => {
    expect(searchTimezones('AUCK')[0]?.id).toBe('Pacific/Auckland');
    expect(searchTimezones('los angeles')[0]).toEqual({ id: 'America/Los_Angeles', label: 'Los Angeles' });
    expect(searchTimezones('a').length).toBeLessThanOrEqual(8);
    expect(searchTimezones('   ')).toEqual([]);
    expect(searchTimezones('zzzz-not-a-place')).toEqual([]);
  });

  it('ranks a city-prefix match above a region-only match', () => {
    const results = searchTimezones('asia', 50).map((r) => r.id);
    // No city starts with "asia"; region matches only — but ordering must be stable.
    expect(results.every((id) => id.toLowerCase().includes('asia'))).toBe(true);
    const syd = searchTimezones('syd').map((r) => r.id);
    expect(syd[0]).toBe('Australia/Sydney');
  });
});
