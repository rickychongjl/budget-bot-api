import { beforeEach, describe, expect, it } from 'vitest';
import { DefaultIdentityService, RefusalError } from '../../../src/core/identity';
import { InMemoryIdentityRepository } from '../../support/in-memory-identity-repository';
import { TestClock } from '../../../src/core/testing/test-clock';
import { FakeLedger } from './fakes';

/**
 * M2 "Tests to write", service half. Runs against `InMemoryIdentityRepository`, which
 * reproduces the unique constraint and the conditional timezone update at the moment
 * of the write; the same cases run against a real Neon branch in
 * `test/integration/identity.test.ts`.
 */

let repo: InMemoryIdentityRepository;
let clock: TestClock;
let ledger: FakeLedger;
let identity: DefaultIdentityService;

beforeEach(() => {
  repo = new InMemoryIdentityRepository();
  clock = new TestClock('2026-09-06T00:00:00.000Z');
  ledger = new FakeLedger();
  identity = new DefaultIdentityService({ repo, clock, ledger });
});

async function onboardedUser(timezone = 'Australia/Sydney') {
  const { userId } = await identity.register('telegram', '12345', '12345', 'ricky');
  await identity.setInitialTimezone(userId, timezone);
  await identity.updateSettings(userId, { periodAnchorDate: '2026-09-01' });
  await identity.setOnboardingStep(userId, 'done');
  return userId;
}

describe('register / resolve', () => {
  it('creates once and resolves to the same user afterwards', async () => {
    const first = await identity.register('telegram', '42', '42', 'a');
    expect(first.isNew).toBe(true);
    expect(first.onboarded).toBe(false);

    const again = await identity.register('telegram', '42', '42', 'a');
    expect(again).toEqual({ userId: first.userId, isNew: false, onboarded: false });

    const resolved = await identity.resolve('telegram', '42');
    expect(resolved).toEqual({ userId: first.userId, isNew: false, onboarded: false });
    expect(repo.users.size).toBe(1);
  });

  it('is idempotent under concurrent duplicate calls — exactly one user, exactly one isNew', async () => {
    const results = await Promise.all(
      Array.from({ length: 25 }, (_, i) => identity.register('telegram', '777', '777', `u${i}`)),
    );
    const ids = new Set(results.map((r) => r.userId));
    expect(ids.size).toBe(1);
    expect(results.filter((r) => r.isNew)).toHaveLength(1);
    expect(repo.users.size).toBe(1);
    expect(repo.connections.size).toBe(1);
  });

  it('keeps different external ids on different users', async () => {
    const a = await identity.register('telegram', '1', '1');
    const b = await identity.register('telegram', '2', '2');
    expect(a.userId).not.toBe(b.userId);
  });

  it('uses the injected clock for initial user and connection timestamps', async () => {
    const now = clock.now();
    const { userId } = await identity.register('telegram', 'clocked', 'clocked');
    const user = await repo.findUser(userId);
    const connection = await identity.findActiveConnection(userId, 'telegram');
    expect(user).toMatchObject({ createdAt: now, updatedAt: now });
    expect(connection?.linkedAt).toBe(now);
  });

  it('resolve returns null for an unknown id', async () => {
    expect(await identity.resolve('telegram', 'nobody')).toBeNull();
  });

  it('re-registering refreshes delivery details and re-activates a blocked connection', async () => {
    const { userId } = await identity.register('telegram', '9', '9', 'old');
    await identity.deactivateConnection(userId, 'telegram');
    expect(await identity.findActiveConnection(userId, 'telegram')).toBeNull();

    await identity.register('telegram', '9', '9', 'new');
    const conn = await identity.findActiveConnection(userId, 'telegram');
    expect(conn?.isActive).toBe(true);
    expect(conn?.username).toBe('new');
  });

  it('rejects blank ids', async () => {
    await expect(identity.register('telegram', '', '1')).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
  });
});

describe('timezone immutability', () => {
  it('setInitialTimezone succeeds once and canonicalises the spelling', async () => {
    const { userId } = await identity.register('telegram', '1', '1');
    await identity.setInitialTimezone(userId, 'australia/brisbane');
    expect((await repo.findUser(userId))?.timezone).toBe('Australia/Brisbane');
  });

  it('an identical replay through setInitialTimezone is not a rejected change', async () => {
    const { userId } = await identity.register('telegram', '1', '1');
    await identity.setInitialTimezone(userId, 'Australia/Perth');
    await expect(identity.setInitialTimezone(userId, 'Australia/Perth')).resolves.toBeUndefined();
    await expect(identity.setInitialTimezone(userId, 'AUSTRALIA/PERTH')).resolves.toBeUndefined();
  });

  it('a different value through setInitialTimezone is TIMEZONE_IMMUTABLE', async () => {
    const { userId } = await identity.register('telegram', '1', '1');
    await identity.setInitialTimezone(userId, 'Australia/Perth');
    await expect(identity.setInitialTimezone(userId, 'Australia/Sydney')).rejects.toMatchObject({
      code: 'TIMEZONE_IMMUTABLE',
    });
    expect((await repo.findUser(userId))?.timezone).toBe('Australia/Perth');
  });

  it('concurrent first writes with different values: exactly one wins, the rest are refused', async () => {
    const { userId } = await identity.register('telegram', '1', '1');
    const zones = ['Australia/Sydney', 'Australia/Perth', 'Australia/Darwin', 'Europe/London'];
    const outcomes = await Promise.allSettled(zones.map((z) => identity.setInitialTimezone(userId, z)));
    const fulfilled = outcomes.filter((o) => o.status === 'fulfilled');
    expect(fulfilled).toHaveLength(1);
    for (const o of outcomes) {
      if (o.status === 'rejected') expect(RefusalError.is(o.reason, 'TIMEZONE_IMMUTABLE')).toBe(true);
    }
    expect(zones).toContain((await repo.findUser(userId))?.timezone);
  });

  it('updateSettings cannot carry timezone at all — an explicit patch with the SAME value is refused', async () => {
    const userId = await onboardedUser('Australia/Sydney');
    const forged = { timezone: 'Australia/Sydney' } as unknown as Parameters<typeof identity.updateSettings>[1];
    await expect(identity.updateSettings(userId, forged)).rejects.toMatchObject({ code: 'TIMEZONE_IMMUTABLE' });

    const different = { timezone: 'Australia/Perth', currencyCode: 'AUD' } as unknown as Parameters<
      typeof identity.updateSettings
    >[1];
    await expect(identity.updateSettings(userId, different)).rejects.toMatchObject({ code: 'TIMEZONE_IMMUTABLE' });
    expect((await identity.getSettings(userId)).timezone).toBe('Australia/Sydney');
  });

  it('rejects an unknown zone up front', async () => {
    const { userId } = await identity.register('telegram', '1', '1');
    await expect(identity.setInitialTimezone(userId, 'Mars/Olympus_Mons')).rejects.toMatchObject({
      code: 'INVALID_ARGUMENT',
    });
    expect((await repo.findUser(userId))?.timezone).toBe('');
  });
});

describe('getSettings', () => {
  it('is ONBOARDING_REQUIRED until a timezone exists', async () => {
    const { userId } = await identity.register('telegram', '1', '1');
    await expect(identity.getSettings(userId)).rejects.toMatchObject({ code: 'ONBOARDING_REQUIRED' });
  });

  it('returns the four-field contract with 07:00 and AUD defaults', async () => {
    const { userId } = await identity.register('telegram', '1', '1');
    await identity.setInitialTimezone(userId, 'Australia/Hobart');
    expect(await identity.getSettings(userId)).toEqual({
      timezone: 'Australia/Hobart',
      currencyCode: 'AUD',
      periodAnchorDate: null,
      reminderLocalTime: '07:00',
    });
  });

  it('is RESOURCE_NOT_FOUND for an unknown user', async () => {
    await expect(identity.getSettings('nope')).rejects.toMatchObject({ code: 'RESOURCE_NOT_FOUND' });
  });
});

describe('updateSettings — currency', () => {
  it('is allowed with zero transactions (and asks M3 to be sure)', async () => {
    const userId = await onboardedUser();
    const settings = await identity.updateSettings(userId, { currencyCode: 'nzd' });
    expect(settings.currencyCode).toBe('NZD');
    expect(ledger.calls).toEqual(['history']);
  });

  it('is refused with one transaction, with no conversion', async () => {
    const userId = await onboardedUser();
    ledger.addTransaction(userId);
    await expect(identity.updateSettings(userId, { currencyCode: 'NZD' })).rejects.toMatchObject({
      code: 'INVALID_ARGUMENT',
      message: expect.stringContaining('AUD'),
    });
    expect((await identity.getSettings(userId)).currencyCode).toBe('AUD');
  });

  it('same-value currency is a no-op even with transactions', async () => {
    const userId = await onboardedUser();
    ledger.addTransaction(userId);
    await expect(identity.updateSettings(userId, { currencyCode: 'AUD' })).resolves.toMatchObject({
      currencyCode: 'AUD',
    });
    expect(ledger.calls).toEqual([]);
  });

  it('rejects a code the runtime does not know', async () => {
    const userId = await onboardedUser();
    await expect(identity.updateSettings(userId, { currencyCode: 'ZZZ' })).rejects.toMatchObject({
      code: 'INVALID_ARGUMENT',
    });
    await expect(identity.updateSettings(userId, { currencyCode: 'AU' })).rejects.toMatchObject({
      code: 'INVALID_ARGUMENT',
    });
  });
});

describe('updateSettings — anchor date and reminder time', () => {
  it('changing the anchor date is a pure re-bucket: only that column moves, M3 is not consulted', async () => {
    const userId = await onboardedUser();
    const before = await repo.findUser(userId);
    const settings = await identity.updateSettings(userId, { periodAnchorDate: '2026-09-15' });
    const after = await repo.findUser(userId);
    expect(settings.periodAnchorDate).toBe('2026-09-15');
    expect(ledger.calls).toEqual([]);
    expect({ ...after, periodAnchorDate: before?.periodAnchorDate, updatedAt: before?.updatedAt }).toEqual(before);
  });

  it('rejects a malformed or impossible date, and null', async () => {
    const userId = await onboardedUser();
    for (const bad of ['15/09/2026', '2026-02-30', '2026-13-01', 'tomorrow']) {
      await expect(identity.updateSettings(userId, { periodAnchorDate: bad })).rejects.toMatchObject({
        code: 'INVALID_ARGUMENT',
      });
    }
    await expect(identity.updateSettings(userId, { periodAnchorDate: null })).rejects.toMatchObject({
      code: 'INVALID_ARGUMENT',
    });
  });

  it('reminder time is a plain write validated as HH:MM (M5 picks it up at the next send)', async () => {
    const userId = await onboardedUser();
    expect((await identity.updateSettings(userId, { reminderLocalTime: '08:30' })).reminderLocalTime).toBe('08:30');
    await expect(identity.updateSettings(userId, { reminderLocalTime: '8:30' })).rejects.toMatchObject({
      code: 'INVALID_ARGUMENT',
    });
    await expect(identity.updateSettings(userId, { reminderLocalTime: '24:00' })).rejects.toMatchObject({
      code: 'INVALID_ARGUMENT',
    });
  });

  it('an empty patch returns the current settings without writing', async () => {
    const userId = await onboardedUser();
    const before = (await repo.findUser(userId))?.updatedAt;
    clock.advance(60_000);
    await identity.updateSettings(userId, {});
    expect((await repo.findUser(userId))?.updatedAt).toBe(before);
  });

  it('rejects unknown setting keys from JavaScript or forged callers', async () => {
    const userId = await onboardedUser();
    const forged = { locale: 'en-AU' } as unknown as Parameters<typeof identity.updateSettings>[1];
    await expect(identity.updateSettings(userId, forged)).rejects.toMatchObject({
      code: 'INVALID_ARGUMENT',
      message: expect.stringContaining('locale'),
    });
  });

  it('is ONBOARDING_REQUIRED before a timezone exists', async () => {
    const { userId } = await identity.register('telegram', '1', '1');
    await expect(identity.updateSettings(userId, { currencyCode: 'NZD' })).rejects.toMatchObject({
      code: 'ONBOARDING_REQUIRED',
    });
  });
});

describe('exportAccount / deleteAccount', () => {
  it('exportAccount is deferred: NOT_YET_AVAILABLE', async () => {
    const userId = await onboardedUser();
    await expect(identity.exportAccount(userId)).rejects.toMatchObject({ code: 'NOT_YET_AVAILABLE' });
  });

  it('deleteAccount hard-deletes the user and cascades to every user-owned row', async () => {
    const userId = await onboardedUser();
    const other = await identity.register('telegram', '2', '2');
    repo.addForeignRow('category', userId);
    repo.addForeignRow('transaction', userId);
    repo.addForeignRow('category', other.userId);

    await identity.deleteAccount(userId);

    expect(repo.users.has(userId)).toBe(false);
    expect(await identity.resolve('telegram', '12345')).toBeNull();
    expect(await identity.findActiveConnection(userId, 'telegram')).toBeNull();
    for (const rows of repo.foreignRows.values()) expect(rows.has(userId)).toBe(false);
    // The other user is untouched.
    expect(repo.users.has(other.userId)).toBe(true);
    expect(repo.foreignRows.get('category')?.has(other.userId)).toBe(true);
    // Deleting again is a no-op, and the id can be re-registered as a brand-new user.
    await expect(identity.deleteAccount(userId)).resolves.toBeUndefined();
    const reborn = await identity.register('telegram', '12345', '12345');
    expect(reborn.isNew).toBe(true);
    expect(reborn.userId).not.toBe(userId);
  });
});
