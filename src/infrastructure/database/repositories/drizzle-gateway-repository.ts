import { eq, sql } from 'drizzle-orm';
import type { Database } from '../client';
import { inboundUpdate, pendingPrompt } from '../schema/platform';
import type {
  GatewayRepository,
  PendingPrompt,
  PendingPromptKind,
  SetPendingPromptInput,
} from '../../../channels/telegram/gateway-repository';
import type { Channel, Instant, UserId } from '../../../core/shared/common';

/**
 * Production `GatewayRepository` over Drizzle (`channels/telegram/gateway-repository.ts`).
 *
 * Both operations are single statements on purpose. `claimUpdate` must be atomic
 * against a concurrent redelivery landing in a different isolate — the primary key
 * does that, and a `select`-then-`insert` would not. The prompt upsert is atomic
 * against the same user sending two messages at once.
 */
export class DrizzleGatewayRepository implements GatewayRepository {
  constructor(private readonly db: Database) {}

  /**
   * `insert … on conflict do nothing`, returning whether *this* call inserted. The
   * `returning` clause is what makes the answer trustworthy: postgres.js reports an
   * affected-row count that a conflicting insert also satisfies in some drivers, so
   * the row itself is the evidence.
   */
  async claimUpdate(channel: Channel, updateId: string, now: Instant): Promise<boolean> {
    const rows = await this.db
      .insert(inboundUpdate)
      .values({ channel, updateId, receivedAt: new Date(now) })
      .onConflictDoNothing()
      .returning({ updateId: inboundUpdate.updateId });
    return rows.length === 1;
  }

  async findPendingPrompt(userId: UserId): Promise<PendingPrompt | null> {
    const [row] = await this.db
      .select()
      .from(pendingPrompt)
      .where(eq(pendingPrompt.userId, userId))
      .limit(1);
    if (!row) return null;
    return {
      userId: row.userId,
      kind: row.kind as PendingPromptKind,
      parseEventId: row.parseEventId,
      payload: row.payload,
      createdAt: row.createdAt.getTime(),
    };
  }

  /**
   * Upsert on the primary key: a second question replaces the first. `created_at` is
   * refreshed too — the row's age is the age of the question actually outstanding.
   */
  async setPendingPrompt(input: SetPendingPromptInput): Promise<void> {
    const values = {
      userId: input.userId,
      kind: input.kind,
      parseEventId: input.parseEventId ?? null,
      payload: input.payload,
      createdAt: new Date(input.now),
    };
    await this.db
      .insert(pendingPrompt)
      .values(values)
      .onConflictDoUpdate({
        target: pendingPrompt.userId,
        set: {
          kind: sql`excluded.kind`,
          parseEventId: sql`excluded.parse_event_id`,
          payload: sql`excluded.payload`,
          createdAt: sql`excluded.created_at`,
        },
      });
  }

  async clearPendingPrompt(userId: UserId): Promise<void> {
    await this.db.delete(pendingPrompt).where(eq(pendingPrompt.userId, userId));
  }
}
