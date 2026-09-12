import { beforeEach, describe, expect, it } from 'vitest';
import { createHarness, reply, USER } from '../harness';
import type { Harness } from '../harness';

let h: Harness;

beforeEach(() => {
  h = createHarness();
});

describe('/stats', () => {
  it('reports spend against each cap for the current cycle', async () => {
    const food = await h.seedCategory(USER, 'Food', { cap: 60000n });
    await h.spend(USER, food, 15000n, '2026-09-10');

    const text = await reply(h, '/stats');

    expect(text).toContain('5 Sep – 4 Oct');
    expect(text).toContain('- Food: $150 of $600, $450 left');
  });

  it('treats a cycle with nothing logged as "cap applies, nothing spent"', async () => {
    await h.seedCategory(USER, 'Food', { cap: 60000n });

    // M4 has deliberately no cron opening periods in advance, so there is no
    // `budget_period` row here at all. That is a zero, never an error.
    expect(await reply(h, '/stats')).toContain('- Food: $0 of $600, $600 left');
  });

  it('says "over" rather than printing a negative remainder', async () => {
    const food = await h.seedCategory(USER, 'Food', { cap: 60000n });
    await h.spend(USER, food, 70000n, '2026-09-10');

    expect(await reply(h, '/stats')).toContain('- Food: $700 of $600, $100 over');
  });

  it('counts a refund against the spend, and income not at all', async () => {
    const food = await h.seedCategory(USER, 'Food', { cap: 60000n });
    await h.spend(USER, food, 15000n, '2026-09-10');
    await h.ledger.record(USER, {
      direction: 'refund',
      amountMinorUnits: 5000n,
      currencyCode: 'AUD',
      occurredAt: Date.parse('2026-09-10T02:00:00Z'),
      occurredOn: '2026-09-10',
      categoryId: food,
      rawText: 'refund',
      parseRoute: 'mechanical',
    });

    // M3 returns `expenses - refunds`, excluding income by construction. M7 prints it.
    expect(await reply(h, '/stats')).toContain('- Food: $100 of $600');
  });

  it('narrows to one category', async () => {
    await h.seedCategory(USER, 'Food', { cap: 60000n });
    await h.seedCategory(USER, 'Transport', { cap: 24000n });

    const text = await reply(h, '/stats Food');

    expect(text).toContain('Food');
    expect(text).not.toContain('Transport');
  });

  it('says so when the named category has no budget', async () => {
    await h.seedCategory(USER, 'Coffee');

    expect(await reply(h, '/stats Coffee')).toContain('no budget yet');
  });

  it('says so when nothing is budgeted at all', async () => {
    expect(await reply(h, '/stats')).toContain('no budgets yet');
  });
});
