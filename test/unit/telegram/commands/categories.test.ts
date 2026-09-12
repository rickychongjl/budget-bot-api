import { beforeEach, describe, expect, it } from 'vitest';
import { createHarness, reply, USER } from '../harness';
import type { Harness } from '../harness';

/**
 * `/categories` — arguments, not inline keyboards (Ricky, 11 Sep 2026).
 *
 * Every refusal here is thrown by M3 or M8 and rendered by the dispatcher. The handler
 * pre-checks nothing: a pre-check would be M7 holding an opinion about a limit it does
 * not own, and it would go stale the moment the limit changed.
 */

let h: Harness;

beforeEach(() => {
  h = createHarness();
});

describe('/categories', () => {
  it('lists categories with their caps and reminders', async () => {
    await h.seedCategory(USER, 'Food', { cap: 60000n, reminder: true });
    await h.seedCategory(USER, 'Coffee');

    const text = await reply(h, '/categories');

    expect(text).toContain('- Food: $600, reminder on');
    expect(text).toContain('- Coffee: no budget');
  });

  it('adds one', async () => {
    expect(await reply(h, '/categories add Coffee')).toContain('Added Coffee');
    expect((await h.categories.list(USER)).map((c) => c.name)).toEqual(['Coffee']);
  });

  it('renames one, quoted', async () => {
    await h.seedCategory(USER, 'Eating Out');

    expect(await reply(h, '/categories rename "Eating Out" Dining')).toContain('Renamed to Dining');
    expect((await h.categories.list(USER)).map((c) => c.name)).toEqual(['Dining']);
  });

  it('archives one', async () => {
    await h.seedCategory(USER, 'Coffee');

    expect(await reply(h, '/categories archive Coffee')).toContain('Archived Coffee');
    expect(await h.categories.list(USER)).toHaveLength(0);
  });

  it("renders M8's own copy when the category limit is reached", async () => {
    h.gate.categoryLimit = 1;
    await h.seedCategory(USER, 'Food');

    // M8 wrote this sentence, not M7 — the handler never pre-checks the limit.
    expect(await reply(h, '/categories add Coffee')).toBe('Free tier allows 1 categories.');
  });

  it("renders M3's own copy when a category cannot be archived yet", async () => {
    const food = await h.seedCategory(USER, 'Food', { cap: 60000n });
    await h.spend(USER, food, 1000n, '2026-09-11');

    const text = await reply(h, '/categories archive Food');

    expect(text).not.toContain('Archived');
    // M3 gates archiving on no transactions in the current cycle.
    expect(text.length).toBeGreaterThan(0);
    expect(await h.categories.list(USER)).toHaveLength(1);
  });

  it('refuses a name that does not exist', async () => {
    expect(await reply(h, '/categories archive Nonsense')).toContain(
      'You don\'t have a category called "Nonsense"',
    );
  });

  it('corrects a missing argument instead of guessing', async () => {
    expect(await reply(h, '/categories add')).toContain('/categories add <name>');
    expect(await reply(h, '/categories rename Food')).toContain('/categories rename');
  });

  it('shows the usage when the sub-action is unknown', async () => {
    expect(await reply(h, '/categories frobnicate Food')).toContain('/categories add <name>');
  });

  it('tells an empty account how to start', async () => {
    expect(await reply(h, '/categories')).toContain('/categories add <name>');
  });
});
