import { describe, expect, it } from 'vitest';
import {
  CURATED_AU_TIMEZONES,
  canonicalTimezone,
  isLocalDate,
  isLocalTime,
  localDateAt,
  localTimeAt,
  searchTimezones,
} from '../../../src/core/identity';

describe('canonicalTimezone', () => {
  it('accepts every curated AU zone', () => {
    for (const zone of CURATED_AU_TIMEZONES) expect(canonicalTimezone(zone)).toBe(zone);
  });

  it('canonicalises case and trims', () => {
    expect(canonicalTimezone('  australia/lord_howe ')).toBe('Australia/Lord_Howe');
    expect(canonicalTimezone('utc')).toBe('UTC');
  });

  it('rejects unknown, empty, and lookalike input', () => {
    expect(canonicalTimezone('')).toBeNull();
    expect(canonicalTimezone('Sydney')).toBeNull();
    expect(canonicalTimezone('Australia/Sidney')).toBeNull();
  });
});

describe('searchTimezones', () => {
  it('finds by city with spaces or underscores, exact city first', () => {
    expect(searchTimezones('new york')[0]).toBe('America/New_York');
    expect(searchTimezones('New_York')[0]).toBe('America/New_York');
    expect(searchTimezones('london')).toEqual(['Europe/London']);
  });

  it('ranks a prefix match above a substring match and caps the list', () => {
    const results = searchTimezones('au', 5);
    expect(results.length).toBe(5);
    expect(results.every((z) => z.toLowerCase().includes('au'))).toBe(true);
    expect(results[0]?.toLowerCase().startsWith('au')).toBe(true);
    expect(searchTimezones('nowhere-at-all')).toEqual([]);
    expect(searchTimezones('   ')).toEqual([]);
  });
});

describe('localDateAt / localTimeAt', () => {
  it('derives the local calendar date, which differs across zones at the same instant', () => {
    const instant = Date.parse('2026-09-05T23:00:00.000Z');
    expect(localDateAt(instant, 'Australia/Sydney')).toBe('2026-09-06'); // AEST +10
    expect(localDateAt(instant, 'Australia/Perth')).toBe('2026-09-06'); // AWST +8
    expect(localDateAt(instant, 'UTC')).toBe('2026-09-05');
    expect(localDateAt(instant, 'America/Los_Angeles')).toBe('2026-09-05');
  });

  it('handles the AEDT start (first Sunday in October 2026: 4 Oct, 02:00 -> 03:00)', () => {
    // 2026-10-03T15:59Z = 01:59 AEST on 4 Oct; 2026-10-03T16:00Z = 03:00 AEDT (02:00 never exists).
    expect(localTimeAt(Date.parse('2026-10-03T15:59:00.000Z'), 'Australia/Sydney')).toBe('01:59');
    expect(localTimeAt(Date.parse('2026-10-03T16:00:00.000Z'), 'Australia/Sydney')).toBe('03:00');
    expect(localDateAt(Date.parse('2026-10-03T16:00:00.000Z'), 'Australia/Sydney')).toBe('2026-10-04');
    // Brisbane doesn't observe DST: same instant is 02:00.
    expect(localTimeAt(Date.parse('2026-10-03T16:00:00.000Z'), 'Australia/Brisbane')).toBe('02:00');
  });

  it('renders midnight as 00:00, not 24:00', () => {
    expect(localTimeAt(Date.parse('2026-09-05T14:00:00.000Z'), 'Australia/Sydney')).toBe('00:00');
  });

  it('Adelaide/Darwin are half-hour zones', () => {
    expect(localTimeAt(Date.parse('2026-09-05T21:30:00.000Z'), 'Australia/Darwin')).toBe('07:00');
  });
});

describe('isLocalDate / isLocalTime', () => {
  it('validates real calendar dates only', () => {
    expect(isLocalDate('2026-09-06')).toBe(true);
    expect(isLocalDate('2028-02-29')).toBe(true);
    expect(isLocalDate('2026-02-29')).toBe(false);
    expect(isLocalDate('2026-04-31')).toBe(false);
    expect(isLocalDate('2026-9-6')).toBe(false);
    expect(isLocalDate('06/09/2026')).toBe(false);
  });

  it('validates HH:MM 24h', () => {
    expect(isLocalTime('07:00')).toBe(true);
    expect(isLocalTime('23:59')).toBe(true);
    expect(isLocalTime('24:00')).toBe(false);
    expect(isLocalTime('7:00')).toBe(false);
    expect(isLocalTime('07:00:00')).toBe(false);
  });
});
