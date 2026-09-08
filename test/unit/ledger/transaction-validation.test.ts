import { describe, expect, it } from 'vitest';
import {
  MAX_CATEGORY_NAME_LENGTH,
  assertAmount,
  assertCurrency,
  assertOccurredOn,
  normalizeCategoryName,
  toCategoryDisplayName,
  type TransactionRules,
} from '../../../src/core/ledger';
import { MoneyError, toMinorUnits } from '../../../src/core/shared/money';

/**
 * M3's pure rules. The money-boundary case is M3's own headline test: `82.404` is a
 * validation failure for AUD, not a rounding opportunity, and `82.40` is exactly
 * `8240` minor units — a float never gets near either.
 */

const RULES: TransactionRules = {
  currencyCode: 'AUD',
  accountCreatedOn: '2026-09-01',
  today: '2026-09-10',
};

describe('money boundary', () => {
  it('converts AUD decimals to exact minor units', () => {
    expect(toMinorUnits('82.40', 'AUD')).toBe(8240n);
    expect(toMinorUnits('82.4', 'AUD')).toBe(8240n);
    expect(toMinorUnits('0.05', 'AUD')).toBe(5n);
    expect(toMinorUnits('1,234.56', 'AUD')).toBe(123_456n);
  });

  it('rejects a scale finer than the currency allows', () => {
    expect(() => toMinorUnits('82.404', 'AUD')).toThrow(MoneyError);
    expect(() => toMinorUnits('82.404', 'AUD')).toThrow(/2/);
  });

  it('honours a zero-exponent currency', () => {
    expect(toMinorUnits('820', 'JPY')).toBe(820n);
    expect(() => toMinorUnits('82.4', 'JPY')).toThrow(MoneyError);
  });
});

describe('assertAmount', () => {
  it('accepts a positive amount', () => {
    expect(() => assertAmount(1n)).not.toThrow();
  });

  /** The sign lives in `direction`; the column is `check (amount_minor_units > 0)`. */
  it('rejects zero and negatives — direction carries the sign', () => {
    expect(() => assertAmount(0n)).toThrow(/more than zero/);
    expect(() => assertAmount(-100n)).toThrow(/more than zero/);
  });
});

describe('assertCurrency', () => {
  it('accepts the account currency in any case', () => {
    expect(() => assertCurrency('aud', 'AUD')).not.toThrow();
  });

  /** No conversion in v1 — a foreign amount cannot be netted against an AUD cap. */
  it('rejects a foreign currency rather than mis-counting it', () => {
    expect(() => assertCurrency('USD', 'AUD')).toThrow(/AUD/);
  });
});

describe('assertOccurredOn — the backdating window', () => {
  it('accepts today and any date back to the account creation date', () => {
    for (const date of ['2026-09-10', '2026-09-05', '2026-09-01']) {
      expect(() => assertOccurredOn(date, RULES)).not.toThrow();
    }
  });

  /** Confirmed round 3: the floor is the account creation date, inclusive. */
  it('rejects the day before the account existed', () => {
    expect(() => assertOccurredOn('2026-08-31', RULES)).toThrow(/2026-09-01/);
  });

  it('rejects a future date', () => {
    expect(() => assertOccurredOn('2026-09-11', RULES)).toThrow(/future/);
  });

  it('rejects a date that is not a real calendar date', () => {
    expect(() => assertOccurredOn('2026-02-30', RULES)).toThrow(/real date/);
    expect(() => assertOccurredOn('10/09/2026', RULES)).toThrow(/real date/);
  });
});

describe('category naming', () => {
  it('treats case and whitespace as insignificant', () => {
    expect(normalizeCategoryName('  Eating   Out ')).toBe('eating out');
    expect(normalizeCategoryName('EATING OUT')).toBe(normalizeCategoryName('eating out'));
  });

  it('keeps the user"s capitalisation in the display name', () => {
    expect(toCategoryDisplayName('  Eating   Out ')).toBe('Eating Out');
  });

  it('refuses an empty or whitespace-only name', () => {
    for (const bad of ['', '   ', '\t\n']) {
      expect(() => toCategoryDisplayName(bad)).toThrow(/needs a name/);
    }
  });

  it('refuses a name past the length limit', () => {
    expect(() => toCategoryDisplayName('x'.repeat(MAX_CATEGORY_NAME_LENGTH))).not.toThrow();
    expect(() => toCategoryDisplayName('x'.repeat(MAX_CATEGORY_NAME_LENGTH + 1))).toThrow(/too long/);
  });
});
