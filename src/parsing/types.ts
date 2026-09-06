import type { CurrencyCode, Id, LocalDate, UserId } from '../core/ports/common';
import type { ParseRoute, Transaction, ValidatedCandidate } from '../core/ports/ledger-service';

/**
 * Shared shapes for the M6 pipeline. Each stage is its own focused component
 * (M6 checklist step 2); these are the seams between them.
 */

/** A category as the parser needs it — id for the ledger, name for matching/prompting. */
export interface CategoryRef {
  id: Id;
  name: string;
}

/**
 * Everything the pipeline needs to know about the user for one parse. Assembled by
 * the caller (M7) from M2 (`getSettings`) and M3 (category list) — M6 never reads
 * another module's table. Deliberately contains no channel identifier.
 */
export interface UserParseContext {
  userId: UserId;
  currencyCode: CurrencyCode;
  /** IANA, e.g. `Australia/Brisbane`. Immutable after onboarding (M2). */
  timezone: string;
  /** Non-archived categories only. */
  categories: readonly CategoryRef[];
  /**
   * M3's backdating floor — the local date of `app_user.created_at`. Optional so a
   * caller that doesn't have it yet still gets every other check.
   */
  accountCreatedOn?: LocalDate;
}

/** Output of `IMessageNormalizer`. */
export interface NormalizedMessage {
  /** Exactly what the user sent — retained on the transaction (M3 `raw_text`). */
  original: string;
  /** Lowercased, trimmed, whitespace-collapsed, symbol-standardised. */
  text: string;
}

/** One monetary amount found mechanically, kept as decimal text (never a float). */
export interface ExtractedAmount {
  /** Plain decimal, e.g. `"82.40"`, `"5"`, `"0.50"`. */
  decimal: string;
  /** ISO code if the token carried one (`AUD`, `USD`, `€`→`EUR`…), else null (`$`, bare). */
  currencyCode: CurrencyCode | null;
  /** `true` for `$5`, `5 bucks`, `5.00` — the token is unambiguously money. */
  explicit: boolean;
  /** Span in the normalised text, for residual-description computation. */
  start: number;
  end: number;
}

export interface ExtractedDate {
  localDate: LocalDate;
  /** What matched, e.g. `yesterday`, `3/9`, `last friday`. */
  token: string;
  start: number;
  end: number;
}

export type IntentMarker = 'income' | 'refund' | 'correction' | 'expense';

/** Output of `IMechanicalTransactionParser`. */
export interface MechanicalCandidate {
  normalized: NormalizedMessage;
  amounts: readonly ExtractedAmount[];
  dates: readonly ExtractedDate[];
  /** Explicit currency tokens found anywhere (`usd`, `€`, `aud`), deduplicated. */
  currencyTokens: readonly CurrencyCode[];
  /** Markers found in the text. `income`/`refund`/`correction` are explicit; absence means expense. */
  markers: readonly IntentMarker[];
  /**
   * What's left after amount/currency/date tokens and leading filler words are
   * removed — the merchant-memory key. Empty string when nothing remains.
   */
  normalizedDescription: string;
  /** Convenience flags used by the routing decision (M6 illustrative code). */
  hasExactlyOneAmount: boolean;
  hasMultipleAmounts: boolean;
  isExplicitIncome: boolean;
  isCorrection: boolean;
  /** Two or more date expressions that disagree. */
  hasConflictingDates: boolean;
  /** Date-shaped tokens that are not real dates (`31/9`, `30 feb`). */
  invalidDateTokens: readonly string[];
  /** `4,50` — a decimal comma, which in AU usage is ambiguous; ask rather than guess. */
  hasAmbiguousDecimalComma: boolean;
}

/** A confirmed merchant → category mapping row (M6 "Merchant memory"). */
export interface MerchantMapping {
  id: Id;
  userId: UserId;
  normalizedMerchant: string;
  displayMerchant: string;
  categoryId: Id;
  source: MerchantMappingSource;
  timesUsed: number;
}

export type MerchantMappingSource = 'user_confirmed' | 'user_corrected';

/**
 * What the pipeline asks the user about after an LLM-routed record: "Always
 * categorise X as Y?" Only becomes a row via `confirmMerchantMapping`.
 */
export interface MappingProposal {
  normalizedMerchant: string;
  displayMerchant: string;
  categoryId: Id;
  categoryName: string;
}

export type ClarifyReason =
  | 'multiple_amounts'
  | 'no_amount'
  | 'invalid_amount'
  | 'foreign_currency'
  | 'ambiguous_date'
  | 'invalid_date'
  | 'missing_category'
  | 'unknown_category'
  | 'ambiguous_intent'
  | 'correction_intent'
  | 'multi_category_merchant'
  | 'low_confidence'
  | 'model_asked'
  | 'llm_unavailable';

/**
 * Result of one parse. M7 renders it; M3/M5 have already been called for `recorded`.
 * Every variant carries `parseEventId` so a later correction can be attributed
 * (`ParseEventCorrectionHook`).
 */
export type ParseOutcome =
  | {
      kind: 'recorded';
      route: ParseRoute;
      parseEventId: Id;
      transaction: Transaction;
      /** Present only when a safe, non-multi-category merchant could be remembered. */
      mappingProposal: MappingProposal | null;
    }
  | {
      kind: 'confirm';
      route: ParseRoute;
      parseEventId: Id;
      /** Fully validated; record via `recordConfirmed` if the user says yes. */
      candidate: ValidatedCandidate;
      categoryName: string | null;
      mappingProposal: MappingProposal | null;
      confidence: number;
    }
  | {
      kind: 'clarify';
      route: ParseRoute;
      parseEventId: Id;
      reason: ClarifyReason;
      /** Suggested question text; M7 may rephrase but must not answer it. */
      question: string;
    };
