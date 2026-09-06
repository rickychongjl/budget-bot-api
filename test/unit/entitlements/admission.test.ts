import { describe, expect, it } from 'vitest';
import { DEFAULT_LIMITS, MINUTE_MS } from '../../../src/core/entitlements/limits';
import { at, makeHarness } from './harness';

const MIN = MINUTE_MS;
const HOUR = 60 * MIN;

describe('admitMessage — fair-use rolling window (20 per 120 minutes, both tiers)', () => {
  it('refuses the 21st message inside the window and admits the 22nd once the earliest ages out', async () => {
    const h = makeHarness({ start: '2026-09-06T00:00:00Z' });
    const user = h.addUser({ tier: 'premium' }); // Premium: only the rolling window applies
    const t0 = h.clock.now();

    // 20 messages, one per minute: t0 .. t0+19min.
    const admitted = await h.admitMany(user, 20, { stepMs: MIN });
    expect(admitted.every((r) => r.outcome === 'admitted')).toBe(true);

    // 21st at t0+20min → refused. Earliest counted message was at t0, so it expires at t0+120min.
    h.clock.set(t0 + 20 * MIN);
    const r21 = await h.service.admitMessage(user, 'm-21', h.clock.now());
    expect(r21).toMatchObject({ outcome: 'refused', code: 'FAIR_USE_LIMIT', retryAt: t0 + 120 * MIN });
    if (r21.outcome !== 'refused') throw new Error('unreachable');
    expect(r21.message).toBe("You've reached 20 messages in 2 hours. Try again in 100 minutes.");

    // One millisecond before the earliest leaves the window: still refused.
    h.clock.set(t0 + 120 * MIN - 1);
    expect(await h.service.admitMessage(user, 'm-21b', h.clock.now())).toMatchObject({ outcome: 'refused' });

    // Exactly 120 minutes after the earliest: it has left the window → admitted (a sliding
    // window, not a fixed bucket — only ONE slot frees, because only m-0 aged out).
    h.clock.set(t0 + 120 * MIN);
    expect(await h.service.admitMessage(user, 'm-22', h.clock.now())).toEqual({ outcome: 'admitted' });
    const r23 = await h.service.admitMessage(user, 'm-23', h.clock.now());
    expect(r23).toMatchObject({ outcome: 'refused', code: 'FAIR_USE_LIMIT', retryAt: t0 + 121 * MIN });
  });

  it('cannot be exploited by a burst straddling a 2-hour wall-clock boundary', async () => {
    // A fixed-bucket implementation keyed on floor(t / 2h) would allow 20 at 01:59 and
    // another 20 at 02:00. The rolling window must refuse the 21st regardless of the clock face.
    const h = makeHarness({ start: '2026-09-06T01:59:00Z' });
    const user = h.addUser({ tier: 'premium' });

    const before = await h.admitMany(user, 20, { prefix: 'before' });
    expect(before.filter((r) => r.outcome === 'admitted')).toHaveLength(20);

    h.clock.set(at('2026-09-06T02:00:00Z'));
    const after = await h.admitMany(user, 21, { prefix: 'after' });
    expect(after.filter((r) => r.outcome === 'admitted')).toHaveLength(0);
    expect(after[0]).toMatchObject({ outcome: 'refused', code: 'FAIR_USE_LIMIT', retryAt: at('2026-09-06T03:59:00Z') });
    if (after[0]?.outcome !== 'refused') throw new Error('unreachable');
    expect(after[0].message).toContain('Try again in 119 minutes.');

    // The same holds at 04:00 for the *second* bucket boundary: nothing new was admitted,
    // so at 03:59 all 20 free up together.
    h.clock.set(at('2026-09-06T03:59:00Z'));
    const later = await h.admitMany(user, 21, { prefix: 'later' });
    expect(later.filter((r) => r.outcome === 'admitted')).toHaveLength(20);
    expect(later[20]).toMatchObject({ outcome: 'refused' });
  });

  it('a refused attempt consumes no slot', async () => {
    const h = makeHarness({ start: '2026-09-06T00:00:00Z' });
    const user = h.addUser({ tier: 'premium' });
    const t0 = h.clock.now();
    await h.admitMany(user, 20, { stepMs: MIN });

    // Hammer with refused attempts — none may be recorded.
    for (let i = 0; i < 10; i++) {
      expect(await h.service.admitMessage(user, `spam-${i}`, h.clock.now())).toMatchObject({ outcome: 'refused' });
    }
    expect(h.store.usageRows(user)).toHaveLength(20);

    // When exactly one slot frees, exactly one new message gets in.
    h.clock.set(t0 + 120 * MIN);
    expect(await h.service.admitMessage(user, 'fresh-1', h.clock.now())).toEqual({ outcome: 'admitted' });
    expect(await h.service.admitMessage(user, 'fresh-2', h.clock.now())).toMatchObject({ outcome: 'refused' });
  });

  it('rounds the wait up and singularises "1 minute"', async () => {
    const h = makeHarness({ start: '2026-09-06T00:00:00Z' });
    const user = h.addUser({ tier: 'premium' });
    const t0 = h.clock.now();
    await h.admitMany(user, 20);
    h.clock.set(t0 + 119 * MIN + 30_000); // 30s left in the window
    const r = await h.service.admitMessage(user, 'x', h.clock.now());
    if (r.outcome !== 'refused') throw new Error('expected refusal');
    expect(r.message).toBe("You've reached 20 messages in 2 hours. Try again in 1 minute.");
  });
});

describe('admitMessage — Free daily cap (5 per user-local day, midnight in the immutable timezone)', () => {
  it("refuses Free's 6th message of the local day with the local reset time, and admits at the reset", async () => {
    // Brisbane is UTC+10, no DST. 2026-09-06T14:00Z is 7 Sep 00:00 local.
    const h = makeHarness({ start: '2026-09-06T14:00:00Z' });
    const user = h.addUser({ timezone: 'Australia/Brisbane' });

    const five = await h.admitMany(user, 5, { stepMs: MIN });
    expect(five.every((r) => r.outcome === 'admitted')).toBe(true);

    const sixth = await h.service.admitMessage(user, 'm-6', h.clock.now());
    expect(sixth).toMatchObject({
      outcome: 'refused',
      code: 'DAILY_MESSAGE_LIMIT',
      retryAt: at('2026-09-07T14:00:00Z'), // 8 Sep 00:00 Brisbane
    });
    if (sixth.outcome !== 'refused') throw new Error('unreachable');
    expect(sixth.message).toBe("You've used your 5 messages today. Your limit resets at 12:00 am (Australia/Brisbane).");

    // The last millisecond of the local day is still refused …
    h.clock.set(at('2026-09-07T13:59:59.999Z'));
    expect(await h.service.admitMessage(user, 'm-6b', h.clock.now())).toMatchObject({ outcome: 'refused' });
    // … and local midnight admits, with a fresh local_date on the row.
    h.clock.set(at('2026-09-07T14:00:00Z'));
    expect(await h.service.admitMessage(user, 'm-7', h.clock.now())).toEqual({ outcome: 'admitted' });
    expect(h.store.usageRows(user).map((r) => r.localDate).sort()).toEqual([
      '2026-09-07', '2026-09-07', '2026-09-07', '2026-09-07', '2026-09-07', '2026-09-08',
    ]);
  });

  it('resets on the user-local day, not the UTC day — two users, same instant, different answers', async () => {
    // 2026-09-06T13:30Z = 23:30 Brisbane (6 Sep) but 06:30 in Auckland (7 Sep, NZST +12)... pick
    // Honolulu (-10): 03:30 on 6 Sep. Each user sends 5 at 13:30Z, then 1 at 14:30Z.
    const h = makeHarness({ start: '2026-09-06T13:30:00Z' });
    const brisbane = h.addUser({ timezone: 'Australia/Brisbane' });
    const honolulu = h.addUser({ timezone: 'Pacific/Honolulu' });
    await h.admitMany(brisbane, 5, { prefix: 'b' });
    await h.admitMany(honolulu, 5, { prefix: 'h' });

    h.clock.set(at('2026-09-06T14:30:00Z')); // Brisbane crossed midnight; Honolulu did not
    expect(await h.service.admitMessage(brisbane, 'b-late', h.clock.now())).toEqual({ outcome: 'admitted' });
    const hr = await h.service.admitMessage(honolulu, 'h-late', h.clock.now());
    expect(hr).toMatchObject({ outcome: 'refused', code: 'DAILY_MESSAGE_LIMIT', retryAt: at('2026-09-07T10:00:00Z') });
  });

  it('honours a 23-hour local day at a DST transition (Sydney, 4 Oct 2026)', async () => {
    const h = makeHarness({ start: '2026-10-03T14:00:00Z' }); // 4 Oct 00:00 AEST
    const user = h.addUser({ timezone: 'Australia/Sydney' });
    await h.admitMany(user, 5);
    const r = await h.service.admitMessage(user, 'over', h.clock.now());
    // Next midnight is 5 Oct 00:00 AEDT = 4 Oct 13:00Z — 23 hours later, not 24.
    expect(r).toMatchObject({ outcome: 'refused', retryAt: at('2026-10-04T13:00:00Z') });
  });

  it("admits Premium's 100th message of the day (no daily cap; fair use still applies)", async () => {
    const h = makeHarness({ start: '2026-09-06T14:00:00Z' });
    const user = h.addUser({ timezone: 'Australia/Brisbane', tier: 'premium' });
    // 100 messages 8 minutes apart: ≤15 in any 120-minute window, all within one Brisbane day.
    const results = await h.admitMany(user, 100, { stepMs: 8 * MIN });
    expect(results.filter((r) => r.outcome === 'admitted')).toHaveLength(100);
    expect(results[99]).toEqual({ outcome: 'admitted' });
  });

  it('the daily cap and the rolling window are independent — Free hits the day first', async () => {
    const h = makeHarness({ start: '2026-09-06T14:00:00Z' });
    const user = h.addUser({ timezone: 'Australia/Brisbane' });
    await h.admitMany(user, 5);
    const r = await h.service.admitMessage(user, 'x', h.clock.now());
    expect(r).toMatchObject({ outcome: 'refused', code: 'DAILY_MESSAGE_LIMIT' });
  });
});

describe('admitMessage — both limits exhausted', () => {
  // Unreachable under the real numbers (Free's 5/day < 20/2h), so exercise the branch
  // with an injected policy: 3/day and 3 per 2h.
  const limits = {
    ...DEFAULT_LIMITS,
    tiers: { ...DEFAULT_LIMITS.tiers, free: { ...DEFAULT_LIMITS.tiers.free, dailyMessages: 3 } },
    fairUse: { maxMessages: 3, windowMs: 2 * HOUR },
  };

  it('returns the later eligibility time (daily reset later) and explains both', async () => {
    // 3 messages at 21:00 Brisbane → window clears 23:00, day resets 00:00 → daily is later.
    const h = makeHarness({ start: '2026-09-06T11:00:00Z', limits });
    const user = h.addUser({ timezone: 'Australia/Brisbane' });
    await h.admitMany(user, 3);
    const r = await h.service.admitMessage(user, 'x', h.clock.now());
    expect(r).toMatchObject({ outcome: 'refused', code: 'DAILY_MESSAGE_LIMIT', retryAt: at('2026-09-06T14:00:00Z') });
    if (r.outcome !== 'refused') throw new Error('unreachable');
    expect(r.message).toBe(
      "You've used your 3 messages today. Your limit resets at 12:00 am (Australia/Brisbane). " +
        "You've also reached 3 messages in 2 hours, so the daily reset is the earliest you can send again.",
    );
  });

  it('returns the later eligibility time (window clears later) and explains both', async () => {
    // 3 messages at 23:30 Brisbane → day resets 00:00 (30 min), window clears 01:30 → fair use is later.
    const h = makeHarness({ start: '2026-09-06T13:30:00Z', limits });
    const user = h.addUser({ timezone: 'Australia/Brisbane' });
    await h.admitMany(user, 3);
    const r = await h.service.admitMessage(user, 'x', h.clock.now());
    expect(r).toMatchObject({ outcome: 'refused', code: 'FAIR_USE_LIMIT', retryAt: at('2026-09-06T15:30:00Z') });
    if (r.outcome !== 'refused') throw new Error('unreachable');
    expect(r.message).toBe(
      "You've reached 3 messages in 2 hours. Try again in 120 minutes. " +
        "You've also used your 3 messages today, which resets earlier, at 12:00 am (Australia/Brisbane).",
    );
  });
});

describe('admitMessage — exactly-once by stable message id', () => {
  it('a redelivered message_id is a no-op duplicate, not a second count', async () => {
    const h = makeHarness();
    const user = h.addUser();
    expect(await h.service.admitMessage(user, 'tg:123', h.clock.now())).toEqual({ outcome: 'admitted' });
    expect(await h.service.admitMessage(user, 'tg:123', h.clock.now())).toEqual({ outcome: 'duplicate' });
    expect(await h.service.admitMessage(user, 'tg:123', h.clock.now() + 5 * MIN)).toEqual({ outcome: 'duplicate' });
    expect(h.store.usageRows(user)).toHaveLength(1);
  });

  it('a redelivery of an already-counted message is a duplicate even when the user is now over limit', async () => {
    const h = makeHarness({ start: '2026-09-06T14:00:00Z' });
    const user = h.addUser();
    await h.admitMany(user, 5); // m-0 .. m-4, Free cap reached
    expect(await h.service.admitMessage(user, 'm-6', h.clock.now())).toMatchObject({ outcome: 'refused' });
    expect(await h.service.admitMessage(user, 'm-2', h.clock.now())).toEqual({ outcome: 'duplicate' });
  });

  it('concurrent redeliveries of the same id: one admitted, the rest duplicates', async () => {
    const h = makeHarness();
    const user = h.addUser();
    const results = await Promise.all(
      Array.from({ length: 8 }, () => h.service.admitMessage(user, 'tg:777', h.clock.now())),
    );
    expect(results.filter((r) => r.outcome === 'admitted')).toHaveLength(1);
    expect(results.filter((r) => r.outcome === 'duplicate')).toHaveLength(7);
    expect(h.store.usageRows(user)).toHaveLength(1);
  });

  it('concurrent distinct messages cannot overshoot the window under the per-user lock', async () => {
    const h = makeHarness();
    const user = h.addUser({ tier: 'premium' });
    const results = await Promise.all(
      Array.from({ length: 35 }, (_, i) => h.service.admitMessage(user, `c-${i}`, h.clock.now())),
    );
    expect(results.filter((r) => r.outcome === 'admitted')).toHaveLength(20);
    expect(results.filter((r) => r.outcome === 'refused')).toHaveLength(15);
    expect(h.store.usageRows(user)).toHaveLength(20);
  });

  it('locks are per user — one user at the cap does not block another', async () => {
    const h = makeHarness({ start: '2026-09-06T14:00:00Z' });
    const a = h.addUser();
    const b = h.addUser();
    await h.admitMany(a, 5, { prefix: 'a' });
    const [ra, rb] = await Promise.all([
      h.service.admitMessage(a, 'a-6', h.clock.now()),
      h.service.admitMessage(b, 'b-1', h.clock.now()),
    ]);
    expect(ra).toMatchObject({ outcome: 'refused' });
    expect(rb).toEqual({ outcome: 'admitted' });
  });
});
