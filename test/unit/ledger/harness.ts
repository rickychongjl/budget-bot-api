import { DefaultBudgetService, type BudgetUserSettings } from '../../../src/core/budgets';
import type { GatedAction } from '../../../src/core/entitlements';
import { EntitlementRefusal } from '../../../src/core/entitlements';
import {
  DefaultCategoryService,
  DefaultLedgerService,
  type AllowanceNotifier,
  type CategoryCapacityGate,
  type LedgerUserSettings,
  type ValidatedCandidate,
} from '../../../src/core/ledger';
import type { Id, LocalDate, UserId } from '../../../src/core/shared/common';
import { InMemoryBudgetRepository } from '../../support/in-memory-budget-repository';
import { InMemoryLedgerRepository } from '../../support/in-memory-ledger-repository';
import { InMemoryStore } from '../../support/in-memory-store';
import { TestClock } from '../../support/test-clock';

export const USER = 'user-1';
export const OTHER_USER = 'user-2';

/**
 * M8's `gate`, reduced to what M3 depends on: it refuses past a capacity limit, and
 * it runs M3's write with an executor. The real thing does this under an advisory
 * lock inside a transaction — M8's own suite covers that; this one covers M3's
 * reaction to being refused.
 */
export class FakeCapacityGate implements CategoryCapacityGate<InMemoryStore> {
  readonly actions: GatedAction['kind'][] = [];
  categoryLimit = 10;

  constructor(private readonly store: InMemoryStore) {}

  async gate<T>(userId: UserId, action: GatedAction, write: (executor: InMemoryStore) => Promise<T>): Promise<T> {
    this.actions.push(action.kind);
    if (action.kind === 'create_category' || action.kind === 'reactivate_category') {
      const active = this.store.categories.filter((c) => c.userId === userId && !c.isArchived).length;
      if (active >= this.categoryLimit) {
        throw new EntitlementRefusal('CATEGORY_LIMIT', `Free tier allows ${this.categoryLimit} categories.`);
      }
    }
    return write(this.store);
  }
}

/** Records what M3 tells M5, so the coupling is observable without M5 existing. */
export class RecordingAllowanceNotifier implements AllowanceNotifier {
  readonly changed: { userId: UserId; localDate: LocalDate }[] = [];
  readonly archived: { userId: UserId; categoryId: Id }[] = [];
  failOnLedgerChange = false;

  async ledgerChanged(userId: UserId, localDate: LocalDate): Promise<void> {
    if (this.failOnLedgerChange) throw new Error('M5 is down');
    this.changed.push({ userId, localDate });
  }

  async categoryArchived(userId: UserId, categoryId: Id): Promise<void> {
    this.archived.push({ userId, categoryId });
  }
}

export interface Harness {
  store: InMemoryStore;
  clock: TestClock;
  capacity: FakeCapacityGate;
  allowance: RecordingAllowanceNotifier;
  budgets: DefaultBudgetService<InMemoryStore>;
  categories: DefaultCategoryService<InMemoryStore>;
  ledger: DefaultLedgerService<InMemoryStore>;
  /** Mutate to change what M2 reports mid-test (currency, anchor, creation date). */
  settings: BudgetUserSettings & LedgerUserSettings;
}

/**
 * M3 and M4 wired together the way the composition root wires them — real services
 * over in-memory repositories that share one store, so `record` really does
 * materialise a period and insert a ledger row in one transaction.
 */
export function createHarness(now = '2026-09-10T02:00:00Z'): Harness {
  const store = new InMemoryStore();
  const clock = new TestClock(now);
  const capacity = new FakeCapacityGate(store);
  const allowance = new RecordingAllowanceNotifier();

  const harness = {
    store,
    clock,
    capacity,
    allowance,
    settings: {
      timezone: 'Australia/Sydney',
      currencyCode: 'AUD',
      periodAnchorDate: '2026-01-05' as LocalDate | null,
      accountCreatedOn: '2026-01-05',
    },
  } as Harness;

  const settingsOf = async () => harness.settings;

  harness.budgets = new DefaultBudgetService({
    repository: new InMemoryBudgetRepository(store),
    settingsOf,
    clock,
  });

  const ledgerRepository = new InMemoryLedgerRepository(store);

  harness.categories = new DefaultCategoryService({
    repository: ledgerRepository,
    entitlements: capacity,
    budgets: harness.budgets,
    settingsOf,
    clock,
    allowance,
  });

  harness.ledger = new DefaultLedgerService({
    repository: ledgerRepository,
    periods: harness.budgets,
    settingsOf,
    clock,
    allowance,
  });

  return harness;
}

/**
 * A candidate shaped the way M6 hands one over: `occurredAt` is local noon of the
 * date it resolved, which is why M3 can re-derive `occurred_on` from it and get the
 * same answer.
 */
export function candidate(overrides: Partial<ValidatedCandidate> = {}): ValidatedCandidate {
  const occurredOn = overrides.occurredOn ?? '2026-09-10';
  return {
    direction: 'expense',
    amountMinorUnits: 8240n,
    currencyCode: 'AUD',
    occurredAt: sydneyNoon(occurredOn),
    occurredOn,
    categoryId: null,
    rawText: 'woolies 82.40',
    parseRoute: 'mechanical',
    ...overrides,
  };
}

/** Sydney is UTC+10 (AEST) or UTC+11 (AEDT); noon local is 01:00Z or 02:00Z. */
export function sydneyNoon(localDate: LocalDate): number {
  const utcNoon = Date.parse(`${localDate}T12:00:00Z`);
  const offset = new Date(utcNoon).getUTCMonth() >= 3 && new Date(utcNoon).getUTCMonth() <= 8 ? 10 : 11;
  return utcNoon - offset * 3_600_000;
}
