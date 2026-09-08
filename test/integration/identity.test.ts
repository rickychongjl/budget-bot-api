import { sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createDatabase } from '../../src/infrastructure/database/client';
import type { Database } from '../../src/infrastructure/database/client';
import { DefaultIdentityService } from '../../src/core/identity';
import { DrizzleIdentityRepository } from '../../src/infrastructure/database/repositories/drizzle-identity-repository';
import { TestClock } from '../support/test-clock';
import { FakeLedger } from '../unit/identity/fakes';

/**
 * M2 integration tier — the cases whose guarantees come from Postgres itself (the
 * `(channel, external_id)` unique constraint, the conditional `timezone = ''`
 * update, `on delete cascade`, the check constraints). A mock can't prove these.
 *
 * Needs `DATABASE_URL` pointing at a branch with the committed migrations applied
 * (`npm run db:migrate`); CI does this on a per-PR Neon branch. Skipped, not faked,
 * when the variable is absent.
 *
 * Cascade coverage today is `channel_connection` only — it's the only user-owned
 * table in the schema at M2 time. Each later module should add its tables to the
 * cascade assertion here (or in its own suite) as they land.
 */

const url = process.env['DATABASE_URL'];
const run = url ? describe : describe.skip;

run('M2 identity (real Postgres)', () => {
  let db: Database;
  let identity: DefaultIdentityService;
  const createdExternalIds: string[] = [];
  const stamp = Date.now().toString(36);
  const ext = (label: string) => {
    const id = `it-${stamp}-${label}`;
    createdExternalIds.push(id);
    return id;
  };

  beforeAll(() => {
    db = createDatabase(url as string);
    identity = new DefaultIdentityService({
      repo: new DrizzleIdentityRepository(db),
      clock: new TestClock('2026-09-06T00:00:00Z'),
      ledger: new FakeLedger(),
    });
  });

  afterEach(async () => {
    for (const id of createdExternalIds.splice(0)) {
      const user = await identity.resolve('telegram', id);
      if (user) await identity.deleteAccount(user.userId);
    }
  });

  afterAll(async () => {
    // postgres.js keeps the pool open; end it so vitest exits.
    await db.$client.end({ timeout: 5 });
  });

  it('register is idempotent under concurrent duplicate calls (unique constraint, not check-then-insert)', async () => {
    const id = ext('race');
    const results = await Promise.all(Array.from({ length: 12 }, (_, i) => identity.register('telegram', id, id, `u${i}`)));
    expect(new Set(results.map((r) => r.userId)).size).toBe(1);
    expect(results.filter((r) => r.isNew)).toHaveLength(1);

    const [{ users }] = (await db.execute(
      sql`select count(*)::int as users from app_user u join channel_connection c on c.user_id = u.id where c.external_id = ${id}`,
    )) as unknown as [{ users: number }];
    expect(users).toBe(1);
    // No orphaned app_user rows from the losing transactions.
    const [{ orphans }] = (await db.execute(
      sql`select count(*)::int as orphans from app_user u where not exists (select 1 from channel_connection c where c.user_id = u.id) and u.created_at > now() - interval '1 minute'`,
    )) as unknown as [{ orphans: number }];
    expect(orphans).toBe(0);
  });

  it('timezone is written once; identical replay OK; any change TIMEZONE_IMMUTABLE — even concurrently', async () => {
    const id = ext('tz');
    const { userId } = await identity.register('telegram', id, id);
    const outcomes = await Promise.allSettled(
      ['Australia/Sydney', 'Australia/Perth', 'Australia/Darwin'].map((z) => identity.setInitialTimezone(userId, z)),
    );
    expect(outcomes.filter((o) => o.status === 'fulfilled')).toHaveLength(1);
    const stored = (await identity.getSettings(userId)).timezone;
    await expect(identity.setInitialTimezone(userId, stored)).resolves.toBeUndefined();
    await expect(identity.setInitialTimezone(userId, 'Europe/London')).rejects.toMatchObject({ code: 'TIMEZONE_IMMUTABLE' });
    const forged = { timezone: stored } as unknown as Parameters<typeof identity.updateSettings>[1];
    await expect(identity.updateSettings(userId, forged)).rejects.toMatchObject({ code: 'TIMEZONE_IMMUTABLE' });
  });

  it('settings round-trip: defaults 07:00 / AUD, anchor date and reminder time persist as strings', async () => {
    const id = ext('settings');
    const { userId } = await identity.register('telegram', id, id);
    await identity.setInitialTimezone(userId, 'Australia/Adelaide');
    expect(await identity.getSettings(userId)).toEqual({
      timezone: 'Australia/Adelaide',
      currencyCode: 'AUD',
      periodAnchorDate: null,
      reminderLocalTime: '07:00',
    });
    const updated = await identity.updateSettings(userId, { periodAnchorDate: '2026-09-15', reminderLocalTime: '08:30', currencyCode: 'NZD' });
    expect(updated).toEqual({
      timezone: 'Australia/Adelaide',
      currencyCode: 'NZD',
      periodAnchorDate: '2026-09-15',
      reminderLocalTime: '08:30',
    });
  });

  it('stores a non-null pre-onboarding timezone but never exposes it as settings', async () => {
    const id = ext('required-timezone');
    const { userId } = await identity.register('telegram', id, id);
    const [row] = (await db.execute(
      sql`select timezone from app_user where id = ${userId}`,
    )) as unknown as [{ timezone: string }];
    expect(row?.timezone).toBe('');
    await expect(identity.getSettings(userId)).rejects.toMatchObject({ code: 'ONBOARDING_REQUIRED' });
  });

  it('check constraints reject a bad channel and a bad status at the DB', async () => {
    const id = ext('check');
    const { userId } = await identity.register('telegram', id, id);
    await expect(
      db.execute(sql`insert into channel_connection (user_id, channel, external_id, chat_id) values (${userId}, 'whatsapp', ${id + '-wa'}, 'x')`),
    ).rejects.toThrow();
    await expect(db.execute(sql`update app_user set status = 'banned' where id = ${userId}`)).rejects.toThrow();
    await expect(db.execute(sql`update app_user set onboarding_step = 'step_9' where id = ${userId}`)).rejects.toThrow();
  });

  it('deleteAccount cascades to every user-owned row', async () => {
    const id = ext('cascade');
    const { userId } = await identity.register('telegram', id, id);
    await identity.deleteAccount(userId);
    const [{ users, connections }] = (await db.execute(
      sql`select (select count(*)::int from app_user where id = ${userId}) as users,
                 (select count(*)::int from channel_connection where user_id = ${userId}) as connections`,
    )) as unknown as [{ users: number; connections: number }];
    expect(users).toBe(0);
    expect(connections).toBe(0);
    expect(await identity.resolve('telegram', id)).toBeNull();
  });
});
