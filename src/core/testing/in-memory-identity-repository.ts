import type {
  AppUserPatch,
  AppUserRecord,
  ConnectionLookup,
  IdentityRepository,
  RegisterOutcome,
  SetTimezoneOutcome,
} from '../identity/repository';
import type { Channel, Instant, UserId } from '../ports/common';
import type { ChannelConnection } from '../ports/messaging';

/**
 * `IdentityRepository` in memory, for unit tests of the M2 service logic.
 *
 * It reproduces the two DB guarantees the service relies on — the
 * `(channel, external_id)` unique constraint and the conditional
 * `timezone = ''` update — as *synchronous* checks at the moment of the write, so
 * concurrent `register`/`setInitialTimezone` calls interleaved across `await`s behave
 * like they do against Postgres. It also cascades deletes. It does not enforce check
 * constraints; that is what the integration tier is for.
 */
export class InMemoryIdentityRepository implements IdentityRepository {
  readonly users = new Map<UserId, AppUserRecord>();
  readonly connections = new Map<string, ChannelConnection>();
  #seq = 0;

  /** Rows other modules would own, keyed by table, so cascade tests can assert them gone. */
  readonly foreignRows = new Map<string, Set<UserId>>();

  async findConnection(channel: Channel, externalId: string): Promise<ConnectionLookup | null> {
    await tick();
    const conn = this.connections.get(key(channel, externalId));
    if (!conn) return null;
    const user = this.users.get(conn.userId);
    return user ? { userId: user.id, onboardingStep: user.onboardingStep } : null;
  }

  async register(
    channel: Channel,
    externalId: string,
    chatId: string,
    username: string | null,
    now: Instant,
  ): Promise<RegisterOutcome> {
    // Simulate the transaction: speculative user row, then the constrained insert.
    const speculative: AppUserRecord = {
      id: this.nextId('user'),
      timezone: '',
      currencyCode: 'AUD',
      periodAnchorDate: null,
      reminderLocalTime: '07:00',
      status: 'active',
      onboardingStep: 'timezone',
      createdAt: now,
      updatedAt: now,
    };
    await tick(); // where a real DB would be waiting on the unique index

    const k = key(channel, externalId);
    const existing = this.connections.get(k);
    if (!existing) {
      this.users.set(speculative.id, speculative);
      this.connections.set(k, {
        id: this.nextId('conn'),
        userId: speculative.id,
        channel,
        externalId,
        chatId,
        username,
        isActive: true,
        linkedAt: now,
      });
      return { userId: speculative.id, isNew: true, onboardingStep: 'timezone' };
    }
    // "rollback": the speculative user is simply never stored.
    this.connections.set(k, { ...existing, chatId, username, isActive: true });
    const user = this.users.get(existing.userId);
    if (!user) throw new Error('dangling connection');
    return { userId: user.id, isNew: false, onboardingStep: user.onboardingStep };
  }

  async findUser(userId: UserId): Promise<AppUserRecord | null> {
    await tick();
    const user = this.users.get(userId);
    return user ? { ...user } : null;
  }

  async setTimezoneIfUnset(userId: UserId, timezone: string, now: Instant): Promise<SetTimezoneOutcome> {
    await tick();
    const user = this.users.get(userId);
    if (!user) return 'missing';
    if (user.timezone !== '') return 'already_set';
    this.users.set(userId, { ...user, timezone, updatedAt: now });
    return 'set';
  }

  async updateUser(userId: UserId, patch: AppUserPatch, now: Instant): Promise<AppUserRecord | null> {
    await tick();
    const user = this.users.get(userId);
    if (!user) return null;
    const next: AppUserRecord = { ...user, updatedAt: now };
    if (patch.currencyCode !== undefined) next.currencyCode = patch.currencyCode;
    if (patch.periodAnchorDate !== undefined) next.periodAnchorDate = patch.periodAnchorDate;
    if (patch.reminderLocalTime !== undefined) next.reminderLocalTime = patch.reminderLocalTime;
    if (patch.onboardingStep !== undefined) next.onboardingStep = patch.onboardingStep;
    this.users.set(userId, next);
    return { ...next };
  }

  async deleteUser(userId: UserId): Promise<void> {
    await tick();
    this.users.delete(userId);
    for (const [k, conn] of this.connections) if (conn.userId === userId) this.connections.delete(k);
    for (const rows of this.foreignRows.values()) rows.delete(userId);
  }

  async activeConnection(userId: UserId, channel: Channel): Promise<ChannelConnection | null> {
    await tick();
    for (const conn of this.connections.values()) {
      if (conn.userId === userId && conn.channel === channel && conn.isActive) return { ...conn };
    }
    return null;
  }

  async deactivateConnection(userId: UserId, channel: Channel): Promise<void> {
    await tick();
    for (const [k, conn] of this.connections) {
      if (conn.userId === userId && conn.channel === channel) this.connections.set(k, { ...conn, isActive: false });
    }
  }

  /** Test helper: pretend another module wrote a `user_id`-scoped row. */
  addForeignRow(table: string, userId: UserId): void {
    let rows = this.foreignRows.get(table);
    if (!rows) this.foreignRows.set(table, (rows = new Set()));
    rows.add(userId);
  }

  private nextId(prefix: string): string {
    this.#seq += 1;
    return `${prefix}-${String(this.#seq).padStart(4, '0')}`;
  }
}

function key(channel: Channel, externalId: string): string {
  return `${channel}:${externalId}`;
}

/** Yield to the microtask queue so concurrent callers actually interleave. */
function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}
