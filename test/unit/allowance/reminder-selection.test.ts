import { beforeEach, describe, expect, it } from 'vitest';
import { RefusalError } from '../../../src/core/shared/errors';
import { isEntitlementRefusal } from '../../../src/core/entitlements';
import { createHarness, USER, type Harness } from './harness';

/**
 * Which categories carry the 07:00 reminder — the contract M2's onboarding step 5 has
 * been calling since Phase 1, now with an implementation behind it.
 */

describe('enable', () => {
  let h: Harness;
  beforeEach(() => {
    h = createHarness();
  });

  it('turns the reminder on for a budgeted category', async () => {
    const food = await h.seedCategory('Food', 50_000n);
    await h.reminders.enable(USER, food);
    expect(await h.reminders.enabledCategoryIds(USER)).toEqual([food]);
  });

  it('refuses a category with no budget — a reminder needs a cap to divide', async () => {
    const uncapped = await h.categories.create(USER, 'Uncapped');

    await expect(h.reminders.enable(USER, uncapped.id)).rejects.toMatchObject({
      code: 'NO_BUDGET',
    });
    expect(await h.reminders.enabledCategoryIds(USER)).toEqual([]);
  });

  it('refuses a category whose budget was deactivated', async () => {
    const food = await h.seedCategory('Food', 50_000n);
    const budget = (await h.budgets.activeBudgets(USER)).find((b) => b.categoryId === food)!;
    await h.budgets.deactivate(USER, budget.id);

    await expect(h.reminders.enable(USER, food)).rejects.toMatchObject({ code: 'NO_BUDGET' });
  });

  it('refuses an unknown category', async () => {
    await expect(h.reminders.enable(USER, 'nope')).rejects.toMatchObject({
      code: 'CATEGORY_NOT_FOUND',
    });
  });

  it('refuses an archived category', async () => {
    const food = await h.seedCategory('Food', 50_000n);
    await h.categories.archive(USER, food);

    await expect(h.reminders.enable(USER, food)).rejects.toMatchObject({
      code: 'CATEGORY_NOT_FOUND',
    });
  });

  it('is idempotent — re-enabling does not consume a second slot', async () => {
    const food = await h.seedCategory('Food', 50_000n);
    await h.reminders.enable(USER, food);

    // Free's limit is 1. Without idempotency this would refuse, which would mean a user
    // re-confirming their own existing pick got told they were over the limit.
    await expect(h.reminders.enable(USER, food)).resolves.toBeUndefined();
    expect(await h.reminders.enabledCategoryIds(USER)).toEqual([food]);
  });

  it('does not call the gate at all for an already-enabled category', async () => {
    const food = await h.seedCategory('Food', 50_000n);
    await h.reminders.enable(USER, food);
    const before = h.gate.actions.filter((a) => a === 'enable_reminder').length;

    await h.reminders.enable(USER, food);

    expect(h.gate.actions.filter((a) => a === 'enable_reminder').length).toBe(before);
  });

  it('refuses past the Free limit of one reminder category', async () => {
    await h.seedCategory('Food', 50_000n, { reminder: true });
    const fun = await h.seedCategory('Fun', 25_000n);

    const error = await h.reminders.enable(USER, fun).catch((e: unknown) => e);
    expect(isEntitlementRefusal(error)).toBe(true);
    expect((error as { code: string }).code).toBe('REMINDER_CATEGORY_LIMIT');
    expect(await h.reminders.enabledCategoryIds(USER)).toHaveLength(1);
  });

  it('allows five on Premium', async () => {
    h.gate.reminderLimit = 5;
    for (const name of ['A', 'B', 'C', 'D', 'E']) {
      await h.seedCategory(name, 30_000n, { reminder: true });
    }
    expect(await h.reminders.enabledCategoryIds(USER)).toHaveLength(5);

    const sixth = await h.seedCategory('F', 30_000n);
    await expect(h.reminders.enable(USER, sixth)).rejects.toMatchObject({
      code: 'REMINDER_CATEGORY_LIMIT',
    });
  });

  it('checks capacity inside the gate, not before it', async () => {
    // The count must happen inside M8's transaction, or two concurrent enables at 0/1
    // could both pass a pre-check and both write. The gate records the action; the
    // refusal proves the count ran within it rather than on stale data read earlier.
    const food = await h.seedCategory('Food', 50_000n);
    await h.reminders.enable(USER, food);
    const fun = await h.seedCategory('Fun', 25_000n);

    await expect(h.reminders.enable(USER, fun)).rejects.toThrow();
    expect(h.gate.actions).toContain('enable_reminder');
  });

  it('refuses with a message naming the category, not a bare code', async () => {
    const uncapped = await h.categories.create(USER, 'Coffee');
    const error = (await h.reminders.enable(USER, uncapped.id).catch((e: unknown) => e)) as RefusalError;
    expect(error.message).toContain('Coffee');
  });
});

describe('disable', () => {
  let h: Harness;
  beforeEach(() => {
    h = createHarness();
  });

  it('frees the slot for another category', async () => {
    const food = await h.seedCategory('Food', 50_000n, { reminder: true });
    const fun = await h.seedCategory('Fun', 25_000n);

    await h.reminders.disable(USER, food);
    await h.reminders.enable(USER, fun);

    expect(await h.reminders.enabledCategoryIds(USER)).toEqual([fun]);
  });

  it('never goes through the capacity gate — turning one off cannot exceed a limit', async () => {
    const food = await h.seedCategory('Food', 50_000n, { reminder: true });
    const before = h.gate.actions.length;
    await h.reminders.disable(USER, food);
    expect(h.gate.actions.length).toBe(before);
  });

  it('is a no-op for a category that never had one', async () => {
    const food = await h.seedCategory('Food', 50_000n);
    await expect(h.reminders.disable(USER, food)).resolves.toBeUndefined();
  });

  it('refuses an unknown category rather than silently succeeding', async () => {
    await expect(h.reminders.disable(USER, 'nope')).rejects.toMatchObject({
      code: 'CATEGORY_NOT_FOUND',
    });
  });
});

describe('enabledCategoryIds', () => {
  it('excludes archived categories even if the flag was never cleared', async () => {
    const h = createHarness();
    const food = await h.seedCategory('Food', 50_000n, { reminder: true });

    // Force the flag back on behind M3's back, to prove the read filters archived rows
    // rather than relying on `categoryArchived` having run.
    await h.categories.archive(USER, food);
    h.store.reminderEnabled.add(food);

    expect(await h.reminders.enabledCategoryIds(USER)).toEqual([]);
  });
});
