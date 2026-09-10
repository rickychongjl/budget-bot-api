import { beforeEach, describe, expect, it } from 'vitest';
import { candidate, createHarness, USER, type Harness } from './harness';

/**
 * M3's category rules, and above all the archive gate resolved in master plan §5.1
 * (round 4): **a category can only be archived if it has no transactions in the
 * current budget cycle.** Earlier-cycle history does not block it.
 */

let h: Harness;

beforeEach(() => {
  h = createHarness();
});

async function categoryWithBudget(name: string, cap = 60_000n) {
  const category = await h.categories.create(USER, name);
  await h.budgets.setCap(USER, category.id, cap);
  return category;
}

describe('create', () => {
  it('stores the display name and the normalized key, in creation order', async () => {
    const food = await h.categories.create(USER, '  Food ');
    const eatingOut = await h.categories.create(USER, 'Eating   Out');

    expect(food).toMatchObject({ name: 'Food', normalizedName: 'food', sortOrder: 0, isArchived: false });
    expect(eatingOut).toMatchObject({ name: 'Eating Out', normalizedName: 'eating out', sortOrder: 1 });
    expect((await h.categories.list(USER)).map((c) => c.name)).toEqual(['Food', 'Eating Out']);
  });

  it('refuses a duplicate name regardless of case or spacing', async () => {
    await h.categories.create(USER, 'Food');
    await expect(h.categories.create(USER, '  fOOd  ')).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
  });

  it('points at reactivate when the name belongs to an archived category', async () => {
    const food = await h.categories.create(USER, 'Food');
    await h.categories.archive(USER, food.id);
    await expect(h.categories.create(USER, 'Food')).rejects.toThrow(/restore that one/);
  });

  it('goes through M8 and surfaces its refusal untouched', async () => {
    h.capacity.categoryLimit = 1;
    await h.categories.create(USER, 'Food');
    await expect(h.categories.create(USER, 'Transport')).rejects.toMatchObject({ code: 'CATEGORY_LIMIT' });
    expect(h.capacity.actions).toEqual(['create_category', 'create_category']);
    expect(await h.categories.countActive(USER)).toBe(1);
  });

  it('refuses an unusable name before it reaches the capacity gate', async () => {
    await expect(h.categories.create(USER, '   ')).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    expect(h.capacity.actions).toEqual([]);
  });
});

describe('findByName / list', () => {
  it('resolves through M3"s own normalization', async () => {
    const food = await h.categories.create(USER, 'Food');
    expect(await h.categories.findByName(USER, '  FOOD ')).toMatchObject({ id: food.id });
    expect(await h.categories.findByName(USER, 'Fuel')).toBeNull();
  });

  it('hides archived categories unless asked for them', async () => {
    const food = await h.categories.create(USER, 'Food');
    await h.categories.create(USER, 'Transport');
    await h.categories.archive(USER, food.id);

    expect((await h.categories.list(USER)).map((c) => c.name)).toEqual(['Transport']);
    expect((await h.categories.list(USER, { includeArchived: true })).map((c) => c.name)).toEqual([
      'Food',
      'Transport',
    ]);
  });
});

describe('rename', () => {
  it('updates both the display name and the normalized key', async () => {
    const food = await h.categories.create(USER, 'Food');
    expect(await h.categories.rename(USER, food.id, 'Groceries')).toMatchObject({
      name: 'Groceries',
      normalizedName: 'groceries',
    });
  });

  it('allows a pure capitalisation change', async () => {
    const food = await h.categories.create(USER, 'food');
    expect(await h.categories.rename(USER, food.id, 'Food')).toMatchObject({ name: 'Food' });
  });

  it('refuses a name another category already holds', async () => {
    await h.categories.create(USER, 'Food');
    const transport = await h.categories.create(USER, 'Transport');
    await expect(h.categories.rename(USER, transport.id, 'food')).rejects.toMatchObject({
      code: 'INVALID_ARGUMENT',
    });
  });

  it('is CATEGORY_NOT_FOUND for a category that is not the caller"s', async () => {
    await expect(h.categories.rename(USER, 'cat-nope', 'Food')).rejects.toMatchObject({
      code: 'CATEGORY_NOT_FOUND',
    });
  });
});

describe('archive — the capacity gate (master plan §5.1)', () => {
  it('is rejected when the category has a transaction in the current cycle', async () => {
    const food = await categoryWithBudget('Food');
    await h.ledger.record(USER, candidate({ categoryId: food.id, occurredOn: '2026-09-10' }));

    await expect(h.categories.archive(USER, food.id)).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    // The message tells the user when they can try again — the cycle after this one.
    await expect(h.categories.archive(USER, food.id)).rejects.toThrow(/2026-10-05/);
    expect(await h.categories.countActive(USER)).toBe(1);
  });

  it('succeeds with earlier-cycle history and frees the slot immediately', async () => {
    const food = await categoryWithBudget('Food');
    // Two cycles of heavy use, none of it in the cycle that contains "today".
    for (const date of ['2026-07-10', '2026-08-10', '2026-08-20']) {
      h.clock.set(`${date}T02:00:00Z`);
      await h.ledger.record(USER, candidate({ categoryId: food.id, occurredOn: date }));
    }
    h.clock.set('2026-09-10T02:00:00Z');

    await h.categories.archive(USER, food.id);

    expect(await h.categories.countActive(USER)).toBe(0);
    expect((await h.categories.list(USER, { includeArchived: true }))[0]).toMatchObject({ isArchived: true });
    // History is preserved, not deleted, to meet a limit.
    expect(h.store.transactions).toHaveLength(3);
  });

  it('is allowed on the boundary day that starts the current cycle, and refused on it', async () => {
    const food = await categoryWithBudget('Food');
    // The cycle containing 2026-09-10 runs 05 Sep – 04 Oct. A transaction on the 4th
    // is in the *previous* cycle; one on the 5th is in this one.
    await h.ledger.record(USER, candidate({ categoryId: food.id, occurredOn: '2026-09-04' }));
    await h.categories.archive(USER, food.id);

    const transport = await categoryWithBudget('Transport', 20_000n);
    await h.ledger.record(USER, candidate({ categoryId: transport.id, occurredOn: '2026-09-05' }));
    await expect(h.categories.archive(USER, transport.id)).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
  });

  it('ignores a soft-deleted transaction — only confirmed rows block the archive', async () => {
    const food = await categoryWithBudget('Food');
    const tx = await h.ledger.record(USER, candidate({ categoryId: food.id, occurredOn: '2026-09-10' }));
    await h.ledger.softDelete(USER, tx.id);

    await expect(h.categories.archive(USER, food.id)).resolves.toBeUndefined();
  });

  it('archives a never-used category', async () => {
    const food = await h.categories.create(USER, 'Food');
    await h.categories.archive(USER, food.id);
    expect(await h.categories.countActive(USER)).toBe(0);
  });

  it('tells M5 to drop the category"s reminder and pending sends', async () => {
    const food = await h.categories.create(USER, 'Food');
    await h.categories.archive(USER, food.id);
    expect(h.allowance.archived).toEqual([{ userId: USER, categoryId: food.id }]);
  });

  it('is a no-op on an already-archived category', async () => {
    const food = await h.categories.create(USER, 'Food');
    await h.categories.archive(USER, food.id);
    await h.categories.archive(USER, food.id);
    expect(h.allowance.archived).toHaveLength(1);
  });
});

describe('reactivate', () => {
  it('re-consumes a capacity slot through M8', async () => {
    const food = await h.categories.create(USER, 'Food');
    await h.categories.archive(USER, food.id);

    const revived = await h.categories.reactivate(USER, food.id);

    expect(revived.isArchived).toBe(false);
    expect(await h.categories.countActive(USER)).toBe(1);
    expect(h.capacity.actions).toContain('reactivate_category');
  });

  it('is refused when the tier is already full', async () => {
    const food = await h.categories.create(USER, 'Food');
    await h.categories.archive(USER, food.id);
    await h.categories.create(USER, 'Transport');
    h.capacity.categoryLimit = 1;

    await expect(h.categories.reactivate(USER, food.id)).rejects.toMatchObject({ code: 'CATEGORY_LIMIT' });
    expect(await h.categories.countActive(USER)).toBe(1);
  });

  it('does not consume a second slot for a category that is already active', async () => {
    const food = await h.categories.create(USER, 'Food');
    await h.categories.reactivate(USER, food.id);
    expect(h.capacity.actions).toEqual(['create_category']);
  });
});
