import type { CurrencyCode, Id, Instant, LocalDate, MinorUnits, UserId } from '../shared/common';
import type { Category } from './category-service';
import type { ParseRoute, Transaction, TransactionDirection } from './ledger-service';

/**
 * The outgoing port for M3 — the persistence seam for both tables the module owns,
 * `category` and `transaction`. `DefaultLedgerService` and `DefaultCategoryService`
 * talk to this interface only; `DrizzleLedgerRepository` is the one place that sees a
 * DB handle (M1 §4 / master plan §6 rule 3), and
 * `test/support/in-memory-ledger-repository.ts` mirrors the same constraints so the
 * business rules are unit-testable without Postgres.
 *
 * Method names describe business persistence requirements, not table operations
 * (CLAUDE.md, "Repository interfaces"): `hasTransactionInPeriod` is the archive gate's
 * question, not a generic `count(*)`.
 *
 * `X` is the *executor* type, matching M8's `CapacityReader<X>`: a Drizzle transaction
 * handle in production, a test "world" in memory. It is how a category insert runs
 * inside M8's capacity transaction, and how a ledger insert runs inside the same
 * transaction as M4's period materialisation — without either module learning what
 * Drizzle is (CLAUDE.md, "Transactions").
 */

export interface NewCategoryInput {
  userId: UserId;
  name: string;
  normalizedName: string;
  sortOrder: number;
  now: Instant;
}

export type CategoryPatch = Partial<Pick<Category, 'name' | 'normalizedName' | 'isArchived'>>;

export interface NewTransactionInput {
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
  parseEventId: Id | null;
  now: Instant;
}

export type StoredTransactionPatch = Partial<
  Pick<
    Transaction,
    | 'categoryId'
    | 'budgetPeriodId'
    | 'direction'
    | 'amountMinorUnits'
    | 'occurredOn'
    | 'occurredAt'
    | 'merchantDisplay'
    | 'note'
  >
>;

/**
 * An opaque keyset position in the history listing. M3 builds and reads it; nothing
 * outside this module interprets its contents.
 */
export interface HistoryCursor {
  occurredOn: LocalDate;
  createdAt: Instant;
  id: Id;
}

export interface LedgerReads {
  listCategories(userId: UserId, includeArchived: boolean): Promise<readonly Category[]>;
  findCategory(userId: UserId, categoryId: Id): Promise<Category | null>;
  findCategoryByNormalizedName(userId: UserId, normalizedName: string): Promise<Category | null>;
  /** Non-archived only — the number M8's capacity check compares against the limit. */
  countActiveCategories(userId: UserId): Promise<number>;
  /** The highest existing `sort_order` for the user, or -1 when they have none. */
  maxCategorySortOrder(userId: UserId): Promise<number>;

  /**
   * The archive gate (master plan §5.1): does any confirmed transaction for this
   * category fall inside `[from, to]`? A boolean, not a count — the rule is "any".
   */
  hasTransactionInPeriod(userId: UserId, categoryId: Id, from: LocalDate, to: LocalDate): Promise<boolean>;

  findTransaction(userId: UserId, transactionId: Id): Promise<Transaction | null>;
  /** Most recent by `created_at` — "the one I just typed", not the latest `occurred_on`. */
  findLastTransaction(userId: UserId): Promise<Transaction | null>;
  /** Confirmed rows, newest `occurred_on` first, strictly after `cursor`. */
  listTransactions(userId: UserId, limit: number, cursor: HistoryCursor | null): Promise<readonly Transaction[]>;

  /** `expenses - refunds`, `income` excluded, `status = 'confirmed'` only. */
  sumInPeriod(userId: UserId, budgetPeriodId: Id, upTo: LocalDate | null): Promise<MinorUnits>;
  sumOnLocalDate(userId: UserId, localDate: LocalDate, categoryId?: Id): Promise<MinorUnits>;
}

export interface LedgerWrites {
  /** Rejects a duplicate `normalized_name` at the database, never by reading first. */
  insertCategory(input: NewCategoryInput): Promise<Category>;
  updateCategory(userId: UserId, categoryId: Id, patch: CategoryPatch): Promise<Category | null>;

  insertTransaction(input: NewTransactionInput): Promise<Transaction>;
  updateTransaction(
    userId: UserId,
    transactionId: Id,
    patch: StoredTransactionPatch,
    now: Instant,
  ): Promise<Transaction | null>;
  /**
   * Soft delete: `status = 'deleted'`, `deleted_at` stamped, the row kept forever
   * (M3 open decisions — retention is M9's to revisit). False when there was no
   * confirmed row to delete.
   */
  markTransactionDeleted(userId: UserId, transactionId: Id, now: Instant): Promise<boolean>;
}

/** Raised when `insertCategory`/`updateCategory` trips `unique (user_id, normalized_name)`. */
export class DuplicateCategoryNameError extends Error {
  override readonly name = 'DuplicateCategoryNameError';
  constructor(readonly normalizedName: string) {
    super(`category name already in use: ${normalizedName}`);
  }
}

export interface LedgerRepository<X> extends LedgerReads, LedgerWrites {
  /** The same operations bound to a caller's transaction handle. */
  withExecutor(executor: X): LedgerReads & LedgerWrites;

  /**
   * Opens a transaction M3 owns, exposing its executor so M4 can materialise a period
   * inside it. This is what makes M3's `record` atomic across steps b–d: a ledger row
   * that no period owns is never visible to a budget query.
   */
  runInTransaction<T>(fn: (tx: LedgerReads & LedgerWrites & { executor: X }) => Promise<T>): Promise<T>;
}
