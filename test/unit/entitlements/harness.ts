import { TestClock } from '../../../src/core/testing/test-clock';
import type { UserId } from '../../../src/core/ports/common';
import { MemoryEntitlementStore } from '../../../src/core/entitlements/memory-store';
import { createEntitlementService } from '../../../src/core/entitlements/service';
import type { EntitlementLimits } from '../../../src/core/entitlements/limits';
import type { CapacityReader } from '../../../src/core/entitlements/ports';

/**
 * A stand-in for the state M3 (categories) and M5 (reminder selection) own. The
 * memory store hands this object to `gate` as the executor, so a test's "domain
 * write" mutates it inside the same locked section as the capacity check — the
 * same shape M3 gets with a Drizzle transaction handle.
 */
export interface World {
  users: Map<UserId, { timezone: string; categories: string[]; reminders: Set<string> }>;
}

export const capacityFromWorld: CapacityReader<World> = {
  async activeCategoryCount(userId, world) {
    return world.users.get(userId)?.categories.length ?? 0;
  },
  async reminderCategoryCount(userId, world) {
    return world.users.get(userId)?.reminders.size ?? 0;
  },
};

export function makeHarness(opts: { start?: string; limits?: EntitlementLimits } = {}) {
  const world: World = { users: new Map() };
  const clock = new TestClock(opts.start ?? '2026-09-06T00:00:00.000Z');
  const store = new MemoryEntitlementStore<World>(world);
  const service = createEntitlementService<World>({
    store,
    capacity: capacityFromWorld,
    clock,
    timezoneOf: async (userId) => {
      const u = world.users.get(userId);
      if (!u) throw new Error(`harness: unknown user ${userId}`);
      return u.timezone;
    },
    ...(opts.limits ? { limits: opts.limits } : {}),
  });

  let seq = 0;
  function addUser(args: { timezone?: string; categories?: number; reminders?: number; tier?: 'free' | 'premium' } = {}): UserId {
    seq += 1;
    const userId = `00000000-0000-4000-8000-${String(seq).padStart(12, '0')}`;
    const categories = Array.from({ length: args.categories ?? 0 }, (_, i) => `cat-${i + 1}`);
    const reminders = new Set(categories.slice(0, args.reminders ?? 0));
    world.users.set(userId, { timezone: args.timezone ?? 'Australia/Brisbane', categories, reminders });
    if (args.tier === 'premium') {
      store.grant(userId, { tier: 'premium', status: 'active', currentPeriodEnd: null });
    }
    return userId;
  }

  /** Admit `n` distinct messages at `clock.now()`, optionally stepping the clock between them. */
  async function admitMany(userId: UserId, n: number, opts2: { stepMs?: number; prefix?: string } = {}) {
    const results = [];
    for (let i = 0; i < n; i++) {
      results.push(await service.admitMessage(userId, `${opts2.prefix ?? 'm'}-${i}`, clock.now()));
      if (opts2.stepMs) clock.advance(opts2.stepMs);
    }
    return results;
  }

  return { world, clock, store, service, addUser, admitMany };
}

export function at(iso: string): number {
  return Date.parse(iso);
}

/** Let other microtasks run — used to open a real interleaving window in concurrency tests. */
export const tick = () => new Promise<void>((r) => setTimeout(r, 0));
