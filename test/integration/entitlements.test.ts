import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDatabase, type Database } from '../../src/infrastructure/database/client';
import {
  DrizzleEntitlementRepository,
  type DatabaseExecutor,
} from '../../src/infrastructure/database/repositories/drizzle-entitlement-repository';
import { createEntitlementService } from '../../src/core/entitlements/default-entitlement-service';
import type { CapacityReader } from '../../src/core/entitlements/entitlement-repository';
import { TestClock } from '../support/test-clock';

/**
 * M8 against a real Neon branch (M1 §7): the `(user_id, message_id)` primary key and
 * the advisory lock are doing the exactly-once work here, so this is what proves the
 * unit suite's memory store is an honest model. Needs `app_user` (M2) applied.
 *
 * Skipped without `DATABASE_URL`. Not run locally by the M8 agent (no Neon project
 * yet) — first exercised by CI once M2's migration has landed. See build-log.
 */
/**
 * The name of the constraint a failing statement tripped, or `undefined` if it
 * succeeded.
 *
 * Not `rejects.toThrow(/name/)`: Drizzle's wrapper sets `message` to just
 * `Failed query: <sql>`, and the constraint name lives on the `PostgresError` it
 * carries as `cause`. Matching the wrapper message can never see it. Reading
 * `constraint_name` also pins the *exact* constraint rather than a substring, so a
 * statement failing for an unrelated reason can't accidentally satisfy the assertion.
 */
async function constraintViolatedBy(run: Promise<unknown>): Promise<string | undefined> {
  try {
    await run;
    return undefined;
  } catch (error) {
    return (error as { cause?: { constraint_name?: string } }).cause?.constraint_name;
  }
}

const url = process.env.DATABASE_URL;

describe.skipIf(!url)('EntitlementService over Drizzle', () => {
  let db: Database;
  let userId: string;

  // M8 never reads M3/M5 tables; for this suite the counts are a fixed fake.
  const capacity: CapacityReader<DatabaseExecutor> = {
    async countActiveCategories() {
      return 0;
    },
    async countReminderCategories() {
      return 0;
    },
  };

  beforeAll(async () => {
    db = createDatabase(url as string);
    const rows = await db.execute(
      sql`insert into app_user (timezone) values ('Australia/Brisbane') returning id`,
    );
    userId = (rows[0] as { id: string }).id;
  });

  afterAll(async () => {
    if (userId) await db.execute(sql`delete from app_user where id = ${userId}`);
  });

  function service(clock: TestClock) {
    return createEntitlementService<DatabaseExecutor>({
      repository: new DrizzleEntitlementRepository(db),
      capacity,
      timezoneOf: async () => 'Australia/Brisbane',
      clock,
    });
  }

  it('is Free with no entitlement row and cascades usage rows with the user', async () => {
    const clock = new TestClock('2026-09-06T14:00:00Z');
    expect(await service(clock).tierOf(userId)).toBe('free');
  });

  it('admits once per message_id under concurrent redelivery, and refuses the 6th of the day', async () => {
    const clock = new TestClock('2026-09-06T14:00:00Z');
    const svc = service(clock);

    const dup = await Promise.all(Array.from({ length: 6 }, () => svc.admitMessage(userId, 'tg:1', clock.now())));
    expect(dup.filter((r) => r.outcome === 'admitted')).toHaveLength(1);
    expect(dup.filter((r) => r.outcome === 'duplicate')).toHaveLength(5);

    const more = await Promise.all(
      Array.from({ length: 8 }, (_, i) => svc.admitMessage(userId, `tg:${i + 2}`, clock.now())),
    );
    expect(more.filter((r) => r.outcome === 'admitted')).toHaveLength(4); // 5 total for the day
    expect(more.filter((r) => r.outcome === 'refused')).toHaveLength(4);
    const refused = more.find((r) => r.outcome === 'refused');
    expect(refused).toMatchObject({ code: 'DAILY_MESSAGE_LIMIT', retryAt: Date.parse('2026-09-07T14:00:00Z') });

    const [{ count }] = (await db.execute(
      sql`select count(*)::int as count from usage_counter where user_id = ${userId}`,
    )) as unknown as [{ count: number }];
    expect(count).toBe(5);
  },
  /**
   * Deliberately serialised, so it is network-bound rather than slow: all 14
   * `admitMessage` calls contend on the same per-user advisory lock, and each holds it
   * for a transaction's worth of round trips to Neon in Sydney. It settles around 3.5s
   * warm, but the very first query of a run also pays Neon's compute wake-up, which
   * pushed it past the 5s default the first time this suite was ever executed against
   * a real database. The timeout is per-test on purpose — raising it globally would
   * hide a genuine hang in the sub-second tests around it.
   */
  30_000);

  it('enforces one active entitlement per user at the database', async () => {
    await db.execute(
      sql`insert into entitlement (user_id, tier, source, status) values (${userId}, 'premium', 'manual', 'active')`,
    );
    expect(
      await constraintViolatedBy(
        db.execute(
          sql`insert into entitlement (user_id, tier, source, status) values (${userId}, 'premium', 'manual', 'active')`,
        ),
      ),
    ).toBe('entitlement_one_active');
    expect(
      await constraintViolatedBy(
        db.execute(
          sql`insert into entitlement (user_id, tier, source, status) values (${userId}, 'gold', 'manual', 'expired')`,
        ),
      ),
    ).toBe('entitlement_tier_check');
    expect(await service(new TestClock('2026-09-06T14:00:00Z')).tierOf(userId)).toBe('premium');
  });
});
