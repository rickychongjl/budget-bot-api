import {
  DefaultAllowanceService,
  DefaultReminderSelectionService,
  type AllowanceConnectionDirectory,
  type AllowanceUserSettings,
  type ReminderCapacityGate,
} from '../../src/core/allowance';
import { DefaultBudgetService, type BudgetUserSettings } from '../../src/core/budgets';
import { EntitlementRefusal, type GatedAction } from '../../src/core/entitlements';
import {
  DefaultCategoryService,
  DefaultLedgerService,
  type CategoryCapacityGate,
  type LedgerUserSettings,
  type ValidatedCandidate,
} from '../../src/core/ledger';
import type { Channel, Id, LocalDate, UserId } from '../../src/core/shared/common';
import type { ChannelConnection } from '../../src/core/shared/messaging';
import { FakeMessageSender } from './fake-message-sender';
import { InMemoryAllowanceRepository } from './in-memory-allowance-repository';
import { InMemoryBudgetRepository } from './in-memory-budget-repository';
import { InMemoryLedgerRepository } from './in-memory-ledger-repository';
import { InMemoryStore } from './in-memory-store';
import type { TestClock } from './test-clock';

/**
 * M3, M4 and M5 wired the way the composition root wires them — real services over
 * in-memory repositories sharing one store.
 *
 * M7's command handlers are only worth testing against the real services: a handler's
 * entire job is to call the owning module and render what comes back, so a fake
 * service would assert nothing but that the fake was called. A `/today` figure in
 * these tests is computed from a materialised period and a real ledger sum, exactly
 * as it will be in production.
 *
 * Lives in `test/support` per CLAUDE.md. `test/unit/allowance/harness.ts` wires the
 * same graph inline and predates this file; it is left alone deliberately — it is a
 * passing suite and the regression guard for M5, not something to refactor inside a
 * feature change.
 */

export type DomainSettings = BudgetUserSettings & LedgerUserSettings & AllowanceUserSettings;

/**
 * M8's capacity gate, reduced to the two limits M3 and M5 depend on.
 *
 * The real `DefaultEntitlementService.gate` is generic over a Drizzle executor and
 * runs under an advisory lock inside a transaction; M8's own suite covers that. What
 * matters here is that a handler renders the refusal it is given, so the gate only
 * has to be able to refuse.
 */
export class FakeCapacityGate
  implements CategoryCapacityGate<InMemoryStore>, ReminderCapacityGate<InMemoryStore>
{
  readonly actions: GatedAction['kind'][] = [];
  categoryLimit = 10;
  reminderLimit = 1;

  constructor(private readonly store: InMemoryStore) {}

  async gate<T>(
    userId: UserId,
    action: GatedAction,
    write: (executor: InMemoryStore) => Promise<T>,
  ): Promise<T> {
    this.actions.push(action.kind);

    if (action.kind === 'create_category' || action.kind === 'reactivate_category') {
      const active = this.store.categories.filter((c) => c.userId === userId && !c.isArchived).length;
      if (active >= this.categoryLimit) {
        throw new EntitlementRefusal(
          'CATEGORY_LIMIT',
          `Free tier allows ${this.categoryLimit} categories.`,
        );
      }
    }

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

    return write(this.store);
  }
}

/** M2's connection surface, as M5's own send path uses it. */
class StubConnectionDirectory implements AllowanceConnectionDirectory {
  connection: ChannelConnection | null = null;

  async findActiveConnection(userId: UserId, channel: Channel): Promise<ChannelConnection | null> {
    return (
      this.connection ?? {
        id: 'conn-1',
        userId,
        channel,
        externalId: '99',
        chatId: '99',
        isActive: true,
        linkedAt: 0,
      }
    );
  }

  async deactivateConnection(): Promise<void> {
    this.connection = null;
  }
}

export interface DomainServices {
  store: InMemoryStore;
  gate: FakeCapacityGate;
  settings: DomainSettings;
  budgets: DefaultBudgetService<InMemoryStore>;
  categories: DefaultCategoryService<InMemoryStore>;
  ledger: DefaultLedgerService<InMemoryStore>;
  allowance: DefaultAllowanceService<InMemoryStore>;
  reminders: DefaultReminderSelectionService<InMemoryStore>;
  /** Create a category, optionally with a cap and the 07:00 reminder switched on. */
  seedCategory(
    userId: UserId,
    name: string,
    opts?: { cap?: bigint; reminder?: boolean },
  ): Promise<Id>;
  /** Log a confirmed expense against a category on a local date. */
  spend(userId: UserId, categoryId: Id, amount: bigint, occurredOn: LocalDate): Promise<void>;
}

export function createDomainServices(clock: TestClock, settings: DomainSettings): DomainServices {
  const store = new InMemoryStore();
  const gate = new FakeCapacityGate(store);

  const ledgerRepository = new InMemoryLedgerRepository(store);
  const allowanceRepository = new InMemoryAllowanceRepository(store);

  const services = { store, gate, settings } as DomainServices;
  const settingsOf = async (): Promise<DomainSettings> => services.settings;

  services.budgets = new DefaultBudgetService({
    repository: new InMemoryBudgetRepository(store),
    settingsOf,
    clock,
  });

  services.allowance = new DefaultAllowanceService({
    repository: allowanceRepository,
    budgets: services.budgets,
    // Resolved lazily: M5 needs M3's spend reads and M3 needs M5's notifier, so one of
    // the two has to be a closure. The composition root does exactly this.
    ledger: {
      spendInPeriod: (...args) => services.ledger.spendInPeriod(...args),
      spentOn: (...args) => services.ledger.spentOn(...args),
    },
    settingsOf,
    connections: new StubConnectionDirectory(),
    // M5's own outbound path, which no command handler goes through. Deliberately not
    // the dispatcher's sender: a test asserting "the bot replied once" must not also
    // be counting a scheduled reminder.
    sender: new FakeMessageSender(),
    clock,
  });

  services.reminders = new DefaultReminderSelectionService({
    repository: allowanceRepository,
    budgets: services.budgets,
    entitlements: gate,
  });

  services.categories = new DefaultCategoryService({
    repository: ledgerRepository,
    entitlements: gate,
    budgets: services.budgets,
    settingsOf,
    clock,
    allowance: services.allowance,
  });

  services.ledger = new DefaultLedgerService({
    repository: ledgerRepository,
    periods: services.budgets,
    settingsOf,
    clock,
    allowance: services.allowance,
  });

  services.seedCategory = async (userId, name, opts) => {
    const created = await services.categories.create(userId, name);
    if (opts?.cap !== undefined) await services.budgets.setCap(userId, created.id, opts.cap);
    if (opts?.reminder === true) await services.reminders.enable(userId, created.id);
    return created.id;
  };

  services.spend = async (userId, categoryId, amount, occurredOn) => {
    await services.ledger.record(userId, {
      direction: 'expense',
      amountMinorUnits: amount,
      currencyCode: services.settings.currencyCode,
      occurredAt: localNoon(occurredOn),
      occurredOn,
      categoryId,
      rawText: 'test',
      parseRoute: 'mechanical',
    } satisfies ValidatedCandidate);
  };

  return services;
}

/** Sydney is UTC+10 (AEST) or UTC+11 (AEDT); noon local is 01:00Z or 02:00Z. */
export function localNoon(localDate: LocalDate): number {
  const utcNoon = Date.parse(`${localDate}T12:00:00Z`);
  const month = new Date(utcNoon).getUTCMonth();
  const offset = month >= 3 && month <= 8 ? 10 : 11;
  return utcNoon - offset * 3_600_000;
}
