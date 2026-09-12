import { beforeEach, describe, expect, it } from 'vitest';
import { createHarness, reply, USER } from '../harness';
import type { Harness } from '../harness';

/**
 * `/remind` — which categories send the 07:00 message.
 *
 * The load-bearing behaviour is that only *budgeted* categories are offered: M5 refuses
 * `NO_BUDGET` for a category with no cap, and M7's handover note says to offer only
 * budgeted ones "so M5's NO_BUDGET never surfaces after the fact".
 */

let h: Harness;

beforeEach(() => {
  h = createHarness();
});

describe('/remind', () => {
  it('offers only categories that have a budget', async () => {
    await h.seedCategory(USER, 'Food', { cap: 60000n });
    await h.seedCategory(USER, 'Coffee');

    const text = await reply(h, '/remind');

    expect(text).toContain('Food');
    // Coffee has no cap, so M5 could only refuse it. Listing it would be an invitation
    // to a dead end.
    expect(text).not.toContain('Coffee');
  });

  it('marks the ones already on', async () => {
    await h.seedCategory(USER, 'Food', { cap: 60000n, reminder: true });
    await h.seedCategory(USER, 'Transport', { cap: 24000n });

    const text = await reply(h, '/remind');

    expect(text).toContain('- Food ✓');
    expect(text).toContain('- Transport');
    expect(text).not.toContain('- Transport ✓');
  });

  it('turns one on', async () => {
    const food = await h.seedCategory(USER, 'Food', { cap: 60000n });

    expect(await reply(h, '/remind Food')).toContain('will remind you at 7:00');
    expect(await h.reminders.enabledCategoryIds(USER)).toEqual([food]);
  });

  it('turns the same one off again', async () => {
    const food = await h.seedCategory(USER, 'Food', { cap: 60000n, reminder: true });

    expect(await reply(h, '/remind Food')).toContain('will not remind you');
    expect(await h.reminders.enabledCategoryIds(USER)).toEqual([]);
    expect(food).toBeTruthy();
  });

  it("renders M8's own copy at the reminder limit", async () => {
    h.gate.reminderLimit = 1;
    await h.seedCategory(USER, 'Food', { cap: 60000n, reminder: true });
    await h.seedCategory(USER, 'Transport', { cap: 24000n });

    expect(await reply(h, '/remind Transport')).toBe(
      'You can have reminders on 1 category on Free.',
    );
  });

  it('says what is missing when nothing is budgeted', async () => {
    await h.seedCategory(USER, 'Coffee');

    expect(await reply(h, '/remind')).toContain('Reminders need a category with a budget');
  });

  it('refuses a name that does not exist', async () => {
    expect(await reply(h, '/remind Nonsense')).toContain('Nonsense');
  });

  it('asks for quotes rather than guessing at an unquoted multi-word name', async () => {
    await h.seedCategory(USER, 'Eating Out', { cap: 24000n });

    expect(await reply(h, '/remind Eating Out')).toContain('quotes');
  });
});
