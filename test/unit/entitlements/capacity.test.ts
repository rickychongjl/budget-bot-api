import { describe, expect, it } from 'vitest';
import { EntitlementRefusal, isEntitlementRefusal } from '../../../src/core/entitlements/entitlement-service';
import { NotConfiguredStarsBilling } from '../../../src/core/entitlements/billing';
import { at, makeHarness, tick, type World } from './harness';

async function refusalOf(p: Promise<unknown>): Promise<EntitlementRefusal> {
  try {
    await p;
  } catch (e) {
    if (isEntitlementRefusal(e)) return e;
    throw e;
  }
  throw new Error('expected an EntitlementRefusal');
}

describe('tierOf', () => {
  it('is Free with no entitlement row', async () => {
    const h = makeHarness();
    expect(await h.service.tierOf(h.addUser())).toBe('free');
  });

  it('is Premium for an active row with no period end, or a future one', async () => {
    const h = makeHarness({ start: '2026-09-06T00:00:00Z' });
    const open = h.addUser();
    h.repository.grant(open, { tier: 'premium', status: 'active', currentPeriodEnd: null });
    const dated = h.addUser();
    h.repository.grant(dated, { tier: 'premium', status: 'active', currentPeriodEnd: at('2026-10-06T00:00:00Z') });
    expect(await h.service.tierOf(open)).toBe('premium');
    expect(await h.service.tierOf(dated)).toBe('premium');
  });

  it('re-validates every call — lapses to Free the instant current_period_end passes, with no status change', async () => {
    const h = makeHarness({ start: '2026-10-05T23:59:59.999Z' });
    const user = h.addUser();
    h.repository.grant(user, { tier: 'premium', status: 'active', currentPeriodEnd: at('2026-10-06T00:00:00Z') });
    expect(await h.service.tierOf(user)).toBe('premium');
    h.clock.advance(1);
    expect(await h.service.tierOf(user)).toBe('free');
  });

  it('is Free once the row is no longer active (expired / cancelled / refunded)', async () => {
    for (const status of ['expired', 'cancelled', 'refunded'] as const) {
      const h = makeHarness();
      const user = h.addUser();
      h.repository.grant(user, { tier: 'premium', status: 'active', currentPeriodEnd: null });
      expect(await h.service.tierOf(user)).toBe('premium');
      h.repository.updateActive(user, { status });
      expect(await h.service.tierOf(user)).toBe('free');
    }
  });

  it('gated actions use the live tier — a lapsed Premium user is held to Free limits', async () => {
    const h = makeHarness({ start: '2026-09-06T00:00:00Z' });
    const user = h.addUser({ categories: 12 });
    h.repository.grant(user, { tier: 'premium', status: 'active', currentPeriodEnd: at('2026-09-07T00:00:00Z') });
    await expect(h.service.assertAllowed(user, { kind: 'create_category' })).resolves.toBeUndefined();
    h.clock.set(at('2026-09-07T00:00:00Z'));
    expect((await refusalOf(h.service.assertAllowed(user, { kind: 'create_category' }))).code).toBe('CATEGORY_LIMIT');
  });
});

describe('assertAllowed — category capacity (non-archived only: 10 Free / 30 Premium)', () => {
  it('Free: allowed at 9, refused at 10', async () => {
    const h = makeHarness();
    const nine = h.addUser({ categories: 9 });
    const ten = h.addUser({ categories: 10 });
    await expect(h.service.assertAllowed(nine, { kind: 'create_category' })).resolves.toBeUndefined();
    const r = await refusalOf(h.service.assertAllowed(ten, { kind: 'create_category' }));
    expect(r.code).toBe('CATEGORY_LIMIT');
    expect(r.retryAt).toBeNull();
    expect(r.message).toBe(
      "You've reached the Free limit of 10 categories. Archive one you're not using first, or upgrade to Premium for up to 30.",
    );
  });

  it('Premium: allowed at 29, refused at 30', async () => {
    const h = makeHarness();
    const ok = h.addUser({ categories: 29, tier: 'premium' });
    const full = h.addUser({ categories: 30, tier: 'premium' });
    await expect(h.service.assertAllowed(ok, { kind: 'create_category' })).resolves.toBeUndefined();
    const r = await refusalOf(h.service.assertAllowed(full, { kind: 'create_category' }));
    expect(r.code).toBe('CATEGORY_LIMIT');
    expect(r.message).toBe("You've reached the Premium limit of 30 categories. Archive one you're not using first.");
  });

  it('reactivating an archived category re-consumes a slot under the same rule', async () => {
    const h = makeHarness();
    const full = h.addUser({ categories: 10 });
    expect((await refusalOf(h.service.assertAllowed(full, { kind: 'reactivate_category' }))).code).toBe('CATEGORY_LIMIT');
    // An archived category is simply absent from the count the owner supplies.
    h.world.users.get(full)!.categories.pop();
    await expect(h.service.assertAllowed(full, { kind: 'reactivate_category' })).resolves.toBeUndefined();
  });
});

describe('assertAllowed — reminder-enabled categories (1 Free / 5 Premium)', () => {
  it('Free: one reminder only; Premium: five', async () => {
    const h = makeHarness();
    const free0 = h.addUser({ categories: 5, reminders: 0 });
    const free1 = h.addUser({ categories: 5, reminders: 1 });
    const prem4 = h.addUser({ categories: 10, reminders: 4, tier: 'premium' });
    const prem5 = h.addUser({ categories: 10, reminders: 5, tier: 'premium' });

    await expect(h.service.assertAllowed(free0, { kind: 'enable_reminder' })).resolves.toBeUndefined();
    const r = await refusalOf(h.service.assertAllowed(free1, { kind: 'enable_reminder' }));
    expect(r.code).toBe('REMINDER_CATEGORY_LIMIT');
    expect(r.message).toBe(
      'You can have reminders on 1 category on Free. Turn a reminder off first, or upgrade to Premium for up to 5.',
    );
    await expect(h.service.assertAllowed(prem4, { kind: 'enable_reminder' })).resolves.toBeUndefined();
    expect((await refusalOf(h.service.assertAllowed(prem5, { kind: 'enable_reminder' }))).message).toBe(
      'You can have reminders on 5 categories on Premium. Turn a reminder off first.',
    );
  });

  it('counts reminders, not budgets — Free can budget all 10 categories while reminding 1', async () => {
    const h = makeHarness();
    const user = h.addUser({ categories: 10, reminders: 0 });
    await expect(h.service.assertAllowed(user, { kind: 'enable_reminder' })).resolves.toBeUndefined();
  });
});

describe('gate — capacity check atomic with the write it guards', () => {
  it('two concurrent category creations at 9/10 cannot both succeed', async () => {
    const h = makeHarness();
    const user = h.addUser({ categories: 9 });
    const create = (name: string) =>
      h.service.gate(user, { kind: 'create_category' }, async (world: World) => {
        await tick(); // open a real interleaving window between check and write
        world.users.get(user)!.categories.push(name);
        return name;
      });

    const outcomes = await Promise.allSettled([create('a'), create('b'), create('c')]);
    const fulfilled = outcomes.filter((o) => o.status === 'fulfilled');
    const refused = outcomes.filter(
      (o): o is PromiseRejectedResult => o.status === 'rejected' && isEntitlementRefusal(o.reason),
    );
    expect(fulfilled).toHaveLength(1);
    expect(refused).toHaveLength(2);
    expect(h.world.users.get(user)!.categories).toHaveLength(10);
  });

  it('a refused gate never runs the write', async () => {
    const h = makeHarness();
    const user = h.addUser({ categories: 10 });
    let ran = false;
    await expect(
      h.service.gate(user, { kind: 'create_category' }, async () => {
        ran = true;
      }),
    ).rejects.toBeInstanceOf(EntitlementRefusal);
    expect(ran).toBe(false);
  });

  it('a category creation racing a downgrade check serialises behind it', async () => {
    const h = makeHarness();
    const user = h.addUser({ categories: 10, reminders: 1, tier: 'premium' });
    // Downgrade assessment holds the capacity lock; the creation must wait and see 10 → refused
    // for Premium? No — Premium allows 30. The point is ordering: the assessment sees 10 (eligible),
    // and the creation that lands after it is what M3's downgrade flow must re-check. Assert order.
    const order: string[] = [];
    const assess = h.service.assessDowngrade(user).then((r) => {
      order.push('assess');
      return r;
    });
    const create = h.service.gate(user, { kind: 'create_category' }, async (world: World) => {
      world.users.get(user)!.categories.push('late');
      order.push('create');
    });
    const [eligibility] = await Promise.all([assess, create]);
    expect(order).toEqual(['assess', 'create']);
    expect(eligibility.eligible).toBe(true);
    // Re-assessing after the creation reports the new state — nothing is cached.
    expect((await h.service.assessDowngrade(user)).eligible).toBe(false);
  });
});

describe('assessDowngrade / request_downgrade (≤10 categories AND ≤1 reminder)', () => {
  it('11 categories / 2 reminders is refused with concrete cleanup instructions', async () => {
    const h = makeHarness();
    const user = h.addUser({ categories: 11, reminders: 2, tier: 'premium' });
    const a = await h.service.assessDowngrade(user);
    expect(a).toEqual({
      eligible: false,
      tier: 'premium',
      current: { categories: 11, reminderCategories: 2 },
      limits: { categories: 10, reminderCategories: 1 },
      mustRemove: { categories: 1, reminderCategories: 1 },
      message:
        'Before switching to Free, archive 1 category (you have 11, Free allows 10) and turn off reminders on 1 category (you have 2 with reminders, Free allows 1).',
    });
    const r = await refusalOf(h.service.assertAllowed(user, { kind: 'request_downgrade' }));
    expect(r.code).toBe('CATEGORY_LIMIT');
    expect(r.message).toBe(a.message);
    // Assessing never removed anything.
    expect(h.world.users.get(user)!.categories).toHaveLength(11);
    expect(h.world.users.get(user)!.reminders.size).toBe(2);
  });

  it('10 categories / 1 reminder is eligible', async () => {
    const h = makeHarness();
    const user = h.addUser({ categories: 10, reminders: 1, tier: 'premium' });
    expect(await h.service.assessDowngrade(user)).toMatchObject({
      eligible: true,
      mustRemove: { categories: 0, reminderCategories: 0 },
      message: '',
    });
    await expect(h.service.assertAllowed(user, { kind: 'request_downgrade' })).resolves.toBeUndefined();
  });

  it('only the reminder count over → REMINDER_CATEGORY_LIMIT; pluralises correctly', async () => {
    const h = makeHarness();
    const user = h.addUser({ categories: 8, reminders: 4, tier: 'premium' });
    const r = await refusalOf(h.service.assertAllowed(user, { kind: 'request_downgrade' }));
    expect(r.code).toBe('REMINDER_CATEGORY_LIMIT');
    expect(r.message).toBe(
      'Before switching to Free, turn off reminders on 3 categories (you have 4 with reminders, Free allows 1).',
    );
  });

  it('a Free user has nothing to downgrade', async () => {
    const h = makeHarness();
    const user = h.addUser({ categories: 3 });
    expect((await h.service.assessDowngrade(user)).tier).toBe('free');
    expect((await refusalOf(h.service.assertAllowed(user, { kind: 'request_downgrade' }))).code).toBe('NO_SUBSCRIPTION');
  });
});

describe('Stars billing (Phase 2) — stubbed as unavailable, never a silent success', () => {
  it('every handler reports not_configured / BILLING_UNAVAILABLE', async () => {
    const billing = new NotConfiguredStarsBilling();
    const event = { chargeId: 'c1', periodEnd: null, amountStars: 100, receivedAt: 0 };
    for (const outcome of [
      await billing.onPurchase('u', event),
      await billing.onRenewal('u', event),
      await billing.onRefund('u', 'c1', 0),
    ]) {
      expect(outcome).toMatchObject({ status: 'not_configured', code: 'BILLING_UNAVAILABLE' });
    }
  });
});
