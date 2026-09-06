import type {
  ConnectionRecord,
  ConnectionRefresh,
  IdentityRepository,
  RegisterConnectionInput,
  RegisterConnectionResult,
  UserRecord,
  UserSettingsPatch,
} from '../identity/repository';
import type { Channel, Id, Instant, UserId } from '../ports/common';

/**
 * In-memory `IdentityRepository` for unit tests — the M2 counterpart of `TestClock`.
 *
 * It models the two guarantees the real schema provides and the service relies on:
 *   - `(channel, external_id)` uniqueness: the check-and-insert in
 *     `registerConnection` is synchronous (one JS turn), so it is atomic the way the
 *     DB constraint is; the optional `yieldBeforeWrite` hook lets a test interleave
 *     concurrent callers ahead of that critical section.
 *   - `on delete cascade`: `deleteUser` removes the user's connections too.
 * It also mirrors `claimInitialTimezone`'s `where timezone = ''` predicate exactly.
 *
 * Neither guarantee is *proved* here — that's the integration suite's job against a
 * real Neon branch (M1 §7).
 */
export class InMemoryIdentityRepository implements IdentityRepository {
  readonly users = new Map<UserId, UserRecord>();
  readonly connections = new Map<Id, ConnectionRecord>();
  #seq = 0;

  /** Awaited before the atomic create — lets a test simulate scheduling jitter. */
  yieldBeforeWrite: () => Promise<void> = async () => {};

  async findConnection(channel: Channel, externalId: string): Promise<ConnectionRecord | null> {
    return this.#lookup(channel, externalId);
  }

  async registerConnection(input: RegisterConnectionInput): Promise<RegisterConnectionResult> {
    await this.yieldBeforeWrite();

    // ── critical section: no `await` between the uniqueness check and the writes ──
    const existing = this.#lookup(input.channel, input.externalId);
    if (existing) return { connection: existing, created: false };

    const userId = this.#id('user');
    this.users.set(userId, {
      id: userId,
      timezone: '',
      currencyCode: 'AUD',
      periodAnchorDate: null,
      reminderLocalTime: '07:00',
      status: 'active',
      createdAt: input.now,
      updatedAt: input.now,
      deletedAt: null,
    });
    const connection: ConnectionRecord = {
      id: this.#id('conn'),
      userId,
      channel: input.channel,
      externalId: input.externalId,
      chatId: input.chatId,
      username: input.username,
      isActive: true,
      linkedAt: input.now,
    };
    this.connections.set(connection.id, connection);
    return { connection, created: true };
  }

  async refreshConnection(connectionId: Id, refresh: ConnectionRefresh): Promise<void> {
    const c = this.connections.get(connectionId);
    if (c) this.connections.set(connectionId, { ...c, ...refresh, isActive: true });
  }

  async findUser(userId: UserId): Promise<UserRecord | null> {
    return this.users.get(userId) ?? null;
  }

  async claimInitialTimezone(userId: UserId, timezone: string, now: Instant): Promise<boolean> {
    const u = this.users.get(userId);
    if (!u || u.timezone !== '') return false;
    this.users.set(userId, { ...u, timezone, updatedAt: now });
    return true;
  }

  async updateUser(userId: UserId, patch: UserSettingsPatch, now: Instant): Promise<UserRecord | null> {
    const u = this.users.get(userId);
    if (!u) return null;
    const next: UserRecord = { ...u, ...patch, updatedAt: now };
    this.users.set(userId, next);
    return next;
  }

  async deleteUser(userId: UserId): Promise<boolean> {
    if (!this.users.delete(userId)) return false;
    for (const [id, c] of this.connections) {
      if (c.userId === userId) this.connections.delete(id); // on delete cascade
    }
    return true;
  }

  /** Test helper: seed a `timezone` directly (bypassing the set-once path) to model a legacy row. */
  seedTimezone(userId: UserId, timezone: string): void {
    const u = this.users.get(userId);
    if (!u) throw new Error(`no user ${userId}`);
    this.users.set(userId, { ...u, timezone });
  }

  #lookup(channel: Channel, externalId: string): ConnectionRecord | null {
    for (const c of this.connections.values()) {
      if (c.channel === channel && c.externalId === externalId) return c;
    }
    return null;
  }

  #id(prefix: string): string {
    this.#seq += 1;
    return `${prefix}-${this.#seq.toString().padStart(4, '0')}`;
  }
}
