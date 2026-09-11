import { z } from 'zod';

/**
 * Raw Telegram `Update` JSON → a discriminated union the dispatcher can switch on.
 *
 * This is the only file that knows Telegram's wire shape. Everything downstream sees
 * `TelegramEvent`, which is why a second channel adapter is a new parser rather than a
 * rewrite of the routing.
 *
 * Two rules live here rather than in the dispatcher:
 *   - **Private chats only.** `chat.type !== 'private'` produces a `group_chat` event,
 *     and M11's shared contract says such a request gets a private-chat instruction and
 *     never account data. Deciding it here means no downstream branch can forget.
 *   - **Anything unrecognised is `unsupported`, never an exception.** A malformed or
 *     future update must still be acknowledged with 200 and dropped quietly; throwing
 *     would turn it into a Telegram retry loop.
 */

/** Telegram numeric ids exceed 2^53 in principle; carried as strings past this boundary. */
const idSchema = z.union([z.number(), z.string()]).transform((v) => String(v));

const userSchema = z.object({
  id: idSchema,
  username: z.string().optional(),
  is_bot: z.boolean().optional(),
});

const chatSchema = z.object({
  id: idSchema,
  type: z.string(),
});

const messageSchema = z.object({
  message_id: idSchema,
  /** Unix seconds. Absent on some synthetic updates; the dispatcher's clock covers that. */
  date: z.number().optional(),
  chat: chatSchema,
  from: userSchema.optional(),
  text: z.string().optional(),
});

const callbackQuerySchema = z.object({
  id: z.string(),
  from: userSchema,
  data: z.string().optional(),
  message: messageSchema.optional(),
});

const preCheckoutSchema = z.object({
  id: z.string(),
  from: userSchema,
  total_amount: z.number().optional(),
  invoice_payload: z.string().optional(),
});

const updateSchema = z.object({
  update_id: idSchema,
  message: messageSchema.optional(),
  edited_message: messageSchema.optional(),
  callback_query: callbackQuerySchema.optional(),
  pre_checkout_query: preCheckoutSchema.optional(),
});

/** Who sent it, in Telegram's terms. Translated to a `UserId` by M2, never before. */
export interface TelegramSender {
  externalId: string;
  chatId: string;
  username: string | undefined;
}

interface BaseEvent {
  updateId: string;
  sender: TelegramSender;
  /** Telegram's `date` in epoch ms, or null when the update carried none. */
  sentAt: number | null;
}

export type TelegramEvent =
  | (BaseEvent & { kind: 'text_message'; text: string; messageId: string })
  | (BaseEvent & { kind: 'callback_query'; callbackQueryId: string; data: string })
  | (BaseEvent & { kind: 'non_text_message'; messageId: string })
  | (BaseEvent & { kind: 'pre_checkout'; preCheckoutQueryId: string })
  | (BaseEvent & { kind: 'successful_payment'; messageId: string })
  /** A message that arrived somewhere other than a private chat. */
  | (BaseEvent & { kind: 'group_chat' })
  /** Recognised as an update, but nothing this bot acts on. Acknowledge and drop. */
  | { kind: 'unsupported'; updateId: string | null };

export function parseUpdate(body: unknown): TelegramEvent {
  const parsed = updateSchema.safeParse(body);
  if (!parsed.success) return { kind: 'unsupported', updateId: null };

  const update = parsed.data;
  const updateId = update.update_id;

  if (update.callback_query) {
    const query = update.callback_query;
    const chatId = query.message?.chat.id ?? query.from.id;
    const base: BaseEvent = {
      updateId,
      sender: { externalId: query.from.id, chatId, username: query.from.username },
      sentAt: null,
    };
    // A callback with no `data` is a button we did not build. Nothing to route on.
    if (query.data === undefined) return { kind: 'unsupported', updateId };
    if (query.message && query.message.chat.type !== 'private') {
      return { ...base, kind: 'group_chat' };
    }
    return { ...base, kind: 'callback_query', callbackQueryId: query.id, data: query.data };
  }

  if (update.pre_checkout_query) {
    const query = update.pre_checkout_query;
    return {
      updateId,
      sender: { externalId: query.from.id, chatId: query.from.id, username: query.from.username },
      sentAt: null,
      kind: 'pre_checkout',
      preCheckoutQueryId: query.id,
    };
  }

  // An edited message is treated as a fresh message: M11 has no edit semantics, and
  // ignoring it would leave the user's correction unanswered.
  const message = update.message ?? update.edited_message;
  if (!message?.from) return { kind: 'unsupported', updateId };

  const base: BaseEvent = {
    updateId,
    sender: {
      externalId: message.from.id,
      chatId: message.chat.id,
      username: message.from.username,
    },
    sentAt: message.date === undefined ? null : message.date * 1000,
  };

  if (message.chat.type !== 'private') return { ...base, kind: 'group_chat' };

  // `successful_payment` rides on a message. Phase 2 acts on it; this pass replies
  // NOT_YET_AVAILABLE, which is still better than the "text only" fallback.
  if (hasSuccessfulPayment(body)) {
    return { ...base, kind: 'successful_payment', messageId: message.message_id };
  }

  if (typeof message.text === 'string' && message.text.trim() !== '') {
    return { ...base, kind: 'text_message', text: message.text, messageId: message.message_id };
  }

  return { ...base, kind: 'non_text_message', messageId: message.message_id };
}

/**
 * Read straight off the raw body rather than through the schema: the payment payload
 * is Phase 2's to model, and this pass only needs to know one is present.
 */
function hasSuccessfulPayment(body: unknown): boolean {
  if (typeof body !== 'object' || body === null) return false;
  const message = (body as { message?: unknown }).message;
  return (
    typeof message === 'object' &&
    message !== null &&
    'successful_payment' in message &&
    (message as { successful_payment?: unknown }).successful_payment !== undefined
  );
}
