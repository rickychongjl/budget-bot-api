import type { CurrencyCode, LocalDate, MinorUnits } from '../shared/common';
import { RefusalError } from '../shared/errors';
import { compareLocalDates, isLocalDate } from '../shared/local-date';

/**
 * M3's pure transaction rules, kept with their owning feature rather than in a shared
 * dumping ground (CLAUDE.md, "Shared domain code"). No clock, no DB, no network — every
 * value the rules need arrives as an argument.
 *
 * These duplicate checks M6's validator already makes, on purpose. M6 exists to turn
 * text into a candidate and can be bypassed (a `/command` route, a future channel, a
 * replayed callback); M3 is the system of record and refuses to write a row it cannot
 * account for. Defence in depth, not distrust of M6.
 */

export interface TransactionRules {
  currencyCode: CurrencyCode;
  /** M3's backdating floor: `app_user.created_at` read in the user's own timezone. */
  accountCreatedOn: LocalDate;
  /** The user's today — the ceiling; a transaction cannot be logged in the future. */
  today: LocalDate;
}

/** The amount carries no sign — direction does (`amount_minor_units > 0` in the schema). */
export function assertAmount(amount: MinorUnits): void {
  if (amount <= 0n) {
    throw new RefusalError('INVALID_ARGUMENT', 'An amount has to be more than zero.');
  }
}

/**
 * No conversion in v1: a foreign-currency amount cannot be netted against a cap
 * denominated in something else, so it is refused rather than silently mis-counted.
 * M6 clarifies with the user before it ever reaches here.
 */
export function assertCurrency(currency: CurrencyCode, expected: CurrencyCode): void {
  if (currency.toUpperCase() !== expected.toUpperCase()) {
    throw new RefusalError(
      'INVALID_ARGUMENT',
      `I can only record amounts in ${expected.toUpperCase()} at the moment.`,
    );
  }
}

/**
 * The backdating window, confirmed round 3: the floor is the account creation date,
 * the ceiling is today. Both ends are inclusive.
 */
export function assertOccurredOn(occurredOn: LocalDate, rules: TransactionRules): void {
  if (!isLocalDate(occurredOn)) {
    throw new RefusalError('INVALID_ARGUMENT', `${occurredOn} isn't a real date.`);
  }
  if (compareLocalDates(occurredOn, rules.today) > 0) {
    throw new RefusalError('INVALID_ARGUMENT', `${occurredOn} is in the future — which day was it?`);
  }
  if (compareLocalDates(occurredOn, rules.accountCreatedOn) < 0) {
    throw new RefusalError(
      'INVALID_ARGUMENT',
      `I can only go back as far as ${rules.accountCreatedOn}, when your account was created.`,
    );
  }
}

export function assertRecordable(
  amount: MinorUnits,
  currency: CurrencyCode,
  occurredOn: LocalDate,
  rules: TransactionRules,
): void {
  assertAmount(amount);
  assertCurrency(currency, rules.currencyCode);
  assertOccurredOn(occurredOn, rules);
}
