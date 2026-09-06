import { describe, expect, it } from 'vitest';
import { addDays, instantAtLocalNoon, isValidLocalDate, localDateAt, weekday } from '../../src/parsing/dates';
import { DefaultMessageNormalizer } from '../../src/parsing/normalizer';

describe('MessageNormalizer', () => {
  const n = new DefaultMessageNormalizer();

  it('lowercases, trims, collapses whitespace and standardises symbols', () => {
    expect(n.normalize('  Spent   $82.40  at WOOLIES!! ').text).toBe('spent $82.40 at woolies');
    expect(n.normalize('A$15 coffee').text).toBe('$15 coffee');
    expect(n.normalize('AU$ 15 coffee').text).toBe('$15 coffee');
    expect(n.normalize('US$25 subscription').text).toBe('usd 25 subscription');
    expect(n.normalize('“coffee” – $4.50').text).toBe('"coffee" - $4.50'.replace(/"/g, ' ').replace(/\s+/g, ' ').trim());
  });

  it('keeps the original verbatim', () => {
    const original = '  Spent $82.40 at WOOLIES!! ';
    expect(n.normalize(original).original).toBe(original);
  });

  it('deriveMerchantKey strips punctuation but does not merge merchants', () => {
    expect(n.deriveMerchantKey('Woolworths 1234 BRISBANE')).toBe('woolworths 1234 brisbane');
    expect(n.deriveMerchantKey("Macca's ☕ !")).toBe("macca's");
    expect(n.deriveMerchantKey('7-Eleven')).toBe('7-eleven');
  });
});

describe('dates', () => {
  it('validates calendar dates', () => {
    expect(isValidLocalDate('2026-09-06')).toBe(true);
    expect(isValidLocalDate('2026-02-29')).toBe(false);
    expect(isValidLocalDate('2028-02-29')).toBe(true);
    expect(isValidLocalDate('2026-09-31')).toBe(false);
    expect(isValidLocalDate('6/9/2026')).toBe(false);
  });

  it('does day arithmetic across month and year boundaries', () => {
    expect(addDays('2026-09-01', -1)).toBe('2026-08-31');
    expect(addDays('2026-01-01', -1)).toBe('2025-12-31');
    expect(weekday('2026-09-06')).toBe(0); // Sunday
  });

  it('derives the user-local date from an instant', () => {
    // 2026-09-06T02:00Z is 12:00 in Brisbane but still 5 Sep 22:00 in Los Angeles.
    const instant = Date.parse('2026-09-06T02:00:00Z');
    expect(localDateAt(instant, 'Australia/Brisbane')).toBe('2026-09-06');
    expect(localDateAt(instant, 'America/Los_Angeles')).toBe('2026-09-05');
    // 15:30Z on 6 Sep is already 7 Sep 01:30 in Sydney (AEST, UTC+10).
    expect(localDateAt(Date.parse('2026-09-06T15:30:00Z'), 'Australia/Sydney')).toBe('2026-09-07');
  });

  it('places a backdated transaction at local noon, correct across DST', () => {
    // Sydney is UTC+10 before the first Sunday of October 2026 and UTC+11 after.
    expect(new Date(instantAtLocalNoon('2026-09-15', 'Australia/Sydney')).toISOString()).toBe('2026-09-15T02:00:00.000Z');
    expect(new Date(instantAtLocalNoon('2026-10-15', 'Australia/Sydney')).toISOString()).toBe('2026-10-15T01:00:00.000Z');
    // Brisbane has no DST.
    expect(new Date(instantAtLocalNoon('2026-10-15', 'Australia/Brisbane')).toISOString()).toBe('2026-10-15T02:00:00.000Z');
    // Round-trips through localDateAt on the day itself.
    expect(localDateAt(instantAtLocalNoon('2026-10-04', 'Australia/Sydney'), 'Australia/Sydney')).toBe('2026-10-04');
  });
});
