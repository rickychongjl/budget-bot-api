import { and, asc, eq, inArray, sql } from 'drizzle-orm';
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
} from '../../../core/allowance/allowance-repository';
import type { Id, Instant, LocalDate, MinorUnits, UserId } from '../../../core/shared/common';
import type { Database } from '../client';
import { dailyAllowanceSend } from '../schema/allowance';
import { budget } from '../schema/budget';
import { category } from '../schema/category';
import { appUser, channelConnection } from '../schema/identity';

/**
 * `AllowanceRepository` over Drizzle/Postgres — the only M5 code that touches a DB
 * handle.
 *
 * Two things here carry real weight rather than being plumbing:
 *
 * 1. **`insertSend` is `insert … on conflict do nothing` then a select**, the same
 *    shape as M4's `materialisePeriod`. `daily_allowance_send_user_category_date_unique`
 *    is what prevents a double-send when two ticks race, and returning the *winner*
 *    rather than the caller's computed value is what makes "the target is written once
 *    and never recomputed" true under concurrency.
 *
 * 2. **`findDueUsers` does the timezone maths in SQL.** Each user's local time is
 *    derived from their own `app_user.timezone`, so the cron stays one indexed scan
 *    instead of "fetch every user and filter in TypeScript" — which is the difference
 *    between the Workers Free plan working and not (10ms CPU, 50 subrequests).
 *
 * It also owns `category.reminder_enabled` — one column on M3's table, a deliberate
 * narrow exception to "one module owns each table" agreed 11 Sep. Nothing here reads or
 * writes any other column of `category` except to render a name and check
 * archived-ness, both of which the dispatch path must revalidate anyway.
 */

/** A Drizzle handle that may be the pool or an open transaction. Mirrors M4's and M8's. */
export type DatabaseExecutor = Database | Parameters<Parameters<Database['transaction']>[0]>[0];

type SendRow = typeof dailyAllowanceSend.$inferSelect;

function toSend(row: SendRow): AllowanceSend {
  return {
    id: row.id,
    userId: row.userId,
    categoryId: row.categoryId,
    localDate: row.localDate,
    dailyTargetMinorUnits: row.dailyTargetMinorUnits,
    budgetPeriodId: row.budgetPeriodId,
    deliveryStatus: row.deliveryStatus as DeliveryStatus,
    attempts: row.attempts,
    sentAt: row.sentAt === null ? null : row.sentAt.getTime(),
    createdAt: row.createdAt.getTime(),
  };
}

function operations(x: DatabaseExecutor): AllowanceReads & AllowanceWrites {
  return {
    async findSend(
      userId: UserId,
      categoryId: Id,
      localDate: LocalDate,
    ): Promise<AllowanceSend | null> {
      const [row] = await x
        .select()
        .from(dailyAllowanceSend)
        .where(
          and(
            eq(dailyAllowanceSend.userId, userId),
            eq(dailyAllowanceSend.categoryId, categoryId),
            eq(dailyAllowanceSend.localDate, localDate),
          ),
        )
        .limit(1);
      return row ? toSend(row) : null;
    },

    async listSendsForDate(
      userId: UserId,
      localDate: LocalDate,
    ): Promise<readonly AllowanceSend[]> {
      const rows = await x
        .select()
        .from(dailyAllowanceSend)
        .where(
          and(
            eq(dailyAllowanceSend.userId, userId),
            eq(dailyAllowanceSend.localDate, localDate),
          ),
        );
      return rows.map(toSend);
    },

    async findDueUsers(window: DueWindow, limit: number): Promise<readonly DueUserRow[]> {
      // The tick instant as a Postgres timestamptz. Everything below is derived from it
      // per user, in their own zone — `at time zone` on a timestamptz yields that zone's
      // wall clock, which is exactly what "is it 07:00 for them yet" needs.
      const tick = sql`to_timestamp(${window.now}::bigint / 1000.0)`;
      const localNow = sql`(${tick} at time zone ${appUser.timezone})`;
      const localDate = sql`(${localNow})::date`;
      const localTime = sql`(${localNow})::time`;

      const rows = await x
        .select({
          userId: appUser.id,
          localDate: sql<string>`to_char(${localDate}, 'YYYY-MM-DD')`,
          timezone: appUser.timezone,
          reminderLocalTime: sql<string>`to_char(${appUser.reminderLocalTime}, 'HH24:MI')`,
        })
        .from(appUser)
        .where(
          and(
            eq(appUser.status, 'active'),
            eq(appUser.onboardingStep, 'done'),
            // Guard the timezone cast: the empty-string sentinel M2 uses for a
            // pre-onboarding user is not a valid zone and `at time zone ''` errors.
            sql`${appUser.timezone} <> ''`,
            // Due from their reminder time until the catch-up bound closes. Both sides
            // are wall-clock times, so DST is already accounted for by the cast above.
            sql`${localTime} >= ${appUser.reminderLocalTime}`,
            sql`${localTime} < ${appUser.reminderLocalTime} + make_interval(mins => ${window.windowMinutes})`,
            // At least one non-archived, reminder-enabled category with an active budget
            // that has not already been delivered or retired today. A `pending` row is
            // still due — that is how a retryable failure gets its next attempt.
            sql`exists (
              select 1
              from ${category} c
              join ${budget} b
                on b.category_id = c.id
               and b.user_id = c.user_id
               and b.is_active
              where c.user_id = ${appUser.id}
                and c.reminder_enabled
                and not c.is_archived
                and not exists (
                  select 1
                  from ${dailyAllowanceSend} s
                  where s.user_id = c.user_id
                    and s.category_id = c.id
                    and s.local_date = ${localDate}
                    and s.delivery_status in ('sent', 'skipped', 'failed')
                )
            )`,
            // No point waking a user we cannot deliver to.
            sql`exists (
              select 1 from ${channelConnection} cc
              where cc.user_id = ${appUser.id} and cc.is_active
            )`,
          ),
        )
        .limit(limit);

      return rows.map((r) => ({
        userId: r.userId,
        localDate: r.localDate,
        timezone: r.timezone,
        reminderLocalTime: r.reminderLocalTime,
      }));
    },

    async listCategories(userId: UserId): Promise<readonly ReminderCategory[]> {
      const rows = await x
        .select({
          categoryId: category.id,
          name: category.name,
          isArchived: category.isArchived,
          reminderEnabled: category.reminderEnabled,
        })
        .from(category)
        .where(and(eq(category.userId, userId), eq(category.isArchived, false)))
        .orderBy(asc(category.sortOrder), asc(category.name));
      return rows;
    },

    async findCategory(userId: UserId, categoryId: Id): Promise<ReminderCategory | null> {
      const [row] = await x
        .select({
          categoryId: category.id,
          name: category.name,
          isArchived: category.isArchived,
          reminderEnabled: category.reminderEnabled,
        })
        .from(category)
        .where(and(eq(category.userId, userId), eq(category.id, categoryId)))
        .limit(1);
      return row ?? null;
    },

    async countReminderCategories(userId: UserId): Promise<number> {
      // Counts categories with a reminder enabled, not categories with budgets — M8's
      // limit is 1 Free / 5 Premium on the former.
      const [row] = await x
        .select({ count: sql<string>`count(*)` })
        .from(category)
        .where(
          and(
            eq(category.userId, userId),
            eq(category.isArchived, false),
            eq(category.reminderEnabled, true),
          ),
        );
      return Number(row?.count ?? '0');
    },

    async insertSend(input: NewAllowanceSendInput): Promise<AllowanceSend> {
      const inserted = await x
        .insert(dailyAllowanceSend)
        .values({
          userId: input.userId,
          categoryId: input.categoryId,
          localDate: input.localDate,
          dailyTargetMinorUnits: input.dailyTargetMinorUnits,
          budgetPeriodId: input.budgetPeriodId,
          deliveryStatus: input.deliveryStatus,
        })
        .onConflictDoNothing({
          target: [
            dailyAllowanceSend.userId,
            dailyAllowanceSend.categoryId,
            dailyAllowanceSend.localDate,
          ],
        })
        .returning();

      const row = inserted[0];
      if (row) return toSend(row);

      // Somebody else computed today's target first — read theirs rather than retrying.
      // Theirs is authoritative by definition: the target is written once per date.
      const [existing] = await x
        .select()
        .from(dailyAllowanceSend)
        .where(
          and(
            eq(dailyAllowanceSend.userId, input.userId),
            eq(dailyAllowanceSend.categoryId, input.categoryId),
            eq(dailyAllowanceSend.localDate, input.localDate),
          ),
        )
        .limit(1);
      if (!existing) {
        throw new Error(
          `daily_allowance_send vanished after conflict: ${input.categoryId} ${input.localDate}`,
        );
      }
      return toSend(existing);
    },

    async markSends(ids: readonly Id[], status: DeliveryStatus, now: Instant): Promise<void> {
      if (ids.length === 0) return;
      // One statement for the whole bundle — every row in a send shares its outcome, so
      // they must not be able to diverge partway through a loop.
      await x
        .update(dailyAllowanceSend)
        .set({
          deliveryStatus: status,
          ...(status === 'sent' ? { sentAt: new Date(now) } : {}),
        })
        .where(inArray(dailyAllowanceSend.id, [...ids]));
    },

    async incrementAttempts(ids: readonly Id[]): Promise<number> {
      if (ids.length === 0) return 0;
      const rows = await x
        .update(dailyAllowanceSend)
        .set({ attempts: sql`${dailyAllowanceSend.attempts} + 1` })
        .where(inArray(dailyAllowanceSend.id, [...ids]))
        .returning({ attempts: dailyAllowanceSend.attempts });
      // The bundle shares an outcome, so its rows share an attempt count; take the
      // highest so a row that somehow lagged cannot buy the bundle an extra retry.
      return rows.reduce((max, r) => Math.max(max, r.attempts), 0);
    },

    async updateTarget(
      userId: UserId,
      categoryId: Id,
      localDate: LocalDate,
      dailyTarget: MinorUnits,
    ): Promise<void> {
      // Only the target column moves. `delivery_status`, `attempts` and `sent_at` are
      // the delivery record and stay as they are — this is a re-price, not a re-send.
      await x
        .update(dailyAllowanceSend)
        .set({ dailyTargetMinorUnits: dailyTarget })
        .where(
          and(
            eq(dailyAllowanceSend.userId, userId),
            eq(dailyAllowanceSend.categoryId, categoryId),
            eq(dailyAllowanceSend.localDate, localDate),
          ),
        );
    },

    async setReminderEnabled(userId: UserId, categoryId: Id, enabled: boolean): Promise<void> {
      await x
        .update(category)
        .set({ reminderEnabled: enabled })
        .where(and(eq(category.userId, userId), eq(category.id, categoryId)));
    },
  };
}

export class DrizzleAllowanceRepository implements AllowanceRepository<DatabaseExecutor> {
  private readonly root: AllowanceReads & AllowanceWrites;

  constructor(private readonly db: Database) {
    this.root = operations(db);
  }

  withExecutor(executor: DatabaseExecutor): AllowanceReads & AllowanceWrites {
    return operations(executor);
  }

  findSend(userId: UserId, categoryId: Id, localDate: LocalDate): Promise<AllowanceSend | null> {
    return this.root.findSend(userId, categoryId, localDate);
  }
  listSendsForDate(userId: UserId, localDate: LocalDate): Promise<readonly AllowanceSend[]> {
    return this.root.listSendsForDate(userId, localDate);
  }
  findDueUsers(window: DueWindow, limit: number): Promise<readonly DueUserRow[]> {
    return this.root.findDueUsers(window, limit);
  }
  listCategories(userId: UserId): Promise<readonly ReminderCategory[]> {
    return this.root.listCategories(userId);
  }
  findCategory(userId: UserId, categoryId: Id): Promise<ReminderCategory | null> {
    return this.root.findCategory(userId, categoryId);
  }
  countReminderCategories(userId: UserId): Promise<number> {
    return this.root.countReminderCategories(userId);
  }
  insertSend(input: NewAllowanceSendInput): Promise<AllowanceSend> {
    return this.root.insertSend(input);
  }
  markSends(ids: readonly Id[], status: DeliveryStatus, now: Instant): Promise<void> {
    return this.root.markSends(ids, status, now);
  }
  incrementAttempts(ids: readonly Id[]): Promise<number> {
    return this.root.incrementAttempts(ids);
  }
  updateTarget(
    userId: UserId,
    categoryId: Id,
    localDate: LocalDate,
    dailyTarget: MinorUnits,
  ): Promise<void> {
    return this.root.updateTarget(userId, categoryId, localDate, dailyTarget);
  }
  setReminderEnabled(userId: UserId, categoryId: Id, enabled: boolean): Promise<void> {
    return this.root.setReminderEnabled(userId, categoryId, enabled);
  }
}
