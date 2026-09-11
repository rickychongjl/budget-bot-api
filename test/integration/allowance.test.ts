import { PGlite } from '@electric-sql/pglite';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pglite';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import identityDdl from '../../src/infrastructure/database/migrations/0000_identity.sql?raw';
import ledgerDdl from '../../src/infrastructure/database/migrations/0003_flashy_true_believers.sql?raw';
import allowanceDdl from '../../src/infrastructure/database/migrations/0004_faithful_baron_zemo.sql?raw';
import type { Database } from '../../src/infrastructure/database/client';
import { DrizzleAllowanceRepository } from '../../src/infrastructure/database/repositories/drizzle-allowance-repository';

/**
 * M5 against a real Postgres. The unit suite proves the *business rules* over an
 * in-memory adapter; it cannot prove that the unique constraint exists, that the check
 * constraint rejects a bad status, that the cascades are wired, or — most importantly —
 * that `findDueUsers` computes each user's local time correctly from their own IANA
 * zone. That last one is pure SQL: there is nothing in TypeScript to unit-test, and a
 * hand-rolled in-memory imitation would pass while the real query was wrong.
 *
 * Runs in-process on PGlite (real Postgres, WASM), so it needs no Neon branch and no
 * `DATABASE_URL` — same approach as `ledger-budgets.test.ts`. The schema is built by
 * executing the **committed migration files**, so this suite cannot drift from a deploy.
 */

const USER = '11111111-1111-4111-8111-111111111111';
const CATEGORY = '22222222-2222-4222-8222-222222222222';
const BUDGET = '33333333-3333-4333-8333-333333333333';
const PERIOD = '44444444-4444-4444-8444-444444444444';

let pg: PGlite;
let db: Database;
let repository: DrizzleAllowanceRepository;

beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(identityDdl);
  await pg.exec(ledgerDdl);
  await pg.exec(allowanceDdl);
  db = drizzle(pg) as unknown as Database;
  repository = new DrizzleAllowanceRepository(db);
});

afterAll(async () => {
  await pg.close();
});

beforeEach(async () => {
  // `app_user` cascades to everything user-scoped, so one delete resets the world.
  await pg.exec('delete from app_user');
});

/** A user with one budgeted category, ready to have a reminder turned on. */
async function seedUser(
  opts: { timezone?: string; reminderAt?: string; userId?: string; connected?: boolean } = {},
): Promise<string> {
  const userId = opts.userId ?? USER;
  await db.execute(sql`
    insert into app_user (id, timezone, currency_code, period_anchor_date, reminder_local_time, onboarding_step)
    values (${userId}, ${opts.timezone ?? 'Australia/Sydney'}, 'AUD', '2026-01-05',
            ${opts.reminderAt ?? '07:00'}, 'done')
  `);
  if (opts.connected !== false) {
    await db.execute(sql`
      insert into channel_connection (user_id, channel, external_id, chat_id)
      values (${userId}, 'telegram', ${userId}, ${userId})
    `);
  }
  return userId;
}

async function seedCategory(
  userId: string,
  opts: { categoryId?: string; budgetId?: string; periodId?: string; reminder?: boolean } = {},
): Promise<{ categoryId: string; periodId: string }> {
  const categoryId = opts.categoryId ?? CATEGORY;
  const budgetId = opts.budgetId ?? BUDGET;
  const periodId = opts.periodId ?? PERIOD;
  await db.execute(sql`
    insert into category (id, user_id, name, normalized_name, reminder_enabled)
    values (${categoryId}, ${userId}, 'Food', ${categoryId}, ${opts.reminder ?? true})
  `);
  await db.execute(sql`
    insert into budget (id, user_id, category_id, cap_minor_units, currency_code)
    values (${budgetId}, ${userId}, ${categoryId}, 50000, 'AUD')
  `);
  await db.execute(sql`
    insert into budget_period (id, user_id, budget_id, period_key, period_start, period_end, cap_minor_units)
    values (${periodId}, ${userId}, ${budgetId}, '2026-09', '2026-09-05', '2026-10-04', 50000)
  `);
  return { categoryId, periodId };
}

/** `db.execute` returns `{ rows }`; a scalar count is the only thing read that way here. */
async function countSends(): Promise<number> {
  const result = await db.execute(sql`select count(*)::int as n from daily_allowance_send`);
  return (result as unknown as { rows: { n: number }[] }).rows[0]?.n ?? -1;
}

function insertInput(overrides: Record<string, unknown> = {}) {
  return {
    userId: USER,
    categoryId: CATEGORY,
    localDate: '2026-09-10',
    dailyTargetMinorUnits: 2_000n,
    budgetPeriodId: PERIOD,
    deliveryStatus: 'pending' as const,
    ...overrides,
  };
}

describe('the unique constraint is the double-send guard', () => {
  beforeEach(async () => {
    await seedUser();
    await seedCategory(USER);
  });

  it('a second insert for the same (user, category, date) returns the first row', async () => {
    // This is what makes "the target is written once and never recomputed" true under
    // concurrency: the loser of the race reads the winner's number rather than its own.
    const first = await repository.insertSend(insertInput({ dailyTargetMinorUnits: 2_000n }));
    const second = await repository.insertSend(insertInput({ dailyTargetMinorUnits: 9_999n }));

    expect(second.id).toBe(first.id);
    expect(second.dailyTargetMinorUnits).toBe(2_000n);

    expect(await countSends()).toBe(1);
  });

  it('allows the same category on a different date', async () => {
    await repository.insertSend(insertInput({ localDate: '2026-09-10' }));
    await repository.insertSend(insertInput({ localDate: '2026-09-11' }));
    expect(await countSends()).toBe(2);
  });

  it('rejects a delivery status outside the agreed set', async () => {
    await expect(
      db.execute(sql`
        insert into daily_allowance_send
          (user_id, category_id, local_date, daily_target_minor_units, budget_period_id, delivery_status)
        values (${USER}, ${CATEGORY}, '2026-09-10', 2000, ${PERIOD}, 'delivered')
      `),
    ).rejects.toThrow();
  });

  it('defaults a row to not_applicable, keeping it out of the pending retry index', async () => {
    await db.execute(sql`
      insert into daily_allowance_send
        (user_id, category_id, local_date, daily_target_minor_units, budget_period_id)
      values (${USER}, ${CATEGORY}, '2026-09-10', 2000, ${PERIOD})
    `);
    const row = await repository.findSend(USER, CATEGORY, '2026-09-10');
    expect(row?.deliveryStatus).toBe('not_applicable');
  });
});

describe('cascades', () => {
  beforeEach(async () => {
    await seedUser();
    await seedCategory(USER);
    await repository.insertSend(insertInput());
  });

  it('deleting the budget period removes the send rows that referenced it', async () => {
    await db.execute(sql`delete from budget_period where id = ${PERIOD}`);
    expect(await countSends()).toBe(0);
  });

  it('deleting the category removes its send rows', async () => {
    await db.execute(sql`delete from budget where id = ${BUDGET}`);
    await db.execute(sql`delete from category where id = ${CATEGORY}`);
    expect(await countSends()).toBe(0);
  });

  it('deleting the account removes everything', async () => {
    await db.execute(sql`delete from app_user where id = ${USER}`);
    expect(await countSends()).toBe(0);
  });
});

describe('bundle state transitions', () => {
  const SECOND_CATEGORY = '55555555-5555-4555-8555-555555555555';

  beforeEach(async () => {
    await seedUser();
    await seedCategory(USER);
    await db.execute(sql`
      insert into category (id, user_id, name, normalized_name, reminder_enabled)
      values (${SECOND_CATEGORY}, ${USER}, 'Fun', 'fun', true)
    `);
  });

  it('marks every row in a bundle together, in one statement', async () => {
    const a = await repository.insertSend(insertInput());
    const b = await repository.insertSend(insertInput({ categoryId: SECOND_CATEGORY }));

    await repository.markSends([a.id, b.id], 'sent', Date.parse('2026-09-10T21:00:00Z'));

    const rows = await repository.listSendsForDate(USER, '2026-09-10');
    expect(rows.map((r) => r.deliveryStatus)).toEqual(['sent', 'sent']);
    expect(rows.every((r) => r.sentAt !== null)).toBe(true);
  });

  it('does not stamp sent_at on a skipped bundle', async () => {
    const a = await repository.insertSend(insertInput());
    await repository.markSends([a.id], 'skipped', Date.now());
    const row = await repository.findSend(USER, CATEGORY, '2026-09-10');
    expect(row).toMatchObject({ deliveryStatus: 'skipped', sentAt: null });
  });

  it('increments every row in the bundle and reports the shared attempt count', async () => {
    const a = await repository.insertSend(insertInput());
    const b = await repository.insertSend(insertInput({ categoryId: SECOND_CATEGORY }));

    expect(await repository.incrementAttempts([a.id, b.id])).toBe(1);
    expect(await repository.incrementAttempts([a.id, b.id])).toBe(2);

    const rows = await repository.listSendsForDate(USER, '2026-09-10');
    expect(rows.map((r) => r.attempts)).toEqual([2, 2]);
  });

  it('treats an empty id list as a no-op rather than updating every row', async () => {
    const a = await repository.insertSend(insertInput());
    await repository.markSends([], 'failed', Date.now());
    expect((await repository.findSend(USER, CATEGORY, '2026-09-10'))!.deliveryStatus).toBe(
      a.deliveryStatus,
    );
  });
});

describe('reminder_enabled, M5s column on M3s table', () => {
  beforeEach(async () => {
    await seedUser();
    await seedCategory(USER, { reminder: false });
  });

  it('round-trips through the repository', async () => {
    expect((await repository.findCategory(USER, CATEGORY))!.reminderEnabled).toBe(false);
    await repository.setReminderEnabled(USER, CATEGORY, true);
    expect((await repository.findCategory(USER, CATEGORY))!.reminderEnabled).toBe(true);
  });

  it('counts only non-archived, reminder-enabled categories for M8', async () => {
    await repository.setReminderEnabled(USER, CATEGORY, true);
    expect(await repository.countReminderCategories(USER)).toBe(1);

    await db.execute(sql`update category set is_archived = true where id = ${CATEGORY}`);
    expect(await repository.countReminderCategories(USER)).toBe(0);
  });

  it('never touches another users category', async () => {
    const other = await seedUser({ userId: '99999999-9999-4999-8999-999999999999' });
    await repository.setReminderEnabled(other, CATEGORY, true);
    expect((await repository.findCategory(USER, CATEGORY))!.reminderEnabled).toBe(false);
  });
});

describe('findDueUsers — per-user local time, computed in SQL', () => {
  /**
   * The whole point of this query. Every user is due at 07:00 *their* time, so one tick
   * has to resolve a different wall clock per row. Australia alone spans UTC+8, +9:30
   * and +10, and the half-hour zones are exactly what an hourly cron gets wrong.
   */
  const SYDNEY = '11111111-1111-4111-8111-111111111111'; // UTC+10 in September
  const ADELAIDE = '66666666-6666-4666-8666-666666666666'; // UTC+9:30
  const PERTH = '77777777-7777-4777-8777-777777777777'; // UTC+8

  beforeEach(async () => {
    await seedUser({ userId: SYDNEY, timezone: 'Australia/Sydney' });
    await seedCategory(SYDNEY, {
      categoryId: '22222222-2222-4222-8222-222222222222',
      budgetId: '33333333-3333-4333-8333-333333333333',
      periodId: '44444444-4444-4444-8444-444444444444',
    });
    await seedUser({ userId: ADELAIDE, timezone: 'Australia/Adelaide' });
    await seedCategory(ADELAIDE, {
      categoryId: 'a2222222-2222-4222-8222-222222222222',
      budgetId: 'a3333333-3333-4333-8333-333333333333',
      periodId: 'a4444444-4444-4444-8444-444444444444',
    });
    await seedUser({ userId: PERTH, timezone: 'Australia/Perth' });
    await seedCategory(PERTH, {
      categoryId: 'b2222222-2222-4222-8222-222222222222',
      budgetId: 'b3333333-3333-4333-8333-333333333333',
      periodId: 'b4444444-4444-4444-8444-444444444444',
    });
  });

  async function dueAt(iso: string): Promise<string[]> {
    const rows = await repository.findDueUsers(
      { now: Date.parse(iso), windowMinutes: 60 },
      50,
    );
    return rows.map((r) => r.userId).sort();
  }

  it('wakes Sydney at 07:10 its time, while Adelaide is still at 06:40', async () => {
    // 21:10Z -> Sydney 07:10 (+10), Adelaide 06:40 (+9:30), Perth 05:10 (+8).
    expect(await dueAt('2026-09-11T21:10:00Z')).toEqual([SYDNEY]);
  });

  it('wakes Adelaide half an hour later — the case an hourly tick gets wrong', async () => {
    // 22:10Z -> Sydney 08:10 (window closed), Adelaide 07:40, Perth 06:10.
    expect(await dueAt('2026-09-11T22:10:00Z')).toEqual([ADELAIDE]);
  });

  it('wakes Perth two hours after Sydney', async () => {
    // 23:10Z -> Perth 07:10; Sydney 09:10 and Adelaide 08:40 are both past the window.
    expect(await dueAt('2026-09-11T23:10:00Z')).toEqual([PERTH]);
  });

  it('wakes nobody before their reminder time', async () => {
    // 20:10Z -> Sydney 06:10, everyone else earlier.
    expect(await dueAt('2026-09-11T20:10:00Z')).toEqual([]);
  });

  it('follows the offset across a DST transition rather than a fixed one', async () => {
    // Sydney enters AEDT (+11) on 4 Oct 2026. 20:10Z is 07:10 on 5 Oct under +11 —
    // it would be 06:10 if the query had cached September's +10.
    expect(await dueAt('2026-10-04T20:10:00Z')).toEqual([SYDNEY]);
  });

  it('reports the local date, not the UTC one', async () => {
    const [row] = await repository.findDueUsers(
      { now: Date.parse('2026-09-11T21:10:00Z'), windowMinutes: 60 },
      50,
    );
    // 21:10Z on the 11th is already the 12th in Sydney — the bundle is for that date.
    expect(row).toMatchObject({ localDate: '2026-09-12', timezone: 'Australia/Sydney' });
  });

  it('honours a reminder time other than 07:00, since M5 reads the column', async () => {
    await db.execute(sql`update app_user set reminder_local_time = '09:00' where id = ${PERTH}`);
    // 01:10Z -> Perth 09:10.
    expect(await dueAt('2026-09-12T01:10:00Z')).toEqual([PERTH]);
  });
});

describe('findDueUsers — who is eligible', () => {
  async function dueNow(): Promise<string[]> {
    // 21:10Z on 11 Sep is 07:10 in Sydney.
    const rows = await repository.findDueUsers(
      { now: Date.parse('2026-09-11T21:10:00Z'), windowMinutes: 60 },
      50,
    );
    return rows.map((r) => r.userId);
  }

  it('includes a user with a reminder-enabled, budgeted category', async () => {
    await seedUser();
    await seedCategory(USER, { reminder: true });
    expect(await dueNow()).toEqual([USER]);
  });

  it('excludes a category with no reminder', async () => {
    await seedUser();
    await seedCategory(USER, { reminder: false });
    expect(await dueNow()).toEqual([]);
  });

  it('excludes an archived category, even with the flag still set', async () => {
    await seedUser();
    await seedCategory(USER, { reminder: true });
    await db.execute(sql`update category set is_archived = true where id = ${CATEGORY}`);
    expect(await dueNow()).toEqual([]);
  });

  it('excludes a category whose budget is inactive — nothing to divide', async () => {
    await seedUser();
    await seedCategory(USER, { reminder: true });
    await db.execute(sql`update budget set is_active = false where id = ${BUDGET}`);
    expect(await dueNow()).toEqual([]);
  });

  it('excludes a user already sent today — this is the once-only guarantee', async () => {
    await seedUser();
    await seedCategory(USER, { reminder: true });
    await db.execute(sql`
      insert into daily_allowance_send
        (user_id, category_id, local_date, daily_target_minor_units, budget_period_id, delivery_status)
      values (${USER}, ${CATEGORY}, '2026-09-12', 2000, ${PERIOD}, 'sent')
    `);
    expect(await dueNow()).toEqual([]);
  });

  it('still includes a user whose bundle is pending — that is how a retry happens', async () => {
    await seedUser();
    await seedCategory(USER, { reminder: true });
    await db.execute(sql`
      insert into daily_allowance_send
        (user_id, category_id, local_date, daily_target_minor_units, budget_period_id, delivery_status)
      values (${USER}, ${CATEGORY}, '2026-09-12', 2000, ${PERIOD}, 'pending')
    `);
    expect(await dueNow()).toEqual([USER]);
  });

  it('excludes a user with no active channel connection', async () => {
    await seedUser({ connected: false });
    await seedCategory(USER, { reminder: true });
    expect(await dueNow()).toEqual([]);
  });

  it('excludes a user who has not finished onboarding', async () => {
    await seedUser();
    await seedCategory(USER, { reminder: true });
    await db.execute(sql`update app_user set onboarding_step = 'categories' where id = ${USER}`);
    expect(await dueNow()).toEqual([]);
  });

  it('excludes a deleted account', async () => {
    await seedUser();
    await seedCategory(USER, { reminder: true });
    await db.execute(sql`update app_user set status = 'deleted' where id = ${USER}`);
    expect(await dueNow()).toEqual([]);
  });

  it('survives a pre-onboarding user whose timezone is still the empty sentinel', async () => {
    // `at time zone ''` is an error, not an empty result — without the guard this query
    // fails for every user the moment one unfinished signup exists.
    await db.execute(sql`
      insert into app_user (id, timezone, onboarding_step)
      values ('88888888-8888-4888-8888-888888888888', '', 'timezone')
    `);
    await seedUser();
    await seedCategory(USER, { reminder: true });
    expect(await dueNow()).toEqual([USER]);
  });

  it('caps the fan-out at the requested limit', async () => {
    for (let i = 0; i < 3; i += 1) {
      const id = `c${i}222222-2222-4222-8222-222222222222`;
      await seedUser({ userId: id });
      await seedCategory(id, {
        categoryId: `d${i}222222-2222-4222-8222-222222222222`,
        budgetId: `e${i}333333-3333-4333-8333-333333333333`,
        periodId: `f${i}444444-4444-4444-8444-444444444444`,
      });
    }
    const rows = await repository.findDueUsers(
      { now: Date.parse('2026-09-11T21:10:00Z'), windowMinutes: 60 },
      2,
    );
    expect(rows).toHaveLength(2);
  });
});
