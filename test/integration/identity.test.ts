import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { DrizzleIdentityRepository } from '../../src/core/identity/drizzle-repository';
import { IdentityServiceImpl } from '../../src/core/identity/identity-service';
import type { LedgerService } from '../../src/core/ports/ledger-service';
import { TestClock } from '../../src/core/testing/test-clock';
import { createDatabase, type Database } from '../../src/db/client';
import { appUser, channelConnection } from '../../src/db/schema/identity';

/**
 * M2 integration — runs only against a real Neon branch (`DATABASE_URL` set; CI
 * creates one per PR and applies `src/db/migrations` first — see
 * `test/integration/README.md`). The constraints under test are the whole point:
 * `unique (channel, external_id)`, the `where timezone = ''` claim, and
 * `on delete cascade`. A mock can't prove any of them.
 *
 * Cascade scope this pass: only `channel_connection` exists yet. When M3/M4/M5/M8
 * land their tables, extend `deleteAccount` below to seed one row in each and assert
 * it's gone (and that `parse_event.user_id` is nulled, not deleted — M9's FK).
 */

const DATABASE_URL = process.env['DATABASE_URL'];

describe.skipIf(!DATABASE_URL)('M2 identity against Postgres', () => {
  let db: Database;
  let repo: DrizzleIdentityRepository;
  let clock: TestClock;
  let identity: IdentityServiceImpl;
  const createdUsers: string[] = [];

  // Each test uses a unique external id so parallel CI runs can share a branch.
  const ext = (label: string): string => `it-${label}-${Date.now()}-${Math.random().toString(36).slice(2)}`;

  const ledger: Pick<LedgerService, 'history'> = {
    history: async () => ({ items: [], nextCursor: null }),
  };

  beforeAll(() => {
    db = createDatabase(DATABASE_URL!);
    repo = new DrizzleIdentityRepository(db);
    clock = new TestClock('2026-09-06T00:00:00.000Z');
    identity = new IdentityServiceImpl({ repo, clock, ledger });
  });

  afterEach(async () => {
    for (const id of createdUsers.splice(0)) {
      await db.delete(appUser).where(eq(appUser.id, id));
    }
  });

  afterAll(async () => {
    // postgres.js keeps the pool open; `createDatabase` doesn't expose it, so end via the driver.
    const client = (db as unknown as { $client?: { end?: () => Promise<void> } }).$client;
    await client?.end?.();
  });

  it('concurrent duplicate register calls converge on one user via the unique constraint', async () => {
    const externalId = ext('race');
    const results = await Promise.all(
      Array.from({ length: 8 }, () => identity.register('telegram', externalId, externalId, 'ricky')),
    );
    const ids = new Set(results.map((r) => r.userId));
    expect(ids.size).toBe(1);
    expect(results.filter((r) => r.isNew)).toHaveLength(1);
    const [userId] = ids;
    createdUsers.push(userId!);

    const users = await db.select().from(appUser);
    // No orphan app_user rows from losing transactions.
    expect(users.filter((u) => u.timezone === '' && u.id !== userId && u.createdAt.getTime() === clock.now())).toHaveLength(0);
    const conns = await db.select().from(channelConnection).where(eq(channelConnection.externalId, externalId));
    expect(conns).toHaveLength(1);
  });

  it('resolve finds the user; the check constraints and defaults hold', async () => {
    const externalId = ext('resolve');
    const { userId } = await identity.register('telegram', externalId, externalId);
    createdUsers.push(userId);
    expect(await identity.resolve('telegram', externalId)).toEqual({ userId, isNew: false });

    const [row] = await db.select().from(appUser).where(eq(appUser.id, userId));
    expect(row?.currencyCode).toBe('AUD');
    expect(row?.reminderLocalTime).toBe('07:00:00');
    expect(row?.status).toBe('active');
    expect(row?.periodAnchorDate).toBeNull();

    await expect(
      db.update(appUser).set({ status: 'banned' }).where(eq(appUser.id, userId)),
    ).rejects.toThrow(/app_user_status_check/);
  });

  it('timezone is claimed once at the write path; a later different value is refused', async () => {
    const externalId = ext('tz');
    const { userId } = await identity.register('telegram', externalId, externalId);
    createdUsers.push(userId);

    const outcomes = await Promise.all(
      ['Australia/Brisbane', 'Australia/Sydney', 'Australia/Perth'].map((z) =>
        identity.setInitialTimezone(userId, z).then(() => 'ok', (e: { code: string }) => e.code),
      ),
    );
    expect(outcomes.filter((o) => o === 'ok')).toHaveLength(1);
    expect(outcomes.filter((o) => o === 'TIMEZONE_IMMUTABLE')).toHaveLength(2);

    const settings = await identity.getSettings(userId);
    await expect(identity.setInitialTimezone(userId, settings.timezone)).resolves.toBeUndefined();
    await expect(identity.setInitialTimezone(userId, 'Pacific/Auckland')).rejects.toMatchObject({
      code: 'TIMEZONE_IMMUTABLE',
    });
  });

  it('updateSettings writes the mutable settings with updated_at from the clock', async () => {
    const externalId = ext('settings');
    const { userId } = await identity.register('telegram', externalId, externalId);
    createdUsers.push(userId);
    await identity.setInitialTimezone(userId, 'Australia/Brisbane');

    clock.set('2026-09-06T02:00:00.000Z');
    const settings = await identity.updateSettings(userId, {
      currencyCode: 'NZD',
      periodAnchorDate: '2026-09-15',
      reminderLocalTime: '06:45',
    });
    expect(settings).toEqual({
      timezone: 'Australia/Brisbane',
      currencyCode: 'NZD',
      periodAnchorDate: '2026-09-15',
      reminderLocalTime: '06:45',
    });
    const [row] = await db.select().from(appUser).where(eq(appUser.id, userId));
    expect(row?.updatedAt.toISOString()).toBe('2026-09-06T02:00:00.000Z');
  });

  it('deleteAccount hard-deletes and cascades to every user-owned row', async () => {
    const externalId = ext('delete');
    const { userId } = await identity.register('telegram', externalId, externalId);

    await identity.deleteAccount(userId);

    expect(await db.select().from(appUser).where(eq(appUser.id, userId))).toHaveLength(0);
    expect(await db.select().from(channelConnection).where(eq(channelConnection.userId, userId))).toHaveLength(0);
    expect(await identity.resolve('telegram', externalId)).toBeNull();

    // Re-registering the same Telegram id is a brand-new account.
    const again = await identity.register('telegram', externalId, externalId);
    createdUsers.push(again.userId);
    expect(again.isNew).toBe(true);
    expect(again.userId).not.toBe(userId);
  });
});
