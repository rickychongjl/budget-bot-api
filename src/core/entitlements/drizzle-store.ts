import { and, count, eq, gt, sql } from 'drizzle-orm';
import type { Database } from '../../db/client';
import { entitlement, usageCounter } from '../../db/schema/entitlement';
import type { Instant, LocalDate, UserId } from '../ports/common';
import type {
  EntitlementReads,
  EntitlementRow,
  EntitlementStore,
  EntitlementTx,
  UsageRow,
  UserLockScope,
  WindowUsage,
} from './ports';

/**
 * Either the root Drizzle handle or a transaction handle — the executor other
 * modules' `CapacityReader`s and gated writes receive.
 */
export type DbExecutor = Database | Parameters<Parameters<Database['transaction']>[0]>[0];

const LOCK_NAMESPACE: Record<UserLockScope, string> = {
  admission: 'm8:admission',
  capacity: 'm8:capacity',
};

function reads(x: DbExecutor): EntitlementReads {
  return {
    async activeEntitlement(userId: UserId): Promise<EntitlementRow | null> {
      const [row] = await x
        .select({
          tier: entitlement.tier,
          status: entitlement.status,
          currentPeriodEnd: entitlement.currentPeriodEnd,
        })
        .from(entitlement)
        .where(and(eq(entitlement.userId, userId), eq(entitlement.status, 'active')))
        .limit(1);
      if (!row) return null;
      return {
        tier: row.tier as EntitlementRow['tier'],
        status: row.status as EntitlementRow['status'],
        currentPeriodEnd: row.currentPeriodEnd ? row.currentPeriodEnd.getTime() : null,
      };
    },

    async hasUsage(userId: UserId, messageId: string): Promise<boolean> {
      const [row] = await x
        .select({ one: sql<number>`1` })
        .from(usageCounter)
        .where(and(eq(usageCounter.userId, userId), eq(usageCounter.messageId, messageId)))
        .limit(1);
      return row !== undefined;
    },

    async usageInWindow(userId: UserId, after: Instant): Promise<WindowUsage> {
      const [row] = await x
        .select({
          count: count(),
          earliest: sql`min(${usageCounter.admittedAt})`.mapWith(usageCounter.admittedAt),
        })
        .from(usageCounter)
        .where(and(eq(usageCounter.userId, userId), gt(usageCounter.admittedAt, new Date(after))));
      const earliest = row?.earliest ?? null;
      return {
        count: row?.count ?? 0,
        earliest: earliest instanceof Date ? earliest.getTime() : null,
      };
    },

    async usageOnLocalDate(userId: UserId, localDate: LocalDate): Promise<number> {
      const [row] = await x
        .select({ count: count() })
        .from(usageCounter)
        .where(and(eq(usageCounter.userId, userId), eq(usageCounter.localDate, localDate)));
      return row?.count ?? 0;
    },
  };
}

/**
 * Production `EntitlementStore` over Drizzle / postgres.js. Per-user serialisation
 * uses a transaction-scoped advisory lock keyed on `(scope, user_id)`, so two
 * concurrent admissions (or a category creation racing a downgrade check) queue
 * behind one another and each re-reads the counts after the other commits.
 */
export class DrizzleEntitlementStore implements EntitlementStore<DbExecutor> {
  private readonly root: EntitlementReads;

  constructor(private readonly db: Database) {
    this.root = reads(db);
  }

  activeEntitlement(userId: UserId): Promise<EntitlementRow | null> {
    return this.root.activeEntitlement(userId);
  }

  hasUsage(userId: UserId, messageId: string): Promise<boolean> {
    return this.root.hasUsage(userId, messageId);
  }

  usageInWindow(userId: UserId, after: Instant): Promise<WindowUsage> {
    return this.root.usageInWindow(userId, after);
  }

  usageOnLocalDate(userId: UserId, localDate: LocalDate): Promise<number> {
    return this.root.usageOnLocalDate(userId, localDate);
  }

  transaction<T>(fn: (tx: EntitlementTx<DbExecutor>) => Promise<T>): Promise<T> {
    return this.db.transaction(async (handle) => {
      const tx: EntitlementTx<DbExecutor> = {
        ...reads(handle),
        executor: handle,
        async lockUser(userId, scope) {
          await handle.execute(
            sql`select pg_advisory_xact_lock(hashtext(${LOCK_NAMESPACE[scope]}), hashtext(${userId}))`,
          );
        },
        async insertUsage(row: UsageRow) {
          await handle
            .insert(usageCounter)
            .values({
              userId: row.userId,
              messageId: row.messageId,
              admittedAt: new Date(row.admittedAt),
              localDate: row.localDate,
            })
            .onConflictDoNothing();
        },
      };
      return fn(tx);
    });
  }
}
