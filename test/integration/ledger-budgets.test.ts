import { PGlite } from '@electric-sql/pglite';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pglite';
import { beforeAll, afterAll, beforeEach, describe, expect, it } from 'vitest';
import { DefaultBudgetService } from '../../src/core/budgets';
import {
  DefaultCategoryService,
  DefaultLedgerService,
  DuplicateCategoryNameError,
  type CategoryCapacityGate,
} from '../../src/core/ledger';
import type { GatedAction } from '../../src/core/entitlements';
import type { UserId } from '../../src/core/shared/common';
import {
  DrizzleBudgetRepository,
  type DatabaseExecutor,
} from '../../src/infrastructure/database/repositories/drizzle-budget-repository';
import { DrizzleLedgerRepository } from '../../src/infrastructure/database/repositories/drizzle-ledger-repository';
import type { Database } from '../../src/infrastructure/database/client';
import { applyMigrations } from '../support/pglite-migrations';
import { TestClock } from '../support/test-clock';

/**
 * M3 + M4 against a real Postgres. The unit suites use in-memory repositories, which
 * prove the *business rules*; they cannot prove that Drizzle emits the right SQL or
 * that the constraints exist. That is what this file is for (M3/M4 plans, "Testing"):
 * unique and check constraints, `on delete cascade` / `set null`, the netting
 * expression, and keyset pagination — all against the schema production actually runs.
 *
 * Runs in-process on PGlite (real Postgres, WASM), so it needs no Neon branch and no
 * `DATABASE_URL` — same approach as `parse-event-fk.test.ts`. The schema is built by
 * applying the **committed migrations in journal order**, not a hand-copied DDL
 * block, so this suite cannot drift away from what a deploy applies.
 *
 * What PGlite cannot show is genuine parallelism: it is a single connection, so the
 * `ensurePeriod` race is exercised here as the conflict *path* plus the constraint
 * that makes the race safe, rather than as two real concurrent writers.
 */

const CLOCK = '2026-09-10T02:00:00Z'; // 12:00 in Sydney
const SETTINGS = {
  timezone: 'Australia/Sydney',
  currencyCode: 'AUD',
  periodAnchorDate: '2026-01-05' as string | null,
  accountCreatedOn: '2026-01-05',
};

/** M8's gate reduced to "run the write on this executor" — capacity itself is M8's suite. */
class PassThroughGate implements CategoryCapacityGate<DatabaseExecutor> {
  constructor(private readonly db: Database) {}
  gate<T>(_userId: UserId, _action: GatedAction, write: (executor: DatabaseExecutor) => Promise<T>): Promise<T> {
    return this.db.transaction((handle) => write(handle));
  }
}

/**
 * The constraint a failing statement tripped, or undefined if it succeeded.
 *
 * Not `rejects.toThrow(/name/)`: Drizzle sets `message` to `Failed query: <sql>`, and
 * the constraint name lives on the driver error it carries. PGlite exposes it as
 * `constraint`, `postgres.js` as `constraint_name` — read both, at both levels.
 * Reading the field also pins the *exact* constraint, so a statement failing for an
 * unrelated reason cannot accidentally satisfy the assertion.
 */
async function constraintViolatedBy(run: Promise<unknown>): Promise<string | undefined> {
  try {
    await run;
    return undefined;
  } catch (error) {
    for (const candidate of [error, (error as { cause?: unknown }).cause]) {
      const named = candidate as { constraint_name?: string; constraint?: string } | undefined;
      const name = named?.constraint_name ?? named?.constraint;
      if (name !== undefined) return name;
    }
    return undefined;
  }
}

describe('M3 + M4 over Drizzle against real Postgres (PGlite)', () => {
  const pg = new PGlite();
  const db = drizzle(pg) as unknown as Database;
  const clock = new TestClock(CLOCK);
  const settingsOf = async () => SETTINGS;

  const ledgerRepository = new DrizzleLedgerRepository(db);
  const budgetRepository = new DrizzleBudgetRepository(db);
  const budgets = new DefaultBudgetService({ repository: budgetRepository, settingsOf, clock });
  const categories = new DefaultCategoryService({
    repository: ledgerRepository,
    entitlements: new PassThroughGate(db),
    budgets,
    settingsOf,
    clock,
  });
  const ledger = new DefaultLedgerService({
    repository: ledgerRepository,
    periods: budgets,
    settingsOf,
    clock,
  });

  let userId: string;
  let otherUserId: string;

  beforeAll(async () => {
    await applyMigrations(pg);
  }, 60_000);

  afterAll(async () => {
    await pg.close();
  });

  beforeEach(async () => {
    clock.set(CLOCK);
    await pg.exec('delete from app_user');
    const rows = await db.execute(
      sql`insert into app_user (timezone, created_at) values ('Australia/Sydney', '2026-01-05T00:00:00Z'), ('Australia/Sydney', '2026-01-05T00:00:00Z') returning id`,
    );
    const ids = (rows as unknown as { rows: { id: string }[] }).rows;
    userId = ids[0]?.id as string;
    otherUserId = ids[1]?.id as string;
  });

  async function budgeted(name: string, cap = 60_000n) {
    const category = await categories.create(userId, name);
    const budget = await budgets.setCap(userId, category.id, cap);
    return { category, budget };
  }

  // ---- constraints -----------------------------------------------------------------

  it('enforces one category name per user, across archived rows too', async () => {
    const food = await categories.create(userId, 'Food');
    await categories.archive(userId, food.id);

    // The service's friendly path.
    await expect(categories.create(userId, 'FOOD')).rejects.toThrow(/restore that one/);

    // And the constraint underneath it, which is what actually decides — asserted at
    // the SQL level, because the repository converts this one into a typed error.
    expect(
      await constraintViolatedBy(
        pg.query(`insert into category (user_id, name, normalized_name) values ($1, 'Food', 'food')`, [
          userId,
        ]),
      ),
    ).toBe('category_user_normalized_name_unique');
  });

  it('surfaces a raw duplicate insert as DuplicateCategoryNameError, not a Postgres error', async () => {
    await categories.create(userId, 'Food');
    await expect(
      ledgerRepository.insertCategory({
        userId,
        name: 'Food',
        normalizedName: 'food',
        sortOrder: 1,
        now: clock.now(),
      }),
    ).rejects.toBeInstanceOf(DuplicateCategoryNameError);
  });

  it('scopes the name constraint per user — two people may both have "Food"', async () => {
    await categories.create(userId, 'Food');
    await expect(categories.create(otherUserId, 'Food')).resolves.toMatchObject({ name: 'Food' });
  });

  it('rejects a non-positive amount, an unknown direction, route and status at the database', async () => {
    const { category } = await budgeted('Food');
    const insert = (columns: string, values: string) =>
      pg.query(
        `insert into "transaction" (user_id, category_id, direction, amount_minor_units, currency_code, occurred_on, occurred_at, parse_route${columns})
         values ($1, $2, ${values})`,
        [userId, category.id],
      );

    expect(
      await constraintViolatedBy(insert('', `'expense', 0, 'AUD', '2026-09-10', now(), 'mechanical'`)),
    ).toBe('transaction_amount_positive');
    expect(
      await constraintViolatedBy(insert('', `'spend', 100, 'AUD', '2026-09-10', now(), 'mechanical'`)),
    ).toBe('transaction_direction_check');
    expect(
      await constraintViolatedBy(insert('', `'expense', 100, 'AUD', '2026-09-10', now(), 'vibes'`)),
    ).toBe('transaction_parse_route_check');
    expect(
      await constraintViolatedBy(
        insert(', status', `'expense', 100, 'AUD', '2026-09-10', now(), 'mechanical', 'maybe'`),
      ),
    ).toBe('transaction_status_check');
  });

  it('rejects a non-positive cap and an inverted period range', async () => {
    const { category, budget } = await budgeted('Food');
    expect(
      await constraintViolatedBy(
        pg.query(
          `insert into category_period_cap (user_id, category_id, period_key, cap_minor_units, currency_code) values ($1, $2, '2026-10', 0, 'AUD')`,
          [userId, category.id],
        ),
      ),
    ).toBe('category_period_cap_positive');

    expect(
      await constraintViolatedBy(
        pg.query(
          `insert into budget_period (user_id, budget_id, period_key, period_start, period_end)
           values ($1, $2, '2026-09', '2026-10-04', '2026-09-05')`,
          [userId, budget.id],
        ),
      ),
    ).toBe('budget_period_range');
  });

  it('keeps one governing row per category per cycle (the unique constraint behind the upsert)', async () => {
    const { category } = await budgeted('Food');
    expect(
      await constraintViolatedBy(
        pg.query(
          `insert into category_period_cap (user_id, category_id, period_key, cap_minor_units, currency_code) values ($1, $2, '2026-09', 500, 'AUD')`,
          [userId, category.id],
        ),
      ),
    ).toBe('category_period_cap_category_key_unique');

    // The service path lands on `on conflict do update`, not the error.
    await budgets.setCap(userId, category.id, 70_000n);
    const rows = await db.execute(
      sql`select cap_minor_units::text as cap from category_period_cap where category_id = ${category.id}`,
    );
    expect((rows as unknown as { rows: { cap: string }[] }).rows).toEqual([{ cap: '70000' }]);
  });

  it('keeps at most one active budget per category (the partial unique index)', async () => {
    const { category, budget } = await budgeted('Food');
    expect(
      await constraintViolatedBy(
        pg.query(
          `insert into budget (user_id, category_id) values ($1, $2)`,
          [userId, category.id],
        ),
      ),
    ).toBe('budget_one_active_per_category');

    // Deactivating frees the slot — the index only covers `is_active` rows.
    await budgets.deactivate(userId, budget.id);
    await budgets.setCap(userId, category.id, 30_000n);
    expect((await budgets.currentBudgets(userId, '2026-09-10')).map((v) => v.capMinorUnits)).toEqual([30_000n]);
  });

  // ---- lazy materialisation --------------------------------------------------------

  it('materialises a period once and returns the same row through the conflict path', async () => {
    const { budget } = await budgeted('Food');
    const first = await budgets.ensurePeriod(userId, budget.id, '2026-09-10');

    // Straight at the repository, bypassing the service's read-first shortcut, so the
    // `on conflict (budget_id, period_key) do nothing` + re-select branch is the one
    // under test — that is what makes two concurrent writers safe.
    const second = await budgetRepository.materialisePeriod({
      userId,
      budgetId: budget.id,
      periodKey: '2026-09',
      periodStart: '2026-09-05',
      periodEnd: '2026-10-04',
      now: clock.now(),
    });

    expect(second.id).toBe(first.id);
    const count = await db.execute(sql`select count(*)::int as n from budget_period`);
    expect((count as unknown as { rows: { n: number }[] }).rows[0]?.n).toBe(1);
  });

  it('pins the unique constraint that makes the race safe', async () => {
    const { budget } = await budgeted('Food');
    await budgets.ensurePeriod(userId, budget.id, '2026-09-10');
    expect(
      await constraintViolatedBy(
        pg.query(
          `insert into budget_period (user_id, budget_id, period_key, period_start, period_end)
           values ($1, $2, '2026-09', '2026-09-05', '2026-10-04')`,
          [userId, budget.id],
        ),
      ),
    ).toBe('budget_period_budget_key_unique');
  });

  // ---- the cap history --------------------------------------------------------------

  it('resolves each cycle"s cap from the greatest key at or before it — the real query', async () => {
    clock.set('2026-07-15T02:00:00Z');
    const { category, budget } = await budgeted('Food', 100_000n); // July: 1000
    clock.set(CLOCK);
    await budgets.setCap(userId, category.id, 120_000n); // September: 1200; August untouched

    // August, opened late by a backdated expense, gets July's cap — not September's.
    expect((await budgets.ensurePeriod(userId, budget.id, '2026-08-20')).capMinorUnits).toBe(100_000n);
    expect((await budgets.ensurePeriod(userId, budget.id, '2026-09-10')).capMinorUnits).toBe(120_000n);
    expect((await budgets.ensurePeriod(userId, budget.id, '2026-11-10')).capMinorUnits).toBe(120_000n);
    // And before any row existed, there is nothing to divide by.
    await expect(budgets.ensurePeriod(userId, budget.id, '2026-06-10')).rejects.toMatchObject({
      code: 'RESOURCE_NOT_FOUND',
    });

    expect(await budgetRepository.findGoverningCap(userId, category.id, '2026-08')).toMatchObject({
      periodKey: '2026-07',
      capMinorUnits: 100_000n,
    });
  });

  it('finds every category"s governing row in one distinct-on query', async () => {
    clock.set('2026-07-15T02:00:00Z');
    const food = await budgeted('Food', 100_000n);
    clock.set(CLOCK);
    const fun = await budgeted('Fun', 25_000n); // September only
    await budgets.setCap(userId, food.category.id, 120_000n); // Food now has July and September rows

    const september = await budgetRepository.findGoverningCaps(userId, '2026-09');
    expect(
      september.map((c) => [c.categoryId, c.periodKey, c.capMinorUnits]).sort(),
    ).toEqual(
      [
        [food.category.id, '2026-09', 120_000n],
        [fun.category.id, '2026-09', 25_000n],
      ].sort(),
    );
    // In August only Food existed, governed by July's row.
    expect(await budgetRepository.findGoverningCaps(userId, '2026-08')).toMatchObject([
      { categoryId: food.category.id, periodKey: '2026-07', capMinorUnits: 100_000n },
    ]);
    expect(await budgetRepository.findGoverningCaps(otherUserId, '2026-09')).toEqual([]);
  });

  it('a removal writes a null row that stops the last cap carrying forward', async () => {
    const { category, budget } = await budgeted('Food');
    await budgets.deactivate(userId, budget.id);

    expect(await budgetRepository.findGoverningCap(userId, category.id, '2026-12')).toMatchObject({
      periodKey: '2026-09',
      capMinorUnits: null,
    });
    expect(await budgets.currentBudgets(userId, '2026-09-10')).toEqual([]);
  });

  // ---- recording -------------------------------------------------------------------

  it('records a transaction and its period in one round trip, with exact minor units', async () => {
    const { category, budget } = await budgeted('Food');
    const tx = await ledger.record(userId, {
      direction: 'expense',
      amountMinorUnits: 8240n,
      currencyCode: 'AUD',
      occurredAt: Date.parse('2026-09-10T02:00:00Z'),
      occurredOn: '2026-09-10',
      categoryId: category.id,
      merchantDisplay: 'Woolworths',
      normalizedMerchant: 'woolies',
      rawText: 'woolies 82.40',
      parseRoute: 'mechanical',
      parseConfidence: 0.93,
    });

    expect(tx).toMatchObject({
      amountMinorUnits: 8240n, // bigint all the way down, never a float
      currencyCode: 'AUD',
      occurredOn: '2026-09-10',
      merchantDisplay: 'Woolworths',
      parseConfidence: 0.93,
      status: 'confirmed',
    });
    const period = await budgetRepository.findPeriod(userId, budget.id, '2026-09');
    expect(tx.budgetPeriodId).toBe(period?.id);
  });

  it('nets refunds out and ignores income in SQL, not in the caller', async () => {
    const { category } = await budgeted('Food');
    const base = {
      currencyCode: 'AUD',
      occurredAt: Date.parse('2026-09-10T02:00:00Z'),
      occurredOn: '2026-09-10',
      categoryId: category.id,
      rawText: 'x',
      parseRoute: 'command' as const,
    };
    const expense = await ledger.record(userId, { ...base, direction: 'expense', amountMinorUnits: 10_000n });
    await ledger.record(userId, { ...base, direction: 'refund', amountMinorUnits: 2_500n });
    await ledger.record(userId, { ...base, direction: 'income', amountMinorUnits: 500_000n });

    expect(await ledger.spendInPeriod(userId, expense.budgetPeriodId as string)).toBe(7_500n);
    expect(await ledger.spentOn(userId, '2026-09-10')).toBe(7_500n);
    expect(await ledger.spentOn(otherUserId, '2026-09-10')).toBe(0n);
  });

  it('narrows spentOn to one category when asked, keeping the netting and the filters', async () => {
    // Added for M5 (Phase 3): `available_today` is per category, so the day's spend has
    // to be too. The netting, the income exclusion and the confirmed-only filter must
    // all still apply once a category predicate joins them.
    const food = await budgeted('Food');
    const fun = await budgeted('Fun');
    const base = {
      currencyCode: 'AUD',
      occurredAt: Date.parse('2026-09-10T02:00:00Z'),
      occurredOn: '2026-09-10',
      rawText: 'x',
      parseRoute: 'command' as const,
    };
    await ledger.record(userId, {
      ...base,
      categoryId: food.category.id,
      direction: 'expense',
      amountMinorUnits: 10_000n,
    });
    await ledger.record(userId, {
      ...base,
      categoryId: food.category.id,
      direction: 'refund',
      amountMinorUnits: 2_500n,
    });
    await ledger.record(userId, {
      ...base,
      categoryId: food.category.id,
      direction: 'income',
      amountMinorUnits: 500_000n,
    });
    await ledger.record(userId, {
      ...base,
      categoryId: fun.category.id,
      direction: 'expense',
      amountMinorUnits: 4_000n,
    });

    expect(await ledger.spentOn(userId, '2026-09-10', food.category.id)).toBe(7_500n);
    expect(await ledger.spentOn(userId, '2026-09-10', fun.category.id)).toBe(4_000n);
    // Omitting the category still returns the user-wide total, so existing callers are
    // genuinely unaffected by the widening.
    expect(await ledger.spentOn(userId, '2026-09-10')).toBe(11_500n);
    // A category with nothing logged is 0, never null.
    expect(await ledger.spentOn(userId, '2026-09-11', food.category.id)).toBe(0n);
  });

  it('excludes soft-deleted rows from every read behind budget maths', async () => {
    const { category } = await budgeted('Food');
    const base = {
      currencyCode: 'AUD',
      occurredAt: Date.parse('2026-09-10T02:00:00Z'),
      occurredOn: '2026-09-10',
      categoryId: category.id,
      rawText: 'x',
      parseRoute: 'command' as const,
      direction: 'expense' as const,
    };
    const kept = await ledger.record(userId, { ...base, amountMinorUnits: 3_000n });
    const removed = await ledger.record(userId, { ...base, amountMinorUnits: 4_000n });
    await ledger.softDelete(userId, removed.id);

    expect(await ledger.spendInPeriod(userId, kept.budgetPeriodId as string)).toBe(3_000n);
    expect((await ledger.history(userId, { limit: 10 })).items.map((t) => t.id)).toEqual([kept.id]);
    // The row is kept, not deleted — retention is M9's call, not a limit workaround.
    const rows = await db.execute(sql`select count(*)::int as n from "transaction"`);
    expect((rows as unknown as { rows: { n: number }[] }).rows[0]?.n).toBe(2);
  });

  it('pages history newest-first and never crosses users', async () => {
    const { category } = await budgeted('Food');
    const dates = ['2026-09-06', '2026-09-07', '2026-09-08'];
    for (const occurredOn of dates) {
      clock.advance(60_000);
      await ledger.record(userId, {
        direction: 'expense',
        amountMinorUnits: 100n,
        currencyCode: 'AUD',
        occurredAt: Date.parse(`${occurredOn}T02:00:00Z`),
        occurredOn,
        categoryId: category.id,
        rawText: occurredOn,
        parseRoute: 'command',
      });
    }

    const first = await ledger.history(userId, { limit: 2 });
    expect(first.items.map((t) => t.occurredOn)).toEqual(['2026-09-08', '2026-09-07']);
    const second = await ledger.history(userId, { limit: 2, cursor: first.nextCursor as string });
    expect(second.items.map((t) => t.occurredOn)).toEqual(['2026-09-06']);
    expect(second.nextCursor).toBeNull();

    expect(await ledger.history(otherUserId, { limit: 10 })).toEqual({ items: [], nextCursor: null });
  });

  // ---- the archive gate ------------------------------------------------------------

  it('blocks an archive with a transaction this cycle and allows one with only older history', async () => {
    const { category } = await budgeted('Food');
    clock.set('2026-08-20T02:00:00Z');
    await ledger.record(userId, {
      direction: 'expense',
      amountMinorUnits: 500n,
      currencyCode: 'AUD',
      occurredAt: Date.parse('2026-08-20T02:00:00Z'),
      occurredOn: '2026-08-20',
      categoryId: category.id,
      rawText: 'august',
      parseRoute: 'command',
    });
    clock.set(CLOCK);

    // Only earlier-cycle history: the slot frees immediately.
    await expect(categories.archive(userId, category.id)).resolves.toBeUndefined();
    expect(await categories.countActive(userId)).toBe(0);

    // Now with something logged inside the current cycle.
    const transport = await categories.create(userId, 'Transport');
    await budgets.setCap(userId, transport.id, 20_000n);
    await ledger.record(userId, {
      direction: 'expense',
      amountMinorUnits: 500n,
      currencyCode: 'AUD',
      occurredAt: Date.parse('2026-09-10T02:00:00Z'),
      occurredOn: '2026-09-10',
      categoryId: transport.id,
      rawText: 'september',
      parseRoute: 'command',
    });
    await expect(categories.archive(userId, transport.id)).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    expect(await categories.countActive(userId)).toBe(1);
  });

  // ---- referential behaviour -------------------------------------------------------

  it('cascades every M3/M4 row away with the account', async () => {
    const { category, budget } = await budgeted('Food');
    await ledger.record(userId, {
      direction: 'expense',
      amountMinorUnits: 100n,
      currencyCode: 'AUD',
      occurredAt: Date.parse('2026-09-10T02:00:00Z'),
      occurredOn: '2026-09-10',
      categoryId: category.id,
      rawText: 'x',
      parseRoute: 'command',
    });
    await budgets.ensurePeriod(userId, budget.id, '2026-09-10');

    await db.execute(sql`delete from app_user where id = ${userId}`);

    for (const table of ['category', 'budget', 'budget_period', 'category_period_cap', '"transaction"']) {
      const rows = await db.execute(sql.raw(`select count(*)::int as n from ${table}`));
      expect((rows as unknown as { rows: { n: number }[] }).rows[0]?.n).toBe(0);
    }
  });

  it('nulls a transaction"s references rather than deleting financial history', async () => {
    const { category, budget } = await budgeted('Food');
    const tx = await ledger.record(userId, {
      direction: 'expense',
      amountMinorUnits: 100n,
      currencyCode: 'AUD',
      occurredAt: Date.parse('2026-09-10T02:00:00Z'),
      occurredOn: '2026-09-10',
      categoryId: category.id,
      rawText: 'x',
      parseRoute: 'command',
    });

    // `budget_period` cascades from `budget`; the transaction survives with a null.
    await db.execute(sql`delete from budget where id = ${budget.id}`);
    await db.execute(sql`delete from category where id = ${category.id}`);

    const survivor = await ledgerRepository.findTransaction(userId, tx.id);
    expect(survivor).toMatchObject({ id: tx.id, categoryId: null, budgetPeriodId: null, amountMinorUnits: 100n });
  });
});
