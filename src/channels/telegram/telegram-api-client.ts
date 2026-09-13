import type { Logger } from '../../observability/log';

/**
 * The only code in the repo that calls the Telegram Bot API (M7 "Outbound delivery").
 *
 * It returns a typed outcome rather than throwing, because the whole point of this
 * layer is that every failure is *classifiable* — `TelegramMessageSender` maps the
 * outcome onto `SendResult`, and M5 maps that onto `daily_allowance_send` row states.
 * An exception escaping from here would turn a retryable rate-limit into an unhandled
 * rejection inside `ctx.waitUntil`.
 *
 * **The token never leaves this class.** It sits in the request URL, so the URL is
 * never logged, never put in an outcome, and never included in a rethrown error — a
 * `fetch` rejection is reduced to its error *name* before it goes anywhere, because
 * the runtime's own message for a failed request can embed the URL it tried
 * (M7 invariant: "Bot tokens and secrets never appear in logs, error messages or
 * `parse_event`").
 */

const API_BASE = 'https://api.telegram.org';

/** Telegram's JSON envelope. `parameters.retry_after` accompanies a 429. */
interface TelegramEnvelope {
  ok?: boolean;
  description?: string;
  error_code?: number;
  parameters?: { retry_after?: number };
}

export type TelegramCallOutcome =
  | { ok: true }
  | {
      ok: false;
      /** HTTP status, or 0 when the request never produced a response (network/abort). */
      status: number;
      /** Telegram's `description`, if it sent a parseable envelope. Never contains the token. */
      description: string | null;
      /** From `parameters.retry_after` on a 429, in seconds. */
      retryAfterSeconds: number | null;
    };

export interface TelegramApiClientOptions {
  /** `env.TELEGRAM_BOT_TOKEN` — a Wrangler secret. Held here, never re-exposed. */
  token: string;
  /** Test seam, mirroring `OpenAiLlmParser`'s. */
  fetch?: typeof fetch;
  logger?: Logger;
}

export class TelegramApiClient {
  readonly #token: string;
  readonly #fetch: typeof fetch;
  readonly #logger: Logger | undefined;

  constructor(options: TelegramApiClientOptions) {
    this.#token = options.token;
    // `.bind(globalThis)`, not the bare reference: the Workers runtime's `fetch` is
    // brand-checked and throws "Illegal invocation" once it's stored on an object and
    // later invoked as `this.#fetch(...)` (a method call sets `this` to the instance,
    // not the global scope `fetch` requires). A test double doesn't care about `this`,
    // so this only matters for the real one.
    this.#fetch = options.fetch ?? fetch.bind(globalThis);
    this.#logger = options.logger;
  }

  /**
   * One Bot API method call. `payload` is serialised as JSON; Telegram accepts that
   * for every method this module uses.
   */
  async call(method: string, payload: Record<string, unknown>): Promise<TelegramCallOutcome> {
    let response: Response;
    try {
      response = await this.#fetch(`${API_BASE}/bot${this.#token}/${method}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
    } catch (error) {
      // `error.message` can quote the request URL, and the URL contains the token —
      // every occurrence of the token itself is scrubbed before this reaches the
      // logger, rather than dropping the message outright, so a real failure reason
      // (bad host, TLS, a malformed URL) is still diagnosable from the logs.
      const name = error instanceof Error ? error.name : 'unknown';
      const message =
        error instanceof Error && error.message
          ? error.message.split(this.#token).join('[redacted]')
          : undefined;
      this.#logger?.log('warn', 'telegram.call.network_error', {
        method,
        error: name,
        ...(message === undefined ? {} : { message }),
      });
      return { ok: false, status: 0, description: null, retryAfterSeconds: null };
    }

    if (response.ok) return { ok: true };

    const envelope = await readEnvelope(response);
    const retryAfterSeconds = envelope?.parameters?.retry_after ?? null;
    const description = envelope?.description ?? null;

    this.#logger?.log('warn', 'telegram.call.failed', {
      method,
      status: response.status,
      ...(retryAfterSeconds === null ? {} : { retryAfterSeconds }),
    });

    return { ok: false, status: response.status, description, retryAfterSeconds };
  }

  sendMessage(
    chatId: string,
    text: string,
    replyMarkup?: unknown,
  ): Promise<TelegramCallOutcome> {
    // No `parse_mode`: every message this bot sends is plain text. M5's renderers
    // *strip* markup characters from user-supplied names rather than escaping them
    // ("M7 escapes nothing further" — `core/allowance/messages.ts`), which is only
    // safe when Telegram is not asked to interpret markup at all.
    return this.call('sendMessage', {
      chat_id: chatId,
      text,
      ...(replyMarkup === undefined ? {} : { reply_markup: replyMarkup }),
    });
  }

  /**
   * Stops the spinner on a tapped inline button. Telegram expects this within a few
   * seconds of every callback query, whether or not the press led anywhere, so the
   * dispatcher calls it before it decides what the press meant.
   *
   * No `text`: the answer itself arrives as a normal message, which keeps one reply
   * per input step (M11) instead of splitting it between a toast and a message.
   */
  answerCallbackQuery(callbackQueryId: string): Promise<TelegramCallOutcome> {
    return this.call('answerCallbackQuery', { callback_query_id: callbackQueryId });
  }

  /**
   * Replaces the whole `/` command menu. Idempotent — safe to rerun after any change
   * to the catalogue in `command-router.ts` (M7 stage 4E).
   */
  setMyCommands(commands: readonly { command: string; description: string }[]): Promise<TelegramCallOutcome> {
    return this.call('setMyCommands', { commands });
  }

  /**
   * `secretToken` is echoed back on every inbound call as
   * `X-Telegram-Bot-Api-Secret-Token`, which `TelegramWebhookHandler` checks before
   * trusting the body. Idempotent — safe to rerun after every deploy.
   */
  setWebhook(url: string, secretToken: string): Promise<TelegramCallOutcome> {
    return this.call('setWebhook', { url, secret_token: secretToken });
  }
}

/** A failing response may carry an envelope, HTML, or nothing. Never let that throw. */
async function readEnvelope(response: Response): Promise<TelegramEnvelope | null> {
  try {
    const body: unknown = await response.json();
    return typeof body === 'object' && body !== null ? (body as TelegramEnvelope) : null;
  } catch {
    return null;
  }
}
