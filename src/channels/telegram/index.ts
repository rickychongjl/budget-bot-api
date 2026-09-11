/**
 * M7 — Telegram Gateway (Phase 4, the integrator). The module's public surface.
 *
 * The only module that knows Telegram exists. It implements `MessageSender`
 * (`core/shared/messaging.ts`) against the Telegram Bot API and owns
 * `infrastructure/database/schema/platform.ts` (`inbound_update`, `pending_prompt`).
 *
 * Landed in stage 4A (outbound delivery + composition root):
 *   telegram-api-client.ts      TelegramApiClient — the only caller of the Bot API
 *   telegram-message-sender.ts  TelegramMessageSender — the `MessageSender` M5 calls
 *
 * Still to land: the webhook handler, update parser, dispatcher and command router
 * (stages 4B–4D). Webhook flow, once built: verify
 * `X-Telegram-Bot-Api-Secret-Token` -> dedup insert -> return 200 fast ->
 * `ctx.waitUntil` background (resolve user -> M8 admit -> route per M11's routing
 * order -> reply). Command catalogue lives in M11.
 *
 * Wiring (composition root, `src/index.ts`):
 *   const telegramApi = new TelegramApiClient({ token: env.TELEGRAM_BOT_TOKEN, logger });
 *   const sender = new TelegramMessageSender(telegramApi);
 */
export { TelegramApiClient } from './telegram-api-client';
export type { TelegramApiClientOptions, TelegramCallOutcome } from './telegram-api-client';

export { TelegramMessageSender, classify } from './telegram-message-sender';
