import type {
  AllowanceReads,
  AllowanceRepository,
  AllowanceSend,
  AllowanceWrites,
  DeliveryStatus,
  DueUserRow,
  DueWindow,
  NewAllowanceSendInput,
  ReminderCategory,
} from '../../src/core/allowance';
import type { Id, Instant, LocalDate, UserId } from '../../src/core/shared/common';
import { fakeId } from './fake-id';
import type { InMemoryStore } from './in-memory-store';

/**
 * `AllowanceRepository` over an `InMemoryStore` — a test adapter, not evidence that
 * Drizzle or Postgres works (M5's plan, "Testing").
 *
 * It models the one guarantee M5's service logic leans on: `insertSend` is idempotent
 * on `(userId, categoryId, localDate)` and returns the *winner*, standing in for
 * `daily_allowance_send_user_category_date_unique`. That is what makes "the target is
 * written once and never recomputed" testable here at all.
 *
 * `findDueUsers` throws rather than guessing. Its whole substance is Postgres doing
 * per-user `at time zone` arithmetic, and a hand-rolled TypeScript imitation would
 * pass while the real query was wrong — the exact failure mode M1 warned about with
 * in-memory repositories. `test/integration/allowance.test.ts` exercises it against a
 * real database instead.
 */
export class InMemoryAllowanceRepository implements AllowanceRepository<InMemoryStore> {
  constructor(private readonly store: InMemoryStore) {}

  withExecutor(executor: InMemoryStore): AllowanceReads & AllowanceWrites {
    return new InMemoryAllowanceRepository(executor);
  }

  async findSend(
    userId: UserId,
    categoryId: Id,
    localDate: LocalDate,
  ): Promise<AllowanceSend | null> {
    return (
      this.store.allowanceSends.find(
        (s) => s.userId === userId && s.categoryId === categoryId && s.localDate === localDate,
      ) ?? null
    );
  }

  async listSendsForDate(userId: UserId, localDate: LocalDate): Promise<readonly AllowanceSend[]> {
    return this.store.allowanceSends.filter(
      (s) => s.userId === userId && s.localDate === localDate,
    );
  }

  findDueUsers(_window: DueWindow, _limit: number): Promise<readonly DueUserRow[]> {
    return Promise.reject(
      new Error('findDueUsers is SQL-only — see test/integration/allowance.test.ts'),
    );
  }

  async listCategories(userId: UserId): Promise<readonly ReminderCategory[]> {
    return this.store.categories
      .filter((c) => c.userId === userId && !c.isArchived)
      .sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name))
      .map((c) => this.toReminderCategory(c.id, c.name, c.isArchived));
  }

  async findCategory(userId: UserId, categoryId: Id): Promise<ReminderCategory | null> {
    const found = this.store.categories.find((c) => c.userId === userId && c.id === categoryId);
    return found ? this.toReminderCategory(found.id, found.name, found.isArchived) : null;
  }

  async countReminderCategories(userId: UserId): Promise<number> {
    return this.store.categories.filter(
      (c) => c.userId === userId && !c.isArchived && this.store.reminderEnabled.has(c.id),
    ).length;
  }

  async insertSend(input: NewAllowanceSendInput): Promise<AllowanceSend> {
    // Stands in for the unique constraint: the row that got there first wins, and its
    // target — not the caller's — is what comes back.
    const existing = await this.findSend(input.userId, input.categoryId, input.localDate);
    if (existing) return existing;

    const row: AllowanceSend = {
      id: fakeId('send'),
      userId: input.userId,
      categoryId: input.categoryId,
      localDate: input.localDate,
      dailyTargetMinorUnits: input.dailyTargetMinorUnits,
      budgetPeriodId: input.budgetPeriodId,
      deliveryStatus: input.deliveryStatus,
      attempts: 0,
      sentAt: null,
      createdAt: 0,
    };
    this.store.allowanceSends = [...this.store.allowanceSends, row];
    return row;
  }

  async markSends(ids: readonly Id[], status: DeliveryStatus, now: Instant): Promise<void> {
    const wanted = new Set(ids);
    this.store.allowanceSends = this.store.allowanceSends.map((s) =>
      wanted.has(s.id) ? { ...s, deliveryStatus: status, sentAt: status === 'sent' ? now : s.sentAt } : s,
    );
  }

  async incrementAttempts(ids: readonly Id[]): Promise<number> {
    const wanted = new Set(ids);
    let highest = 0;
    this.store.allowanceSends = this.store.allowanceSends.map((s) => {
      if (!wanted.has(s.id)) return s;
      const attempts = s.attempts + 1;
      highest = Math.max(highest, attempts);
      return { ...s, attempts };
    });
    return highest;
  }

  async setReminderEnabled(_userId: UserId, categoryId: Id, enabled: boolean): Promise<void> {
    if (enabled) this.store.reminderEnabled.add(categoryId);
    else this.store.reminderEnabled.delete(categoryId);
  }

  private toReminderCategory(id: Id, name: string, isArchived: boolean): ReminderCategory {
    return { categoryId: id, name, isArchived, reminderEnabled: this.store.reminderEnabled.has(id) };
  }
}
