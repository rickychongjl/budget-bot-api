import { beforeEach, describe, expect, it } from 'vitest';
import { createHarness, reply, USER } from '../harness';
import type { Harness } from '../harness';

let h: Harness;

beforeEach(() => {
  h = createHarness();
});

describe('/delete', () => {
  it('removes the last entry and reports the updated allowance', async () => {
    const food = await h.seedCategory(USER, 'Food', { cap: 60000n });
    await h.spend(USER, food, 1000n, '2026-09-11');

    const text = await reply(h, '/delete');

    expect(text).toContain('Removed $10');
    // $600 over 24 days is $25 a day, and the $10 is gone again.
    expect(text).toContain('You can spend $25 on Food today');
  });

  it('asks M5 for the allowance rather than trusting ledgerChanged', async () => {
    const food = await h.seedCategory(USER, 'Food', { cap: 60000n });
    await h.spend(USER, food, 1000n, '2026-09-11');

    let asked = 0;
    const real = h.allowance.availableToday.bind(h.allowance);
    h.allowance.availableToday = async (...args) => {
      asked += 1;
      return real(...args);
    };

    await reply(h, '/delete');

    // `AllowanceNotifier.ledgerChanged` is a documented no-op — `available_today` is
    // derived, not stored, so there is nothing for a notification to have refreshed.
    // A handler relying on it would print the pre-delete number.
    expect(asked).toBe(1);
  });

  it('refuses when there is nothing to delete', async () => {
    expect(await reply(h, '/delete')).toContain('nothing recorded yet');
  });

  it('takes the most recently recorded entry, not the most recent date', async () => {
    const food = await h.seedCategory(USER, 'Food', { cap: 60000n });
    await h.spend(USER, food, 1000n, '2026-09-11');
    // Recorded second, but backdated — "/delete" means "the one I just typed".
    await h.spend(USER, food, 2500n, '2026-09-08');

    expect(await reply(h, '/delete')).toContain('$25');
  });

  it('still confirms a delete for a category with no budget', async () => {
    const misc = await h.seedCategory(USER, 'Misc');
    await h.spend(USER, misc, 500n, '2026-09-11');

    const text = await reply(h, '/delete');

    expect(text).toContain('Removed $5');
    expect(text).not.toContain('stay on budget');
  });
});
