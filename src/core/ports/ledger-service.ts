import type { CurrencyCode, Id, Instant, LocalDate, MinorUnits, UserId } from './common';

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
}

/**
 * A `category` row (M3's SQL). Added by M2 (Phase 1) alongside `createCategory` —
 * onboarding step 4 hands categories off to M3 and needs the id back. Only the shape
 * M2 relies on (`id`, `name`) is load-bearing; M3 may refine the rest.
 */
export interface Category {
  id: Id;
  userId: UserId;
  name: string;
  normalizedName: string;
  sortOrder: number;
  isArchived: boolean;
  createdAt: Instant;
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
  /**
   * **Added to M3's contract by M2 (Phase 1) — see build-log, M2 "Open questions".**
   * Onboarding step 4 ("fill in categories + caps") hands each draft category to M3;
   * the original interface had no category-creation method (`record` only creates one
   * as a side effect of a transaction). M3 owns the body: normalise the name, enforce
   * `unique (user_id, normalized_name)`, and check capacity with M8 (M3 checklist
   * step 5) — M2 also calls `assertAllowed` before this, but M3's check is the
   * atomic one.
   */
  createCategory(userId: UserId, name: string): Promise<Category>;

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
  spentOn(userId: UserId, localDate: LocalDate): Promise<MinorUnits>;
}
