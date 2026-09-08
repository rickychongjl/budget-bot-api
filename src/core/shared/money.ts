import type { CurrencyCode, MinorUnits } from './common';

/**
 * Pure money helpers. Money is `bigint` minor units everywhere; a float never
 * touches a monetary value at any layer (M1 §4 / master plan §6).
 *
 * Lives in `core/shared` because it is a genuinely shared concept rather than one
 * feature's calculation (CLAUDE.md, "Shared domain code").
 *
 * Implemented by M6 (the parser boundary is where decimal text becomes a domain
 * value — M3's plan, "Money"). The conversion validates scale against the currency's
 * exponent first: `82.404` for AUD is a validation failure, not a rounding
 * opportunity. M3 may reuse these as-is; nothing here is parser-specific.
 */

export class MoneyError extends Error {
  constructor(
    readonly code: 'MALFORMED_AMOUNT' | 'SCALE_EXCEEDS_EXPONENT' | 'NON_POSITIVE_AMOUNT',
    message: string,
  ) {
    super(message);
    this.name = 'MoneyError';
  }
}

/** ISO 4217 minor-unit exponents that differ from the default of 2. */
const EXPONENT_OVERRIDES: Readonly<Record<string, number>> = {
  JPY: 0,
  KRW: 0,
  VND: 0,
  CLP: 0,
  ISK: 0,
  HUF: 2,
  BHD: 3,
  IQD: 3,
  JOD: 3,
  KWD: 3,
  LYD: 3,
  OMR: 3,
  TND: 3,
};

/** Minor-unit exponent for a currency, e.g. AUD -> 2, JPY -> 0. */
export function minorUnitExponent(currency: CurrencyCode): number {
  return EXPONENT_OVERRIDES[currency.toUpperCase()] ?? 2;
}

const DECIMAL_PATTERN = /^(\d+)(?:\.(\d+))?$/;

/**
 * Parse a user-entered decimal string in `currency` to minor units, rejecting a
 * scale finer than the currency allows. Throws `MoneyError` on a malformed,
 * over-precise, or non-positive amount. Thousands separators (`,`) and surrounding
 * whitespace are tolerated; signs are not — direction lives in
 * `TransactionDirection`, never in the amount (M3 schema: `amount_minor_units > 0`).
 */
export function toMinorUnits(decimal: string, currency: CurrencyCode): MinorUnits {
  const cleaned = decimal.trim().replace(/,/g, '');
  const match = DECIMAL_PATTERN.exec(cleaned);
  if (match === null) {
    throw new MoneyError('MALFORMED_AMOUNT', 'amount is not a plain decimal');
  }
  const whole = match[1] ?? '0';
  const fraction = match[2] ?? '';
  const exponent = minorUnitExponent(currency);
  if (fraction.length > exponent) {
    throw new MoneyError(
      'SCALE_EXCEEDS_EXPONENT',
      `amount has ${fraction.length} decimal places; ${currency} allows ${exponent}`,
    );
  }
  const minor = BigInt(whole) * 10n ** BigInt(exponent) + BigInt(fraction.padEnd(exponent, '0') || '0');
  if (minor <= 0n) {
    throw new MoneyError('NON_POSITIVE_AMOUNT', 'amount must be greater than zero');
  }
  return minor;
}

/** Render minor units for display in `currency` (no symbol policy decided here). */
export function formatMinorUnits(amount: MinorUnits, currency: CurrencyCode): string {
  const exponent = minorUnitExponent(currency);
  const negative = amount < 0n;
  const abs = negative ? -amount : amount;
  if (exponent === 0) return `${negative ? '-' : ''}${abs.toString()}`;
  const divisor = 10n ** BigInt(exponent);
  const whole = abs / divisor;
  const fraction = (abs % divisor).toString().padStart(exponent, '0');
  return `${negative ? '-' : ''}${whole.toString()}.${fraction}`;
}
