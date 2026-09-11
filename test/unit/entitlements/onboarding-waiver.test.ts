import { describe, expect, it } from 'vitest';
import { makeHarness } from './harness';

/**
 * The onboarding waiver — `admitMessage(..., { skipDailyCap: true })`, added with M7
 * stage 4B.
 *
 * Free admits five messages per user-local day and a callback tap is an admitted event
 * (M8, "Non-message events"), so `/start` plus the five onboarding answers is six: a
 * brand-new Free user was refused `DAILY_MESSAGE_LIMIT` before they could finish
 * signing up, and M7's own acceptance test ("walk /start end-to-end in under five
 * minutes") could never have passed.
 *
 * Ricky's ruling, 11 Sep 2026: the daily cap is a product limit on a working account
 * and is waived until onboarding completes; fair use is abuse protection and is never
 * waived. That is why the two checks became separable here rather than M7 skipping the
 * gate — skipping it would have dropped the rate limit too.
 */

describe('admitMessage — the onboarding waiver', () => {
  it('admits past the daily cap while the caller says the user is still signing up', async () => {
    const h = makeHarness();
    const user = h.addUser();

    const results = [];
    for (let i = 0; i < 8; i++) {
      results.push(
        await h.service.admitMessage(user, `onboarding-${i}`, h.clock.now(), { skipDailyCap: true }),
      );
    }

    expect(results.every((r) => r.outcome === 'admitted')).toBe(true);
  });

  it('still records every waived message, so fair use counts them', async () => {
    const h = makeHarness();
    const user = h.addUser();

    for (let i = 0; i < 6; i++) {
      await h.service.admitMessage(user, `onboarding-${i}`, h.clock.now(), { skipDailyCap: true });
    }

    expect(h.repository.usageRows(user)).toHaveLength(6);
    expect(h.repository.usageRows(user).every((row) => !row.countsTowardDaily)).toBe(true);
  });

  it('refuses on fair use even while the daily cap is waived', async () => {
    const h = makeHarness();
    const user = h.addUser();

    // Twenty in the rolling window is the ceiling for both tiers.
    for (let i = 0; i < 20; i++) {
      await h.service.admitMessage(user, `w-${i}`, h.clock.now(), { skipDailyCap: true });
    }
    const next = await h.service.admitMessage(user, 'w-21', h.clock.now(), { skipDailyCap: true });

    expect(next).toMatchObject({ outcome: 'refused', code: 'FAIR_USE_LIMIT' });
  });

  it('leaves the day untouched: the quota starts from zero once onboarding ends', async () => {
    const h = makeHarness();
    const user = h.addUser();
    for (let i = 0; i < 6; i++) {
      await h.service.admitMessage(user, `onboarding-${i}`, h.clock.now(), { skipDailyCap: true });
    }

    // Five more, now counting — all admitted, because the waived six are invisible to
    // the daily count. The sixth is the one that is refused.
    const after = [];
    for (let i = 0; i < 5; i++) {
      after.push(await h.service.admitMessage(user, `live-${i}`, h.clock.now()));
    }
    const sixth = await h.service.admitMessage(user, 'live-6', h.clock.now());

    expect(after.every((r) => r.outcome === 'admitted')).toBe(true);
    expect(sixth).toMatchObject({ outcome: 'refused', code: 'DAILY_MESSAGE_LIMIT' });
  });

  it('counts by default, so no existing caller changed behaviour', async () => {
    const h = makeHarness();
    const user = h.addUser();

    await h.service.admitMessage(user, 'm-1', h.clock.now());

    expect(h.repository.usageRows(user)[0]!.countsTowardDaily).toBe(true);
  });
});
