import type { Clock } from '../ports/clock';
import type { Instant, Tier, UserId } from '../ports/common';
import {
  EntitlementRefusal,
  type AdmissionResult,
  type CapacityCounts,
  type DowngradeEligibility,
  type EntitlementService,
  type GatedAction,
} from '../ports/entitlement-service';
import { DEFAULT_LIMITS, MINUTE_MS, type EntitlementLimits, type TierLimits } from './limits';
import { formatLocalTime, localDateOf, nextLocalMidnight } from './local-time';
import {
  ALREADY_FREE,
  categoryLimitRefusal,
  combinedRefusal,
  dailyRefusal,
  downgradeCleanup,
  fairUseRefusal,
  reminderLimitRefusal,
} from './messages';
import type {
  CapacityReader,
  EntitlementReads,
  EntitlementRow,
  EntitlementStore,
  EntitlementTx,
  TimezoneReader,
} from './ports';

export interface EntitlementServiceDeps<X> {
  store: EntitlementStore<X>;
  capacity: CapacityReader<X>;
  /** M2's immutable timezone for the user — anchors the daily reset. */
  timezoneOf: TimezoneReader;
  /** Used for tier validity (`current_period_end`). Message accounting uses `receivedAt`. */
  clock: Clock;
  /** Settled policy; override only in tests. */
  limits?: EntitlementLimits;
}

/**
 * `EntitlementService` — the policy, independent of storage. Every decision is made
 * inside one store transaction under a per-user lock, so "check then record" is one
 * atomic step (M8 invariants: exactly-once admission; a refusal never consumes a
 * slot; capacity checks atomic with the write they gate).
 *
 * `X` is the executor type of the store (Drizzle transaction handle in production,
 * an arbitrary test "world" in memory) — see `gate` for why callers care.
 */
export class EntitlementServiceImpl<X> implements EntitlementService {
  private readonly store: EntitlementStore<X>;
  private readonly capacity: CapacityReader<X>;
  private readonly timezoneOf: TimezoneReader;
  private readonly clock: Clock;
  private readonly limits: EntitlementLimits;

  constructor(deps: EntitlementServiceDeps<X>) {
    this.store = deps.store;
    this.capacity = deps.capacity;
    this.timezoneOf = deps.timezoneOf;
    this.clock = deps.clock;
    this.limits = deps.limits ?? DEFAULT_LIMITS;
  }

  // ---- tier ---------------------------------------------------------------------

  /** Re-read on every call; honours `status` *and* `current_period_end`. Never cached. */
  async tierOf(userId: UserId): Promise<Tier> {
    return this.resolveTier(await this.store.activeEntitlement(userId));
  }

  private resolveTier(row: EntitlementRow | null): Tier {
    if (!row || row.status !== 'active' || row.tier !== 'premium') return 'free';
    if (row.currentPeriodEnd !== null && row.currentPeriodEnd <= this.clock.now()) return 'free';
    return 'premium';
  }

  private async tierIn(reads: EntitlementReads, userId: UserId): Promise<Tier> {
    return this.resolveTier(await reads.activeEntitlement(userId));
  }

  // ---- message admission --------------------------------------------------------

  /**
   * One atomic check-and-record. Order inside the transaction:
   *   1. per-user advisory lock (serialises concurrent redelivery)
   *   2. duplicate `messageId` → `duplicate`, before any limit check — a redelivery of
   *      an already-counted message is never refused and never counted again
   *   3. fair-use rolling window (both tiers) and Free daily cap, evaluated together
   *   4. refused → return without writing; admitted → insert the `usage_counter` row
   */
  async admitMessage(userId: UserId, messageId: string, receivedAt: Instant): Promise<AdmissionResult> {
    const timeZone = await this.timezoneOf(userId);
    const { fairUse } = this.limits;

    return this.store.transaction(async (tx) => {
      await tx.lockUser(userId, 'admission');

      if (await tx.hasUsage(userId, messageId)) return { outcome: 'duplicate' };

      const tier = await this.tierIn(tx, userId);
      const tierLimits = this.limits.tiers[tier];
      const localDate = localDateOf(receivedAt, timeZone);

      // Rolling window: events with admittedAt > receivedAt - windowMs count; one exactly
      // windowMs old has left. Not a wall-clock bucket.
      const window = await tx.usageInWindow(userId, receivedAt - fairUse.windowMs);
      const fairUseRetryAt: Instant | null =
        window.count >= fairUse.maxMessages && window.earliest !== null
          ? window.earliest + fairUse.windowMs
          : null;

      let dailyRetryAt: Instant | null = null;
      if (tierLimits.dailyMessages !== null) {
        const used = await tx.usageOnLocalDate(userId, localDate);
        if (used >= tierLimits.dailyMessages) dailyRetryAt = nextLocalMidnight(receivedAt, timeZone);
      }

      if (fairUseRetryAt !== null || dailyRetryAt !== null) {
        return this.refusal({ receivedAt, timeZone, tierLimits, fairUseRetryAt, dailyRetryAt });
      }

      await tx.insertUsage({ userId, messageId, admittedAt: receivedAt, localDate });
      return { outcome: 'admitted' };
    });
  }

  private refusal(args: {
    receivedAt: Instant;
    timeZone: string;
    tierLimits: TierLimits;
    fairUseRetryAt: Instant | null;
    dailyRetryAt: Instant | null;
  }): AdmissionResult {
    const { fairUse } = this.limits;
    const windowMinutes = fairUse.windowMs / MINUTE_MS;
    const minutesUntil = (at: Instant): number => Math.max(1, Math.ceil((at - args.receivedAt) / MINUTE_MS));

    if (args.fairUseRetryAt !== null && args.dailyRetryAt !== null) {
      // Both exhausted: the later eligibility time wins, and the text explains both.
      const later = args.dailyRetryAt >= args.fairUseRetryAt ? 'daily' : 'fairUse';
      const retryAt = later === 'daily' ? args.dailyRetryAt : args.fairUseRetryAt;
      return {
        outcome: 'refused',
        code: later === 'daily' ? 'DAILY_MESSAGE_LIMIT' : 'FAIR_USE_LIMIT',
        retryAt,
        message: combinedRefusal({
          later,
          dailyLimit: args.tierLimits.dailyMessages ?? 0,
          resetLabel: this.resetLabel(args.dailyRetryAt, args.timeZone),
          maxMessages: fairUse.maxMessages,
          windowMinutes,
          minutes: minutesUntil(args.fairUseRetryAt),
        }),
      };
    }

    if (args.dailyRetryAt !== null) {
      return {
        outcome: 'refused',
        code: 'DAILY_MESSAGE_LIMIT',
        retryAt: args.dailyRetryAt,
        message: dailyRefusal(args.tierLimits.dailyMessages ?? 0, this.resetLabel(args.dailyRetryAt, args.timeZone)),
      };
    }

    const retryAt = args.fairUseRetryAt as Instant; // one of the two is non-null here
    return {
      outcome: 'refused',
      code: 'FAIR_USE_LIMIT',
      retryAt,
      message: fairUseRefusal(fairUse.maxMessages, windowMinutes, minutesUntil(retryAt)),
    };
  }

  private resetLabel(at: Instant, timeZone: string): string {
    return `${formatLocalTime(at, timeZone)} (${timeZone})`;
  }

  // ---- capacity gates -----------------------------------------------------------

  /** Standalone check. For a check that is atomic with the write it gates, use `gate`. */
  async assertAllowed(userId: UserId, action: GatedAction): Promise<void> {
    await this.gate(userId, action, async () => undefined);
  }

  /**
   * Run `write` in the same transaction as — and serialised behind — the capacity
   * check, under a per-user lock. Two concurrent category creations at 9/10 queue
   * here; the second re-counts after the first commits and is refused. M3/M5 call
   * this with their own insert/update as `write(executor)`.
   */
  async gate<T>(userId: UserId, action: GatedAction, write: (executor: X) => Promise<T>): Promise<T> {
    return this.store.transaction(async (tx) => {
      await tx.lockUser(userId, 'capacity');
      await this.check(tx, userId, action);
      return write(tx.executor);
    });
  }

  private async check(tx: EntitlementTx<X>, userId: UserId, action: GatedAction): Promise<void> {
    const tier = await this.tierIn(tx, userId);
    const limits = this.limits.tiers[tier];
    const premium = this.limits.tiers.premium;

    switch (action.kind) {
      case 'create_category':
      case 'reactivate_category': {
        const current = await this.capacity.activeCategoryCount(userId, tx.executor);
        if (current >= limits.categories) {
          throw new EntitlementRefusal(
            'CATEGORY_LIMIT',
            categoryLimitRefusal(tier, limits.categories, premium.categories),
          );
        }
        return;
      }
      case 'enable_reminder': {
        const current = await this.capacity.reminderCategoryCount(userId, tx.executor);
        if (current >= limits.reminderCategories) {
          throw new EntitlementRefusal(
            'REMINDER_CATEGORY_LIMIT',
            reminderLimitRefusal(tier, limits.reminderCategories, premium.reminderCategories),
          );
        }
        return;
      }
      case 'request_downgrade': {
        if (tier === 'free') throw new EntitlementRefusal('NO_SUBSCRIPTION', ALREADY_FREE);
        const assessment = await this.assess(tx, userId, tier);
        if (!assessment.eligible) {
          throw new EntitlementRefusal(
            assessment.mustRemove.categories > 0 ? 'CATEGORY_LIMIT' : 'REMINDER_CATEGORY_LIMIT',
            assessment.message,
          );
        }
        return;
      }
    }
  }

  // ---- downgrade ----------------------------------------------------------------

  /** Reports what must go before Free's limits fit. Removes nothing — that's M3/M5's job. */
  async assessDowngrade(userId: UserId): Promise<DowngradeEligibility> {
    return this.store.transaction(async (tx) => {
      await tx.lockUser(userId, 'capacity');
      return this.assess(tx, userId, await this.tierIn(tx, userId));
    });
  }

  private async assess(tx: EntitlementTx<X>, userId: UserId, tier: Tier): Promise<DowngradeEligibility> {
    const free = this.limits.tiers.free;
    const limits: CapacityCounts = { categories: free.categories, reminderCategories: free.reminderCategories };
    const current: CapacityCounts = {
      categories: await this.capacity.activeCategoryCount(userId, tx.executor),
      reminderCategories: await this.capacity.reminderCategoryCount(userId, tx.executor),
    };
    const mustRemove: CapacityCounts = {
      categories: Math.max(0, current.categories - limits.categories),
      reminderCategories: Math.max(0, current.reminderCategories - limits.reminderCategories),
    };
    const eligible = mustRemove.categories === 0 && mustRemove.reminderCategories === 0;
    return {
      eligible,
      tier,
      current,
      limits,
      mustRemove,
      message: eligible ? '' : downgradeCleanup(current, limits, mustRemove),
    };
  }
}

export function createEntitlementService<X>(deps: EntitlementServiceDeps<X>): EntitlementServiceImpl<X> {
  return new EntitlementServiceImpl(deps);
}
