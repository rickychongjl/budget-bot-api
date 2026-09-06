import { and, eq, TransactionRollbackError } from 'drizzle-orm';
import type { Database } from '../../db/client';
import { appUser, channelConnection } from '../../db/schema/identity';
import type { AppUserRow, ChannelConnectionRow } from '../../db/schema/identity';
import type { Channel, Id, Instant, UserId } from '../ports/common';
import type {
  ConnectionRecord,
  ConnectionRefresh,
  IdentityRepository,
  RegisterConnectionInput,
  RegisterConnectionResult,
  UserRecord,
  UserSettingsPatch,
  UserStatus,
} from './repository';
import { validateLocalTime } from './validation';

/**
 * The production edge for M2: `IdentityRepository` over Drizzle + `postgres.js`
 * (`db/client.ts`). Constraints do the real work here — the `(channel, external_id)`
 * unique constraint makes `registerConnection` idempotent, `on delete cascade` makes
 * `deleteUser` complete — which is why this class is exercised by the integration
 * suite against a real Neon branch, not a mock (M1 §7).
 */
export class DrizzleIdentityRepository implements IdentityRepository {
  constructor(private readonly db: Database) {}

  async findConnection(channel: Channel, externalId: string): Promise<ConnectionRecord | null> {
    const rows = await this.db
      .select()
      .from(channelConnection)
      .where(and(eq(channelConnection.channel, channel), eq(channelConnection.externalId, externalId)))
      .limit(1);
    const row = rows[0];
    return row ? toConnection(row) : null;
  }

  /**
   * One transaction: insert `app_user`, then `insert … on conflict (channel,
   * external_id) do nothing returning *`. No returned row means another call already
   * owns this identity — roll the orphan `app_user` back and return the winner's
   * connection. The read-first fast path is an optimisation for the common returning
   * user; correctness never depends on it.
   */
  async registerConnection(input: RegisterConnectionInput): Promise<RegisterConnectionResult> {
    const existing = await this.findConnection(input.channel, input.externalId);
    if (existing) return { connection: existing, created: false };

    const now = new Date(input.now);
    let inserted: ChannelConnectionRow | null = null;
    try {
      inserted = await this.db.transaction(async (tx) => {
        const users = await tx
          .insert(appUser)
          .values({ timezone: '', createdAt: now, updatedAt: now })
          .returning({ id: appUser.id });
        const user = users[0];
        if (!user) throw new Error('app_user insert returned no row');

        const connections = await tx
          .insert(channelConnection)
          .values({
            userId: user.id,
            channel: input.channel,
            externalId: input.externalId,
            chatId: input.chatId,
            username: input.username,
            linkedAt: now,
          })
          .onConflictDoNothing({ target: [channelConnection.channel, channelConnection.externalId] })
          .returning();
        const connection = connections[0];
        if (!connection) tx.rollback(); // lost the race — discard the orphan app_user
        return connection ?? null;
      });
    } catch (error) {
      if (!(error instanceof TransactionRollbackError)) throw error;
    }

    if (inserted) return { connection: toConnection(inserted), created: true };

    const winner = await this.findConnection(input.channel, input.externalId);
    if (!winner) {
      // Only reachable if the winner was deleted between its commit and our read.
      throw new Error(`register race for ${input.channel}:${input.externalId} left no connection`);
    }
    return { connection: winner, created: false };
  }

  async refreshConnection(connectionId: Id, refresh: ConnectionRefresh): Promise<void> {
    await this.db
      .update(channelConnection)
      .set({ chatId: refresh.chatId, username: refresh.username, isActive: true })
      .where(eq(channelConnection.id, connectionId));
  }

  async findUser(userId: UserId): Promise<UserRecord | null> {
    const rows = await this.db.select().from(appUser).where(eq(appUser.id, userId)).limit(1);
    const row = rows[0];
    return row ? toUser(row) : null;
  }

  async claimInitialTimezone(userId: UserId, timezone: string, now: Instant): Promise<boolean> {
    const rows = await this.db
      .update(appUser)
      .set({ timezone, updatedAt: new Date(now) })
      .where(and(eq(appUser.id, userId), eq(appUser.timezone, '')))
      .returning({ id: appUser.id });
    return rows.length > 0;
  }

  async updateUser(
    userId: UserId,
    patch: UserSettingsPatch,
    now: Instant,
  ): Promise<UserRecord | null> {
    const rows = await this.db
      .update(appUser)
      .set({ ...patch, updatedAt: new Date(now) })
      .where(eq(appUser.id, userId))
      .returning();
    const row = rows[0];
    return row ? toUser(row) : null;
  }

  async deleteUser(userId: UserId): Promise<boolean> {
    const rows = await this.db.delete(appUser).where(eq(appUser.id, userId)).returning({ id: appUser.id });
    return rows.length > 0;
  }
}

function toUser(row: AppUserRow): UserRecord {
  return {
    id: row.id,
    timezone: row.timezone,
    currencyCode: row.currencyCode,
    periodAnchorDate: row.periodAnchorDate,
    // Postgres `time` reads back as HH:MM:SS; the contract is HH:MM.
    reminderLocalTime: validateLocalTime(row.reminderLocalTime),
    status: row.status as UserStatus,
    createdAt: row.createdAt.getTime(),
    updatedAt: row.updatedAt.getTime(),
    deletedAt: row.deletedAt ? row.deletedAt.getTime() : null,
  };
}

function toConnection(row: ChannelConnectionRow): ConnectionRecord {
  return {
    id: row.id,
    userId: row.userId,
    channel: row.channel as Channel,
    externalId: row.externalId,
    chatId: row.chatId,
    username: row.username,
    isActive: row.isActive,
    linkedAt: row.linkedAt.getTime(),
  };
}
