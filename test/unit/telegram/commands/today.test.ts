import { beforeEach, describe, expect, it } from 'vitest';
import { createHarness, reply, USER } from '../harness';
import type { Harness } from '../harness';

/**
 * `/today` — M5's figure, M5's wording, rendered by M7.
 *
 * The clock is 12:00 on 11 Sep in Sydney and the anchor is the 5th, so the cycle runs
 * 5 Sep – 4 Oct: 24 days left including today. A $600 cap with nothing spent is
 * therefore $25 a day.
 */

let h: Harness;

beforeEach(() => {
  h = createHarness();
});

describe('/today', () => {
  it('reports the daily figure for every budgeted category', async () => {
    await h.seedCategory(USER, 'Food', { cap: 60000n });

    expect(await reply(h, '/today')).toBe(
      'You can spend $25 on Food today to stay on budget.',
    );
  });

  it('subtracts what was already spent today', async () => {
    const food = await h.seedCategory(USER, 'Food', { cap: 60000n });
    await h.spend(USER, food, 1000n, '2026-09-11');

    expect(await reply(h, '/today')).toBe(
      'You can spend $15 on Food today to stay on budget.',
    );
  });

  it('narrows to one category by name', async () => {
    await h.seedCategory(USER, 'Food', { cap: 60000n });
    await h.seedCategory(USER, 'Transport', { cap: 24000n });

    const text = await reply(h, '/today Food');

    expect(text).toContain('Food');
    expect(text).not.toContain('Transport');
  });

  it('finds a quoted multi-word category', async () => {
    await h.seedCategory(USER, 'Eating Out', { cap: 24000n });

    expect(await reply(h, '/today "Eating Out"')).toContain('Eating Out');
  });

  it('refuses a name the user does not have', async () => {
    await h.seedCategory(USER, 'Food', { cap: 60000n });

    expect(await reply(h, '/today Nonsense')).toContain(
      'You don\'t have a category called "Nonsense"',
    );
  });

  it('says so plainly when nothing is budgeted', async () => {
    expect(await reply(h, '/today')).toContain('no budgets yet');
  });

  it('adds no arithmetic of its own — the figure is exactly what M5 returned', async () => {
    const food = await h.seedCategory(USER, 'Food', { cap: 60000n });
    const [view] = await h.allowance.availableToday(USER, food);

    expect(await reply(h, '/today')).toContain(`$${Number(view!.availableToday) / 100}`);
  });
});
