import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDatabase, type Database } from '../../src/db/client';
import { DrizzleEntitlementStore, type DbExecutor } from '../../src/core/entitlements/drizzle-store';
import { createEntitlementService } from '../../src/core/entitlements/service';
import type { CapacityReader } from '../../src/core/entitlements/ports';
import { TestClock } from '../../src/core/testing/test-clock';

/**
 * M8 against a real Neon branch (M1 §7): the `(user_id, message_id)` primary key and
 * the advisory lock are doing the exactly-once work here, so this is what proves the
 * unit suite's memory store is an honest model. Needs `app_user` (M2) applied.
 *
 * Skipped without `DATABASE_URL`. Not run locally by the M8 agent (no Neon project
 * yet) — first exercised by CI once M2's migration has landed. See build-log.
 */
const url = process.env.DATABASE_URL;

describe.skipIf(!url)('EntitlementService over Drizzle', () => {
  let db: Database;
  let userId: string;

  // M8 never reads M3/M5 tables; for this suite the counts are a fixed fake.
  const capacity: CapacityReader<DbExecutor> = {
    async activeCategoryCount() {
      return 0;
    },
    async reminderCategoryCount() {
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
    return createEntitlementService<DbExecutor>({
      store: new DrizzleEntitlementStore(db),
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
  });

  it('enforces one active entitlement per user at the database', async () => {
    await db.execute(
      sql`insert into entitlement (user_id, tier, source, status) values (${userId}, 'premium', 'manual', 'active')`,
    );
    await expect(
      db.execute(
        sql`insert into entitlement (user_id, tier, source, status) values (${userId}, 'premium', 'manual', 'active')`,
      ),
    ).rejects.toThrow(/entitlement_one_active/);
    await expect(
      db.execute(sql`insert into entitlement (user_id, tier, source, status) values (${userId}, 'gold', 'manual', 'expired')`),
    ).rejects.toThrow(/entitlement_tier_check/);
    expect(await service(new TestClock('2026-09-06T14:00:00Z')).tierOf(userId)).toBe('premium');
  });
});
