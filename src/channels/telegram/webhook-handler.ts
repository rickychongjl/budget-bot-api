import type { Clock } from '../../core/shared/clock';
import type { Logger } from '../../observability/log';
import { startTimer } from '../../observability/timing';
import type { TelegramDispatcher } from './dispatcher';
import type { GatewayRepository } from './gateway-repository';
import { parseUpdate } from './update-parser';

/**
 * `POST /telegram/webhook`.
 *
 * Telegram retries any non-2xx response, aggressively, so the rule from M7's page is
 * absolute: **always return 200 fast and do the real work in `ctx.waitUntil`.** Real
 * work here can include an LLM call taking a second or more; holding the webhook open
 * for it invites a retry that races the first attempt's own dedupe write.
 *
 *   1. `X-Telegram-Bot-Api-Secret-Token` mismatch → 401, body never read, nothing logged.
 *   2. Claim the update (`inbound_update`) → already claimed → 200, stop.
 *   3. Return 200.
 *   4. Background: dispatch.
 *
 * Timing (M9): this is where the clock on a whole message starts, so the receipt
 * instant is captured here and handed to `dispatch` — every other stage measures
 * itself, and the dispatcher closes the lifecycle with one total. `telegram.webhook.*`
 * lines carry the update id and durations only; the body is never logged.
 *
 * The secret token is not optional. The webhook URL alone is not a credential — it
 * leaks into logs, proxies and screenshots — which is why `setWebhook` sets a token
 * and this is the first thing checked.
 */

const SECRET_HEADER = 'X-Telegram-Bot-Api-Secret-Token';
const CHANNEL = 'telegram' as const;

/** Only what this handler needs from `ExecutionContext`, so tests can supply it. */
export interface BackgroundWork {
  waitUntil(promise: Promise<unknown>): void;
}

export interface WebhookHandlerDeps {
  dispatcher: Pick<TelegramDispatcher, 'dispatch'>;
  gateway: Pick<GatewayRepository, 'claimUpdate'>;
  clock: Clock;
  logger: Logger;
  /** `env.TELEGRAM_WEBHOOK_SECRET`, the value given to `setWebhook`. */
  webhookSecret: string;
}

export class TelegramWebhookHandler {
  constructor(private readonly deps: WebhookHandlerDeps) {}

  async handle(request: Request, ctx: BackgroundWork): Promise<Response> {
    // 1. Authenticate before touching the body. An unauthenticated caller must not be
    //    able to make us parse arbitrary JSON, and nothing about the attempt is logged
    //    — the header itself is a secret and the body is unverified.
    if (!isAuthentic(request.headers.get(SECRET_HEADER), this.deps.webhookSecret)) {
      return new Response('unauthorized', { status: 401 });
    }

    // Everything downstream is measured against this instant, so it is taken before
    // the body is even read: JSON parsing is part of the message's latency too.
    const receivedAt = this.deps.clock.now();
    const sinceReceipt = startTimer(this.deps.clock);

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      // Malformed JSON from an authenticated caller is still Telegram's delivery.
      // 200 so it is not retried forever; there is nothing here to act on.
      return ok();
    }

    const event = parseUpdate(body);
    if (event.kind === 'unsupported' && event.updateId === null) return ok();

    // The update id and its kind, never the text — enough to line a `wrangler tail`
    // session up with one message.
    this.deps.logger.log('info', 'telegram.webhook.received', {
      updateId: event.updateId,
      kind: event.kind,
      ms: sinceReceipt(),
    });

    // 2. Deduplicate in the database, never in memory: two deliveries of the same
    //    retry can land in different isolates, so an in-process guard would not see
    //    the other one.
    const claimElapsed = startTimer(this.deps.clock);
    const claimed = await this.deps.gateway.claimUpdate(
      CHANNEL,
      event.updateId ?? '',
      this.deps.clock.now(),
    );
    // The first database round trip of the request — and therefore the one that pays
    // for a cold Neon compute, which is why it is measured separately from the rest.
    this.deps.logger.log('info', 'telegram.webhook.claimed', {
      updateId: event.updateId,
      claimed,
      ms: claimElapsed(),
    });
    if (!claimed) {
      this.deps.logger.log('info', 'telegram.webhook.duplicate', { updateId: event.updateId });
      return ok();
    }

    // 3 & 4. Answer now; work afterwards. `receivedAt` travels with the event so the
    // dispatcher's closing line can report the whole lifecycle, not just its own half.
    ctx.waitUntil(this.deps.dispatcher.dispatch(event, receivedAt));
    return ok();
  }
}

function ok(): Response {
  return new Response('ok', { status: 200 });
}

/**
 * Constant-time comparison — the same treatment `/internal/send-allowance` gives its
 * dispatch secret. Length is compared first and leaks only the length.
 */
function isAuthentic(presented: string | null, expected: string): boolean {
  if (presented === null || expected === '' || presented.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < presented.length; i += 1) {
    diff |= presented.charCodeAt(i) ^ expected.charCodeAt(i);
  }
  return diff === 0;
}
