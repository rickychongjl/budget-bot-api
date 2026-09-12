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

  it('carries the cap governing that cycle — resolved from the history, not stored on the row', async () => {
    const budget = await budgets.setCap(USER, GROCERIES, 60_000n);
    const september = await budgets.ensurePeriod(USER, budget.id, '2026-09-10');
    expect(september.capMinorUnits).toBe(60_000n);
    expect(store.periods[0]).not.toHaveProperty('capMinorUnits');
  });

  it('refuses a cycle from before the category carried any cap, and materialises nothing', async () => {
    const budget = await budgets.setCap(USER, GROCERIES, 60_000n); // September's row
    await expect(budgets.ensurePeriod(USER, budget.id, '2026-08-20')).rejects.toMatchObject({
      code: 'RESOURCE_NOT_FOUND',
    });
    expect(store.periods).toHaveLength(0);
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

  it('is null for a cycle before the budget existed — the expense was uncapped then', async () => {
    // A cap set in September, an expense backdated into August. The old per-row
    // snapshot stamped September's cap onto August; the history says August had none.
    await budgets.setCap(USER, GROCERIES, 60_000n);
    expect(await budgets.ensurePeriodForCategory(USER, GROCERIES, '2026-08-20', store)).toBeNull();
    expect(store.periods).toHaveLength(0);
  });
});

describe('setCap', () => {
  it('keeps one active budget per category, updating rather than adding', async () => {
    const first = await budgets.setCap(USER, GROCERIES, 60_000n);
    const second = await budgets.setCap(USER, GROCERIES, 65_000n);

    expect(second.id).toBe(first.id);
    expect(store.budgets).toHaveLength(1);
    expect((await budgets.currentBudgets(USER, '2026-09-10'))[0]?.capMinorUnits).toBe(65_000n);
  });

  it('two changes in one cycle leave one governing row — the later write', async () => {
    await budgets.setCap(USER, GROCERIES, 60_000n);
    await budgets.setCap(USER, GROCERIES, 65_000n);
    expect(store.periodCaps).toEqual([expect.objectContaining({ periodKey: '2026-09', capMinorUnits: 65_000n })]);
  });

  it('governs the current cycle and every later one, and leaves earlier cycles alone', async () => {
    clock.set('2026-08-20T02:00:00Z');
    const budget = await budgets.setCap(USER, GROCERIES, 60_000n); // August's row
    await budgets.ensurePeriod(USER, budget.id, '2026-08-20');
    clock.set('2026-09-10T02:00:00Z');
    expect((await budgets.ensurePeriod(USER, budget.id, '2026-09-10')).capMinorUnits).toBe(60_000n); // carried forward

    await budgets.setCap(USER, GROCERIES, 45_000n); // September's row

    expect((await budgets.ensurePeriod(USER, budget.id, '2026-08-20')).capMinorUnits).toBe(60_000n);
    expect((await budgets.ensurePeriod(USER, budget.id, '2026-09-10')).capMinorUnits).toBe(45_000n);
    expect(store.periodCaps.map((c) => [c.periodKey, c.capMinorUnits])).toEqual([
      ['2026-08', 60_000n],
      ['2026-09', 45_000n],
    ]);
    expect(store.periods).toHaveLength(2); // the change wrote no period row
  });

  it('a cycle nobody touched still reads the cap that applied to it when opened late', async () => {
    // The August case (Ricky, 11–12 Sep). July: 1000. August: nothing logged, no
    // /today, no /stats, no reminder — no row of any kind. September: raised to 1200.
    // Then an expense backdated into August. The old snapshot stamped August at 1200.
    clock.set('2026-07-15T02:00:00Z');
    await budgets.setCap(USER, GROCERIES, 100_000n);
    clock.set('2026-09-10T02:00:00Z');
    await budgets.setCap(USER, GROCERIES, 120_000n);

    const august = await budgets.ensurePeriodForCategory(USER, GROCERIES, '2026-08-20', store);
    expect(august?.capMinorUnits).toBe(100_000n);
    expect((await budgets.ensurePeriodForCategory(USER, GROCERIES, '2026-09-10', store))?.capMinorUnits).toBe(120_000n);
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

  it('writes the cycle"s cap row but materialises no period of its own', async () => {
    await budgets.setCap(USER, GROCERIES, 60_000n);
    expect(store.periods).toHaveLength(0);
    expect(store.periodCaps).toHaveLength(1);
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
    await expect(budgets.setCap(USER, GROCERIES, 90_000n)).resolves.toMatchObject({ id: budget.id });

    expect((await budgets.ensurePeriod(USER, budget.id, '2026-09-10')).capMinorUnits).toBe(90_000n);
    expect(store.periods.map((p) => p.id)).toEqual([period.id]);
  });
});

describe('deactivate', () => {
  it('drops the budget from the active list but keeps its historical snapshots', async () => {
    const budget = await budgets.setCap(USER, GROCERIES, 60_000n);
    const period = await budgets.ensurePeriod(USER, budget.id, '2026-09-10');

    await budgets.deactivate(USER, budget.id);

    expect(await budgets.activeBudgets(USER)).toEqual([]);
    expect(store.periods.map((p) => p.id)).toEqual([period.id]);
    expect(store.budgets[0]).toMatchObject({ id: budget.id, isActive: false });
  });

  it('writes a null cap row so the old cap does not carry into cycles with no budget', async () => {
    const budget = await budgets.setCap(USER, GROCERIES, 60_000n);
    await budgets.deactivate(USER, budget.id);

    expect(store.periodCaps).toEqual([expect.objectContaining({ periodKey: '2026-09', capMinorUnits: null })]);
    clock.set('2026-10-10T02:00:00Z');
    expect(await budgets.ensurePeriodForCategory(USER, GROCERIES, '2026-10-10', store)).toBeNull();
  });

  it('a budget re-added in a later cycle governs from that cycle only', async () => {
    const first = await budgets.setCap(USER, GROCERIES, 60_000n); // September
    await budgets.deactivate(USER, first.id); // September: none
    clock.set('2026-11-10T02:00:00Z');
    const second = await budgets.setCap(USER, GROCERIES, 30_000n); // November

    expect((await budgets.ensurePeriod(USER, second.id, '2026-11-10')).capMinorUnits).toBe(30_000n);
    await expect(budgets.ensurePeriod(USER, second.id, '2026-10-10')).rejects.toMatchObject({
      code: 'RESOURCE_NOT_FOUND',
    });
    expect(store.periodCaps.map((c) => [c.periodKey, c.capMinorUnits])).toEqual([
      ['2026-09', null],
      ['2026-11', 30_000n],
    ]);
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
  it('reports each active budget with the cap governing the current cycle', async () => {
    const budget = await budgets.setCap(USER, GROCERIES, 60_000n);
    await budgets.ensurePeriod(USER, budget.id, '2026-09-10');

    expect(await budgets.currentBudgets(USER, '2026-09-10')).toEqual([
      {
        budget: expect.objectContaining({ id: budget.id }),
        period: { key: '2026-09', start: '2026-09-05', end: '2026-10-04' },
        capMinorUnits: 60_000n,
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
    expect(view?.capMinorUnits).toBe(60_000n); // September's row governs November
    expect(view?.period.key).toBe('2026-11');
  });

  it('is loud, not silent, if an active budget somehow has no governing cap', async () => {
    await budgets.setCap(USER, GROCERIES, 60_000n);
    store.periodCaps = []; // a broken backfill, say
    await expect(budgets.currentBudgets(USER, '2026-09-10')).rejects.toThrow(/active but has no cap/);
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
