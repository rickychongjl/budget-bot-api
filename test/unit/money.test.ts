import { describe, expect, it } from 'vitest';
import { MoneyError, formatMinorUnits, minorUnitExponent, toMinorUnits } from '../../src/core/shared/money';

describe('toMinorUnits', () => {
  it('converts AUD decimals to cents as bigint', () => {
    expect(toMinorUnits('82.40', 'AUD')).toBe(8240n);
    expect(toMinorUnits('82.4', 'AUD')).toBe(8240n);
    expect(toMinorUnits('5', 'AUD')).toBe(500n);
    expect(toMinorUnits('0.50', 'AUD')).toBe(50n);
    expect(toMinorUnits('1,250', 'AUD')).toBe(125000n);
    expect(toMinorUnits(' 4,250.00 ', 'AUD')).toBe(425000n);
  });

  it('rejects an exponent mismatch (82.404 for AUD) — M6 "Tests to write"', () => {
    expect(() => toMinorUnits('82.404', 'AUD')).toThrowError(MoneyError);
    try {
      toMinorUnits('82.404', 'AUD');
    } catch (e) {
      expect((e as MoneyError).code).toBe('SCALE_EXCEEDS_EXPONENT');
    }
  });

  it('respects zero- and three-exponent currencies', () => {
    expect(toMinorUnits('500', 'JPY')).toBe(500n);
    expect(() => toMinorUnits('500.5', 'JPY')).toThrowError(MoneyError);
    expect(toMinorUnits('1.234', 'KWD')).toBe(1234n);
    expect(minorUnitExponent('aud')).toBe(2);
  });

  it('rejects malformed, signed, exponent-form, and non-positive amounts', () => {
    for (const bad of ['', 'abc', '-5', '+5', '1e3', '5.', '.5', '0', '0.00', '12.5.1']) {
      expect(() => toMinorUnits(bad, 'AUD'), bad).toThrowError(MoneyError);
    }
  });

  it('formats back without floats', () => {
    expect(formatMinorUnits(8240n, 'AUD')).toBe('82.40');
    expect(formatMinorUnits(5n, 'AUD')).toBe('0.05');
    expect(formatMinorUnits(-1250n, 'AUD')).toBe('-12.50');
    expect(formatMinorUnits(500n, 'JPY')).toBe('500');
  });
});
