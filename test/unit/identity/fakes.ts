import { RefusalError } from '../../../src/core/identity';
import type {
  Budget,
  BudgetPeriod,
  BudgetService,
  BudgetView,
  Period,
} from '../../../src/core/budgets';
import type {
  DowngradeEligibility,
  EntitlementService,
  GatedAction,
} from '../../../src/core/entitlements';
import type {
  Category,
  CategoryService,
  LedgerService,
  Page,
  PageRequest,
  Transaction,
} from '../../../src/core/ledger';
import type { ReminderSelectionService } from '../../../src/core/ports';
import type { CurrencyCode, Id, LocalDate, MinorUnits, Tier, UserId } from '../../../src/core/shared/common';

/**
 * Minimal fakes for the ports M2 calls. Each enforces just the rule M2's tests care
 * about (capacity, duplicate names, transaction count) so the tests exercise M2's
 * orchestration, not the other modules' logic.
 */

export class FakeLedger implements LedgerService {
  readonly transactionsByUser = new Map<UserId, number>();
  readonly calls: string[] = [];

  addTransaction(userId: UserId): void {
    this.transactionsByUser.set(userId, (this.transactionsByUser.get(userId) ?? 0) + 1);
  }

  async history(userId: UserId, _page: PageRequest): Promise<Page<Transaction>> {
    this.calls.push('history');
    const n = this.transactionsByUser.get(userId) ?? 0;
    const items = Array.from({ length: Math.min(n, 1) }, () => ({}) as Transaction);
    return { items, nextCursor: null };
  }

  record(): Promise<Transaction> {
    return Promise.reject(new Error('not used'));
  }
  correct(): Promise<Transaction> {
    return Promise.reject(new Error('not used'));
  }
  softDelete(): Promise<void> {
    return Promise.reject(new Error('not used'));
  }
  deleteLast(): Promise<Transaction | null> {
    return Promise.reject(new Error('not used'));
  }
  exportCsv(): Promise<ReadableStream> {
    return Promise.reject(new Error('not used'));
  }
  spendInPeriod(): Promise<MinorUnits> {
    return Promise.reject(new Error('not used'));
  }
  spentOn(): Promise<MinorUnits> {
    return Promise.reject(new Error('not used'));
  }
}

export class FakeEntitlements implements EntitlementService {
  readonly tiers = new Map<UserId, Tier>();
  readonly assertions: GatedAction['kind'][] = [];

  constructor(
    private readonly categories: FakeCategories,
    private readonly reminders: FakeReminders,
    private readonly defaultTier: Tier = 'free',
  ) {}

  async tierOf(userId: UserId): Promise<Tier> {
    return this.tiers.get(userId) ?? this.defaultTier;
  }

  async admitMessage(): Promise<never> {
    throw new Error('not used');
  }

  async assertAllowed(userId: UserId, action: GatedAction): Promise<void> {
    this.assertions.push(action.kind);
    const tier = await this.tierOf(userId);
    if (action.kind === 'create_category') {
      const limit = tier === 'free' ? 10 : 30;
      const count = (await this.categories.list(userId)).length;
      if (count >= limit) {
        throw new RefusalError('CATEGORY_LIMIT', `You're at the ${limit}-category limit for the ${tier} plan.`);
      }
    }
    if (action.kind === 'enable_reminder') {
      const limit = tier === 'free' ? 1 : 5;
      const count = (await this.reminders.enabledCategoryIds(userId)).length;
      if (count >= limit) {
        throw new RefusalError('REMINDER_CATEGORY_LIMIT', `You can have reminders on ${limit} categor${limit === 1 ? 'y' : 'ies'} on the ${tier} plan.`);
      }
    }
  }

  async assessDowngrade(): Promise<DowngradeEligibility> {
    throw new Error('not used');
  }
}

export class FakeCategories implements CategoryService {
  readonly rows: Category[] = [];
  #seq = 0;

  async list(userId: UserId, opts?: { includeArchived?: boolean }): Promise<readonly Category[]> {
    return this.rows.filter((c) => c.userId === userId && (opts?.includeArchived || !c.isArchived));
  }

  async create(userId: UserId, name: string): Promise<Category> {
    const normalizedName = name.trim().toLowerCase().replace(/\s+/g, ' ');
    if (this.rows.some((c) => c.userId === userId && c.normalizedName === normalizedName)) {
      throw new RefusalError('INVALID_ARGUMENT', `duplicate category ${name}`);
    }
    const row: Category = {
      id: `cat-${++this.#seq}`,
      userId,
      name: name.trim(),
      normalizedName,
      sortOrder: this.rows.length,
      isArchived: false,
      createdAt: 0,
    };
    this.rows.push(row);
    return row;
  }

  async rename(userId: UserId, categoryId: Id, name: string): Promise<Category> {
    const row = this.rows.find((category) => category.userId === userId && category.id === categoryId);
    if (!row) throw new RefusalError('CATEGORY_NOT_FOUND');
    const normalizedName = name.trim().toLowerCase().replace(/\s+/g, ' ');
    if (
      this.rows.some(
        (category) =>
          category.userId === userId && category.id !== categoryId && category.normalizedName === normalizedName,
      )
    ) {
      throw new RefusalError('INVALID_ARGUMENT', `duplicate category ${name}`);
    }
    row.name = name.trim();
    row.normalizedName = normalizedName;
    return row;
  }

  async findByName(userId: UserId, name: string): Promise<Category | null> {
    const normalizedName = name.trim().toLowerCase().replace(/\s+/g, ' ');
    return this.rows.find((c) => c.userId === userId && c.normalizedName === normalizedName) ?? null;
  }

  async countActive(userId: UserId): Promise<number> {
    return this.rows.filter((c) => c.userId === userId && !c.isArchived).length;
  }

  async archive(userId: UserId, categoryId: Id): Promise<void> {
    const row = this.rows.find((c) => c.userId === userId && c.id === categoryId);
    if (!row) throw new RefusalError('CATEGORY_NOT_FOUND');
    row.isArchived = true;
  }

  async reactivate(userId: UserId, categoryId: Id): Promise<Category> {
    const row = this.rows.find((c) => c.userId === userId && c.id === categoryId);
    if (!row) throw new RefusalError('CATEGORY_NOT_FOUND');
    row.isArchived = false;
    return row;
  }

  /** Cascade helper for delete tests. */
  removeUser(userId: UserId): void {
    for (let i = this.rows.length - 1; i >= 0; i--) if (this.rows[i]?.userId === userId) this.rows.splice(i, 1);
  }
}

export class FakeBudgets implements BudgetService {
  readonly rows: Budget[] = [];
  #seq = 0;

  async periodFor(): Promise<Period> {
    throw new Error('not used');
  }
  async ensurePeriod(): Promise<BudgetPeriod> {
    throw new Error('not used');
  }

  async activeBudgets(userId: UserId): Promise<readonly Budget[]> {
    return this.rows.filter((b) => b.userId === userId && b.isActive);
  }

  /** M2 never renders `/budget`; present only to satisfy the port. */
  async currentBudgets(_userId: UserId, _localDate: LocalDate): Promise<readonly BudgetView[]> {
    throw new Error('not used');
  }

  async setCap(userId: UserId, categoryId: Id, cap: MinorUnits): Promise<Budget> {
    const existing = this.rows.find((b) => b.userId === userId && b.categoryId === categoryId && b.isActive);
    if (existing) {
      existing.capMinorUnits = cap;
      return existing;
    }
    const row: Budget = {
      id: `bud-${++this.#seq}`,
      userId,
      categoryId,
      capMinorUnits: cap,
      currencyCode: 'AUD',
      isActive: true,
      createdAt: 0,
      updatedAt: 0,
    };
    this.rows.push(row);
    return row;
  }

  async deactivate(userId: UserId, budgetId: Id): Promise<void> {
    const row = this.rows.find((b) => b.userId === userId && b.id === budgetId);
    if (row) row.isActive = false;
  }
}

export class FakeReminders implements ReminderSelectionService {
  readonly enabled = new Map<UserId, Set<Id>>();

  async enabledCategoryIds(userId: UserId): Promise<readonly Id[]> {
    return [...(this.enabled.get(userId) ?? [])];
  }

  async enable(userId: UserId, categoryId: Id): Promise<void> {
    let set = this.enabled.get(userId);
    if (!set) this.enabled.set(userId, (set = new Set()));
    set.add(categoryId);
  }

  async disable(userId: UserId, categoryId: Id): Promise<void> {
    this.enabled.get(userId)?.delete(categoryId);
  }
}

/** Two-decimal parser standing in for M3's `toMinorUnits` (a stub until M3 lands). */
export function parseTwoDecimals(decimal: string, _currency: CurrencyCode): MinorUnits {
  const m = /^(\d+)(?:\.(\d{1,2}))?$/.exec(decimal.trim());
  if (!m) throw new Error(`bad amount ${decimal}`);
  const cents = (m[2] ?? '').padEnd(2, '0');
  return BigInt(m[1] ?? '0') * 100n + BigInt(cents);
}

export function formatTwoDecimals(amount: MinorUnits, currency: CurrencyCode): string {
  const s = amount.toString().padStart(3, '0');
  return `${currency} ${s.slice(0, -2)}.${s.slice(-2)}`;
}
