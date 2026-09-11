import {
  DefaultAllowanceService,
  DefaultReminderSelectionService,
  type AllowanceConnectionDirectory,
  type AllowanceUserSettings,
  type ReminderCapacityGate,
} from '../../../src/core/allowance';
import { DefaultBudgetService, type BudgetUserSettings } from '../../../src/core/budgets';
import type { GatedAction } from '../../../src/core/entitlements';
import { EntitlementRefusal } from '../../../src/core/entitlements';
import {
  DefaultCategoryService,
  DefaultLedgerService,
  type CategoryCapacityGate,
  type LedgerUserSettings,
  type ValidatedCandidate,
} from '../../../src/core/ledger';
import type { Channel, Id, LocalDate, UserId } from '../../../src/core/shared/common';
import type { ChannelConnection } from '../../../src/core/shared/messaging';
import { FakeMessageSender } from '../../support/fake-message-sender';
import { InMemoryAllowanceRepository } from '../../support/in-memory-allowance-repository';
import { InMemoryBudgetRepository } from '../../support/in-memory-budget-repository';
import { InMemoryLedgerRepository } from '../../support/in-memory-ledger-repository';
import { InMemoryStore } from '../../support/in-memory-store';
import { TestClock } from '../../support/test-clock';

export const USER = 'user-1';

/**
 * M8's `gate`, reduced to the reminder limit M5 depends on. The real thing runs under
 * an advisory lock inside a transaction — M8's own suite covers that; this covers M5's
 * reaction to being refused, and the fact that it counts *inside* the gate.
 */
export class FakeReminderGate
  implements ReminderCapacityGate<InMemoryStore>, CategoryCapacityGate<InMemoryStore>
{
  readonly actions: GatedAction['kind'][] = [];
  reminderLimit = 1;
  categoryLimit = 10;

  constructor(private readonly store: InMemoryStore) {}

  async gate<T>(
    userId: UserId,
    action: GatedAction,
    write: (executor: InMemoryStore) => Promise<T>,
  ): Promise<T> {
    this.actions.push(action.kind);
    if (action.kind === 'enable_reminder') {
      const enabled = this.store.categories.filter(
        (c) => c.userId === userId && !c.isArchived && this.store.reminderEnabled.has(c.id),
      ).length;
      if (enabled >= this.reminderLimit) {
        throw new EntitlementRefusal(
          'REMINDER_CATEGORY_LIMIT',
          `You can have reminders on ${this.reminderLimit} category on Free.`,
        );
      }
    }
    if (action.kind === 'create_category') {
      const active = this.store.categories.filter((c) => c.userId === userId && !c.isArchived).length;
      if (active >= this.categoryLimit) {
        throw new EntitlementRefusal('CATEGORY_LIMIT', 'Too many categories.');
      }
    }
    return write(this.store);
  }
}

/** M2's connection surface, reduced to the 403 path. */
export class FakeConnectionDirectory implements AllowanceConnectionDirectory {
  readonly deactivated: UserId[] = [];
  connection: ChannelConnection | null = {
    id: 'conn-1',
    userId: USER,
    channel: 'telegram',
    externalId: '99',
    chatId: '99',
    isActive: true,
    linkedAt: 0,
  };

  async findActiveConnection(_userId: UserId, _channel: Channel): Promise<ChannelConnection | null> {
    return this.connection;
  }

  async deactivateConnection(userId: UserId, _channel: Channel): Promise<void> {
    this.deactivated.push(userId);
    this.connection = null;
  }
}

export interface Harness {
  store: InMemoryStore;
  clock: TestClock;
  gate: FakeReminderGate;
  connections: FakeConnectionDirectory;
  sender: FakeMessageSender;
  budgets: DefaultBudgetService<InMemoryStore>;
  categories: DefaultCategoryService<InMemoryStore>;
  ledger: DefaultLedgerService<InMemoryStore>;
  allowance: DefaultAllowanceService<InMemoryStore>;
  reminders: DefaultReminderSelectionService<InMemoryStore>;
  settings: BudgetUserSettings & LedgerUserSettings & AllowanceUserSettings;
  /** Create a category with a cap, optionally with the 07:00 reminder switched on. */
  seedCategory(name: string, cap: bigint, opts?: { reminder?: boolean }): Promise<Id>;
  /** Log a confirmed expense against a category on a local date. */
  spend(categoryId: Id, amount: bigint, occurredOn?: LocalDate): Promise<void>;
}

/**
 * M3, M4 and M5 wired the way the composition root wires them — real services over
 * in-memory repositories sharing one store, so a target really is computed from a
 * materialised period and a real ledger sum.
 *
 * Default clock is 2026-09-10T02:00:00Z, which is 12:00 on 2026-09-10 in Sydney. The
 * anchor is the 5th, so the cycle runs 5 Sep – 4 Oct: 25 days left including today.
 */
export function createHarness(now = '2026-09-10T02:00:00Z'): Harness {
  const store = new InMemoryStore();
  const clock = new TestClock(now);
  const gate = new FakeReminderGate(store);
  const connections = new FakeConnectionDirectory();
  const sender = new FakeMessageSender();

  const harness = {
    store,
    clock,
    gate,
    connections,
    sender,
    settings: {
      timezone: 'Australia/Sydney',
      currencyCode: 'AUD',
      periodAnchorDate: '2026-01-05' as LocalDate | null,
      accountCreatedOn: '2026-01-05',
      reminderLocalTime: '07:00',
    },
  } as Harness;

  const settingsOf = async () => harness.settings;

  harness.budgets = new DefaultBudgetService({
    repository: new InMemoryBudgetRepository(store),
    settingsOf,
    clock,
  });

  const ledgerRepository = new InMemoryLedgerRepository(store);
  const allowanceRepository = new InMemoryAllowanceRepository(store);

  harness.allowance = new DefaultAllowanceService({
    repository: allowanceRepository,
    budgets: harness.budgets,
    ledger: {
      spendInPeriod: (...args) => harness.ledger.spendInPeriod(...args),
      spentOn: (...args) => harness.ledger.spentOn(...args),
    },
    settingsOf,
    connections,
    sender,
    clock,
  });

  harness.reminders = new DefaultReminderSelectionService({
    repository: allowanceRepository,
    budgets: harness.budgets,
    entitlements: gate,
  });

  harness.categories = new DefaultCategoryService({
    repository: ledgerRepository,
    entitlements: gate,
    budgets: harness.budgets,
    settingsOf,
    clock,
    allowance: harness.allowance,
  });

  harness.ledger = new DefaultLedgerService({
    repository: ledgerRepository,
    periods: harness.budgets,
    settingsOf,
    clock,
    allowance: harness.allowance,
  });

  harness.seedCategory = async (name, cap, opts) => {
    const created = await harness.categories.create(USER, name);
    await harness.budgets.setCap(USER, created.id, cap);
    if (opts?.reminder) await harness.reminders.enable(USER, created.id);
    return created.id;
  };

  harness.spend = async (categoryId, amount, occurredOn = '2026-09-10') => {
    await harness.ledger.record(USER, candidate({ categoryId, amountMinorUnits: amount, occurredOn }));
  };

  return harness;
}

export function candidate(overrides: Partial<ValidatedCandidate> = {}): ValidatedCandidate {
  const occurredOn = overrides.occurredOn ?? '2026-09-10';
  return {
    direction: 'expense',
    amountMinorUnits: 1000n,
    currencyCode: 'AUD',
    occurredAt: sydneyNoon(occurredOn),
    occurredOn,
    categoryId: null,
    rawText: 'test',
    parseRoute: 'mechanical',
    ...overrides,
  };
}

/** Sydney is UTC+10 (AEST) or UTC+11 (AEDT); noon local is 01:00Z or 02:00Z. */
export function sydneyNoon(localDate: LocalDate): number {
  const utcNoon = Date.parse(`${localDate}T12:00:00Z`);
  const month = new Date(utcNoon).getUTCMonth();
  const offset = month >= 3 && month <= 8 ? 10 : 11;
  return utcNoon - offset * 3_600_000;
}
