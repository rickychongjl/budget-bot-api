import type { Channel, UserId } from '../ports/common';
import type { ChannelConnection } from '../ports/messaging';

/**
 * M2's read/deactivate surface over `channel_connection` for the transport layer.
 * **Added by M2** — see build-log.
 *
 * M7's plan says "403 blocked by user → deactivate `channel_connection` (via M2)" and
 * M5's says the same, and M5's `MessageSender.send` takes a `ChannelConnection` — but
 * `IdentityService` (the committed M2 port) has no way to fetch or deactivate one.
 * Kept as a separate, deliberately tiny port rather than widening `IdentityService`,
 * so the agreed interface stays verbatim. Per M2's invariants, nobody outside M2 reads
 * `channel_connection` to make a *business* decision — M7/M5 read it only to find a
 * `chat_id`.
 */
export interface ChannelConnectionDirectory {
  /** The active connection for delivering to `userId` on `channel`, or null if none/blocked. */
  findActiveConnection(userId: UserId, channel: Channel): Promise<ChannelConnection | null>;

  /** 403 path — the user blocked the bot. Never retried; `register` re-activates on next `/start`. */
  deactivateConnection(userId: UserId, channel: Channel): Promise<void>;
}
