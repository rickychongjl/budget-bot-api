import type { Channel, Id, Instant, UserId } from './common';

/**
 * M7 — Telegram Gateway. Transport only. The shared ports every channel adapter must
 * implement (M1 §3) — this is what makes a second channel a new adapter later, not a
 * rewrite. WhatsApp is out of scope this pass; don't build a second adapter now.
 *
 * `InboundMessage` / `MessageSender` lifted verbatim from
 * `docs/M7-telegram-gateway.md` ("Shared ports every channel adapter must implement").
 * Stub only.
 */

export interface InboundMessage {
  channel: Channel;
  externalId: string;
  chatId: string;
  text: string;
  sentAt: Instant;
  updateId: string;
}

/** Where an outbound message goes — M2's `channel_connection` row. */
export interface ChannelConnection {
  id: Id;
  userId: UserId;
  channel: Channel;
  externalId: string;
  chatId: string;
  username?: string | null;
  isActive: boolean;
  linkedAt: Instant;
}

export interface OutboundMessage {
  text: string;
  /** Inline keyboard / reply markup — Telegram-shaped, rendered by M7. */
  replyMarkup?: unknown;
}

/**
 * Delivery outcome, classified per M7's "Outbound delivery" section:
 *   - 403 blocked  -> `skipped` (deactivate the connection via M2, never retry)
 *   - 429 / 5xx    -> `retryable` (don't sleep inside the invocation)
 *   - 400          -> `permanent` (a bug in the message we built)
 */
export type SendResult =
  | { status: 'sent' }
  | { status: 'skipped'; reason: 'blocked' }
  | { status: 'retryable'; retryAfterSeconds?: number }
  | { status: 'permanent' };

export interface MessageSender {
  send(connection: ChannelConnection, message: OutboundMessage): Promise<SendResult>;
}
