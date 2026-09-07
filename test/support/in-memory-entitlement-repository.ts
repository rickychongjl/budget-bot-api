import type { Instant, LocalDate, UserId } from '../../src/core/shared/common';
import type {
  EntitlementRepository,
  EntitlementRow,
  EntitlementTransaction,
  UsageRow,
  WindowUsage,
} from '../../src/core/entitlements/entitlement-repository';

/**
 * In-memory `EntitlementRepository` for unit tests (and for other modules' unit tests
 * that need a working entitlement gate without Postgres). A test adapter — it proves
 * nothing about Drizzle or Postgres; `test/integration/entitlements.test.ts` does that.
 *
 * Faithful where it matters for the policy: per-user, per-scope locks are held for
 * the whole `runInTransaction` callback, so concurrent admissions and gated writes
 * serialise exactly as `pg_advisory_xact_lock` makes them in Postgres. Not faithful
 * on rollback — writes apply immediately. The service only writes as the last step
 * of a transaction, so nothing here depends on rollback.
 */
export class InMemoryEntitlementRepository<X = undefined> implements EntitlementRepository<X> {
  private readonly entitlementsByUser = new Map<UserId, EntitlementRow[]>();
  private readonly usage = new Map<UserId, Map<string, UsageRow>>();
  private readonly locks = new Map<string, Promise<void>>();

  constructor(private readonly executor: X = undefined as X) {}

  // ---- test setup helpers -------------------------------------------------

  grant(userId: UserId, row: EntitlementRow): void {
    const rows = this.entitlementsByUser.get(userId) ?? [];
    if (row.status === 'active' && rows.some((r) => r.status === 'active')) {
      throw new Error('entitlement_one_active: user already has an active entitlement');
    }
    rows.push({ ...row });
    this.entitlementsByUser.set(userId, rows);
  }

  /** Mutate the user's active row in place (e.g. flip `status`) — mirrors a Phase 2 state change. */
  updateActive(userId: UserId, patch: Partial<EntitlementRow>): void {
    const row = (this.entitlementsByUser.get(userId) ?? []).find((r) => r.status === 'active');
    if (!row) throw new Error('no active entitlement to update');
    Object.assign(row, patch);
  }

  usageRows(userId: UserId): readonly UsageRow[] {
    return [...(this.usage.get(userId)?.values() ?? [])];
  }

  // ---- reads ------------------------------------------------------------------

  async findActiveEntitlement(userId: UserId): Promise<EntitlementRow | null> {
    const row = (this.entitlementsByUser.get(userId) ?? []).find((r) => r.status === 'active');
    return row ? { ...row } : null;
  }

  async hasUsage(userId: UserId, messageId: string): Promise<boolean> {
    return this.usage.get(userId)?.has(messageId) ?? false;
  }

  async getUsageInWindow(userId: UserId, after: Instant): Promise<WindowUsage> {
    let count = 0;
    let earliest: Instant | null = null;
    for (const row of this.usage.get(userId)?.values() ?? []) {
      if (row.admittedAt > after) {
        count += 1;
        if (earliest === null || row.admittedAt < earliest) earliest = row.admittedAt;
      }
    }
    return { count, earliest };
  }

  async countUsageOnLocalDate(userId: UserId, localDate: LocalDate): Promise<number> {
    let count = 0;
    for (const row of this.usage.get(userId)?.values() ?? []) {
      if (row.localDate === localDate) count += 1;
    }
    return count;
  }

  // ---- transaction ------------------------------------------------------------

  async runInTransaction<T>(fn: (tx: EntitlementTransaction<X>) => Promise<T>): Promise<T> {
    const released: Array<() => void> = [];
    const tx: EntitlementTransaction<X> = {
      executor: this.executor,
      findActiveEntitlement: (u) => this.findActiveEntitlement(u),
      hasUsage: (u, m) => this.hasUsage(u, m),
      getUsageInWindow: (u, a) => this.getUsageInWindow(u, a),
      countUsageOnLocalDate: (u, d) => this.countUsageOnLocalDate(u, d),
      lockUser: async (userId, scope) => {
        released.push(await this.acquire(`${scope}:${userId}`));
      },
      recordUsage: async (row) => {
        const byUser = this.usage.get(row.userId) ?? new Map<string, UsageRow>();
        if (!byUser.has(row.messageId)) byUser.set(row.messageId, { ...row });
        this.usage.set(row.userId, byUser);
      },
    };
    try {
      return await fn(tx);
    } finally {
      for (const release of released.reverse()) release();
    }
  }

  /** Per-key async mutex: resolves once every earlier holder of `key` has released. */
  private async acquire(key: string): Promise<() => void> {
    const previous = this.locks.get(key) ?? Promise.resolve();
    let release!: () => void;
    const mine = new Promise<void>((resolve) => {
      release = resolve;
    });
    const chained = previous.then(() => mine);
    this.locks.set(key, chained);
    await previous;
    return () => {
      release();
      if (this.locks.get(key) === chained) this.locks.delete(key);
    };
  }
}
