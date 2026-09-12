import { beforeEach, describe, expect, it } from 'vitest';
import { MAX_SEND_ATTEMPTS } from '../../../src/core/allowance';
import type { SendResult } from '../../../src/core/shared/messaging';
import { createHarness, USER, type Harness } from './harness';

/**
 * M5's service behaviour, over real M3/M4 services and in-memory repositories sharing
 * one store — so a target really is computed from a materialised period and a real
 * ledger sum, not from a stubbed number.
 *
 * Clock is 12:00 on 2026-09-10 in Sydney; the anchor is the 5th, so the cycle runs
 * 5 Sep – 4 Oct and 2026-09-10 has 25 days left including today.
 */

const DAYS_LEFT_ON_10_SEP = 25;

describe('availableToday', () => {
  let h: Harness;
  beforeEach(() => {
    h = createHarness();
  });

  it('spreads the cap over the days remaining in the cycle', async () => {
    const food = await h.seedCategory('Food', 50_000n); // $500 cap
    const [view] = await h.allowance.availableToday(USER, food);

    expect(view).toMatchObject({
      categoryId: food,
      categoryName: 'Food',
      daysLeft: DAYS_LEFT_ON_10_SEP,
      periodEnd: '2026-10-04',
      spentToday: 0n,
    });
    // $500 / 25 days = $20.00
    expect(view!.dailyTarget).toBe(2_000n);
    expect(view!.availableToday).toBe(2_000n);
  });

  it('subtracts what has already been spent today, leaving the target alone', async () => {
    const food = await h.seedCategory('Food', 50_000n);
    await h.spend(food, 750n); // $7.50 this morning

    const [view] = await h.allowance.availableToday(USER, food);
    expect(view!.dailyTarget).toBe(2_000n);
    expect(view!.availableToday).toBe(1_250n);
  });

  it('shows a negative figure once today is overspent, rather than clamping to zero', async () => {
    const food = await h.seedCategory('Food', 50_000n);
    await h.spend(food, 3_000n); // $30 against a $20 target

    const [view] = await h.allowance.availableToday(USER, food);
    expect(view!.availableToday).toBe(-1_000n);
  });

  it('excludes earlier days from today, but counts them against the cap', async () => {
    const food = await h.seedCategory('Food', 50_000n);
    await h.spend(food, 10_000n, '2026-09-08'); // $100 earlier in the cycle

    const [view] = await h.allowance.availableToday(USER, food);
    // $400 left over 25 days = $16
    expect(view!.dailyTarget).toBe(1_600n);
    expect(view!.spentToday).toBe(0n);
  });

  it('nets refunds out of the period spend', async () => {
    const food = await h.seedCategory('Food', 50_000n);
    await h.spend(food, 10_000n, '2026-09-08');
    await h.ledger.record(USER, {
      direction: 'refund',
      amountMinorUnits: 10_000n,
      currencyCode: 'AUD',
      occurredAt: Date.parse('2026-09-08T02:00:00Z'),
      occurredOn: '2026-09-08',
      categoryId: food,
      rawText: 'refund',
      parseRoute: 'mechanical',
    });

    const [view] = await h.allowance.availableToday(USER, food);
    expect(view!.dailyTarget).toBe(2_000n); // back to the full $500 / 25
  });

  it('returns every budgeted category when no category is named', async () => {
    await h.seedCategory('Food', 50_000n);
    await h.seedCategory('Fun', 25_000n);
    const views = await h.allowance.availableToday(USER);
    expect(views.map((v) => v.categoryName).sort()).toEqual(['Food', 'Fun']);
  });

  it('skips a category with no active budget — there is nothing to divide', async () => {
    const food = await h.seedCategory('Food', 50_000n);
    await h.categories.create(USER, 'Uncapped');

    const views = await h.allowance.availableToday(USER);
    expect(views.map((v) => v.categoryId)).toEqual([food]);
  });

  it('persists a row on demand so the first /today and the morning message agree', async () => {
    const food = await h.seedCategory('Food', 50_000n);
    await h.allowance.availableToday(USER, food);

    const rows = await h.store.allowanceSends;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ localDate: '2026-09-10', dailyTargetMinorUnits: 2_000n });
  });

  it('marks a budgeted-but-unreminded category not_applicable, keeping it out of the retry index', async () => {
    await h.seedCategory('Food', 50_000n, { reminder: false });
    await h.allowance.availableToday(USER);
    expect(h.store.allowanceSends[0]!.deliveryStatus).toBe('not_applicable');
  });

  it('marks a reminder-enabled category pending, ready for the 07:00 send', async () => {
    await h.seedCategory('Food', 50_000n, { reminder: true });
    await h.allowance.availableToday(USER);
    expect(h.store.allowanceSends[0]!.deliveryStatus).toBe('pending');
  });
});

describe('the persisted target is frozen for the date', () => {
  let h: Harness;
  beforeEach(() => {
    h = createHarness();
  });

  it('a mid-day transaction moves available_today but never daily_target', async () => {
    // This is the module's whole reason for persisting. If the target were recomputed
    // live, a lunchtime overspend would spread across the remaining days and
    // available_today would quietly stay positive — the user would never see it.
    const food = await h.seedCategory('Food', 50_000n);

    const [morning] = await h.allowance.availableToday(USER, food);
    expect(morning!.dailyTarget).toBe(2_000n);

    await h.spend(food, 15_000n); // blow $150 at lunch

    const [afternoon] = await h.allowance.availableToday(USER, food);
    expect(afternoon!.dailyTarget).toBe(2_000n); // unchanged
    expect(afternoon!.availableToday).toBe(-13_000n); // visible, today
  });

  it('the correction arrives tomorrow, from a genuinely smaller remaining balance', async () => {
    const food = await h.seedCategory('Food', 50_000n);
    await h.allowance.availableToday(USER, food);
    await h.spend(food, 15_000n);

    h.clock.set('2026-09-11T02:00:00Z');
    const [tomorrow] = await h.allowance.availableToday(USER, food);
    // $350 left over 24 days = $14.58, down from $20.
    expect(tomorrow!.daysLeft).toBe(24);
    expect(tomorrow!.dailyTarget).toBe(1_458n);
  });

});

describe('a cap change is the one thing that re-prices today', () => {
  let h: Harness;
  beforeEach(() => {
    h = createHarness();
  });

  it('a cap raised mid-cycle rewrites today"s target, so the raise is spendable today', async () => {
    // Ricky, 11 Sep: "a raise today should give you more to spend today." The freeze
    // above guards against recomputing from *spend*; a cap moving is a different
    // trigger and does not reopen that hole — see the next test.
    const food = await h.seedCategory('Food', 50_000n);
    const [before] = await h.allowance.availableToday(USER, food);
    expect(before!.dailyTarget).toBe(2_000n);

    await h.budgets.setCap(USER, food, 100_000n);

    const [after] = await h.allowance.availableToday(USER, food);
    expect(after!.dailyTarget).toBe(4_000n); // $1,000 / 25 days, today
    expect(after!.availableToday).toBe(4_000n);
    expect(h.store.allowanceSends).toHaveLength(1); // rewritten in place, not a second row
  });

  it('the re-price still takes spend only to the end of yesterday, so an overspend stays visible', async () => {
    const food = await h.seedCategory('Food', 50_000n);
    await h.allowance.availableToday(USER, food);
    await h.spend(food, 15_000n); // blow $150 at lunch

    await h.budgets.setCap(USER, food, 100_000n);

    const [after] = await h.allowance.availableToday(USER, food);
    // Today's $150 is not in the target's inputs — it is measured *against* the target.
    expect(after!.dailyTarget).toBe(4_000n);
    expect(after!.availableToday).toBe(-11_000n);
  });

  it('counts earlier days of the cycle against the new cap', async () => {
    const food = await h.seedCategory('Food', 50_000n);
    await h.spend(food, 10_000n, '2026-09-08');
    const [before] = await h.allowance.availableToday(USER, food);
    expect(before!.dailyTarget).toBe(1_600n); // ($500 - $100) / 25

    await h.budgets.setCap(USER, food, 100_000n);

    const [after] = await h.allowance.availableToday(USER, food);
    expect(after!.dailyTarget).toBe(3_600n); // ($1,000 - $100) / 25
  });

  it('a cap lowered below what is already spent this cycle re-prices today to zero', async () => {
    const food = await h.seedCategory('Food', 50_000n);
    await h.spend(food, 10_000n, '2026-09-08');
    await h.allowance.availableToday(USER, food);

    await h.budgets.setCap(USER, food, 5_000n);

    const [after] = await h.allowance.availableToday(USER, food);
    expect(after!.dailyTarget).toBe(0n);
  });

  it('re-pricing twice on one day gives the same number both times', async () => {
    // What makes the exception safe: the inputs are the cap and yesterday's spend, so
    // the rewrite is a pure function of state that does not move during the day.
    const food = await h.seedCategory('Food', 50_000n);
    await h.allowance.availableToday(USER, food);
    await h.spend(food, 3_000n);

    await h.budgets.setCap(USER, food, 100_000n);
    const [first] = await h.allowance.availableToday(USER, food);
    await h.budgets.setCap(USER, food, 100_000n);
    const [second] = await h.allowance.availableToday(USER, food);

    expect(second!.dailyTarget).toBe(first!.dailyTarget);
  });

  it('writes nothing when today has no row yet — the first read computes from the new cap', async () => {
    const food = await h.seedCategory('Food', 50_000n);
    await h.budgets.setCap(USER, food, 100_000n);
    expect(h.store.allowanceSends).toHaveLength(0);

    const [first] = await h.allowance.availableToday(USER, food);
    expect(first!.dailyTarget).toBe(4_000n);
  });

  it('re-prices a row the 07:00 bundle already delivered, without sending again', async () => {
    // Ricky's call, 11 Sep: rewrite regardless of delivery state, never a second
    // message. The morning text said $20; `/today` now says $40; the row still records
    // that it was sent, and when.
    const food = await h.seedCategory('Food', 50_000n, { reminder: true });
    expect(await h.allowance.computeAndSend(USER)).toMatchObject({ status: 'sent' });
    expect(h.sender.onlyText).toContain('$20');

    await h.budgets.setCap(USER, food, 100_000n);

    expect(h.sender.callCount).toBe(1);
    expect(h.store.allowanceSends).toHaveLength(1);
    expect(h.store.allowanceSends[0]).toMatchObject({
      deliveryStatus: 'sent',
      dailyTargetMinorUnits: 4_000n,
    });
    expect(h.store.allowanceSends[0]!.sentAt).not.toBeNull();

    const [view] = await h.allowance.availableToday(USER, food);
    expect(view!.dailyTarget).toBe(4_000n);
    // And a later tick still finds nothing outstanding — the rewrite did not reopen the day.
    expect(await h.allowance.computeAndSend(USER)).toMatchObject({ status: 'skipped', categoryCount: 0 });
    expect(h.sender.callCount).toBe(1);
  });

  it('tomorrow computes from the new cap as before', async () => {
    const food = await h.seedCategory('Food', 50_000n);
    await h.allowance.availableToday(USER, food);
    await h.budgets.setCap(USER, food, 100_000n);

    h.clock.set('2026-09-11T02:00:00Z');
    const [tomorrow] = await h.allowance.availableToday(USER, food);
    expect(tomorrow!.daysLeft).toBe(24);
    expect(tomorrow!.dailyTarget).toBe(4_166n); // $1,000 / 24
  });
});

describe('computeAndSend — the 07:00 bundle', () => {
  let h: Harness;
  beforeEach(() => {
    h = createHarness();
    h.gate.reminderLimit = 5; // Premium, so several categories can carry a reminder
  });

  it('sends exactly one message covering every reminder-eligible category', async () => {
    await h.seedCategory('Food', 50_000n, { reminder: true });
    await h.seedCategory('Fun', 25_000n, { reminder: true });
    await h.seedCategory('Transport', 12_500n, { reminder: true });

    const outcome = await h.allowance.computeAndSend(USER);

    expect(outcome).toMatchObject({ status: 'sent', categoryCount: 3 });
    expect(h.sender.callCount).toBe(1); // one message, not three
    expect(h.sender.onlyText).toContain('Food');
    expect(h.sender.onlyText).toContain('Fun');
    expect(h.sender.onlyText).toContain('Transport');
  });

  it('sends one message for a Premium user with five reminder categories', async () => {
    for (const name of ['A', 'B', 'C', 'D', 'E']) {
      await h.seedCategory(name, 30_000n, { reminder: true });
    }
    const outcome = await h.allowance.computeAndSend(USER);
    expect(outcome.categoryCount).toBe(5);
    expect(h.sender.callCount).toBe(1);
  });

  it('marks every row in the bundle sent together', async () => {
    await h.seedCategory('Food', 50_000n, { reminder: true });
    await h.seedCategory('Fun', 25_000n, { reminder: true });

    await h.allowance.computeAndSend(USER);

    const statuses = h.store.allowanceSends.map((s) => s.deliveryStatus);
    expect(statuses).toEqual(['sent', 'sent']);
    expect(h.store.allowanceSends.every((s) => s.sentAt !== null)).toBe(true);
  });

  it('leaves a budgeted category with no reminder out of the bundle entirely', async () => {
    await h.seedCategory('Food', 50_000n, { reminder: true });
    await h.seedCategory('Rent', 200_000n, { reminder: false });

    const outcome = await h.allowance.computeAndSend(USER);
    expect(outcome.categoryCount).toBe(1);
    expect(h.sender.onlyText).toContain('Food');
    expect(h.sender.onlyText).not.toContain('Rent');
  });

  it('does not send twice on the same day', async () => {
    await h.seedCategory('Food', 50_000n, { reminder: true });
    const first = await h.allowance.computeAndSend(USER);
    expect(first.status).toBe('sent');

    // A duplicated subrequest, or a tick that fired twice, must not produce a second
    // message. Every row is terminal, so there is nothing outstanding to bundle.
    const second = await h.allowance.computeAndSend(USER);
    expect(second).toMatchObject({ status: 'skipped', categoryCount: 0 });
    expect(h.sender.callCount).toBe(1);
    expect(h.store.allowanceSends).toHaveLength(1);
    expect(h.store.allowanceSends[0]).toMatchObject({
      deliveryStatus: 'sent',
      dailyTargetMinorUnits: 2_000n,
    });
  });

  it('does not resurrect a bundle that already failed today', async () => {
    const failed = createHarnessWithResults({ status: 'permanent' });
    await failed.seedCategory('Food', 50_000n, { reminder: true });
    await failed.allowance.computeAndSend(USER);
    expect(failed.store.allowanceSends[0]!.deliveryStatus).toBe('failed');

    const retry = await failed.allowance.computeAndSend(USER);
    expect(retry).toMatchObject({ status: 'skipped', categoryCount: 0 });
    expect(failed.sender.callCount).toBe(1);
  });

  it('sends the next day, with a fresh target', async () => {
    await h.seedCategory('Food', 50_000n, { reminder: true });
    await h.allowance.computeAndSend(USER);

    h.clock.set('2026-09-11T02:00:00Z');
    const tomorrow = await h.allowance.computeAndSend(USER);

    expect(tomorrow.status).toBe('sent');
    expect(h.sender.callCount).toBe(2);
    expect(h.store.allowanceSends.map((s) => s.localDate)).toEqual(['2026-09-10', '2026-09-11']);
  });

  it('still sends when the user already logged an expense before 07:00', async () => {
    // Suppression was considered and explicitly rejected (M5, 5 Sep).
    const food = await h.seedCategory('Food', 50_000n, { reminder: true });
    await h.spend(food, 500n);

    const outcome = await h.allowance.computeAndSend(USER);
    expect(outcome.status).toBe('sent');
    expect(h.sender.callCount).toBe(1);
  });

  it('sends nothing and skips when the user has no reminder categories', async () => {
    await h.seedCategory('Food', 50_000n, { reminder: false });
    const outcome = await h.allowance.computeAndSend(USER);
    expect(outcome).toMatchObject({ status: 'skipped', categoryCount: 0 });
    expect(h.sender.callCount).toBe(0);
  });

  it('skips rather than throwing when there is no active connection to deliver to', async () => {
    await h.seedCategory('Food', 50_000n, { reminder: true });
    h.connections.connection = null;

    const outcome = await h.allowance.computeAndSend(USER);
    expect(outcome.status).toBe('skipped');
    expect(h.store.allowanceSends[0]!.deliveryStatus).toBe('skipped');
  });
});

describe('computeAndSend — revalidation at dispatch', () => {
  let h: Harness;
  beforeEach(() => {
    h = createHarness();
    h.gate.reminderLimit = 5;
  });

  it('drops a category archived after queueing, and still sends the rest', async () => {
    const food = await h.seedCategory('Food', 50_000n, { reminder: true });
    await h.seedCategory('Fun', 25_000n, { reminder: true });

    // Archiving goes through M3, which calls back into M5's categoryArchived.
    await h.categories.archive(USER, food);

    const outcome = await h.allowance.computeAndSend(USER);
    expect(outcome).toMatchObject({ status: 'sent', categoryCount: 1 });
    expect(h.sender.onlyText).toContain('Fun');
    expect(h.sender.onlyText).not.toContain('Food');
  });

  it('drops a category whose budget was deactivated', async () => {
    const food = await h.seedCategory('Food', 50_000n, { reminder: true });
    await h.seedCategory('Fun', 25_000n, { reminder: true });

    const budgets = await h.budgets.activeBudgets(USER);
    const foodBudget = budgets.find((b) => b.categoryId === food)!;
    await h.budgets.deactivate(USER, foodBudget.id);

    const outcome = await h.allowance.computeAndSend(USER);
    expect(outcome.categoryCount).toBe(1);
    expect(h.sender.onlyText).not.toContain('Food');
  });

  it('marks the bundle skipped, not sent or failed, when every category drops out', async () => {
    const food = await h.seedCategory('Food', 50_000n, { reminder: true });
    await h.reminders.disable(USER, food);

    const outcome = await h.allowance.computeAndSend(USER);
    expect(outcome).toMatchObject({ status: 'skipped', categoryCount: 0 });
    expect(h.sender.callCount).toBe(0);
  });

  it('retires a dropped category row rather than leaving it pending forever', async () => {
    const food = await h.seedCategory('Food', 50_000n, { reminder: true });
    const fun = await h.seedCategory('Fun', 25_000n, { reminder: true });
    // Open both rows, then make one ineligible.
    await h.allowance.availableToday(USER);
    await h.categories.archive(USER, food);

    await h.allowance.computeAndSend(USER);

    const byCategory = new Map(h.store.allowanceSends.map((s) => [s.categoryId, s]));
    // A row left `pending` would keep the user due and be re-dropped every tick.
    expect(byCategory.get(food)!.deliveryStatus).toBe('skipped');
    expect(byCategory.get(fun)!.deliveryStatus).toBe('sent');
  });

  it('retires the pending row it opened when the bundle empties', async () => {
    const food = await h.seedCategory('Food', 50_000n, { reminder: true });
    // Open the row first, then make the category ineligible.
    await h.allowance.availableToday(USER, food);
    expect(h.store.allowanceSends[0]!.deliveryStatus).toBe('pending');

    await h.categories.archive(USER, food);
    await h.allowance.computeAndSend(USER);

    expect(h.store.allowanceSends[0]!.deliveryStatus).toBe('skipped');
  });
});

describe('computeAndSend — delivery failures', () => {
  it('leaves the bundle pending for the next tick on a 429', async () => {
    const rateLimited = createHarnessWithResults({ status: 'retryable', retryAfterSeconds: 30 });
    await rateLimited.seedCategory('Food', 50_000n, { reminder: true });

    const outcome = await rateLimited.allowance.computeAndSend(USER);
    expect(outcome).toMatchObject({ status: 'pending', retryable: true, retryAfterSeconds: 30 });
    expect(rateLimited.store.allowanceSends[0]).toMatchObject({
      deliveryStatus: 'pending',
      attempts: 1,
    });
  });

  it('gives up after three attempts and marks the bundle failed', async () => {
    const failing = createHarnessWithResults(
      { status: 'retryable' },
      { status: 'retryable' },
      { status: 'retryable' },
    );
    await failing.seedCategory('Food', 50_000n, { reminder: true });

    let outcome = await failing.allowance.computeAndSend(USER);
    expect(outcome.status).toBe('pending');
    outcome = await failing.allowance.computeAndSend(USER);
    expect(outcome.status).toBe('pending');
    outcome = await failing.allowance.computeAndSend(USER);

    expect(outcome.status).toBe('failed');
    expect(failing.store.allowanceSends[0]).toMatchObject({
      deliveryStatus: 'failed',
      attempts: MAX_SEND_ATTEMPTS,
    });
  });

  it('deactivates the connection and stops trying when the user blocked the bot', async () => {
    const blocked = createHarnessWithResults({ status: 'skipped', reason: 'blocked' });
    await blocked.seedCategory('Food', 50_000n, { reminder: true });

    const outcome = await blocked.allowance.computeAndSend(USER);
    expect(outcome.status).toBe('skipped');
    expect(blocked.store.allowanceSends[0]!.deliveryStatus).toBe('skipped');
    expect(blocked.connections.deactivated).toEqual([USER]);
  });

  it('marks a 400 failed rather than retrying a message that cannot succeed', async () => {
    const broken = createHarnessWithResults({ status: 'permanent' });
    await broken.seedCategory('Food', 50_000n, { reminder: true });

    const outcome = await broken.allowance.computeAndSend(USER);
    expect(outcome.status).toBe('failed');
    expect(broken.store.allowanceSends[0]).toMatchObject({ deliveryStatus: 'failed', attempts: 0 });
  });

  it('shares one outcome across the whole bundle — never partly sent, partly pending', async () => {
    const rateLimited = createHarnessWithResults({ status: 'retryable' });
    rateLimited.gate.reminderLimit = 5;
    await rateLimited.seedCategory('Food', 50_000n, { reminder: true });
    await rateLimited.seedCategory('Fun', 25_000n, { reminder: true });

    await rateLimited.allowance.computeAndSend(USER);

    const statuses = new Set(rateLimited.store.allowanceSends.map((s) => s.deliveryStatus));
    expect(statuses).toEqual(new Set(['pending']));
    expect(rateLimited.store.allowanceSends.every((s) => s.attempts === 1)).toBe(true);
  });
});

describe('M3 couplings', () => {
  let h: Harness;
  beforeEach(() => {
    h = createHarness();
  });

  it('ledgerChanged is a no-op — available_today is derived, so nothing needs invalidating', async () => {
    const food = await h.seedCategory('Food', 50_000n);
    await h.allowance.availableToday(USER, food);
    const before = [...h.store.allowanceSends];

    await h.allowance.ledgerChanged(USER, '2026-09-10');

    expect(h.store.allowanceSends).toEqual(before);
  });

  it('archiving a category turns its reminder off', async () => {
    const food = await h.seedCategory('Food', 50_000n, { reminder: true });
    expect(await h.reminders.enabledCategoryIds(USER)).toEqual([food]);

    await h.categories.archive(USER, food);

    expect(await h.reminders.enabledCategoryIds(USER)).toEqual([]);
  });

  it('archiving retires a pending row so an in-flight bundle cannot pick it up', async () => {
    const food = await h.seedCategory('Food', 50_000n, { reminder: true });
    await h.allowance.availableToday(USER, food);

    await h.categories.archive(USER, food);

    expect(h.store.allowanceSends[0]!.deliveryStatus).toBe('skipped');
  });

  it('recording a transaction does not disturb the persisted target', async () => {
    const food = await h.seedCategory('Food', 50_000n);
    await h.allowance.availableToday(USER, food);
    await h.spend(food, 4_000n);
    expect(h.store.allowanceSends[0]!.dailyTargetMinorUnits).toBe(2_000n);
  });
});

/** A harness whose sender replies with a scripted sequence of results, then succeeds. */
function createHarnessWithResults(...results: SendResult[]): Harness {
  const h = createHarness();
  h.sender.script(...results);
  return h;
}
