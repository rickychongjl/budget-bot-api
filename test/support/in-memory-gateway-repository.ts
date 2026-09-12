import type {
  GatewayRepository,
  PendingPrompt,
  SetPendingPromptInput,
} from '../../src/channels/telegram/gateway-repository';
import type { Channel, Instant, UserId } from '../../src/core/shared/common';

/**
 * In-memory `GatewayRepository` for the dispatcher's unit tests.
 *
 * A test adapter, not evidence: it models the two guarantees the routing depends on —
 * "claim once" and "one prompt per user" — and proves nothing about the primary key or
 * the cascade that actually enforce them. `test/integration/gateway.test.ts` does that
 * against real Postgres.
 */
export class InMemoryGatewayRepository implements GatewayRepository {
  private readonly claimed = new Set<string>();
  private readonly prompts = new Map<UserId, PendingPrompt>();

  readonly claims: string[] = [];

  async claimUpdate(channel: Channel, updateId: string, _now: Instant): Promise<boolean> {
    const key = `${channel}:${updateId}`;
    this.claims.push(key);
    if (this.claimed.has(key)) return false;
    this.claimed.add(key);
    return true;
  }

  async findPendingPrompt(userId: UserId): Promise<PendingPrompt | null> {
    return this.prompts.get(userId) ?? null;
  }

  async setPendingPrompt(input: SetPendingPromptInput): Promise<void> {
    // Upsert on the user, mirroring the primary key: a second question replaces the first.
    this.prompts.set(input.userId, {
      userId: input.userId,
      kind: input.kind,
      parseEventId: input.parseEventId ?? null,
      payload: input.payload,
      createdAt: input.now,
    });
  }

  async clearPendingPrompt(userId: UserId): Promise<void> {
    this.prompts.delete(userId);
  }

  /** Test helper: is a prompt open? */
  has(userId: UserId): boolean {
    return this.prompts.has(userId);
  }
}
