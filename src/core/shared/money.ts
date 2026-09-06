import type { CurrencyCode, MinorUnits } from './common';

/**
 * Pure money helpers (M1 §2). Money is `bigint` minor units everywhere; a float never
 * touches a monetary value at any layer (M1 §4 / master plan §6).
 *
 * Stubs — M3/M6 own the real conversion. The decimal→minor-units conversion happens
 * once, at the boundary where the parser's output becomes a domain value, and
 * validates scale against the currency's exponent first (`82.404` for AUD is a
 * validation failure, not a rounding opportunity).
 */

/** Minor-unit exponent for a currency, e.g. AUD -> 2, JPY -> 0. */
export function minorUnitExponent(_currency: CurrencyCode): number {
  throw new Error('not implemented');
}

/**
 * Parse a user-entered decimal string in `currency` to minor units, rejecting a
 * scale finer than the currency allows. Throws on a malformed or over-precise amount.
 */
export function toMinorUnits(_decimal: string, _currency: CurrencyCode): MinorUnits {
  throw new Error('not implemented');
}

/** Render minor units for display in `currency` (no symbol policy decided here). */
export function formatMinorUnits(_amount: MinorUnits, _currency: CurrencyCode): string {
  throw new Error('not implemented');
}
