import { describe, expect, it } from 'vitest';
import { isIdentityError } from '../../../src/core/identity/errors';
import type { UserSettings } from '../../../src/core/ports/identity-service';
import { harness, onboarded, registered } from './doubles';

async function codeOf(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
    return undefined;
  } catch (error) {
    return isIdentityError(error) ? error.code : `unexpected: ${String(error)}`;
  }
}

describe('register / resolve', () => {
  it('creates exactly one user under concurrent duplicate register calls', async () => {
    const h = harness();
    // Make every caller yield before its atomic create so they genuinely interleave.
    h.repo.yieldBeforeWrite = () => new Promise((r) => setTimeout(r, Math.random() * 5));

    const results = await Promise.all(
      Array.from({ length: 12 }, () => h.identity.register('telegram', '42', '42', 'ricky')),
    );

    const ids = new Set(results.map((r) => r.userId));
    expect(ids.size).toBe(1);
    expect(results.filter((r) => r.isNew)).toHaveLength(1);
    expect(h.repo.users.size).toBe(1);
    expect(h.repo.connections.size).toBe(1);
  });

  it('resolve returns the registered user and null for a stranger', async () => {
    const h = harness();
    const userId = await registered(h, '7');
    expect(await h.identity.resolve('telegram', '7')).toEqual({ userId, isNew: false });
    expect(await h.identity.resolve('telegram', '8')).toBeNull();
  });

  it('a second register is idempotent and refreshes the connection, not the account', async () => {
    const h = harness();
    const first = await h.identity.register('telegram', '9', '9', 'old-name');
    expect(first.isNew).toBe(true);

    // Simulate M5 having deactivated the connection after a 403.
    const conn = [...h.repo.connections.values()][0]!;
    h.repo.connections.set(conn.id, { ...conn, isActive: false });

    const again = await h.identity.register('telegram', '9', '9', 'new-name');
    expect(again).toEqual({ userId: first.userId, isNew: false });
    expect(h.repo.users.size).toBe(1);
    const refreshed = h.repo.connections.get(conn.id)!;
    expect(refreshed.username).toBe('new-name');
    expect(refreshed.isActive).toBe(true);
  });

  it('stamps created_at / updated_at from the injected clock', async () => {
    const h = harness('2026-09-06T07:00:00.000Z');
    const userId = await registered(h);
    const user = h.repo.users.get(userId)!;
    expect(user.createdAt).toBe(Date.parse('2026-09-06T07:00:00.000Z'));
    expect(user.updatedAt).toBe(user.createdAt);
  });
});

describe('settings defaults', () => {
  it('a fresh user has an unset timezone, AUD, no anchor date, 07:00 reminder', async () => {
    const h = harness();
    const userId = await registered(h);
    expect(await h.identity.getSettings(userId)).toEqual<UserSettings>({
      timezone: '',
      currencyCode: 'AUD',
      periodAnchorDate: null,
      reminderLocalTime: '07:00',
    });
  });

  it('getSettings on an unknown user is RESOURCE_NOT_FOUND', async () => {
    const h = harness();
    expect(await codeOf(h.identity.getSettings('nope'))).toBe('RESOURCE_NOT_FOUND');
  });
});

describe('timezone immutability', () => {
  it('setInitialTimezone succeeds once and stores the canonical zone id', async () => {
    const h = harness('2026-09-06T01:00:00.000Z');
    const userId = await registered(h);
    h.clock.advance(60_000);
    await h.identity.setInitialTimezone(userId, 'australia/brisbane');
    const settings = await h.identity.getSettings(userId);
    expect(settings.timezone).toBe('Australia/Brisbane');
    expect(h.repo.users.get(userId)!.updatedAt).toBe(Date.parse('2026-09-06T01:01:00.000Z'));
  });

  it('a second setInitialTimezone with a different zone is TIMEZONE_IMMUTABLE', async () => {
    const h = harness();
    const userId = await registered(h);
    await h.identity.setInitialTimezone(userId, 'Australia/Brisbane');
    expect(await codeOf(h.identity.setInitialTimezone(userId, 'Australia/Sydney'))).toBe(
      'TIMEZONE_IMMUTABLE',
    );
    expect((await h.identity.getSettings(userId)).timezone).toBe('Australia/Brisbane');
  });

  it('a replayed setInitialTimezone with the identical zone is a silent no-op', async () => {
    const h = harness();
    const userId = await registered(h);
    await h.identity.setInitialTimezone(userId, 'Australia/Brisbane');
    const before = h.repo.users.get(userId)!.updatedAt;
    h.clock.advance(1_000);
    await expect(h.identity.setInitialTimezone(userId, 'Australia/Brisbane')).resolves.toBeUndefined();
    expect(h.repo.users.get(userId)!.updatedAt).toBe(before);
  });

  it('only one of many concurrent first-time claims wins', async () => {
    const h = harness();
    const userId = await registered(h);
    const zones = ['Australia/Brisbane', 'Australia/Sydney', 'Australia/Perth', 'Australia/Hobart'];
    const outcomes = await Promise.all(
      zones.map((z) => h.identity.setInitialTimezone(userId, z).then(() => 'ok', (e) => e.code)),
    );
    expect(outcomes.filter((o) => o === 'ok')).toHaveLength(1);
    expect(outcomes.filter((o) => o === 'TIMEZONE_IMMUTABLE')).toHaveLength(3);
  });

  it('updateSettings carrying timezone is TIMEZONE_IMMUTABLE — even the same value, even if unset', async () => {
    const h = harness();
    const userId = await registered(h);

    // Forged patch before onboarding: the type forbids it, the runtime guard catches it.
    const forged = { timezone: 'Australia/Sydney' } as unknown as Partial<Omit<UserSettings, 'timezone'>>;
    expect(await codeOf(h.identity.updateSettings(userId, forged))).toBe('TIMEZONE_IMMUTABLE');

    await h.identity.setInitialTimezone(userId, 'Australia/Brisbane');

    const sameValue = { timezone: 'Australia/Brisbane', currencyCode: 'AUD' } as unknown as Partial<
      Omit<UserSettings, 'timezone'>
    >;
    expect(await codeOf(h.identity.updateSettings(userId, sameValue))).toBe('TIMEZONE_IMMUTABLE');

    const different = { timezone: 'Australia/Sydney' } as unknown as Partial<Omit<UserSettings, 'timezone'>>;
    expect(await codeOf(h.identity.updateSettings(userId, different))).toBe('TIMEZONE_IMMUTABLE');

    // Nothing else in the patch was applied either — no partial write.
    expect((await h.identity.getSettings(userId)).timezone).toBe('Australia/Brisbane');
  });

  it('an invalid IANA zone is INVALID_ARGUMENT and leaves the slot unclaimed', async () => {
    const h = harness();
    const userId = await registered(h);
    expect(await codeOf(h.identity.setInitialTimezone(userId, 'Mars/Olympus_Mons'))).toBe(
      'INVALID_ARGUMENT',
    );
    expect(await codeOf(h.identity.setInitialTimezone(userId, ''))).toBe('INVALID_ARGUMENT');
    await expect(h.identity.setInitialTimezone(userId, 'Australia/Darwin')).resolves.toBeUndefined();
  });
});

describe('currency change', () => {
  it('is allowed with zero transactions', async () => {
    const h = harness();
    const userId = await onboarded(h);
    h.ledger.transactionCount = 0;
    const settings = await h.identity.updateSettings(userId, { currencyCode: 'NZD' });
    expect(settings.currencyCode).toBe('NZD');
  });

  it('is refused with CURRENCY_LOCKED once the user has one transaction', async () => {
    const h = harness();
    const userId = await onboarded(h);
    h.ledger.transactionCount = 1;
    expect(await codeOf(h.identity.updateSettings(userId, { currencyCode: 'NZD' }))).toBe(
      'CURRENCY_LOCKED',
    );
    expect((await h.identity.getSettings(userId)).currencyCode).toBe('AUD');
  });

  it('a same-value currency patch is a no-op even with transactions', async () => {
    const h = harness();
    const userId = await onboarded(h);
    h.ledger.transactionCount = 5;
    const settings = await h.identity.updateSettings(userId, { currencyCode: 'AUD' });
    expect(settings.currencyCode).toBe('AUD');
  });

  it('rejects a malformed code', async () => {
    const h = harness();
    const userId = await onboarded(h);
    expect(await codeOf(h.identity.updateSettings(userId, { currencyCode: 'aud' }))).toBe(
      'INVALID_ARGUMENT',
    );
    expect(await codeOf(h.identity.updateSettings(userId, { currencyCode: 'AUDX' }))).toBe(
      'INVALID_ARGUMENT',
    );
  });
});

describe('period anchor date and reminder time', () => {
  it('stores a valid anchor date and rejects impossible ones', async () => {
    const h = harness();
    const userId = await registered(h);
    await h.identity.setInitialTimezone(userId, 'Australia/Brisbane');
    const s = await h.identity.updateSettings(userId, { periodAnchorDate: '2026-02-28' });
    expect(s.periodAnchorDate).toBe('2026-02-28');
    expect(await codeOf(h.identity.updateSettings(userId, { periodAnchorDate: '2026-02-30' }))).toBe(
      'INVALID_ARGUMENT',
    );
    expect(await codeOf(h.identity.updateSettings(userId, { periodAnchorDate: '28/02/2026' }))).toBe(
      'INVALID_ARGUMENT',
    );
    expect(await codeOf(h.identity.updateSettings(userId, { periodAnchorDate: null }))).toBe(
      'INVALID_ARGUMENT',
    );
  });

  it('changing the anchor date is a pure setting write — nothing else is touched', async () => {
    const h = harness();
    const userId = await onboarded(h);
    h.ledger.transactionCount = 3; // history exists; re-bucketing is allowed regardless
    const s = await h.identity.updateSettings(userId, { periodAnchorDate: '2026-09-15' });
    expect(s.periodAnchorDate).toBe('2026-09-15');
    expect(s.currencyCode).toBe('AUD');
  });

  it('reminder time accepts HH:MM only', async () => {
    const h = harness();
    const userId = await onboarded(h);
    const s = await h.identity.updateSettings(userId, { reminderLocalTime: '06:30' });
    expect(s.reminderLocalTime).toBe('06:30');
    expect(await codeOf(h.identity.updateSettings(userId, { reminderLocalTime: '6:30' }))).toBe(
      'INVALID_ARGUMENT',
    );
    expect(await codeOf(h.identity.updateSettings(userId, { reminderLocalTime: '24:00' }))).toBe(
      'INVALID_ARGUMENT',
    );
  });

  it('an unknown key in the patch is INVALID_ARGUMENT', async () => {
    const h = harness();
    const userId = await onboarded(h);
    const forged = { tier: 'premium' } as unknown as Partial<Omit<UserSettings, 'timezone'>>;
    expect(await codeOf(h.identity.updateSettings(userId, forged))).toBe('INVALID_ARGUMENT');
  });

  it('an all-no-op patch does not bump updated_at', async () => {
    const h = harness();
    const userId = await onboarded(h);
    const before = h.repo.users.get(userId)!.updatedAt;
    h.clock.advance(5_000);
    await h.identity.updateSettings(userId, { periodAnchorDate: '2026-09-01', reminderLocalTime: '07:00' });
    expect(h.repo.users.get(userId)!.updatedAt).toBe(before);
  });
});

describe('exportAccount (deferred)', () => {
  it('throws NOT_YET_AVAILABLE with a "not implemented" message', async () => {
    const h = harness();
    const userId = await onboarded(h);
    const error = await h.identity.exportAccount(userId).catch((e: unknown) => e);
    expect(isIdentityError(error, 'NOT_YET_AVAILABLE')).toBe(true);
    expect((error as Error).message).toMatch(/not implemented/);
  });
});

describe('deleteAccount', () => {
  it('hard-deletes the user and cascades to the channel connection', async () => {
    const h = harness();
    const userId = await onboarded(h, '55');
    await h.identity.deleteAccount(userId);
    expect(h.repo.users.has(userId)).toBe(false);
    expect([...h.repo.connections.values()].filter((c) => c.userId === userId)).toHaveLength(0);
    expect(await h.identity.resolve('telegram', '55')).toBeNull();
  });

  it('is idempotent — a retried delete is a no-op', async () => {
    const h = harness();
    const userId = await onboarded(h);
    await h.identity.deleteAccount(userId);
    await expect(h.identity.deleteAccount(userId)).resolves.toBeUndefined();
  });

  it('re-registering after deletion is a brand-new account with fresh settings', async () => {
    const h = harness();
    const userId = await onboarded(h, '66');
    await h.identity.deleteAccount(userId);
    const again = await h.identity.register('telegram', '66', '66');
    expect(again.isNew).toBe(true);
    expect(again.userId).not.toBe(userId);
    expect((await h.identity.getSettings(again.userId)).timezone).toBe('');
  });
});
