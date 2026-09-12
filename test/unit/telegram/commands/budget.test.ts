import { beforeEach, describe, expect, it } from 'vitest';
import { createHarness, reply, USER } from '../harness';
import type { Harness } from '../harness';

let h: Harness;

beforeEach(() => {
  h = createHarness();
});

describe('/budget', () => {
  it('lists every cap for the current cycle', async () => {
    await h.seedCategory(USER, 'Food', { cap: 60000n });
    await h.seedCategory(USER, 'Transport', { cap: 24000n });

    const text = await reply(h, '/budget');

    expect(text).toContain('5 Sep – 4 Oct');
    expect(text).toContain('- Food: $600');
    expect(text).toContain('- Transport: $240');
  });

  it('sets a cap through the owning module', async () => {
    const food = await h.seedCategory(USER, 'Food');

    expect(await reply(h, '/budget Food 300')).toContain('$300');

    const [view] = await h.budgets.currentBudgets(USER, '2026-09-11');
    expect(view?.budget.categoryId).toBe(food);
    expect(view?.capMinorUnits).toBe(30000n);
  });

  it('keeps a quoted multi-word name together', async () => {
    await h.seedCategory(USER, 'Eating Out');

    expect(await reply(h, '/budget "Eating Out" 300')).toContain('Eating Out is now $300');
  });

  it('accepts cents', async () => {
    await h.seedCategory(USER, 'Food');

    await reply(h, '/budget Food 12.50');

    const [view] = await h.budgets.currentBudgets(USER, '2026-09-11');
    expect(view?.capMinorUnits).toBe(1250n);
  });

  it('writes nothing when the amount is malformed', async () => {
    await h.seedCategory(USER, 'Food');

    expect(await reply(h, '/budget Food banana')).toContain("I couldn't read \"banana\"");

    // M11's shared contract: "invalid input returns a precise correction with no
    // partial write". The conversion happening before `setCap` is what makes it true.
    expect(await h.budgets.activeBudgets(USER)).toHaveLength(0);
  });

  it('writes nothing when the amount is too precise for the currency', async () => {
    await h.seedCategory(USER, 'Food');

    expect(await reply(h, '/budget Food 12.345')).toContain("couldn't read");
    expect(await h.budgets.activeBudgets(USER)).toHaveLength(0);
  });

  it('refuses a category that does not exist, without creating one', async () => {
    expect(await reply(h, '/budget Nonsense 300')).toContain('/categories');
    expect(await h.categories.list(USER)).toHaveLength(0);
  });

  it('asks for quotes rather than guessing at an unquoted multi-word name', async () => {
    await h.seedCategory(USER, 'Eating Out');

    expect(await reply(h, '/budget Eating Out 300')).toContain('quotes');
  });

  it('confirms a new cap with what that means for today, in M5"s words', async () => {
    const food = await h.seedCategory(USER, 'Food', { cap: 60000n });
    // 24 days left on 11 Sep: $600 is $25 a day, and today's row now exists.
    expect(await reply(h, '/today')).toBe('You can spend $25 on Food today to stay on budget.');

    // Ricky, 11 Sep: a raise today is spendable today — $960 / 24 = $40, now.
    expect(await reply(h, '/budget Food 960')).toBe(
      'Food is now $960 a cycle. You can spend $40 on Food today to stay on budget.',
    );
    expect(await reply(h, '/today')).toBe('You can spend $40 on Food today to stay on budget.');
    expect(await h.budgets.currentBudgets(USER, '2026-09-11')).toMatchObject([
      { budget: { categoryId: food }, capMinorUnits: 96000n },
    ]);
  });

  it('shows one figure after a mid-cycle change, because M4 moves the snapshot too', async () => {
    const food = await h.seedCategory(USER, 'Food', { cap: 60000n });
    // Logging materialises this cycle's snapshot at the old cap.
    await h.spend(USER, food, 1000n, '2026-09-11');
    await h.budgets.setCap(USER, food, 90000n);

    const text = await reply(h, '/budget');

    // M4's page says to "show both" after a mid-period change, but `setCap` updates
    // the standing budget and the current snapshot in one call, precisely so "my
    // budget is 900 now" means now. There is no second figure to show, and rendering
    // one would be dead code pretending to be a feature.
    expect(text).toContain('- Food: $900');
    expect(text).not.toContain('$600');
  });

  it('says what to do when there are no budgets at all', async () => {
    expect(await reply(h, '/budget')).toContain('no budgets yet');
  });
});
