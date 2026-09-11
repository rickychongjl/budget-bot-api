import type {
  ChannelConnection,
  MessageSender,
  OutboundMessage,
  SendResult,
} from '../../core/shared/messaging';
import type { TelegramApiClient, TelegramCallOutcome } from './telegram-api-client';

/**
 * M7's implementation of the `MessageSender` port (`core/shared/messaging.ts`).
 *
 * Its entire substance is the failure classification in M7's "Outbound delivery"
 * section. M5 maps the result straight onto `daily_allowance_send` row states, so a
 * misclassification silently turns a retryable failure into a dead bundle (or, worse,
 * retries something that will never succeed):
 *
 *   403 blocked   -> `skipped`    — M5 retires the rows and deactivates the connection
 *   429 limited   -> `retryable`  — rows stay `pending`; the next 15-minute tick retries
 *   5xx / network -> `retryable`  — same
 *   400 bad body  -> `permanent`  — a bug in the message we built; rows go `failed`
 *
 * **This class never deactivates a connection.** `DefaultAllowanceService` already
 * calls `deactivateConnection` on a `skipped` result
 * (`core/allowance/default-allowance-service.ts`), and M7's own inbound reply path
 * does the same for its own sends. The sender only classifies; the caller decides.
 */
export class TelegramMessageSender implements MessageSender {
  constructor(private readonly api: TelegramApiClient) {}

  async send(connection: ChannelConnection, message: OutboundMessage): Promise<SendResult> {
    const outcome = await this.api.sendMessage(
      connection.chatId,
      message.text,
      message.replyMarkup,
    );
    return classify(outcome);
  }
}

export function classify(outcome: TelegramCallOutcome): SendResult {
  if (outcome.ok) return { status: 'sent' };

  switch (outcome.status) {
    case 403:
      // The user blocked the bot, or deleted the chat. Nothing to retry to.
      return { status: 'skipped', reason: 'blocked' };

    case 429:
      // Never sleep here — a Worker invocation has 10ms of CPU on the Free plan.
      return {
        status: 'retryable',
        ...(outcome.retryAfterSeconds === null
          ? {}
          : { retryAfterSeconds: outcome.retryAfterSeconds }),
      };

    case 400:
      // Our message was malformed. Retrying sends the identical bytes.
      return { status: 'permanent' };

    default:
      // 0 is "no response at all" (network/abort); 5xx is Telegram being unwell. Both
      // are worth another tick. Every other 4xx — 401 (wrong token), 404 (chat gone) —
      // is a misconfiguration that a retry cannot fix, so it fails loudly rather than
      // burning the retry budget every 15 minutes.
      return outcome.status === 0 || outcome.status >= 500
        ? { status: 'retryable' }
        : { status: 'permanent' };
  }
}
