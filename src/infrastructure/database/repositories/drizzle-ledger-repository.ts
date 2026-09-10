import { and, asc, desc, eq, max, sql } from 'drizzle-orm';
import type { Category } from '../../../core/ledger/category-service';
import {
  DuplicateCategoryNameError,
  type CategoryPatch,
  type HistoryCursor,
  type LedgerReads,
  type LedgerRepository,
  type LedgerWrites,
  type NewCategoryInput,
  type NewTransactionInput,
  type StoredTransactionPatch,
} from '../../../core/ledger/ledger-repository';
import type { ParseRoute, Transaction, TransactionDirection } from '../../../core/ledger/ledger-service';
import type { Id, Instant, LocalDate, MinorUnits, UserId } from '../../../core/shared/common';
import type { Database } from '../client';
import { category } from '../schema/category';
import { transaction } from '../schema/transaction';

/**
 * `LedgerRepository` over Drizzle/Postgres — the only M3 code that touches a DB handle.
 *
 * What lives here rather than in the service, and why:
 *   - **Category uniqueness** is `category_user_normalized_name_unique`. The service
 *     reads first for a friendlier message, but the constraint is what decides; a
 *     violation surfaces as `DuplicateCategoryNameError` so core never sees a
 *     Postgres error shape.
 *   - **Netting** (`expenses - refunds`, `income` excluded) is one SQL expression, so
 *     no caller can accidentally sum the wrong set. Every read filters
 *     `status = 'confirmed'`, matching the partial indexes.
 *   - **User scoping** is in every single predicate. M3's invariant is that no code
 *     path can return another user's rows; that is only true if it is true here.
 */

export type DatabaseExecutor = Database | Parameters<Parameters<Database['transaction']>[0]>[0];

const CATEGORY_NAME_CONSTRAINT = 'category_user_normalized_name_unique';

type CategoryRow = typeof category.$inferSelect;
type TransactionRow = typeof transaction.$inferSelect;

function toCategory(row: CategoryRow): Category {
  return {
    id: row.id,
    userId: row.userId,
    name: row.name,
    normalizedName: row.normalizedName,
    sortOrder: row.sortOrder,
    isArchived: row.isArchived,
    createdAt: row.createdAt.getTime(),
  };
}

function toTransaction(row: TransactionRow): Transaction {
  return {
    id: row.id,
    userId: row.userId,
    categoryId: row.categoryId,
    budgetPeriodId: row.budgetPeriodId,
    direction: row.direction as TransactionDirection,
    amountMinorUnits: row.amountMinorUnits,
    currencyCode: row.currencyCode,
    occurredOn: row.occurredOn,
    occurredAt: row.occurredAt.getTime(),
    merchantDisplay: row.merchantDisplay,
    normalizedMerchant: row.normalizedMerchant,
    note: row.note,
    rawText: row.rawText,
    parseRoute: row.parseRoute as ParseRoute,
    parseConfidence: row.parseConfidence === null ? null : Number(row.parseConfidence),
    status: row.status as Transaction['status'],
    createdAt: row.createdAt.getTime(),
    updatedAt: row.updatedAt.getTime(),
    deletedAt: row.deletedAt === null ? null : row.deletedAt.getTime(),
  };
}

/**
 * `expense` adds, `refund` subtracts, `income` contributes nothing. Written once, in
 * SQL, so `spendInPeriod` and `spentOn` cannot diverge — M5 reads both.
 */
const NET_SPEND = sql<string>`coalesce(sum(
  case ${transaction.direction}
    when 'expense' then ${transaction.amountMinorUnits}
    when 'refund' then -${transaction.amountMinorUnits}
    else 0
  end
), 0)::text`;

const CONFIRMED = eq(transaction.status, 'confirmed');

/**
 * Drizzle wraps a driver error and sets `message` to `Failed query: <sql>`, so the
 * constraint name is only reachable through the wrapped cause. The field it lives in
 * differs by driver — `postgres.js` (production, over Hyperdrive) calls it
 * `constraint_name`, PGlite (the integration suite) calls it `constraint` — so both
 * are read, at both levels. Matching on the message would see neither.
 */
function constraintNameOf(error: unknown): string | undefined {
  const candidates = [error, (error as { cause?: unknown }).cause];
  for (const candidate of candidates) {
    const named = candidate as { constraint_name?: string; constraint?: string } | undefined;
    const name = named?.constraint_name ?? named?.constraint;
    if (name !== undefined) return name;
  }
  return undefined;
}

function isDuplicateCategoryName(error: unknown): boolean {
  return constraintNameOf(error) === CATEGORY_NAME_CONSTRAINT;
}

function operations(x: DatabaseExecutor): LedgerReads & LedgerWrites {
  return {
    // ---- categories -------------------------------------------------------------

    async listCategories(userId: UserId, includeArchived: boolean): Promise<readonly Category[]> {
      const where = includeArchived
        ? eq(category.userId, userId)
        : and(eq(category.userId, userId), eq(category.isArchived, false));
      const rows = await x
        .select()
        .from(category)
        .where(where)
        .orderBy(asc(category.sortOrder), asc(category.name));
      return rows.map(toCategory);
    },

    async findCategory(userId: UserId, categoryId: Id): Promise<Category | null> {
      const [row] = await x
        .select()
        .from(category)
        .where(and(eq(category.userId, userId), eq(category.id, categoryId)))
        .limit(1);
      return row ? toCategory(row) : null;
    },

    async findCategoryByNormalizedName(userId: UserId, normalizedName: string): Promise<Category | null> {
      const [row] = await x
        .select()
        .from(category)
        .where(and(eq(category.userId, userId), eq(category.normalizedName, normalizedName)))
        .limit(1);
      return row ? toCategory(row) : null;
    },

    async countActiveCategories(userId: UserId): Promise<number> {
      const [row] = await x
        .select({ n: sql<number>`count(*)::int` })
        .from(category)
        .where(and(eq(category.userId, userId), eq(category.isArchived, false)));
      return row?.n ?? 0;
    },

    async maxCategorySortOrder(userId: UserId): Promise<number> {
      const [row] = await x
        .select({ highest: max(category.sortOrder) })
        .from(category)
        .where(eq(category.userId, userId));
      return row?.highest ?? -1;
    },

    async insertCategory(input: NewCategoryInput): Promise<Category> {
      try {
        const [row] = await x
          .insert(category)
          .values({
            userId: input.userId,
            name: input.name,
            normalizedName: input.normalizedName,
            sortOrder: input.sortOrder,
            createdAt: new Date(input.now),
          })
          .returning();
        if (!row) throw new Error('category insert returned no row');
        return toCategory(row);
      } catch (error) {
        if (isDuplicateCategoryName(error)) throw new DuplicateCategoryNameError(input.normalizedName);
        throw error;
      }
    },

    async updateCategory(userId: UserId, categoryId: Id, patch: CategoryPatch): Promise<Category | null> {
      const set: Partial<typeof category.$inferInsert> = {};
      if (patch.name !== undefined) set.name = patch.name;
      if (patch.normalizedName !== undefined) set.normalizedName = patch.normalizedName;
      if (patch.isArchived !== undefined) set.isArchived = patch.isArchived;
      if (Object.keys(set).length === 0) return operations(x).findCategory(userId, categoryId);
      try {
        const [row] = await x
          .update(category)
          .set(set)
          .where(and(eq(category.userId, userId), eq(category.id, categoryId)))
          .returning();
        return row ? toCategory(row) : null;
      } catch (error) {
        if (isDuplicateCategoryName(error)) {
          throw new DuplicateCategoryNameError(patch.normalizedName ?? '');
        }
        throw error;
      }
    },

    async hasTransactionInPeriod(
      userId: UserId,
      categoryId: Id,
      from: LocalDate,
      to: LocalDate,
    ): Promise<boolean> {
      const rows = await x
        .select({ id: transaction.id })
        .from(transaction)
        .where(
          and(
            eq(transaction.userId, userId),
            eq(transaction.categoryId, categoryId),
            CONFIRMED,
            sql`${transaction.occurredOn} between ${from} and ${to}`,
          ),
        )
        .limit(1);
      return rows.length > 0;
    },

    // ---- transactions -----------------------------------------------------------

    async findTransaction(userId: UserId, transactionId: Id): Promise<Transaction | null> {
      const [row] = await x
        .select()
        .from(transaction)
        .where(and(eq(transaction.userId, userId), eq(transaction.id, transactionId), CONFIRMED))
        .limit(1);
      return row ? toTransaction(row) : null;
    },

    async findLastTransaction(userId: UserId): Promise<Transaction | null> {
      const [row] = await x
        .select()
        .from(transaction)
        .where(and(eq(transaction.userId, userId), CONFIRMED))
        .orderBy(desc(transaction.createdAt), desc(transaction.id))
        .limit(1);
      return row ? toTransaction(row) : null;
    },

    async listTransactions(
      userId: UserId,
      limit: number,
      cursor: HistoryCursor | null,
    ): Promise<readonly Transaction[]> {
      // Row-value comparison over the same tuple the ordering uses — a keyset seek,
      // not an offset, so a page stays stable while older rows are added.
      const after =
        cursor === null
          ? undefined
          : sql`(${transaction.occurredOn}, ${transaction.createdAt}, ${transaction.id}) < (${cursor.occurredOn}::date, ${new Date(cursor.createdAt)}::timestamptz, ${cursor.id}::uuid)`;
      const rows = await x
        .select()
        .from(transaction)
        .where(and(eq(transaction.userId, userId), CONFIRMED, after))
        .orderBy(desc(transaction.occurredOn), desc(transaction.createdAt), desc(transaction.id))
        .limit(limit);
      return rows.map(toTransaction);
    },

    async sumInPeriod(userId: UserId, budgetPeriodId: Id, upTo: LocalDate | null): Promise<MinorUnits> {
      const [row] = await x
        .select({ net: NET_SPEND })
        .from(transaction)
        .where(
          and(
            eq(transaction.userId, userId),
            eq(transaction.budgetPeriodId, budgetPeriodId),
            CONFIRMED,
            upTo === null ? undefined : sql`${transaction.occurredOn} <= ${upTo}`,
          ),
        );
      return BigInt(row?.net ?? '0');
    },

    async sumOnLocalDate(userId: UserId, localDate: LocalDate): Promise<MinorUnits> {
      const [row] = await x
        .select({ net: NET_SPEND })
        .from(transaction)
        .where(and(eq(transaction.userId, userId), eq(transaction.occurredOn, localDate), CONFIRMED));
      return BigInt(row?.net ?? '0');
    },

    async insertTransaction(input: NewTransactionInput): Promise<Transaction> {
      const [row] = await x
        .insert(transaction)
        .values({
          userId: input.userId,
          categoryId: input.categoryId,
          budgetPeriodId: input.budgetPeriodId,
          direction: input.direction,
          amountMinorUnits: input.amountMinorUnits,
          currencyCode: input.currencyCode,
          occurredOn: input.occurredOn,
          occurredAt: new Date(input.occurredAt),
          merchantDisplay: input.merchantDisplay,
          normalizedMerchant: input.normalizedMerchant,
          note: input.note,
          rawText: input.rawText,
          parseRoute: input.parseRoute,
          parseConfidence: input.parseConfidence === null ? null : input.parseConfidence.toFixed(3),
          status: 'confirmed',
          createdAt: new Date(input.now),
          updatedAt: new Date(input.now),
        })
        .returning();
      if (!row) throw new Error('transaction insert returned no row');
      return toTransaction(row);
    },

    async updateTransaction(
      userId: UserId,
      transactionId: Id,
      patch: StoredTransactionPatch,
      now: Instant,
    ): Promise<Transaction | null> {
      const set: Partial<typeof transaction.$inferInsert> = { updatedAt: new Date(now) };
      if (patch.categoryId !== undefined) set.categoryId = patch.categoryId;
      if (patch.budgetPeriodId !== undefined) set.budgetPeriodId = patch.budgetPeriodId;
      if (patch.direction !== undefined) set.direction = patch.direction;
      if (patch.amountMinorUnits !== undefined) set.amountMinorUnits = patch.amountMinorUnits;
      if (patch.occurredOn !== undefined) set.occurredOn = patch.occurredOn;
      if (patch.occurredAt !== undefined) set.occurredAt = new Date(patch.occurredAt);
      if (patch.merchantDisplay !== undefined) set.merchantDisplay = patch.merchantDisplay;
      if (patch.note !== undefined) set.note = patch.note;

      const [row] = await x
        .update(transaction)
        .set(set)
        .where(and(eq(transaction.userId, userId), eq(transaction.id, transactionId), CONFIRMED))
        .returning();
      return row ? toTransaction(row) : null;
    },

    async markTransactionDeleted(userId: UserId, transactionId: Id, now: Instant): Promise<boolean> {
      const rows = await x
        .update(transaction)
        .set({ status: 'deleted', deletedAt: new Date(now), updatedAt: new Date(now) })
        .where(and(eq(transaction.userId, userId), eq(transaction.id, transactionId), CONFIRMED))
        .returning({ id: transaction.id });
      return rows.length === 1;
    },
  };
}

export class DrizzleLedgerRepository implements LedgerRepository<DatabaseExecutor> {
  private readonly root: LedgerReads & LedgerWrites;

  constructor(private readonly db: Database) {
    this.root = operations(db);
  }

  withExecutor(executor: DatabaseExecutor): LedgerReads & LedgerWrites {
    return operations(executor);
  }

  runInTransaction<T>(
    fn: (tx: LedgerReads & LedgerWrites & { executor: DatabaseExecutor }) => Promise<T>,
  ): Promise<T> {
    return this.db.transaction((handle) => fn({ ...operations(handle), executor: handle }));
  }

  listCategories(userId: UserId, includeArchived: boolean): Promise<readonly Category[]> {
    return this.root.listCategories(userId, includeArchived);
  }
  findCategory(userId: UserId, categoryId: Id): Promise<Category | null> {
    return this.root.findCategory(userId, categoryId);
  }
  findCategoryByNormalizedName(userId: UserId, normalizedName: string): Promise<Category | null> {
    return this.root.findCategoryByNormalizedName(userId, normalizedName);
  }
  countActiveCategories(userId: UserId): Promise<number> {
    return this.root.countActiveCategories(userId);
  }
  maxCategorySortOrder(userId: UserId): Promise<number> {
    return this.root.maxCategorySortOrder(userId);
  }
  hasTransactionInPeriod(userId: UserId, categoryId: Id, from: LocalDate, to: LocalDate): Promise<boolean> {
    return this.root.hasTransactionInPeriod(userId, categoryId, from, to);
  }
  findTransaction(userId: UserId, transactionId: Id): Promise<Transaction | null> {
    return this.root.findTransaction(userId, transactionId);
  }
  findLastTransaction(userId: UserId): Promise<Transaction | null> {
    return this.root.findLastTransaction(userId);
  }
  listTransactions(userId: UserId, limit: number, cursor: HistoryCursor | null): Promise<readonly Transaction[]> {
    return this.root.listTransactions(userId, limit, cursor);
  }
  sumInPeriod(userId: UserId, budgetPeriodId: Id, upTo: LocalDate | null): Promise<MinorUnits> {
    return this.root.sumInPeriod(userId, budgetPeriodId, upTo);
  }
  sumOnLocalDate(userId: UserId, localDate: LocalDate): Promise<MinorUnits> {
    return this.root.sumOnLocalDate(userId, localDate);
  }
  insertCategory(input: NewCategoryInput): Promise<Category> {
    return this.root.insertCategory(input);
  }
  updateCategory(userId: UserId, categoryId: Id, patch: CategoryPatch): Promise<Category | null> {
    return this.root.updateCategory(userId, categoryId, patch);
  }
  insertTransaction(input: NewTransactionInput): Promise<Transaction> {
    return this.root.insertTransaction(input);
  }
  updateTransaction(
    userId: UserId,
    transactionId: Id,
    patch: StoredTransactionPatch,
    now: Instant,
  ): Promise<Transaction | null> {
    return this.root.updateTransaction(userId, transactionId, patch, now);
  }
  markTransactionDeleted(userId: UserId, transactionId: Id, now: Instant): Promise<boolean> {
    return this.root.markTransactionDeleted(userId, transactionId, now);
  }

  /**
   * M3's half of M8's `CapacityReader` (master plan §2, rule 2: M8 never reads this
   * table itself — the owning module supplies the number). Takes the executor so the
   * count is read inside M8's gating transaction, which is what makes "count, then
   * insert" atomic.
   */
  readonly capacity = {
    countActiveCategories: (userId: UserId, executor: DatabaseExecutor): Promise<number> =>
      operations(executor).countActiveCategories(userId),
  };
}
