import { and, eq } from 'drizzle-orm';
import { TransactionRollbackError } from 'drizzle-orm/errors';
import type { Database } from '../../db/client';
import { appUser, channelConnection } from '../../db/schema/identity';
import type { Channel, Instant, UserId } from '../ports/common';
import type { ChannelConnection } from '../ports/messaging';
import type {
  AppUserPatch,
  AppUserRecord,
  ConnectionLookup,
  IdentityRepository,
  OnboardingStep,
  RegisterOutcome,
  SetTimezoneOutcome,
  UserStatus,
} from './repository';

/**
 * `IdentityRepository` over Drizzle/Postgres — the only M2 code that touches a DB
 * handle. Every invariant the module promises is a *constraint or conditional
 * update here*, never a read-then-write in the service:
 *
 *   - `register`: `insert app_user` + `insert channel_connection … on conflict
 *     (channel, external_id) do nothing`, in one transaction. Zero rows from the
 *     second insert means somebody else won — roll back (so the speculative
 *     `app_user` never survives) and read the winner. Two concurrent first-`/start`s
 *     serialise on the unique index.
 *   - `setTimezoneIfUnset`: `update … where timezone = ''` — at most one caller
 *     ever sees a row updated.
 */
export class DrizzleIdentityRepository implements IdentityRepository {
  constructor(private readonly db: Database) {}

  async findConnection(channel: Channel, externalId: string): Promise<ConnectionLookup | null> {
    const rows = await this.db
      .select({ userId: channelConnection.userId, onboardingStep: appUser.onboardingStep })
      .from(channelConnection)
      .innerJoin(appUser, eq(appUser.id, channelConnection.userId))
      .where(and(eq(channelConnection.channel, channel), eq(channelConnection.externalId, externalId)))
      .limit(1);
    const row = rows[0];
    return row ? { userId: row.userId, onboardingStep: asStep(row.onboardingStep) } : null;
  }

  async register(
    channel: Channel,
    externalId: string,
    chatId: string,
    username: string | null,
    now: Instant,
  ): Promise<RegisterOutcome> {
    const created = await this.db
      .transaction(async (tx): Promise<RegisterOutcome> => {
        const [user] = await tx
          .insert(appUser)
          .values({
            timezone: '',
            onboardingStep: 'timezone',
            createdAt: new Date(now),
            updatedAt: new Date(now),
          })
          .returning({ id: appUser.id, onboardingStep: appUser.onboardingStep });
        if (!user) throw new Error('app_user insert returned no row');

        const linked = await tx
          .insert(channelConnection)
          .values({ userId: user.id, channel, externalId, chatId, username, linkedAt: new Date(now) })
          .onConflictDoNothing({ target: [channelConnection.channel, channelConnection.externalId] })
          .returning({ userId: channelConnection.userId });

        // Somebody else holds (channel, external_id): undo our speculative app_user.
        if (linked.length === 0) tx.rollback();
        return { userId: user.id, isNew: true, onboardingStep: asStep(user.onboardingStep) };
      })
      .catch((err: unknown) => {
        if (err instanceof TransactionRollbackError) return null;
        throw err;
      });
    if (created) return created;

    // Existing user: refresh delivery details and re-activate (403 recovery path).
    const [refreshed] = await this.db
      .update(channelConnection)
      .set({ chatId, username, isActive: true })
      .where(and(eq(channelConnection.channel, channel), eq(channelConnection.externalId, externalId)))
      .returning({ userId: channelConnection.userId });
    if (!refreshed) {
      // Deleted between our conflict and this update — vanishingly rare; try once more.
      return this.register(channel, externalId, chatId, username, now);
    }
    const user = await this.findUser(refreshed.userId);
    if (!user) throw new Error(`channel_connection without app_user: ${refreshed.userId}`);
    return { userId: user.id, isNew: false, onboardingStep: user.onboardingStep };
  }

  async findUser(userId: UserId): Promise<AppUserRecord | null> {
    const rows = await this.db.select().from(appUser).where(eq(appUser.id, userId)).limit(1);
    const row = rows[0];
    return row ? toRecord(row) : null;
  }

  async setTimezoneIfUnset(userId: UserId, timezone: string, now: Instant): Promise<SetTimezoneOutcome> {
    const updated = await this.db
      .update(appUser)
      .set({ timezone, updatedAt: new Date(now) })
      .where(and(eq(appUser.id, userId), eq(appUser.timezone, '')))
      .returning({ id: appUser.id });
    if (updated.length === 1) return 'set';
    const exists = await this.db.select({ id: appUser.id }).from(appUser).where(eq(appUser.id, userId)).limit(1);
    return exists.length === 1 ? 'already_set' : 'missing';
  }

  async updateUser(userId: UserId, patch: AppUserPatch, now: Instant): Promise<AppUserRecord | null> {
    const set: Partial<typeof appUser.$inferInsert> = { updatedAt: new Date(now) };
    if (patch.currencyCode !== undefined) set.currencyCode = patch.currencyCode;
    if (patch.periodAnchorDate !== undefined) set.periodAnchorDate = patch.periodAnchorDate;
    if (patch.reminderLocalTime !== undefined) set.reminderLocalTime = patch.reminderLocalTime;
    if (patch.onboardingStep !== undefined) set.onboardingStep = patch.onboardingStep;
    const rows = await this.db.update(appUser).set(set).where(eq(appUser.id, userId)).returning();
    const row = rows[0];
    return row ? toRecord(row) : null;
  }

  async deleteUser(userId: UserId): Promise<void> {
    await this.db.delete(appUser).where(eq(appUser.id, userId));
  }

  async activeConnection(userId: UserId, channel: Channel): Promise<ChannelConnection | null> {
    const rows = await this.db
      .select()
      .from(channelConnection)
      .where(
        and(
          eq(channelConnection.userId, userId),
          eq(channelConnection.channel, channel),
          eq(channelConnection.isActive, true),
        ),
      )
      .limit(1);
    const row = rows[0];
    if (!row) return null;
    return {
      id: row.id,
      userId: row.userId,
      channel: asChannel(row.channel),
      externalId: row.externalId,
      chatId: row.chatId,
      username: row.username,
      isActive: row.isActive,
      linkedAt: row.linkedAt.getTime(),
    };
  }

  async deactivateConnection(userId: UserId, channel: Channel): Promise<void> {
    await this.db
      .update(channelConnection)
      .set({ isActive: false })
      .where(and(eq(channelConnection.userId, userId), eq(channelConnection.channel, channel)));
  }
}

function toRecord(row: typeof appUser.$inferSelect): AppUserRecord {
  return {
    id: row.id,
    timezone: row.timezone,
    currencyCode: row.currencyCode,
    periodAnchorDate: row.periodAnchorDate,
    // Postgres `time` reads back as 'HH:MM:SS'; the contract is 'HH:MM'.
    reminderLocalTime: row.reminderLocalTime.slice(0, 5),
    status: row.status as UserStatus,
    onboardingStep: asStep(row.onboardingStep),
    createdAt: row.createdAt.getTime(),
    updatedAt: row.updatedAt.getTime(),
  };
}

/** The check constraint guarantees the value; this only narrows the type. */
function asStep(value: string): OnboardingStep {
  return value as OnboardingStep;
}

function asChannel(value: string): Channel {
  return value as Channel;
}
