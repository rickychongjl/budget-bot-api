import { MoneyError, toMinorUnits } from '../core/domain/money';
import type { CurrencyCode, Instant, LocalDate } from '../core/ports/common';
import type { ParseRoute, TransactionDirection, ValidatedCandidate } from '../core/ports/ledger-service';
import type { LlmParseResult } from '../core/ports/llm-parser';
import { compareLocalDates, instantAtLocalNoon, isValidLocalDate } from './dates';
import type { IMessageNormalizer } from './normalizer';
import type { CategoryRef, ClarifyReason, MechanicalCandidate, UserParseContext } from './types';

/**
 * Stage 7 (M6 "End-to-end flow"): the application validator. The server is
 * authoritative — a malformed amount, impossible date, unsupported category,
 * missing required field, or conflict between extractors is rejected here no
 * matter how confident the model was. Nothing downstream re-checks these.
 */

/** The raw fields a route hands the validator — the union of what each route knows. */
export interface CandidateFields {
  direction: TransactionDirection;
  /** Plain decimal text, e.g. "82.40". The LLM's float is stringified upstream. */
  amountDecimal: string | null;
  /** ISO code if the message/model named one; null means "the user's default". */
  currencyCode: CurrencyCode | null;
  /** Explicit date, if any. null means today. */
  transactionDate: LocalDate | null;
  /** Category by id (mapping route) or by name (LLM route). */
  categoryId?: string | null;
  categoryName?: string | null;
  merchantDisplay: string | null;
  normalizedMerchant: string | null;
  note?: string | null;
  route: ParseRoute;
  confidence?: number;
}

export type ValidationResult =
  | { ok: true; candidate: ValidatedCandidate; category: CategoryRef | null }
  | { ok: false; reason: ClarifyReason; question: string };

export interface ValidationInput {
  fields: CandidateFields;
  mechanical: MechanicalCandidate;
  context: UserParseContext;
  today: LocalDate;
  now: Instant;
}

export interface ITransactionCandidateValidator {
  validate(input: ValidationInput): ValidationResult;
}

export class TransactionCandidateValidator implements ITransactionCandidateValidator {
  constructor(private readonly normalizer: IMessageNormalizer) {}

  validate({ fields, mechanical, context, today, now }: ValidationInput): ValidationResult {
    // 1. Currency — no conversion in v1 (M3 "Money"): anything but the user's default clarifies.
    const stated = fields.currencyCode ?? mechanical.currencyTokens[0] ?? null;
    if (stated !== null && stated.toUpperCase() !== context.currencyCode.toUpperCase()) {
      return fail(
        'foreign_currency',
        `That looks like ${stated.toUpperCase()}, but your budget is in ${context.currencyCode}. What was it in ${context.currencyCode}?`,
      );
    }
    for (const token of mechanical.currencyTokens) {
      if (token.toUpperCase() !== context.currencyCode.toUpperCase()) {
        return fail(
          'foreign_currency',
          `That looks like ${token}, but your budget is in ${context.currencyCode}. What was it in ${context.currencyCode}?`,
        );
      }
    }

    // 2. Amount — required, plain decimal, scale within the currency's exponent, > 0.
    if (fields.amountDecimal === null) {
      return fail('no_amount', 'How much was it?');
    }
    let amountMinorUnits;
    try {
      amountMinorUnits = toMinorUnits(fields.amountDecimal, context.currencyCode);
    } catch (error) {
      if (error instanceof MoneyError) {
        const question =
          error.code === 'SCALE_EXCEEDS_EXPONENT'
            ? `${fields.amountDecimal} has too many decimal places for ${context.currencyCode} — what was the exact amount?`
            : 'I could not read the amount — what was it?';
        return fail('invalid_amount', question);
      }
      throw error;
    }
    // Conflict between extractors: the model's amount must be one the mechanical pass saw.
    if (
      mechanical.amounts.length > 0 &&
      !mechanical.amounts.some((a) => sameAmount(a.decimal, fields.amountDecimal ?? '', context.currencyCode))
    ) {
      return fail('invalid_amount', 'I saw more than one possible amount — which one is it?');
    }

    // 3. Date — explicit dates must be real, not in the future, not before the account floor.
    if (mechanical.hasConflictingDates) {
      return fail('ambiguous_date', 'I saw more than one date — which day was it?');
    }
    const mechanicalDate = mechanical.dates[0]?.localDate ?? null;
    let occurredOn: LocalDate;
    if (mechanicalDate !== null) {
      occurredOn = mechanicalDate;
      if (fields.transactionDate !== null && fields.transactionDate !== mechanicalDate) {
        return fail('ambiguous_date', 'I saw more than one date — which day was it?');
      }
    } else if (fields.transactionDate !== null) {
      if (!isValidLocalDate(fields.transactionDate)) {
        return fail('invalid_date', 'I could not read the date — which day was it?');
      }
      occurredOn = fields.transactionDate;
    } else {
      occurredOn = today;
    }
    if (compareLocalDates(occurredOn, today) > 0) {
      return fail('invalid_date', `${occurredOn} is in the future — which day was it?`);
    }
    if (context.accountCreatedOn !== undefined && compareLocalDates(occurredOn, context.accountCreatedOn) < 0) {
      return fail('invalid_date', `I can only record from ${context.accountCreatedOn} onwards — which day was it?`);
    }

    // 4. Category — expenses/refunds need one that exists; income never offsets a cap, so none.
    let category: CategoryRef | null = null;
    if (fields.direction !== 'income') {
      category = this.resolveCategory(fields, context.categories);
      if (category === null) {
        const named = fields.categoryName?.trim();
        if (named !== undefined && named.length > 0) {
          return fail('unknown_category', `I don't have a category called "${named}". Which of these is it: ${listNames(context.categories)}?`);
        }
        return fail('missing_category', `Which category is that? ${listNames(context.categories)}`);
      }
    }

    const occurredAt = occurredOn === today ? now : instantAtLocalNoon(occurredOn, context.timezone);
    const merchantDisplay = fields.merchantDisplay?.trim() || undefined;
    const normalizedMerchant =
      fields.normalizedMerchant !== null && fields.normalizedMerchant.length > 0
        ? fields.normalizedMerchant
        : merchantDisplay !== undefined
          ? this.normalizer.merchantKey(merchantDisplay)
          : undefined;
    const note = fields.note?.trim() || undefined;

    const candidate: ValidatedCandidate = {
      direction: fields.direction,
      amountMinorUnits,
      currencyCode: context.currencyCode,
      occurredAt,
      occurredOn,
      categoryId: category?.id ?? null,
      ...(merchantDisplay !== undefined ? { merchantDisplay } : {}),
      ...(normalizedMerchant !== undefined ? { normalizedMerchant } : {}),
      ...(note !== undefined ? { note } : {}),
      rawText: mechanical.normalized.original,
      parseRoute: fields.route,
      ...(fields.confidence !== undefined ? { parseConfidence: fields.confidence } : {}),
    };
    return { ok: true, candidate, category };
  }

  private resolveCategory(fields: CandidateFields, categories: readonly CategoryRef[]): CategoryRef | null {
    if (fields.categoryId) {
      return categories.find((c) => c.id === fields.categoryId) ?? null;
    }
    const name = fields.categoryName?.trim();
    if (!name) return null;
    const key = this.normalizer.merchantKey(name);
    return categories.find((c) => this.normalizer.merchantKey(c.name) === key) ?? null;
  }
}

function fail(reason: ClarifyReason, question: string): ValidationResult {
  return { ok: false, reason, question };
}

function listNames(categories: readonly CategoryRef[]): string {
  return categories.length > 0 ? categories.map((c) => c.name).join(', ') : '(you have no categories yet)';
}

function sameAmount(a: string, b: string, currency: CurrencyCode): boolean {
  try {
    return toMinorUnits(a, currency) === toMinorUnits(b, currency);
  } catch {
    return false;
  }
}
