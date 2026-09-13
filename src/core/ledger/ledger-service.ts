import type { CurrencyCode, Id, Instant, LocalDate, MinorUnits, UserId } from '../shared/common';

/**
 * M3 — Categories & Ledger. The system of record for what the user spent. Every
 * confirmed transaction enters through this module; nothing else writes the ledger.
 *
 * Interface lifted verbatim from `docs/M3-categories-ledger.md` ("Public interface").
 * Stub only.
 */

export type TransactionDirection = 'expense' | 'income' | 'refund';
export type ParseRoute = 'command' | 'mechanical' | 'mapping' | 'llm';
export type TransactionStatus = 'confirmed' | 'pending' | 'deleted';

/**
 * What M6 hands M3 to record — already validated (amount scale checked against the
 * currency exponent, date within the backdating floor, category resolved or
 * explicitly confirmed-new). M6 owns the exact shape; this is the agreed seam.
 */
export interface ValidatedCandidate {
  direction: TransactionDirection;
  amountMinorUnits: MinorUnits;
  currencyCode: CurrencyCode;
  occurredAt: Instant;
  occurredOn: LocalDate;
  categoryId: Id | null;
  /** Set only when the user explicitly confirmed a new category name. */
  newCategoryName?: string;
  merchantDisplay?: string;
  normalizedMerchant?: string;
  note?: string;
  rawText: string;
  parseRoute: ParseRoute;
  parseConfidence?: number;
  /**
   * The `parse_event` row this candidate was parsed from, when there is one — a 4C-style
   * direct command write has none. Set by `TransactionParsingPipeline.persist` just
   * before recording, never by the validator: the id only exists once `parse_event` has
   * been written, which happens after validation succeeds. Carried through to
   * `Transaction` so a later `correct()` can attribute the fix back to it
   * (`LedgerCorrectionNotifier`, `core/ledger/collaborators.ts`).
   */
  parseEventId?: Id | null;
}

export interface Transaction {
  id: Id;
  userId: UserId;
  categoryId: Id | null;
  budgetPeriodId: Id | null;
  direction: TransactionDirection;
  amountMinorUnits: MinorUnits;
  currencyCode: CurrencyCode;
  occurredOn: LocalDate;
  occurredAt: Instant;
  merchantDisplay: string | null;
  normalizedMerchant: string | null;
  note: string | null;
  rawText: string | null;
  parseRoute: ParseRoute;
  parseConfidence: number | null;
  /** Null for anything not written from a parse (M7 stage 4D). */
  parseEventId: Id | null;
  status: TransactionStatus;
  createdAt: Instant;
  updatedAt: Instant;
  deletedAt: Instant | null;
}

export type TransactionPatch = Partial<
  Pick<
    Transaction,
    'categoryId' | 'direction' | 'amountMinorUnits' | 'occurredOn' | 'merchantDisplay' | 'note'
  >
>;

export interface PageRequest {
  cursor?: string;
  limit: number;
}

export interface Page<T> {
  items: readonly T[];
  nextCursor: string | null;
}

export interface LedgerService {
  record(userId: UserId, candidate: ValidatedCandidate): Promise<Transaction>;
  correct(userId: UserId, transactionId: Id, patch: TransactionPatch): Promise<Transaction>;
  softDelete(userId: UserId, transactionId: Id): Promise<void>;

  /** "The one I just typed" — picks by `created_at`, not `occurred_on`. */
  deleteLast(userId: UserId): Promise<Transaction | null>;

  history(userId: UserId, page: PageRequest): Promise<Page<Transaction>>;

  /**
   * Deferred this pass (round 5, Story 7). Signature kept so M7 has something to
   * stub `/export` against; streaming/CSV assembly is not built yet. When built it
   * must scope strictly to `userId` (flagged as a data-breach concern).
   */
  exportCsv(userId: UserId): Promise<ReadableStream>;

  /** Returns `expenses - refunds`, excluding `income` by construction. */
  spendInPeriod(userId: UserId, budgetPeriodId: Id, upTo?: LocalDate): Promise<MinorUnits>;
  /**
   * `expenses - refunds` on one user-local date, optionally narrowed to a single
   * category. The `categoryId` argument was added for M5 (Phase 3): `AllowanceView`
   * is per category, so `available_today` needs a per-category figure rather than the
   * user-wide one. Additive — existing callers are unaffected — and it keeps every
   * ledger read behind this module's `status = 'confirmed'` filter instead of M5
   * re-implementing it against `transaction`.
   */
  spentOn(userId: UserId, localDate: LocalDate, categoryId?: Id): Promise<MinorUnits>;
}
