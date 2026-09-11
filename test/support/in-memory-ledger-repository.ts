import type {
  Category,
  CategoryPatch,
  HistoryCursor,
  LedgerReads,
  LedgerRepository,
  LedgerWrites,
  NewCategoryInput,
  NewTransactionInput,
  StoredTransactionPatch,
  Transaction,
} from '../../src/core/ledger';
import { DuplicateCategoryNameError } from '../../src/core/ledger';
import type { Id, Instant, LocalDate, MinorUnits, UserId } from '../../src/core/shared/common';
import { fakeId } from './fake-id';
import type { InMemoryStore } from './in-memory-store';

/**
 * `LedgerRepository` over an `InMemoryStore` — a test adapter (M3's plan, "Testing":
 * an in-memory repository does not prove Drizzle or Postgres works). It models only
 * what M3's business rules depend on:
 *
 *   - `unique (user_id, normalized_name)`, raised as `DuplicateCategoryNameError`;
 *   - netting: `expenses - refunds`, `income` excluded, confirmed rows only;
 *   - the `(occurred_on, created_at, id)` ordering `history` pages through;
 *   - rollback, via the shared store, so the atomicity test is real.
 *
 * Check constraints, partial indexes and genuine concurrency are the integration
 * suite's job.
 */
export class InMemoryLedgerRepository implements LedgerRepository<InMemoryStore> {
  constructor(private readonly store: InMemoryStore) {}

  withExecutor(executor: InMemoryStore): LedgerReads & LedgerWrites {
    return new InMemoryLedgerRepository(executor);
  }

  runInTransaction<T>(
    fn: (tx: LedgerReads & LedgerWrites & { executor: InMemoryStore }) => Promise<T>,
  ): Promise<T> {
    const store = this.store;
    return store.transaction(() =>
      fn(Object.assign(new InMemoryLedgerRepository(store), { executor: store })),
    );
  }

  // ---- categories -----------------------------------------------------------------

  async listCategories(userId: UserId, includeArchived: boolean): Promise<readonly Category[]> {
    return this.store.categories
      .filter((c) => c.userId === userId && (includeArchived || !c.isArchived))
      .sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name));
  }

  async findCategory(userId: UserId, categoryId: Id): Promise<Category | null> {
    return this.store.categories.find((c) => c.userId === userId && c.id === categoryId) ?? null;
  }

  async findCategoryByNormalizedName(userId: UserId, normalizedName: string): Promise<Category | null> {
    return (
      this.store.categories.find((c) => c.userId === userId && c.normalizedName === normalizedName) ?? null
    );
  }

  async countActiveCategories(userId: UserId): Promise<number> {
    return this.store.categories.filter((c) => c.userId === userId && !c.isArchived).length;
  }

  async maxCategorySortOrder(userId: UserId): Promise<number> {
    return this.store.categories
      .filter((c) => c.userId === userId)
      .reduce((highest, c) => Math.max(highest, c.sortOrder), -1);
  }

  async insertCategory(input: NewCategoryInput): Promise<Category> {
    if (this.store.categories.some((c) => c.userId === input.userId && c.normalizedName === input.normalizedName)) {
      throw new DuplicateCategoryNameError(input.normalizedName);
    }
    const row: Category = {
      id: fakeId('cat'),
      userId: input.userId,
      name: input.name,
      normalizedName: input.normalizedName,
      sortOrder: input.sortOrder,
      isArchived: false,
      createdAt: input.now,
    };
    this.store.categories.push(row);
    return row;
  }

  async updateCategory(userId: UserId, categoryId: Id, patch: CategoryPatch): Promise<Category | null> {
    const index = this.store.categories.findIndex((c) => c.userId === userId && c.id === categoryId);
    const existing = this.store.categories[index];
    if (!existing) return null;
    if (
      patch.normalizedName !== undefined &&
      this.store.categories.some(
        (c) => c.userId === userId && c.id !== categoryId && c.normalizedName === patch.normalizedName,
      )
    ) {
      throw new DuplicateCategoryNameError(patch.normalizedName);
    }
    const updated: Category = { ...existing, ...patch };
    this.store.categories[index] = updated;
    return updated;
  }

  async hasTransactionInPeriod(
    userId: UserId,
    categoryId: Id,
    from: LocalDate,
    to: LocalDate,
  ): Promise<boolean> {
    return this.confirmed(userId).some(
      (t) => t.categoryId === categoryId && t.occurredOn >= from && t.occurredOn <= to,
    );
  }

  // ---- transactions ---------------------------------------------------------------

  async findTransaction(userId: UserId, transactionId: Id): Promise<Transaction | null> {
    return this.confirmed(userId).find((t) => t.id === transactionId) ?? null;
  }

  async findLastTransaction(userId: UserId): Promise<Transaction | null> {
    return [...this.confirmed(userId)].sort((a, b) => b.createdAt - a.createdAt || cmp(b.id, a.id))[0] ?? null;
  }

  async listTransactions(
    userId: UserId,
    limit: number,
    cursor: HistoryCursor | null,
  ): Promise<readonly Transaction[]> {
    const ordered = [...this.confirmed(userId)].sort(
      (a, b) => cmp(b.occurredOn, a.occurredOn) || b.createdAt - a.createdAt || cmp(b.id, a.id),
    );
    const after = cursor === null ? ordered : ordered.filter((t) => isBefore(t, cursor));
    return after.slice(0, limit);
  }

  async sumInPeriod(userId: UserId, budgetPeriodId: Id, upTo: LocalDate | null): Promise<MinorUnits> {
    return net(
      this.confirmed(userId).filter(
        (t) => t.budgetPeriodId === budgetPeriodId && (upTo === null || t.occurredOn <= upTo),
      ),
    );
  }

  async sumOnLocalDate(
    userId: UserId,
    localDate: LocalDate,
    categoryId?: Id,
  ): Promise<MinorUnits> {
    return net(
      this.confirmed(userId).filter(
        (t) => t.occurredOn === localDate && (categoryId === undefined || t.categoryId === categoryId),
      ),
    );
  }

  async insertTransaction(input: NewTransactionInput): Promise<Transaction> {
    const row: Transaction = {
      id: fakeId('tx'),
      userId: input.userId,
      categoryId: input.categoryId,
      budgetPeriodId: input.budgetPeriodId,
      direction: input.direction,
      amountMinorUnits: input.amountMinorUnits,
      currencyCode: input.currencyCode,
      occurredOn: input.occurredOn,
      occurredAt: input.occurredAt,
      merchantDisplay: input.merchantDisplay,
      normalizedMerchant: input.normalizedMerchant,
      note: input.note,
      rawText: input.rawText,
      parseRoute: input.parseRoute,
      parseConfidence: input.parseConfidence,
      status: 'confirmed',
      createdAt: input.now,
      updatedAt: input.now,
      deletedAt: null,
    };
    this.store.transactions.push(row);
    return row;
  }

  async updateTransaction(
    userId: UserId,
    transactionId: Id,
    patch: StoredTransactionPatch,
    now: Instant,
  ): Promise<Transaction | null> {
    const index = this.store.transactions.findIndex(
      (t) => t.userId === userId && t.id === transactionId && t.status === 'confirmed',
    );
    const existing = this.store.transactions[index];
    if (!existing) return null;
    const updated: Transaction = { ...existing, ...patch, updatedAt: now };
    this.store.transactions[index] = updated;
    return updated;
  }

  async markTransactionDeleted(userId: UserId, transactionId: Id, now: Instant): Promise<boolean> {
    const index = this.store.transactions.findIndex(
      (t) => t.userId === userId && t.id === transactionId && t.status === 'confirmed',
    );
    const existing = this.store.transactions[index];
    if (!existing) return false;
    this.store.transactions[index] = { ...existing, status: 'deleted', deletedAt: now, updatedAt: now };
    return true;
  }

  /** Every read is user-scoped here for the same reason it is in SQL — M3's invariant. */
  private confirmed(userId: UserId): readonly Transaction[] {
    return this.store.transactions.filter((t) => t.userId === userId && t.status === 'confirmed');
  }
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** The `(occurred_on, created_at, id) < cursor` row comparison, in JavaScript. */
function isBefore(row: Transaction, cursor: HistoryCursor): boolean {
  if (row.occurredOn !== cursor.occurredOn) return row.occurredOn < cursor.occurredOn;
  if (row.createdAt !== cursor.createdAt) return row.createdAt < cursor.createdAt;
  return row.id < cursor.id;
}

/** `expenses - refunds`; `income` contributes nothing, by construction. */
function net(rows: readonly Transaction[]): MinorUnits {
  return rows.reduce((total, t) => {
    if (t.direction === 'expense') return total + t.amountMinorUnits;
    if (t.direction === 'refund') return total - t.amountMinorUnits;
    return total;
  }, 0n);
}
