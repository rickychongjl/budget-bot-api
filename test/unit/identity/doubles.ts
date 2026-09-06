import { IdentityServiceImpl } from '../../../src/core/identity/identity-service';
import { OnboardingService, type ReminderSelectionPort } from '../../../src/core/identity/onboarding';
import type { BudgetService, Budget } from '../../../src/core/ports/budget-service';
import type { Id, MinorUnits, Tier, UserId } from '../../../src/core/ports/common';
import type { EntitlementService, GatedAction } from '../../../src/core/ports/entitlement-service';
import type { Category, LedgerService, Page, Transaction } from '../../../src/core/ports/ledger-service';
import { InMemoryIdentityRepository } from '../../../src/core/testing/in-memory-identity-repository';
import { TestClock } from '../../../src/core/testing/test-clock';

/**
 * Hand-rolled doubles for the ports M2 calls but doesn't own. They record calls and
 * can be told to fail, nothing more — M3/M4/M5/M8 behaviour is those modules' tests.
 */

export class FakeLedger implements Pick<LedgerService, 'history' | 'createCategory'> {
  /** How many transactions `history` should pretend the user has. */
  transactionCount = 0;
  readonly created: { userId: UserId; name: string }[] = [];
  failCreateFor: string | null = null;
  #seq = 0;

  async history(_userId: UserId, page: { limit: number }): Promise<Page<Transaction>> {
    const n = Math.min(this.transactionCount, page.limit);
    return { items: Array.from({ length: n }, () => ({}) as Transaction), nextCursor: null };
  }

  async createCategory(userId: UserId, name: string): Promise<Category> {
    if (this.failCreateFor === name) throw new Error(`ledger down while creating ${name}`);
    this.#seq += 1;
    this.created.push({ userId, name });
    return {
      id: `cat-${this.#seq}`,
      userId,
      name,
      normalizedName: name.toLowerCase(),
      sortOrder: this.#seq,
      isArchived: false,
      createdAt: 0,
    };
  }
}

export class FakeEntitlements implements Pick<EntitlementService, 'tierOf' | 'assertAllowed'> {
  tier: Tier = 'free';
  readonly asserted: GatedAction['kind'][] = [];
  refuse: GatedAction['kind'] | null = null;

  async tierOf(): Promise<Tier> {
    return this.tier;
  }

  async assertAllowed(_userId: UserId, action: GatedAction): Promise<void> {
    this.asserted.push(action.kind);
    if (this.refuse === action.kind) throw new Error(`refused ${action.kind}`);
  }
}

export class FakeBudgets implements Pick<BudgetService, 'setCap'> {
  readonly caps: { categoryId: Id; cap: MinorUnits }[] = [];
  failFor: Id | null = null;

  async setCap(userId: UserId, categoryId: Id, cap: MinorUnits): Promise<Budget> {
    if (this.failFor === categoryId) throw new Error(`budget down for ${categoryId}`);
    this.caps.push({ categoryId, cap });
    return {
      id: `budget-${this.caps.length}`,
      userId,
      categoryId,
      capMinorUnits: cap,
      currencyCode: 'AUD',
      isActive: true,
      createdAt: 0,
      updatedAt: 0,
    };
  }
}

export class FakeReminders implements ReminderSelectionPort {
  readonly enabled: Id[] = [];
  failFor: Id | null = null;

  async enableReminder(_userId: UserId, categoryId: Id): Promise<void> {
    if (this.failFor === categoryId) throw new Error(`reminders down for ${categoryId}`);
    this.enabled.push(categoryId);
  }
}

export function harness(startAt = '2026-09-06T00:00:00.000Z') {
  const clock = new TestClock(startAt);
  const repo = new InMemoryIdentityRepository();
  const ledger = new FakeLedger();
  const entitlements = new FakeEntitlements();
  const budgets = new FakeBudgets();
  const reminders = new FakeReminders();
  const identity = new IdentityServiceImpl({ repo, clock, ledger });
  const onboarding = new OnboardingService({
    identity,
    ledger,
    budgets,
    entitlements,
    reminders,
    clock,
  });
  return { clock, repo, ledger, entitlements, budgets, reminders, identity, onboarding };
}

/** Registers a Telegram user and returns the id. */
export async function registered(h: ReturnType<typeof harness>, externalId = '1001'): Promise<UserId> {
  const { userId } = await h.identity.register('telegram', externalId, externalId, 'ricky');
  return userId;
}

/** Registers and walks steps 1–3 so the user is past the immutable/anchor writes. */
export async function onboarded(
  h: ReturnType<typeof harness>,
  externalId = '1001',
  timezone = 'Australia/Brisbane',
): Promise<UserId> {
  const userId = await registered(h, externalId);
  await h.identity.setInitialTimezone(userId, timezone);
  await h.identity.updateSettings(userId, { periodAnchorDate: '2026-09-01' });
  return userId;
}
