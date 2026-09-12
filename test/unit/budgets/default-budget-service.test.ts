import { beforeEach, describe, expect, it } from 'vitest';
import { DefaultBudgetService, type BudgetUserSettings } from '../../../src/core/budgets';
import { InMemoryBudgetRepository } from '../../support/in-memory-budget-repository';
import { InMemoryStore } from '../../support/in-memory-store';
import { TestClock } from '../../support/test-clock';

/**
 * M4's "Tests to write", minus the ones that need a real database (the concurrent
 * `ensurePeriod` race is in `test/integration/ledger-budgets.test.ts`, where the
 * unique constraint is actually doing the work).
 */

const USER = 'user-1';
const GROCERIES = 'cat-groceries';
const TRANSPORT = 'cat-transport';

let store: InMemoryStore;
let repository: InMemoryBudgetRepository;
let clock: TestClock;
let settings: BudgetUserSettings;
let budgets: DefaultBudgetService<InMemoryStore>;

beforeEach(() => {
  store = new InMemoryStore();
  repository = new InMemoryBudgetRepository(store);
  clock = new TestClock('2026-09-10T02:00:00Z'); // 12:00 in Sydney
  settings = { timezone: 'Australia/Sydney', currencyCode: 'AUD', periodAnchorDate: '2026-01-05' };
  budgets = new DefaultBudgetService({ repository, settingsOf: async () => settings, clock });
});

describe('periodFor', () => {
  it('derives the cycle from the user"s anchor', async () => {
    expect(await budgets.periodFor(USER, '2026-09-10')).toEqual({
      key: '2026-09',
      start: '2026-09-05',
      end: '2026-10-04',
    });
  });

  it('refuses before onboarding step 3 rather than guessing an anchor', async () => {
    settings = { ...settings, periodAnchorDate: null };
    await expect(budgets.periodFor(USER, '2026-09-10')).rejects.toMatchObject({
      code: 'ONBOARDING_REQUIRED',
    });
  });
});

describe('ensurePeriod', () => {
  it('materialises once and returns the same row on every later call', async () => {
    const budget = await budgets.setCap(USER, GROCERIES, 60_000n);
    const first = await budgets.ensurePeriod(USER, budget.id, '2026-09-10');
    const second = await budgets.ensurePeriod(USER, budget.id, '2026-09-30');

    expect(second.id).toBe(first.id);
    expect(store.periods).toHaveLength(1);
    expect(first).toMatchObject({
      periodKey: '2026-09',
      periodStart: '2026-09-05',
      periodEnd: '2026-10-04',
      capMinorUnits: 60_000n,
    });
  });

  it('snapshots the standing cap as it was at materialisation', async () => {
    const budget = await budgets.setCap(USER, GROCERIES, 60_000n);
    const september = await budgets.ensurePeriod(USER, budget.id, '2026-09-10');
    expect(september.capMinorUnits).toBe(60_000n);
  });

  it('is RESOURCE_NOT_FOUND for a budget that is not the caller"s', async () => {
    await expect(budgets.ensurePeriod(USER, 'budget-nope', '2026-09-10')).rejects.toMatchObject({
      code: 'RESOURCE_NOT_FOUND',
    });
  });
});

describe('ensurePeriodForCategory — M3"s seam', () => {
  it('materialises the period for whichever budget owns the category', async () => {
    const budget = await budgets.setCap(USER, GROCERIES, 60_000n);
    const period = await budgets.ensurePeriodForCategory(USER, GROCERIES, '2026-09-10', store);
    expect(period).toMatchObject({ budgetId: budget.id, periodKey: '2026-09' });
  });

  it('is null for a category with no active budget — an uncapped expense is normal', async () => {
    expect(await budgets.ensurePeriodForCategory(USER, TRANSPORT, '2026-09-10', store)).toBeNull();
    expect(store.periods).toHaveLength(0);
  });

  it('is null once the budget is deactivated', async () => {
    const budget = await budgets.setCap(USER, GROCERIES, 60_000n);
    await budgets.deactivate(USER, budget.id);
    expect(await budgets.ensurePeriodForCategory(USER, GROCERIES, '2026-09-10', store)).toBeNull();
  });
});

describe('setCap', () => {
  it('keeps one active budget per category, updating rather than adding', async () => {
    const first = await budgets.setCap(USER, GROCERIES, 60_000n);
    const second = await budgets.setCap(USER, GROCERIES, 65_000n);

    expect(second.id).toBe(first.id);
    expect(store.budgets).toHaveLength(1);
    expect(second.capMinorUnits).toBe(65_000n);
  });

  it('updates the current period"s snapshot but leaves past periods byte-for-byte', async () => {
    const budget = await budgets.setCap(USER, GROCERIES, 60_000n);
    const august = await budgets.ensurePeriod(USER, budget.id, '2026-08-20');
    const september = await budgets.ensurePeriod(USER, budget.id, '2026-09-10');

    await budgets.setCap(USER, GROCERIES, 45_000n);

    const augustAfter = store.periods.find((p) => p.id === august.id);
    const septemberAfter = store.periods.find((p) => p.id === september.id);
    expect(augustAfter).toEqual(august);
    expect(augustAfter?.capMinorUnits).toBe(60_000n);
    expect(septemberAfter?.capMinorUnits).toBe(45_000n);
  });

  it('a period materialised after the change picks up the new standing cap', async () => {
    const budget = await budgets.setCap(USER, GROCERIES, 60_000n);
    await budgets.ensurePeriod(USER, budget.id, '2026-09-10');
    await budgets.setCap(USER, GROCERIES, 45_000n);

    clock.set('2026-10-10T02:00:00Z');
    const october = await budgets.ensurePeriod(USER, budget.id, '2026-10-10');
    expect(october.periodKey).toBe('2026-10');
    expect(october.capMinorUnits).toBe(45_000n);
  });

  it('writes nothing to a snapshot that has not been materialised yet', async () => {
    await budgets.setCap(USER, GROCERIES, 60_000n);
    expect(store.periods).toHaveLength(0);
  });

  it('refuses a cap of zero or less', async () => {
    await expect(budgets.setCap(USER, GROCERIES, 0n)).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    await expect(budgets.setCap(USER, GROCERIES, -1n)).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
  });

  it('denominates the cap in the user"s currency', async () => {
    settings = { ...settings, currencyCode: 'NZD' };
    expect((await budgets.setCap(USER, GROCERIES, 60_000n)).currencyCode).toBe('NZD');
  });

  /** 5 Sep decision: budgets are independent of which categories carry a reminder. */
  it('sets a budget on any category, on either tier, with no reminder involvement', async () => {
    await budgets.setCap(USER, GROCERIES, 60_000n);
    await budgets.setCap(USER, TRANSPORT, 20_000n);
    expect((await budgets.activeBudgets(USER)).map((b) => b.categoryId)).toEqual([GROCERIES, TRANSPORT]);
  });
});

describe('setCap tells M5 (Ricky, 11 Sep: a raise today is spendable today)', () => {
  let notified: [string, string][];
  let failNext: boolean;

  beforeEach(() => {
    notified = [];
    failNext = false;
    budgets = new DefaultBudgetService({
      repository,
      settingsOf: async () => settings,
      clock,
      allowance: {
        capChanged: async (userId, categoryId) => {
          if (failNext) throw new Error('M5 is down');
          notified.push([userId, categoryId]);
        },
      },
    });
  });

  it('after the current cycle"s snapshot has moved', async () => {
    const budget = await budgets.setCap(USER, GROCERIES, 60_000n);
    await budgets.ensurePeriod(USER, budget.id, '2026-09-10');

    await budgets.setCap(USER, GROCERIES, 90_000n);

    expect(notified).toEqual([[USER, GROCERIES]]);
  });

  it('not when no snapshot exists — there is no row for M5 to re-price', async () => {
    await budgets.setCap(USER, GROCERIES, 60_000n);
    await budgets.setCap(USER, GROCERIES, 90_000n);
    expect(notified).toEqual([]);
  });

  it('only after both M4 rows are written, and M5 failing never fails the cap change', async () => {
    const budget = await budgets.setCap(USER, GROCERIES, 60_000n);
    const period = await budgets.ensurePeriod(USER, budget.id, '2026-09-10');

    failNext = true;
    await expect(budgets.setCap(USER, GROCERIES, 90_000n)).resolves.toMatchObject({
      capMinorUnits: 90_000n,
    });

    expect(store.periods.find((p) => p.id === period.id)?.capMinorUnits).toBe(90_000n);
  });
});

describe('deactivate', () => {
  it('drops the budget from the active list but keeps its historical snapshots', async () => {
    const budget = await budgets.setCap(USER, GROCERIES, 60_000n);
    const period = await budgets.ensurePeriod(USER, budget.id, '2026-09-10');

    await budgets.deactivate(USER, budget.id);

    expect(await budgets.activeBudgets(USER)).toEqual([]);
    expect(store.periods).toEqual([period]);
    expect(store.budgets[0]).toMatchObject({ id: budget.id, isActive: false });
  });

  it('frees the category to take a new budget afterwards', async () => {
    const first = await budgets.setCap(USER, GROCERIES, 60_000n);
    await budgets.deactivate(USER, first.id);
    const second = await budgets.setCap(USER, GROCERIES, 30_000n);
    expect(second.id).not.toBe(first.id);
    expect((await budgets.activeBudgets(USER)).map((b) => b.id)).toEqual([second.id]);
  });

  it('is RESOURCE_NOT_FOUND for an unknown or already-inactive budget', async () => {
    const budget = await budgets.setCap(USER, GROCERIES, 60_000n);
    await budgets.deactivate(USER, budget.id);
    await expect(budgets.deactivate(USER, budget.id)).rejects.toMatchObject({ code: 'RESOURCE_NOT_FOUND' });
  });
});

describe('currentBudgets — `/budget` with no arguments', () => {
  it('reports the current-period snapshot alongside the standing rule', async () => {
    const budget = await budgets.setCap(USER, GROCERIES, 60_000n);
    await budgets.ensurePeriod(USER, budget.id, '2026-09-10');

    expect(await budgets.currentBudgets(USER, '2026-09-10')).toEqual([
      {
        budget: expect.objectContaining({ id: budget.id, capMinorUnits: 60_000n }),
        period: { key: '2026-09', start: '2026-09-05', end: '2026-10-04' },
        snapshotCapMinorUnits: 60_000n,
      },
    ]);
  });

  /**
   * M4's test: a user who logs nothing in a period has no `budget_period` row, and
   * that means "the cap applies, nothing spent" — never an error.
   */
  it('treats a period with no materialised row as the cap applying, not as an error', async () => {
    await budgets.setCap(USER, GROCERIES, 60_000n);
    const [view] = await budgets.currentBudgets(USER, '2026-11-11');
    expect(view?.snapshotCapMinorUnits).toBeNull();
    expect(view?.budget.capMinorUnits).toBe(60_000n);
    expect(view?.period.key).toBe('2026-11');
  });

  it('materialises nothing of its own', async () => {
    await budgets.setCap(USER, GROCERIES, 60_000n);
    await budgets.currentBudgets(USER, '2026-09-10');
    expect(store.periods).toHaveLength(0);
  });

  it('omits deactivated budgets', async () => {
    const budget = await budgets.setCap(USER, GROCERIES, 60_000n);
    await budgets.setCap(USER, TRANSPORT, 20_000n);
    await budgets.deactivate(USER, budget.id);
    const views = await budgets.currentBudgets(USER, '2026-09-10');
    expect(views.map((v) => v.budget.categoryId)).toEqual([TRANSPORT]);
  });
});
