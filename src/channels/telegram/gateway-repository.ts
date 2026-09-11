import type { Channel, Id, Instant, UserId } from '../../core/shared/common';

/**
 * M7's outgoing port — the two tables this module owns (`inbound_update`,
 * `pending_prompt`), expressed as business operations rather than table operations.
 *
 * The port lives with the module that owns it and the Drizzle implementation lives
 * under `infrastructure/database/repositories/` (CLAUDE.md, "Repository interfaces").
 * `channels/telegram/` is infrastructure in every respect except its folder, so the
 * pairing is the same one `core/identity` has with `DrizzleIdentityRepository`.
 */

export type PendingPromptKind = 'confirm' | 'clarify';

/**
 * An open question the bot is waiting on an answer to. `payload` is M6's — the
 * serialised candidate for a `confirm`, the question for a `clarify`. M7 stores and
 * returns it without interpreting it; stage 4D is what hands it back to the pipeline.
 */
export interface PendingPrompt {
  userId: UserId;
  kind: PendingPromptKind;
  parseEventId: Id | null;
  payload: unknown;
  createdAt: Instant;
}

export interface SetPendingPromptInput {
  userId: UserId;
  kind: PendingPromptKind;
  parseEventId?: Id | null;
  payload: unknown;
  now: Instant;
}

export interface GatewayRepository {
  /**
   * Record this update as seen. **True means "you are the one who claimed it"** —
   * insert `on conflict do nothing`, one row affected. A false return is a Telegram
   * redelivery that another invocation is already handling (possibly in another
   * isolate, which is exactly why this is a database constraint and not a cache).
   */
  claimUpdate(channel: Channel, updateId: string, now: Instant): Promise<boolean>;

  findPendingPrompt(userId: UserId): Promise<PendingPrompt | null>;

  /** Upsert on `user_id` — a new question replaces the open one, never queues behind it. */
  setPendingPrompt(input: SetPendingPromptInput): Promise<void>;

  /** Idempotent: clearing when nothing is open is not an error. */
  clearPendingPrompt(userId: UserId): Promise<void>;
}
